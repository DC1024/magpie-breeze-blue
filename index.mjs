// Magpie 的 Breeze Blue provider 插件接线：config/auth/provider 三个 hook，
// 具体的请求映射与 HTTP 逻辑都在 lib/breeze.mjs。
// 每日签到（auth.checkin）走的是 Web 端会话 cookie，逻辑在 lib/checkin.mjs。
import {
  BALANCE_PLAN,
  BREEZE_BASE_URL,
  breezeBalance,
  createBreezeSpeechFetch,
} from './lib/breeze.mjs'
import { claimDailyCredits } from './lib/checkin.mjs'

const PROVIDER_ID = 'breeze'
const MODEL_ID = 'breeze-tts-2'

// 登录时让用户粘贴 Breeze Blue 网页会话 cookie；Magpie 会将其作为 OAuth 凭证保存在自己的 plugin-auth.json。
// 这不是 API Key。Breeze 当前使用 Firebase 登录，未来可用完整浏览器流程替换粘贴式登录。
function normalizeCookie(raw) {
  if (typeof raw !== 'string') return null
  let cookie = raw.trim().replace(/^cookie\s*:\s*/i, '')
  if (!cookie || /[\r\n]/.test(cookie)) return null
  return cookie
}

function resolveCheckinCookie(auth) {
  return normalizeCookie(auth?.metadata?.cookie ?? auth?.cookie ?? auth?.access ?? '')
}

function modelDeclaration() {
  return {
    name: 'Breeze TTS 2',
    capabilities: { input: { text: true }, output: { audio: true } },
    limit: { context: 1000, output: 0 },
    tool_call: false,
  }
}

// Magpie 会把模块导出的函数都当作插件，因此这里只导出默认工厂。
export default async function breezePlugin() {
  return {
    config: async (config) => {
      config.provider ??= {}
      const existing = config.provider[PROVIDER_ID] ?? {}
      config.provider[PROVIDER_ID] = {
        name: 'BreezeBlue',
        npm: '@ai-sdk/openai-compatible',
        api: BREEZE_BASE_URL,
        ...existing,
        models: {
          ...(existing.models ?? {}),
          [MODEL_ID]: {
            ...modelDeclaration(),
            ...(existing.models?.[MODEL_ID] ?? {}),
          },
        },
      }
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        { type: 'api', label: 'Breeze API key', placeholder: 'brz_…' },
        {
          // Magpie 会把 authorize 返回的 OAuth 凭证保存到 plugin-auth.json。
          // 不在 authorize 里联网；校验放 callback，避免阻塞宿主的登录流程。
          type: 'oauth',
          label: 'Breeze 网页 Cookie（每日签到）',
          prompts: [{
            type: 'text',
            key: 'cookie',
            message: '粘贴 breezeblue.ai 的整行 cookie',
            placeholder: 'name=value; other=value',
            validate: (value) => normalizeCookie(value) ? undefined : '请输入有效的单行 Cookie',
          }],
          async authorize(inputs) {
            const cookie = normalizeCookie(inputs?.cookie)
            if (!cookie) throw new Error('请输入有效的单行 Cookie')
            return {
              url: 'https://breezeblue.ai/app/home',
              instructions: '正在验证 Breeze Blue 登录态…',
              method: 'auto',
              opened: true,
              async callback() {
                const summary = await fetch('https://breezeblue.ai/api/credits/summary', {
                  headers: {
                    cookie,
                    accept: 'application/json, text/plain, */*',
                    origin: 'https://breezeblue.ai',
                    referer: 'https://breezeblue.ai/app/home',
                  },
                }).catch((error) => ({ status: 0, error }))
                if (summary.status === 401 || summary.status === 403) {
                  return { type: 'failed', error: 'Breeze 网页 Cookie 无效或已过期' }
                }
                if (summary.status !== 200) {
                  return { type: 'failed', error: `Breeze 登录态验证失败：HTTP ${summary.status || 'network error'}` }
                }
                return {
                  type: 'success',
                  access: cookie,
                  refresh: '',
                  // Web 会话实际有效期由服务端决定；这里仅避免 Magpie 主动过早淘汰。
                  // 401/403 会在 checkin 时返回 signIn: "expired"。
                  expires: Date.now() + 360 * 24 * 3600 * 1000,
                  metadata: { cookie },
                }
              },
            }
          },
        },
      ],

      async loader(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch {
          return {}
        }
        const key = auth?.type === 'api' && typeof auth.key === 'string' ? auth.key : ''
        if (!key) return {}
        return {
          baseURL: BREEZE_BASE_URL,
          fetch: createBreezeSpeechFetch(key),
        }
      },

      // 余额只用于 Magpie 的 provider 卡片/usage；任何失败都变成 error 文本。
      async usage(getAuth) {
        try {
          const auth = await getAuth()
          const usage = await breezeBalance(auth?.key)
          if (Array.isArray(usage.windows) && usage.windows.length > 0) {
            usage.windows.push({
              name: '每日积分',
              display: '在 breezeblue.ai/app 手动领取',
              aside: true,
            })
          }
          return usage
        } catch (error) {
          return {
            plan: BALANCE_PLAN,
            windows: [],
            error: `Breeze balance: ${error?.message ?? String(error)}`,
          }
        }
      },

      // Magpie 每个北京日对每个已登录账调用一次（受 设置→用量→插件 的每日签到开关控制）。
      // 返回 { outcome, credit?, streak?, message?, until? }，outcome 只认
      // claimed / done / ineligible / inactive / captcha / failed。
      // 只有 failed 会在当天 30 分钟后重试，所以「cookie 过期」这类不该重试的情况
      // 一律报 ineligible，避免一天被重试几十次。
      async checkin(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch {
          return { outcome: 'ineligible', message: '未登录 Breeze 网页签到账号' }
        }
        const cookie = resolveCheckinCookie(auth)
        if (!cookie) {
          return {
            outcome: 'ineligible',
            message: '未配置 Breeze 网页 Cookie：请先登录“Breeze 网页 Cookie（每日签到）”账号',
          }
        }

        const result = await claimDailyCredits({ cookie })
        if (result.outcome === 'ineligible' && /会话已失效/.test(result.message ?? '')) {
          return { ...result, signIn: 'expired' }
        }
        return result
      },
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        return provider?.models ?? { [MODEL_ID]: modelDeclaration() }
      },
    },
  }
}

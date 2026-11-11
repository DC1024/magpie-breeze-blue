// Magpie 的 Breeze Blue provider 插件接线：config/auth/provider 三个 hook，
// 具体的请求映射与 HTTP 逻辑都在 lib/breeze.mjs。
// 每日签到（auth.checkin）走的是 Web 端会话 cookie，逻辑在 lib/checkin.mjs，
// 浏览器取 cookie 的流程在 lib/browser-login.mjs。
import {
  BALANCE_PLAN,
  BREEZE_BASE_URL,
  breezeBalance,
  createBreezeSpeechFetch,
} from './lib/breeze.mjs'
import { claimDailyCredits, normalizeCookie, verifyCookie } from './lib/checkin.mjs'
import { LOGIN_URL, loginWithBrowser, normalizeCdpBase } from './lib/browser-login.mjs'

const PROVIDER_ID = 'breeze'
const MODEL_ID = 'breeze-tts-2'

// 会话 cookie 存在 auth.access / auth.metadata.cookie，两种都读。
function resolveCheckinCookie(auth) {
  return normalizeCookie(auth?.metadata?.cookie ?? auth?.cookie ?? auth?.access ?? '')
}

// 登录成功后交给 Magpie 的凭据形状。expires 只是让宿主别主动淘汰；
// 真正的判据是上游 401，届时 checkin 会返回 signIn: "expired"。
function cookieCredential(cookie) {
  return {
    type: 'success',
    access: cookie,
    refresh: '',
    expires: Date.now() + 360 * 24 * 3600 * 1000,
    metadata: { cookie },
  }
}

function modelDeclaration() {
  return {
    name: 'Breeze TTS 2',
    capabilities: { input: { text: true }, output: { audio: true } },
    limit: { context: 1000, output: 0 },
    tool_call: false,
  }
}

// 把「跑一次 loginWithBrowser」包装成 Magpie 的 oauth method。
// 关键约束：authorize 必须立即返回，等待放在 callback 里，否则会和宿主互锁。
// instructions 支持传函数，用于把用户填的地址回显进去。
function browserLoginMethod({ label, instructions, opened = true, options = () => ({}) }) {
  return {
    type: 'oauth',
    label,
    async authorize(inputs, context) {
      const signal = context?.signal
      const pending = loginWithBrowser({
        signal,
        verify: async (cookie) => (await verifyCookie(cookie)).ok,
        // 写 stderr 而不是 stdout：宿主的 stdout 是它与 magpie 的通信通道，
        // 插件不该往上面写任何东西。
        log: (line) => console.error(`[breeze] ${line}`),
        ...options(inputs),
      })
      // 宿主放弃登录（取消 / 超时）时不会调用 callback，这个 Promise 就没人接管。
      // 未处理的 reject 会让 Bun 直接以 exit 1 退出整个插件宿主，所以这里兜一层。
      pending.catch(() => {})

      return {
        url: LOGIN_URL,
        instructions: typeof instructions === 'function' ? instructions(inputs) : instructions,
        method: 'auto',
        opened,
        async callback() {
          let result
          try {
            result = await pending
          } catch (err) {
            return { type: 'failed', error: String(err?.message ?? err) }
          }
          if (!result.ok) return { type: 'failed', error: result.error }
          return cookieCredential(result.cookie)
        },
      }
    },
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
        {
          type: 'api',
          label: 'Breeze API key',
          placeholder: 'brz_…',
        },
        // 本机模式：Magpie 和你用的是同一台电脑时最省事——点一下弹浏览器，登录完自动读回 cookie。
        browserLoginMethod({
          label: '浏览器登录（推荐，点一下即可）',
          instructions:
            '已打开 Breeze 登录窗口：登录完成后会自动读取登录态，无需复制任何东西。窗口会在成功后自动关闭。',
        }),
        // 远程模式：Magpie 跑在 NAS / 服务器上，浏览器在你自己的电脑上。
        // 这时插件进程 spawn 出来的窗口开在 NAS 那块屏幕上，你根本看不到，
        // 所以改成「连你电脑上 Chrome 的调试端口」。
        {
          ...browserLoginMethod({
            label: '远程浏览器登录（Magpie 装在 NAS / 服务器时用）',
            // 浏览器已经开在用户电脑上了，不该再让宿主去开一个
            opened: false,
            options: (inputs) => ({ cdpUrl: normalizeCdpBase(inputs?.cdp) || 'http://127.0.0.1:9222' }),
            instructions: (inputs) => {
              const cdp = normalizeCdpBase(inputs?.cdp) || 'http://127.0.0.1:9222'
              return (
                `正在连你电脑上的 Chrome（${cdp}）。请在那个 Chrome 里登录 Breeze，` +
                '登录成功后会自动读取登录态。注意：窗口在你自己的电脑上，不在 NAS 上。'
              )
            },
          }),
          prompts: [
            {
              type: 'text',
              key: 'cdp',
              message: '在你电脑上启动带调试端口的 Chrome，然后填它的地址',
              placeholder: '127.0.0.1:9222',
              validate: (value) => (normalizeCdpBase(value) ? undefined : '填成 主机:端口 或 http://主机:端口'),
            },
          ],
        },
        {
          // 兜底：没有 Chromium 浏览器、或在别人的机器上临时用时，
          // 从 DevTools 复制整行 cookie 粘进来。纯 HTTP 校验。
          type: 'oauth',
          label: '粘贴 Cookie 登录',
          prompts: [{
            type: 'text',
            key: 'cookie',
            message: '粘贴 breezeblue.ai 的整行 cookie',
            placeholder: 'name=value; other=value',
            validate: (value) => normalizeCookie(value) ? undefined : '请输入有效的单行 Cookie',
          }],
          async authorize(inputs) {
            const cookie = normalizeCookie(inputs?.cookie)
            // 失败只能 throw：return { type: 'failed' } 会被宿主当成登录流程去调 .callback()。
            if (!cookie) throw new Error('请输入有效的单行 Cookie')
            return {
              url: 'https://breezeblue.ai/app/home',
              instructions: '正在验证 Breeze Blue 登录态…',
              method: 'auto',
              opened: true,
              async callback() {
                const check = await verifyCookie(cookie)
                if (!check.ok) return { type: 'failed', error: check.reason }
                return cookieCredential(cookie)
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
      // 注意：用「浏览器登录」的用户只有会话 cookie、没有 API key，
      // 这种情况不该报 "not signed in"——他只是没配 key，签到照样能用。
      async usage(getAuth) {
        try {
          const auth = await getAuth()
          const key = typeof auth?.key === 'string' ? auth.key.trim() : ''
          if (!key) {
            const hasCookie = Boolean(resolveCheckinCookie(auth))
            return {
              plan: BALANCE_PLAN,
              windows: hasCookie
                ? [{ name: '每日积分', display: '由每日签到自动领取', aside: true }]
                : [],
              error: hasCookie ? undefined : '未配置 Breeze API key，余额不可查',
            }
          }

          const usage = await breezeBalance(key)
          if (Array.isArray(usage.windows) && usage.windows.length > 0) {
            usage.windows.push({
              name: '每日积分',
              display: '由每日签到自动领取',
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

      // Magpie 每个北京日对每个已登录账号调用一次（受 设置→用量→插件 的每日签到开关控制）。
      // 返回 { outcome, credit?, streak?, message?, until? }，outcome 只认
      // claimed / done / ineligible / inactive / captcha / failed。
      // 只有 failed 会在当天 30 分钟后重试，所以「会话失效」不该用 failed，
      // 否则一天会被重试几十次；改用 signIn: "expired" 让宿主标记账号需要重新登录。
      async checkin(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch {
          return { outcome: 'ineligible', message: '未登录 Breeze 网页账号' }
        }
        const cookie = resolveCheckinCookie(auth)
        if (!cookie) {
          // 区分「完全没登录」和「只配了 API key」：后者是常见误区，
          // TTS 的 key 不能用来签到，得单独走一次浏览器登录。
          const hasKey = typeof auth?.key === 'string' && auth.key.trim()
          return {
            outcome: 'ineligible',
            message: hasKey
              ? '当前账号只有 API key，签到需要网页登录态：请再用「浏览器登录」方式添加一个账号'
              : '未登录 Breeze 网页账号：请用「浏览器登录」方式登录一次',
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

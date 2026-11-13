// Magpie 的 Breeze Blue provider 插件接线：config/auth/provider 三个 hook，
// 具体的请求映射与 HTTP 逻辑都在 lib/breeze.mjs。
// 每日签到（auth.checkin）走的是 Web 端会话 cookie，逻辑在 lib/checkin.mjs。
//
// 三条拿会话的路径：
//   1. 邮箱密码（lib/password-login.mjs）：Firebase 直连换 idToken，再换 Breeze 会话。
//      不开浏览器、不用复制，且能靠 refresh token 长期续期。首选。
//   2. 浏览器登录：magpie 打开登录页（网页版 window.open(url)，桌面版系统浏览器，
//      见 internal/gui/assets/app.js 的 openSignInPage 与 internal/gui/api.go 的
//      openSignIn），用户登录后把 cookie 粘回来。站点性质决定它只能这样。
//   3. 本机自动读 Cookie（lib/browser-login.mjs）：Magpie 与浏览器同机时走 CDP，
//      不用复制。跨机时 spawn 的窗口开在 NAS 的屏幕上，没用。
import {
  BALANCE_PLAN,
  BREEZE_BASE_URL,
  breezeBalance,
  createBreezeSpeechFetch,
} from './lib/breeze.mjs'
import { claimDailyCredits, normalizeCookie, verifyCookie, webCreditsUsage } from './lib/checkin.mjs'
import { LOGIN_PAGE_URL, loginWithBrowser } from './lib/browser-login.mjs'
import { loginWithPassword, renewSession } from './lib/password-login.mjs'

const PROVIDER_ID = 'breeze'
const MODEL_ID = 'breeze-tts-2'

// 会话 cookie 存在 auth.access / auth.metadata.cookie，两种都读。
function resolveCheckinCookie(auth) {
  return normalizeCookie(auth?.metadata?.cookie ?? auth?.cookie ?? auth?.access ?? '')
}

// 登录成功后交给 Magpie 的凭据形状。
// 必须带 refresh 字段（哪怕是空串）：宿主 save() 靠 `"refresh" in result` 判断
// 这该存成 oauth 账号，少了它整条登录会被静默丢弃。
//
// 两种形状的区别在 expires：
//   - 只有 cookie（粘贴 / CDP）：不写 expires。宿主的 renewAt() 只对有 expires 的
//     oauth 账号续期，没有就永不续期——这正确，因为没有 refresh token 可续。
//   - 邮箱密码登录：写 expires + 真的 refresh token，宿主到点自动续期。
function cookieCredential(cookie, extra = {}) {
  const { expires, refresh, metadata } = extra
  return {
    type: 'success',
    access: cookie,
    refresh: refresh ?? '',
    ...(expires ? { expires } : {}),
    metadata: { cookie, ...(metadata ?? {}) },
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

// 主登录方式的引导语。magpie 会把它原样显示在登录卡片上，
// 所以必须自己说清「在哪复制、粘到哪」——它是这段流程唯一的说明书。
const PASTE_STEPS =
  '已在你自己的浏览器里打开 Breeze 登录页（不在 NAS 上）。' +
  '① 完成登录；' +
  '② 在该页按 F12 → Console，执行 copy(document.cookie) 回车；' +
  '若粘出来是空的（会话 cookie 是 HttpOnly），改走 F12 → Network，点任一条 /api 请求，' +
  '在 Request Headers 里对 cookie: 那一行右键 Copy value；' +
  '③ 回到这里粘贴到下面的输入框，点提交。'

// 把用户粘进来的东西变成一行 cookie，实在不行就给一条能照做的报错。
// 三类常见错法各有各的提示，否则用户只会看到「无效」然后反复重试同一段内容：
//   - 整块从 Application → Cookies 表格里复制 → 带制表符/换行，能识别出来
//   - 粘了网址 / 邮箱 / 密码
//   - 粘了别的东西
function readPastedCookie(raw) {
  const text = String(raw ?? '')
  // 先查制表符/换行：Cookie 头永远是单行无制表符的，
  // 而 normalizeCookie 只拒换行，表格整块复制（一行多列）会被它放过去。
  if (/[\t\r\n]/.test(text.trim())) {
    throw new Error(
      '这段内容带换行或制表符，多半是从 Application → Cookies 表格里整块复制的。' +
        '请改在 F12 → Network 里点任一条 /api 请求，从 Request Headers 复制 cookie: 整行。',
    )
  }
  const cookie = normalizeCookie(text)
  if (!cookie) throw new Error('这里要粘的是 Cookie（形如 a=1; b=2 的一行），不是网址或邮箱')
  return cookie
}

// 把授权方法包成 Magpie 的 oauth hook。
// 两条硬约束（都踩过）：
//   1. authorize 必须**立即返回**，等待放到 callback 里，否则会和宿主互锁；
//   2. 失败只能 throw，不能 return { type: 'failed' }——老版本宿主会拿它去调
//      .callback()，报「gave nothing to finish it with」这种莫名其妙的错。
function oauthMethod({ label, url, instructions, opened, run }) {
  return {
    type: 'oauth',
    label,
    async authorize(inputs, context) {
      const signal = context?.signal
      const pending = run({ inputs, signal })
      // 宿主放弃登录（取消 / 超时）时不会调用 callback，这个 Promise 就没人接管。
      // 未处理的 reject 会让 Bun 直接以 exit 1 退出整个插件宿主，所以这里兜一层。
      pending.catch(() => {})

      return {
        url,
        instructions,
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
        // ── 首选：邮箱密码。全程在插件进程里打 HTTP，不开浏览器、不用复制、
        // 还能靠 Firebase 的 refresh token 长期续期（见下面的 refresh 钩子）。
        // authorize 里就把活干完（3 个请求，几秒），失败直接 throw，宿主会把
        // 原因显示在登录卡片上；成功则 callback 立刻交出凭据，界面一闪而过。
        {
          type: 'oauth',
          label: '邮箱密码登录（推荐，不用浏览器）',
          prompts: [
            {
              type: 'text',
              key: 'email',
              message: 'Breeze 账号邮箱',
              placeholder: 'you@example.com',
              validate: (value) => (String(value ?? '').includes('@') ? undefined : '填一个完整的邮箱地址'),
            },
            {
              // magpie 自己的 prompt 类型（OpenCode 只有 text/select），界面是掩码框
              type: 'password',
              key: 'password',
              message: 'Breeze 账号密码',
              placeholder: '只在登录这一刻用到，不写盘',
              validate: (value) => (String(value ?? '').trim() ? undefined : '请输入密码'),
            },
          ],
          async authorize(inputs) {
            const result = await loginWithPassword({
              email: inputs?.email,
              password: inputs?.password,
              verify: async (cookie) => (await verifyCookie(cookie)).ok,
              log: (line) => console.error(`[breeze] ${line}`),
            })
            // 失败只能 throw：return { type: 'failed' } 在老版本宿主上会被当成
            // 登录流程去调 .callback()，报「gave nothing to finish it with」。
            if (!result.ok) throw new Error(result.error)

            return {
              // 没有页面要开：url 留空，前端就不会 window.open，也不会渲染链接
              url: '',
              instructions: `已登录 ${result.user}`,
              method: 'auto',
              opened: true,
              async callback() {
                return cookieCredential(result.cookie, {
                  expires: result.expiresAt,
                  refresh: result.refreshToken,
                  metadata: {
                    firebaseRefreshToken: result.refreshToken,
                    apiKey: result.apiKey,
                    user: result.user,
                  },
                })
              },
            }
          },
        },
        // ── 主路径（免密码）：magpie 开登录页 + 粘贴框。
        // method: 'code' 让界面在 instructions 下面直接给一个输入框和一个提交按钮，
        // 用户粘完点一下就好；宿主把这段文本原样交回 callback(code)。
        // 这条路径不依赖 Magpie 与本机的任何能力，NAS / Docker / 远程访问全都能用。
        {
          type: 'oauth',
          label: '浏览器登录（打开登录页，粘一次 Cookie）',
          async authorize() {
            return {
              // opened: false —— 交给 magpie 打开（网页版开新标签页，桌面版调系统浏览器）
              url: LOGIN_PAGE_URL,
              instructions: PASTE_STEPS,
              method: 'code',
              opened: false,
              async callback(code) {
                const cookie = readPastedCookie(code)
                const check = await verifyCookie(cookie)
                if (!check.ok) {
                  // 「网络错误」是 Magpie 那台机器的出网问题，不是用户粘错了东西，
                  // 别让用户对着一个正确的 Cookie 反复重试。
                  throw new Error(
                    /^网络错误/.test(check.reason)
                      ? `${check.reason}。这是 Magpie 所在机器访问 breezeblue.ai 的问题（多半是代理），不是 Cookie 的问题。`
                      : `${check.reason}。请确认复制的是 https://breezeblue.ai 域下的 Cookie`,
                  )
                }
                return cookieCredential(cookie)
              },
            }
          },
        },
        // ── 本机自动：Magpie 和浏览器在同一台电脑时，连复制都不用。
        // 自己 spawn 一个带调试端口的浏览器，登录完直接读回 cookie。
        oauthMethod({
          label: '本机自动读 Cookie（Magpie 与浏览器在同一台电脑）',
          url: LOGIN_PAGE_URL,
          instructions:
            '已打开一个独立的 Breeze 登录窗口：登录完成后会自动读取登录态，无需复制任何东西。成功后窗口会自己关掉。'
            + '若页面提示「此浏览器或应用可能不安全」，那是 Google 拦了插件开的浏览器，请改用「邮箱密码登录」，或关掉窗口用「浏览器登录」。',
          // 窗口是插件自己开的，别让宿主再开第二个
          opened: true,
          run: ({ signal }) =>
            loginWithBrowser({
              signal,
              verify: async (cookie) => (await verifyCookie(cookie)).ok,
              // 写 stderr 而不是 stdout：宿主的 stdout 是它与 magpie 的通信通道，
              // 插件不该往上面写任何东西。
              log: (line) => console.error(`[breeze] ${line}`),
            }),
        }),
        {
          // 兜底：Cookie 已经在手上（别处复制过来的），不想开浏览器。
          type: 'oauth',
          label: '直接粘贴 Cookie',
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
                const check = await verifyCookie(cookie)
                if (!check.ok) throw new Error(check.reason)
                return cookieCredential(cookie)
              },
            }
          },
        },
        {
          // 只做 TTS 的人用这条：api.breeze.blue 认的是 xi-api-key，跟网页会话
          // 完全是两套东西。凭证存成 api 类型，loader 从 auth.key 取。
          // （e42ca41 重构时误删过这一条，会让 TTS 无 key 可用，别再去掉。）
          type: 'api',
          label: 'Breeze API key（只做 TTS / 查余额时用）',
          placeholder: 'brz_…',
        },
      ],

      // 宿主到点（expires - 5 分钟）会调这个，也在 checkin / usage 之前按需调。
      // 只有邮箱密码登录的账号带 refresh token；粘贴 / CDP 来的 cookie 没有
      // expires，宿主根本不会调到这里。
      //
      // 返回的字段会覆盖旧凭据（type 由宿主强制成 oauth）。抛异常时带
      // signIn: 'expired' 表示「彻底没救了」，宿主会把账号标成需要重新登录；
      // 不带就只是这次续期失败，退避后再试。
      async refresh(auth) {
        const refreshToken = String(auth?.refresh ?? auth?.metadata?.firebaseRefreshToken ?? '').trim()
        if (!refreshToken) return undefined

        const result = await renewSession({
          refreshToken,
          verify: async (cookie) => (await verifyCookie(cookie)).ok,
        })
        if (!result.ok) {
          const error = new Error(result.error ?? '续期失败')
          if (result.expired) error.signIn = 'expired'
          throw error
        }

        return {
          access: result.cookie,
          refresh: result.refreshToken,
          expires: result.expiresAt,
          metadata: {
            ...(auth?.metadata ?? {}),
            cookie: result.cookie,
            firebaseRefreshToken: result.refreshToken,
            apiKey: result.apiKey,
          },
        }
      },

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
          const cookie = resolveCheckinCookie(auth)
          if (cookie) return await webCreditsUsage({ cookie })
          const key = typeof auth?.key === 'string' ? auth.key.trim() : ''
          if (key) return await breezeBalance(key)
          return { plan: BALANCE_PLAN, windows: [], error: '请登录 Breeze 网页账号或配置 API key 后查询积分' }
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

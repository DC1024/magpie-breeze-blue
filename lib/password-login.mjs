// 用 Breeze 的邮箱密码换会话 cookie —— 不启动浏览器、也不用用户复制任何东西。
//
// 这条链路是 2026-11 实测出来的（不是文档，全凭探测）：
//   1. GET  https://breezeblue.ai/api/config          公开配置，里面有 firebase_api_key
//   2. POST identitytoolkit …:signInWithPassword      Firebase 直连。实测返回
//      INVALID_LOGIN_CREDENTIALS 而不是 MISSING_RECAPTCHA_TOKEN，说明**不要验证码**
//   3. POST https://breezeblue.ai/api/auth/firebase   {idToken} → Set-Cookie 会话
//   4. GET  /api/credits/summary                      验一次，确认这把 cookie 真能用
//
// 另一条路 `/api/auth/email/continue` 没走：它的分支对不存在的邮箱会返回
// AUTH_SIGNUP_VERIFICATION_REQUIRED + Cloudflare Turnstile 的 site_key，
// 注册要人机验证；而第 2 步的 Firebase 通道干净得多。
//
// 密码只在这几个函数的内存里过一遍，不写盘、不进日志：
// 宿主 save() 的 oauth 分支只持久化我们 return 的字段，prompts 的输入不留档
// （internal/plugin/host.js 的 plainAnswers 只存 select 类型的答案）。

import { BREEZE_WEB_BASE_URL } from './checkin.mjs'

const IDENTITY_BASE = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword'
const REFRESH_URL = 'https://securetoken.googleapis.com/v1/token'

// 与 checkin.mjs 用同一个 UA，Breeze 侧看到的是同一种客户端。
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// Firebase 的错误码翻成人话。这张表是对着真实响应写的，别凭印象加。
const AUTH_ERRORS = {
  INVALID_LOGIN_CREDENTIALS: '邮箱或密码不对（Breeze 用 Firebase，不区分是哪个错）',
  EMAIL_NOT_FOUND: '这个邮箱没有注册过 Breeze',
  INVALID_PASSWORD: '密码不对',
  USER_DISABLED: '这个账号已被停用',
  TOO_MANY_ATTEMPTS_TRY_LATER: '试错次数太多，Firebase 暂时锁了这个来源，等一会儿再试',
  PASSWORD_LOGIN_DISABLED: 'Breeze 关掉了邮箱密码登录，请改用「浏览器登录」',
  OPERATION_NOT_ALLOWED: 'Breeze 关掉了邮箱密码登录，请改用「浏览器登录」',
  MISSING_RECAPTCHA_TOKEN: '这次登录要求人机验证，这个方式走不通，请改用「浏览器登录」',
  RECAPTCHA_REQUIRED: '这次登录要求人机验证，这个方式走不通，请改用「浏览器登录」',
  // securetoken 刷新接口的
  INVALID_REFRESH_TOKEN: '续期凭据失效了，需要重新登录一次',
  TOKEN_EXPIRED: '续期凭据过期了，需要重新登录一次',
  USER_NOT_FOUND: '这个账号已经不存在了',
}

function firebaseMessage(payload) {
  const raw = payload?.error?.message ?? payload?.error ?? ''
  return typeof raw === 'string' ? raw.split(' : ')[0].trim() : ''
}

function describe(code) {
  return AUTH_ERRORS[code] ?? (code ? `Breeze 返回 ${code}` : '登录失败')
}

function withTimeout(ms) {
  return ms > 0 && typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

// JSON 请求 + 统一的错误出口。返回 {status, payload}。
async function requestJson(url, init, timeoutMs, fetchImpl) {
  const signal = withTimeout(timeoutMs)
  const response = await fetchImpl(url, { ...init, ...(signal ? { signal } : {}) })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { response, payload }
}

// Set-Cookie 列表 → 一行 Cookie 头。
// 两个坑：① 同一条 Set-Cookie 可能重复下发（后者胜）；② Max-Age=0 / 过期的 Expires
// 是在删 cookie，不能当成有效值收进来，否则会把刚种下的会话又覆盖成空。
export function cookiesFromSetCookie(lines, domain = 'breezeblue.ai') {
  const jar = new Map()
  for (const line of Array.isArray(lines) ? lines : []) {
    const parts = String(line).split(';')
    const pair = parts.shift() ?? ''
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!name) continue

    let keep = true
    let host = ''
    for (const attr of parts) {
      const [rawKey, ...rest] = attr.split('=')
      const key = String(rawKey ?? '').trim().toLowerCase()
      const val = rest.join('=').trim()
      if (key === 'domain') host = val.replace(/^\./, '').toLowerCase()
      if (key === 'max-age' && Number(val) <= 0) keep = false
      if (key === 'expires') {
        const at = Date.parse(val)
        if (Number.isFinite(at) && at <= Date.now()) keep = false
      }
    }
    // 只收目标域（和不写 Domain 的宿主 cookie）
    if (host && host !== domain && !host.endsWith('.' + domain)) continue
    if (!keep) {
      jar.delete(name)
      continue
    }
    jar.set(name, value)
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

// 会话 cookie 的到期时间：取 Set-Cookie 里最靠后的 Max-Age / Expires。
// 都没有（session cookie）就给一个保守值，让宿主的 refresh 钩子定期来续。
export function expiryFromSetCookie(lines, fallbackMs = 6 * 3600 * 1000) {
  let at = 0
  for (const line of Array.isArray(lines) ? lines : []) {
    for (const attr of String(line).split(';').slice(1)) {
      const [rawKey, ...rest] = attr.split('=')
      const key = String(rawKey ?? '').trim().toLowerCase()
      const val = rest.join('=').trim()
      if (key === 'max-age') {
        const secs = Number(val)
        if (Number.isFinite(secs) && secs > 0) at = Math.max(at, Date.now() + secs * 1000)
      }
      if (key === 'expires') {
        const t = Date.parse(val)
        if (Number.isFinite(t) && t > Date.now()) at = Math.max(at, t)
      }
    }
  }
  return at || Date.now() + fallbackMs
}

function setCookieList(response) {
  const headers = response?.headers
  if (!headers) return []
  if (typeof headers.getSetCookie === 'function') {
    const list = headers.getSetCookie()
    if (Array.isArray(list) && list.length) return list
  }
  const flat = headers.get?.('set-cookie') ?? ''
  if (!flat) return []
  // 老运行时不给 getSetCookie 时只能猜：只在「, 名字=」处切，别切 Expires 里的逗号
  return flat.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/).map((s) => s.trim())
}

// GET /api/config —— 公开的认证配置。每次登录/续期都重新取，key 换了也不怕。
export async function loadAuthConfig(options = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = options
  const { response, payload } = await requestJson(
    `${BREEZE_WEB_BASE_URL}/api/config`,
    { method: 'GET', headers: { accept: 'application/json', 'user-agent': USER_AGENT } },
    timeoutMs,
    fetchImpl,
  )
  if (!response.ok || !payload) {
    throw new Error(`取 Breeze 配置失败：HTTP ${response.status}`)
  }
  const apiKey = String(payload.firebase_api_key ?? '').trim()
  if (!apiKey) throw new Error('Breeze 配置里没有 firebase_api_key，可能改版了')
  return {
    apiKey,
    projectId: String(payload.firebase_project_id ?? ''),
    authDomain: String(payload.firebase_auth_domain ?? ''),
    authEnabled: payload.auth_enabled !== false,
  }
}

// 第 2 步：拿邮箱密码换 Firebase 的 idToken。
export async function firebaseSignIn(options = {}) {
  const { apiKey, email, password, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = options
  if (!apiKey) return { ok: false, error: '缺少 firebase_api_key' }
  if (!email) return { ok: false, error: '请输入邮箱' }
  if (!password) return { ok: false, error: '请输入密码' }

  let out
  try {
    out = await requestJson(
      `${IDENTITY_BASE}?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          origin: BREEZE_WEB_BASE_URL,
          referer: `${BREEZE_WEB_BASE_URL}/auth/login`,
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
      timeoutMs,
      fetchImpl,
    )
  } catch (error) {
    return { ok: false, error: `连不上 Firebase：${error?.message ?? error}` }
  }

  const { response, payload } = out
  if (!response.ok || !payload?.idToken) {
    const code = firebaseMessage(payload)
    return { ok: false, error: describe(code), code }
  }
  return {
    ok: true,
    idToken: payload.idToken,
    refreshToken: String(payload.refreshToken ?? ''),
    localId: String(payload.localId ?? ''),
    email: String(payload.email ?? email),
  }
}

// 第 3 步：idToken 换 Breeze 自己的会话 cookie。
// 前端也是这么干的（chunk 里 loginWithFirebase 只 POST {idToken}，JS 侧不存任何 token），
// 所以会话只能是从 Set-Cookie 下来的。
export async function exchangeSession(options = {}) {
  const { idToken, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = options
  if (!idToken) return { ok: false, error: '缺少 idToken' }

  let out
  try {
    out = await requestJson(
      `${BREEZE_WEB_BASE_URL}/api/auth/firebase`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          origin: BREEZE_WEB_BASE_URL,
          referer: `${BREEZE_WEB_BASE_URL}/auth/login`,
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({ idToken }),
      },
      timeoutMs,
      fetchImpl,
    )
  } catch (error) {
    return { ok: false, error: `连不上 Breeze：${error?.message ?? error}` }
  }

  const { response, payload } = out
  const lines = setCookieList(response)
  const cookie = cookiesFromSetCookie(lines)

  if (!response.ok) {
    const code = String(payload?.code ?? payload?.error ?? firebaseMessage(payload) ?? '')
    if (code === 'AUTH_SIGNUP_VERIFICATION_REQUIRED') {
      return {
        ok: false,
        error: '这个账号在 Breeze 侧还没建档（Firebase 认得，Breeze 不认）。请先用「浏览器登录」在网页上完成一次注册/人机验证。',
        code,
      }
    }
    return { ok: false, error: describe(code) || `Breeze 拒绝了这次登录：HTTP ${response.status}`, code }
  }

  if (!cookie) {
    // 走到这里说明「idToken 换会话」的形式和预期不一样，需要看实际回了什么。
    // 只报字段名，不报值：里面可能有 token。
    const keys = payload && typeof payload === 'object' ? Object.keys(payload).join(', ') : '（非 JSON）'
    return {
      ok: false,
      error: `Breeze 接受了登录但没下发会话 cookie（响应字段：${keys || '空'}）。请把这条报给插件维护者。`,
      code: 'NO_SESSION_COOKIE',
    }
  }

  return { ok: true, cookie, expiresAt: expiryFromSetCookie(lines), payload }
}

// 续期：refreshToken → 新 idToken（可能同时换新 refreshToken）→ 新会话 cookie。
// 目标是让账号「一次登录，长期有效」，不必过几天让用户重填密码。
export async function renewFirebaseToken(options = {}) {
  const { apiKey, refreshToken, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = options
  if (!apiKey) return { ok: false, error: '缺少 firebase_api_key' }
  if (!refreshToken) return { ok: false, error: '没有续期凭据' }

  let out
  try {
    out = await requestJson(
      `${REFRESH_URL}?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
      },
      timeoutMs,
      fetchImpl,
    )
  } catch (error) {
    return { ok: false, error: `续期请求失败：${error?.message ?? error}` }
  }

  const { response, payload } = out
  if (!response.ok || !payload?.id_token) {
    const code = firebaseMessage(payload)
    return { ok: false, error: describe(code), code, expired: /REFRESH_TOKEN|TOKEN_EXPIRED|USER_NOT_FOUND/.test(code) }
  }
  return {
    ok: true,
    idToken: payload.id_token,
    refreshToken: String(payload.refresh_token ?? refreshToken),
  }
}

// 一条龙：配置 → 密码登录 → 换会话 → 验一次。给 index.mjs 的 authorize 用。
// 失败不抛异常，返回 {ok:false, error}，让调用方决定怎么呈现。
export async function loginWithPassword(options = {}) {
  const {
    email,
    password,
    fetchImpl = globalThis.fetch,
    verify,
    timeoutMs = 20000,
    log = () => {},
  } = options

  const mail = String(email ?? '').trim()
  if (!mail) return { ok: false, error: '请输入 Breeze 账号邮箱' }
  if (!password) return { ok: false, error: '请输入 Breeze 账号密码' }

  try {
    const config = await loadAuthConfig({ fetchImpl, timeoutMs })
    if (!config.authEnabled) {
      return { ok: false, error: 'Breeze 当前关闭了账号登录（auth_enabled=false）' }
    }
    log('config loaded')

    const signIn = await firebaseSignIn({ apiKey: config.apiKey, email: mail, password, fetchImpl, timeoutMs })
    if (!signIn.ok) return { ok: false, error: signIn.error, code: signIn.code }
    log('firebase sign-in ok')

    const session = await exchangeSession({ idToken: signIn.idToken, fetchImpl, timeoutMs })
    if (!session.ok) return { ok: false, error: session.error, code: session.code }
    log('session cookie received')

    if (typeof verify === 'function') {
      let accepted = false
      try {
        accepted = await verify(session.cookie)
      } catch {
        accepted = false
      }
      if (!accepted) {
        return {
          ok: false,
          error: 'Breeze 发了会话 cookie，但拿它读不到额度 —— 可能改版了，请改用「浏览器登录」并把这条报给维护者。',
          code: 'COOKIE_UNUSABLE',
        }
      }
    }

    return {
      ok: true,
      cookie: session.cookie,
      expiresAt: session.expiresAt,
      apiKey: config.apiKey,
      refreshToken: signIn.refreshToken,
      user: signIn.email || mail,
      localId: signIn.localId,
    }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}

// 续期一条龙：给 auth.refresh 钩子用。返回新的 cookie / expiresAt / refreshToken。
export async function renewSession(options = {}) {
  const { refreshToken, fetchImpl = globalThis.fetch, verify, timeoutMs = 20000 } = options
  if (!refreshToken) return { ok: false, error: '没有续期凭据', expired: true }

  try {
    const config = await loadAuthConfig({ fetchImpl, timeoutMs })
    const renewed = await renewFirebaseToken({ apiKey: config.apiKey, refreshToken, fetchImpl, timeoutMs })
    if (!renewed.ok) return renewed

    const session = await exchangeSession({ idToken: renewed.idToken, fetchImpl, timeoutMs })
    if (!session.ok) return session

    if (typeof verify === 'function') {
      let accepted = false
      try {
        accepted = await verify(session.cookie)
      } catch {
        accepted = false
      }
      if (!accepted) return { ok: false, error: '续期后的会话读不到额度', expired: true }
    }

    return {
      ok: true,
      cookie: session.cookie,
      expiresAt: session.expiresAt,
      apiKey: config.apiKey,
      refreshToken: renewed.refreshToken,
    }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}

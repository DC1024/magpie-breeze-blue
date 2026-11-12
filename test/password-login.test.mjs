// lib/password-login.mjs 的纯逻辑：Set-Cookie 解析、到期时间、错误翻译、续期。
// 全部注入 fetch，不访问真实网络。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cookiesFromSetCookie,
  exchangeSession,
  expiryFromSetCookie,
  firebaseSignIn,
  loadAuthConfig,
  loginWithPassword,
  renewFirebaseToken,
  renewSession,
} from '../lib/password-login.mjs'

// 造一个只会按脚本回答的 fetch。routes 是 [匹配函数, 响应] 或 [匹配函数, 函数]。
function stub(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, method: init.method ?? 'GET', body: init.body, headers: init.headers ?? {} })
    for (const [match, reply] of routes) {
      if (match(u, init)) {
        const r = typeof reply === 'function' ? await reply(u, init) : reply
        return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}), {
          status: r.status ?? 200,
          headers: r.headers ?? { 'content-type': 'application/json' },
        })
      }
    }
    throw new Error(`unexpected request: ${u}`)
  }
  return { impl, calls }
}

const isConfig = (u) => u.endsWith('/api/config')
const isIdentity = (u) => u.includes('identitytoolkit')
const isExchange = (u) => u.endsWith('/api/auth/firebase')
const isRefresh = (u) => u.includes('securetoken')

test('cookiesFromSetCookie 合并多条并去掉无效的', () => {
  const header = cookiesFromSetCookie([
    'breeze_session=abc; Path=/; HttpOnly; Max-Age=3600',
    'breeze_uid=u1; Path=/; Max-Age=3600',
    // 删除指令：同名 cookie 的 Max-Age=0 不该留下
    'breeze_stale=; Path=/; Max-Age=0',
    'other=1; Domain=example.com; Path=/',
  ])
  assert.equal(header, 'breeze_session=abc; breeze_uid=u1')
})

test('cookiesFromSetCookie 认过期的 Expires', () => {
  const header = cookiesFromSetCookie([
    'a=1; Path=/',
    'b=2; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
  ])
  assert.equal(header, 'a=1')
})

test('cookiesFromSetCookie 空输入不炸', () => {
  assert.equal(cookiesFromSetCookie([]), '')
  assert.equal(cookiesFromSetCookie(null), '')
  assert.equal(cookiesFromSetCookie(['garbage']), '')
  assert.equal(cookiesFromSetCookie(['=noName; Path=/']), '')
})

test('cookiesFromSetCookie 接受子域但与目标域无关的丢弃', () => {
  const header = cookiesFromSetCookie(['s=1; Domain=.breezeblue.ai; Path=/', 'x=2; Domain=evil.com; Path=/'])
  assert.equal(header, 's=1')
})

test('expiryFromSetCookie 取最晚的那个，缺省给保守值', () => {
  const now = Date.now()
  const withAge = expiryFromSetCookie(['s=1; Max-Age=3600'])
  assert.ok(withAge > now + 3000 * 1000 && withAge < now + 3700 * 1000, String(withAge - now))

  const withExpires = expiryFromSetCookie(['s=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT'])
  assert.equal(withExpires, Date.parse('Wed, 01 Jan 2031 00:00:00 GMT'))

  const both = expiryFromSetCookie(['s=1; Max-Age=60', 's=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT'])
  assert.equal(both, Date.parse('Wed, 01 Jan 2031 00:00:00 GMT'))

  // session cookie 没有到期信息：给 fallback（默认 6 小时）
  const fallback = expiryFromSetCookie(['s=1; Path=/'])
  assert.ok(fallback > now + 5.9 * 3600 * 1000 && fallback < now + 6.1 * 3600 * 1000)
  assert.equal(expiryFromSetCookie(['s=1'], 1000) - now < 2000, true)
})

test('loadAuthConfig 取 firebase_api_key 与开关', async () => {
  const s = stub([[isConfig, { body: { firebase_api_key: 'KEY', firebase_project_id: 'p', auth_enabled: true } }]])
  const c = await loadAuthConfig({ fetchImpl: s.impl })
  assert.equal(c.apiKey, 'KEY')
  assert.equal(c.authEnabled, true)

  const off = stub([[isConfig, { body: { firebase_api_key: 'K', auth_enabled: false } }]])
  assert.equal((await loadAuthConfig({ fetchImpl: off.impl })).authEnabled, false)

  const none = stub([[isConfig, { body: {} }]])
  await assert.rejects(() => loadAuthConfig({ fetchImpl: none.impl }), /firebase_api_key/)
})

test('firebaseSignIn 成功时带 returnSecureToken', async () => {
  const s = stub([[isIdentity, { body: { idToken: 'ID', refreshToken: 'RT', localId: 'L', email: 'a@b.c' } }]])
  const r = await firebaseSignIn({ apiKey: 'K', email: 'a@b.c', password: 'pw', fetchImpl: s.impl })
  assert.equal(r.ok, true)
  assert.equal(r.idToken, 'ID')
  assert.equal(r.refreshToken, 'RT')
  assert.equal(JSON.parse(s.calls[0].body).returnSecureToken, true)
})

test('firebaseSignIn 把 Firebase 错误码翻成人话', async () => {
  const cases = [
    ['INVALID_LOGIN_CREDENTIALS', /邮箱或密码不对/],
    ['TOO_MANY_ATTEMPTS_TRY_LATER', /试错次数太多/],
    ['USER_DISABLED', /停用/],
    ['MISSING_RECAPTCHA_TOKEN', /人机验证/],
  ]
  for (const [code, re] of cases) {
    const s = stub([[isIdentity, { status: 400, body: { error: { message: code } } }]])
    const r = await firebaseSignIn({ apiKey: 'K', email: 'a@b.c', password: 'pw', fetchImpl: s.impl })
    assert.equal(r.ok, false)
    assert.match(r.error, re, code)
    assert.equal(r.code, code)
  }
})

test('exchangeSession 从 Set-Cookie 拼出会话', async () => {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.append('set-cookie', 'breeze_session=s1; Path=/; HttpOnly; Max-Age=7200')
  headers.append('set-cookie', 'breeze_uid=u1; Path=/; Max-Age=7200')
  const s = stub([[isExchange, { body: { ok: true, user: { id: 'u1' } }, headers }]])
  const r = await exchangeSession({ idToken: 'ID', fetchImpl: s.impl })
  assert.equal(r.ok, true)
  assert.equal(r.cookie, 'breeze_session=s1; breeze_uid=u1')
  assert.ok(r.expiresAt > Date.now() + 7000 * 1000)
  // 必须带 Origin，Breeze 会校验
  assert.equal(s.calls[0].headers.origin, 'https://breezeblue.ai')
  assert.equal(JSON.parse(s.calls[0].body).idToken, 'ID')
})

test('exchangeSession 没回 cookie 时说清字段名', async () => {
  const s = stub([[isExchange, { body: { ok: true, access_token: 'x', token_type: 'bearer' } }]])
  const r = await exchangeSession({ idToken: 'ID', fetchImpl: s.impl })
  assert.equal(r.ok, false)
  assert.match(r.error, /没下发会话 cookie/)
  assert.match(r.error, /access_token/)
  // 不能把值漏进错误里
  assert.doesNotMatch(r.error, /\bbearer\b/)
})

test('exchangeSession 认出「Breeze 侧没建档」', async () => {
  const s = stub([[isExchange, { status: 403, body: { code: 'AUTH_SIGNUP_VERIFICATION_REQUIRED' } }]])
  const r = await exchangeSession({ idToken: 'ID', fetchImpl: s.impl })
  assert.equal(r.ok, false)
  assert.match(r.error, /还没建档/)
})

test('renewFirebaseToken 用 form 表单换新 idToken', async () => {
  const s = stub([[isRefresh, { body: { id_token: 'ID2', refresh_token: 'RT2' } }]])
  const r = await renewFirebaseToken({ apiKey: 'K', refreshToken: 'RT', fetchImpl: s.impl })
  assert.equal(r.ok, true)
  assert.equal(r.idToken, 'ID2')
  assert.equal(r.refreshToken, 'RT2')
  assert.match(String(s.calls[0].body), /grant_type=refresh_token/)
})

test('renewFirebaseToken 认「凭据作废」', async () => {
  const s = stub([[isRefresh, { status: 400, body: { error: { message: 'INVALID_REFRESH_TOKEN' } } }]])
  const r = await renewFirebaseToken({ apiKey: 'K', refreshToken: 'RT', fetchImpl: s.impl })
  assert.equal(r.ok, false)
  assert.equal(r.expired, true)
  assert.match(r.error, /重新登录/)
})

test('loginWithPassword 一条龙：配置 → 登录 → 换会话 → 校验', async () => {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.append('set-cookie', 'breeze_session=s2; Path=/; Max-Age=3600')
  const s = stub([
    [isConfig, { body: { firebase_api_key: 'K', auth_enabled: true } }],
    [isIdentity, { body: { idToken: 'ID', refreshToken: 'RT', localId: 'L', email: 'a@b.c' } }],
    [isExchange, { body: { ok: true }, headers }],
  ])
  const verified = []
  const r = await loginWithPassword({
    email: ' a@b.c ',
    password: 'pw',
    fetchImpl: s.impl,
    verify: async (cookie) => {
      verified.push(cookie)
      return true
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.cookie, 'breeze_session=s2')
  assert.equal(r.refreshToken, 'RT')
  assert.equal(r.apiKey, 'K')
  assert.equal(r.user, 'a@b.c')
  assert.deepEqual(verified, ['breeze_session=s2'])
})

test('loginWithPassword 缺邮箱/密码时直接拒绝，不打网络', async () => {
  const s = stub([])
  assert.match((await loginWithPassword({ password: 'x', fetchImpl: s.impl })).error, /邮箱/)
  assert.match((await loginWithPassword({ email: 'a@b.c', fetchImpl: s.impl })).error, /密码/)
  assert.equal(s.calls.length, 0)
})

test('loginWithPassword 在校验不通过时明确报「cookie 用不了」', async () => {
  const headers = new Headers()
  headers.append('set-cookie', 'breeze_session=s3; Path=/; Max-Age=3600')
  const s = stub([
    [isConfig, { body: { firebase_api_key: 'K', auth_enabled: true } }],
    [isIdentity, { body: { idToken: 'ID', refreshToken: 'RT' } }],
    [isExchange, { body: { ok: true }, headers }],
  ])
  const r = await loginWithPassword({
    email: 'a@b.c',
    password: 'pw',
    fetchImpl: s.impl,
    verify: async () => false,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'COOKIE_UNUSABLE')
})

test('renewSession 把新 cookie 与轮换后的 refresh token 一起给出', async () => {
  const headers = new Headers()
  headers.append('set-cookie', 'breeze_session=s9; Path=/; Max-Age=1800')
  const s = stub([
    [isConfig, { body: { firebase_api_key: 'K2', auth_enabled: true } }],
    [isRefresh, { body: { id_token: 'ID9', refresh_token: 'RT9' } }],
    [isExchange, { body: { ok: true }, headers }],
  ])
  const r = await renewSession({ refreshToken: 'RT', fetchImpl: s.impl, verify: async () => true })
  assert.equal(r.ok, true)
  assert.equal(r.cookie, 'breeze_session=s9')
  assert.equal(r.refreshToken, 'RT9')
  assert.equal(r.apiKey, 'K2', '续期时也要用最新的 apiKey')
})

test('renewSession 没有 refresh token 时明确失败', async () => {
  const r = await renewSession({ fetchImpl: async () => new Response('{}') })
  assert.equal(r.ok, false)
  assert.equal(r.expired, true)
})

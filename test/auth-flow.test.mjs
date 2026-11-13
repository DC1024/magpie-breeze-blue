// index.mjs 里 auth 方法的接线契约。
//
// 这里守三件事：
//   1. 邮箱密码方法排在第一位，且是「不开页面、不粘东西」的 auto 流程；
//   2. 粘贴方法仍然是 opened:false + method:'code'（登录页由 magpie 开在用户浏览器里，
//      见 internal/gui/assets/app.js 的 openSignInPage）——防止退回 v0.5.0 的隧道方案；
//   3. 只有带 refresh token 的账号才写 expires，否则宿主会去续期一个没凭据可续的账号。
import test from 'node:test'
import assert from 'node:assert/strict'

import plugin from '../index.mjs'
import { LOGIN_PAGE_URL } from '../lib/browser-login.mjs'

async function hooks() {
  return await plugin()
}

// 按 label 找方法，别用下标：方法顺序以后还会变。
function methodOf(auth, label) {
  const m = auth.methods.find((x) => String(x.label ?? '').includes(label))
  assert.ok(m, `找不到「${label}」方法，现有：${auth.methods.map((x) => x.label).join(' / ')}`)
  return m
}

// 一个按路径分发的假 fetch，同时覆盖插件自己的请求和 verifyCookie 的。
function stubFetch(routes) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, method: init.method ?? 'GET', body: init.body })
    for (const [match, reply] of routes) {
      if (match(u)) {
        const r = typeof reply === 'function' ? await reply(u, init) : reply
        return new Response(JSON.stringify(r.body ?? {}), {
          status: r.status ?? 200,
          headers: r.headers ?? { 'content-type': 'application/json' },
        })
      }
    }
    throw new Error(`unexpected request: ${u}`)
  }
  return { calls, restore: () => { globalThis.fetch = real } }
}

function cookieHeaders(...lines) {
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const line of lines) headers.append('set-cookie', line)
  return headers
}

const isConfig = (u) => u.endsWith('/api/config')
const isIdentity = (u) => u.includes('identitytoolkit')
const isExchange = (u) => u.endsWith('/api/auth/firebase')
const isSummary = (u) => u.endsWith('/api/credits/summary')
const isClaim = (u) => u.endsWith('/api/credits/daily-claim')
const isRefresh = (u) => u.includes('securetoken')

// ---------- 方法清单 ----------

test('邮箱密码排第一，旧的三种都还在', async () => {
  const { auth } = await hooks()
  assert.match(String(auth.methods[0].label), /密码/)
  for (const label of ['浏览器登录', '本机自动', '直接粘贴']) {
    methodOf(auth, label)
  }
  // API key 那条是给 TTS 用的，不能丢（丢了 loader 取不到 auth.key，TTS 直接 401）
  const api = auth.methods.filter((m) => m.type === 'api')
  assert.equal(api.length, 1)
  assert.match(String(api[0].label), /API key/)
})

test('邮箱密码方法提供的两个问题里，密码是掩码类型', async () => {
  const { auth } = await hooks()
  const m = methodOf(auth, '密码')
  assert.equal(m.type, 'oauth')
  assert.equal(m.prompts.length, 2)
  assert.equal(m.prompts[0].key, 'email')
  assert.equal(m.prompts[1].key, 'password')
  // magpie 自己的 prompt 类型；写成 text 密码就会明文显示
  assert.equal(m.prompts[1].type, 'password')
  // 校验器要真的拦住空值
  assert.equal(m.prompts[1].validate('  '), '请输入密码')
  assert.equal(m.prompts[1].validate('x'), undefined)
  assert.ok(m.prompts[0].validate('no-at-sign'))
  assert.equal(m.prompts[0].validate('a@b.c'), undefined)
})

// ---------- 邮箱密码在线路里的形状 ----------

test('邮箱密码登录成功后交出带续期凭据的账号，且不打开任何页面', async () => {
  const { auth } = await hooks()
  const m = methodOf(auth, '密码')

  const s = stubFetch([
    [isConfig, { body: { firebase_api_key: 'K', auth_enabled: true } }],
    [isIdentity, { body: { idToken: 'ID', refreshToken: 'RT', localId: 'L', email: 'a@b.c' } }],
    [isExchange, { body: { ok: true }, headers: cookieHeaders('breeze_session=s1; Path=/; Max-Age=7200', 'breeze_uid=u1; Path=/; Max-Age=7200') }],
    [isSummary, { body: { credits: 5 } }],
  ])
  try {
    const a = await m.authorize({ email: ' a@b.c ', password: 'pw' }, {})

    // 没有页面要开：url 空串，前端不会 window.open，也不会渲染「打开链接」
    assert.equal(a.url, '')
    assert.equal(a.opened, true)
    assert.equal(a.method, 'auto')
    assert.match(a.instructions, /a@b\.c/)

    const cred = await a.callback()
    assert.equal(cred.type, 'success')
    assert.equal(cred.access, 'breeze_session=s1; breeze_uid=u1')
    // 这两样是「能不能永不掉线」的关键
    assert.equal(cred.refresh, 'RT')
    assert.ok(cred.expires > Date.now() + 7000 * 1000)
    assert.equal(cred.metadata.cookie, 'breeze_session=s1; breeze_uid=u1')
    assert.equal(cred.metadata.firebaseRefreshToken, 'RT')
    assert.equal(cred.metadata.apiKey, 'K')
    // 密码一个字都不该出现在凭据里
    assert.doesNotMatch(JSON.stringify(cred), /"pw"/)
  } finally {
    s.restore()
  }
})

test('密码错时 authorize 直接抛，界面才能显示原因', async () => {
  const { auth } = await hooks()
  const m = methodOf(auth, '密码')
  const s = stubFetch([
    [isConfig, { body: { firebase_api_key: 'K', auth_enabled: true } }],
    [isIdentity, { status: 400, body: { error: { message: 'INVALID_LOGIN_CREDENTIALS' } } }],
  ])
  try {
    await assert.rejects(() => m.authorize({ email: 'a@b.c', password: 'wrong' }, {}), /邮箱或密码不对/)
  } finally {
    s.restore()
  }
})

test('换会话没拿到 cookie 时给出可上报的报错', async () => {
  const { auth } = await hooks()
  const m = methodOf(auth, '密码')
  const s = stubFetch([
    [isConfig, { body: { firebase_api_key: 'K', auth_enabled: true } }],
    [isIdentity, { body: { idToken: 'ID', refreshToken: 'RT' } }],
    [isExchange, { body: { ok: true, access_token: 'secret-ish' } }],
  ])
  try {
    await assert.rejects(() => m.authorize({ email: 'a@b.c', password: 'pw' }, {}), /没下发会话 cookie/)
  } finally {
    s.restore()
  }
})

// ---------- 续期钩子 ----------

test('refresh 钩子用 refresh token 换新 cookie 并轮换凭据', async () => {
  const { auth } = await hooks()
  const s = stubFetch([
    [isConfig, { body: { firebase_api_key: 'K2', auth_enabled: true } }],
    [isRefresh, { body: { id_token: 'ID9', refresh_token: 'RT9' } }],
    [isExchange, { body: { ok: true }, headers: cookieHeaders('breeze_session=s9; Path=/; Max-Age=1800') }],
    [isSummary, { body: { credits: 1 } }],
  ])
  try {
    const kept = await auth.refresh({
      type: 'oauth',
      access: 'breeze_session=old',
      refresh: 'RT',
      expires: Date.now(),
      metadata: { cookie: 'breeze_session=old', user: 'a@b.c' },
    })
    assert.equal(kept.access, 'breeze_session=s9')
    assert.equal(kept.refresh, 'RT9')
    assert.ok(kept.expires > Date.now())
    // metadata 要合并，别把 user 之类的旧字段冲掉
    assert.equal(kept.metadata.user, 'a@b.c')
    assert.equal(kept.metadata.cookie, 'breeze_session=s9')
  } finally {
    s.restore()
  }
})

test('没有 refresh token 的账号不该被续期', async () => {
  const { auth } = await hooks()
  const kept = await auth.refresh({ type: 'oauth', access: 'sid=x', refresh: '', metadata: { cookie: 'sid=x' } })
  assert.equal(kept, undefined)
})

test('续期凭据作废时抛 signIn:expired，宿主才会标记重新登录', async () => {
  const { auth } = await hooks()
  const s = stubFetch([
    [isConfig, { body: { firebase_api_key: 'K', auth_enabled: true } }],
    [isRefresh, { status: 400, body: { error: { message: 'INVALID_REFRESH_TOKEN' } } }],
  ])
  try {
    await assert.rejects(
      () => auth.refresh({ type: 'oauth', access: 's', refresh: 'RT', expires: Date.now() }),
      (error) => error.signIn === 'expired' && /重新登录/.test(error.message),
    )
  } finally {
    s.restore()
  }
})

// ---------- 浏览器登录（粘贴）仍保持原契约 ----------

test('浏览器登录仍然是 magpie 开页面 + 粘贴框', async () => {
  const { auth } = await hooks()
  const m = methodOf(auth, '浏览器登录')
  const a = await m.authorize({}, {})
  assert.equal(a.opened, false, 'opened 必须是 false，登录页才会由 magpie 开在用户浏览器里')
  assert.equal(a.method, 'code')
  assert.equal(a.url, LOGIN_PAGE_URL)
  assert.match(a.instructions, /document\.cookie/)
  assert.equal(typeof a.callback, 'function')
})

test('粘贴有效 Cookie 存成账号，但不写 expires（没有凭据可续期）', async () => {
  const { auth } = await hooks()
  const m = methodOf(auth, '浏览器登录')
  const a = await m.authorize({}, {})
  const s = stubFetch([[isSummary, { body: { credits: 12 } }]])
  try {
    const cred = await a.callback('cookie: sid=abc; theme=dark')
    assert.equal(cred.type, 'success')
    assert.equal(cred.access, 'sid=abc; theme=dark')
    assert.equal(cred.metadata.cookie, 'sid=abc; theme=dark')
    // 有 expires 宿主就会去调 refresh，而粘贴来的账号没有 refresh token
    assert.equal('expires' in cred, false)
    assert.equal(cred.refresh, '', 'refresh 字段必须存在，否则宿主不会存成 oauth 账号')
  } finally {
    s.restore()
  }
})

test('粘贴的 Cookie 无效时抛错', async () => {
  const { auth } = await hooks()
  const a = await methodOf(auth, '浏览器登录').authorize({}, {})
  const s = stubFetch([[isSummary, { status: 401, body: {} }]])
  try {
    await assert.rejects(() => a.callback('sid=stale'), /无效|过期/)
  } finally {
    s.restore()
  }
})

test('粘贴空内容时直接拒绝，不打网络', async () => {
  const { auth } = await hooks()
  const a = await methodOf(auth, '浏览器登录').authorize({}, {})
  const s = stubFetch([[isSummary, { status: 200 }]])
  try {
    await assert.rejects(() => a.callback('   '), /Cookie/)
    assert.equal(s.calls.length, 0)
  } finally {
    s.restore()
  }
})

test('从 Cookies 表格整块复制的内容会被认出来并指路', async () => {
  const { auth } = await hooks()
  const a = await methodOf(auth, '浏览器登录').authorize({}, {})
  const s = stubFetch([[isSummary, { status: 200 }]])
  try {
    await assert.rejects(() => a.callback('sid\tabc\tbreezeblue.ai\t/\t2027-01-01'), /制表符|换行/)
    assert.equal(s.calls.length, 0)
  } finally {
    s.restore()
  }
})

test('本机自动模式标记 opened:true，避免 magpie 再开第二个窗口', async () => {
  const { auth } = await hooks()
  const m = methodOf(auth, '本机自动')
  const a = await m.authorize({}, { signal: { aborted: true } })
  assert.equal(a.opened, true)
  assert.equal(a.method, 'auto')
  const r = await a.callback()
  assert.equal(r.type, 'failed')
})

test('网页登录账号直接读取真实剩余积分和今日领取状态', async () => {
  const { auth } = await hooks()
  const s = stubFetch([[isSummary, { body: {
    balance: 3090.9, daily_claim_amount: 400, daily_claim_claimed_today: true,
    daily_claim_next_reset_at: '2026-11-14T00:00:00Z',
  } }]])
  try {
    const r = await auth.usage(async () => ({ type: 'oauth', access: 'sid=ok' }))
    assert.equal(r.windows[0].balance, 3090.9)
    assert.equal(r.windows[0].unit, '积分')
    assert.match(r.windows[1].display, /已领取.*400/)
    assert.match(r.windows[2].display, /08:00:00/)
    assert.equal(s.calls.length, 1)
  } finally { s.restore() }
})

test('零积分是有效余额，未领取时显示可领取，查询不触发领取', async () => {
  const { auth } = await hooks()
  const s = stubFetch([[isSummary, { body: {
    balance: 0, daily_claim_amount: 100, daily_claim_available: true, daily_claim_claimed_today: false,
  } }]])
  try {
    const r = await auth.usage(async () => ({ type: 'oauth', access: 'sid=ok' }))
    assert.equal(r.windows[0].balance, 0)
    assert.match(r.windows[1].display, /可领取.*100/)
    assert.equal(s.calls[0].method, 'GET')
  } finally { s.restore() }
})

// ---------- 签到 ----------

test('checkin 对只有 API key 的账号给出可照做的提示', async () => {
  const { auth } = await hooks()
  const r = await auth.checkin(async () => ({ type: 'api', key: 'brz_x' }))
  assert.equal(r.outcome, 'ineligible')
  assert.match(r.message, /网页登录/)
})

test('checkin 用会话 cookie 领取，401 变成需要重新登录', async () => {
  const { auth } = await hooks()
  // 领取打的是 daily-claim（POST），summary 只是登录时验一次 cookie，别搞混。
  const good = stubFetch([[isClaim, { body: { ok: true, credit: 30 } }]])
  try {
    const r = await auth.checkin(async () => ({ type: 'success', access: 'sid=ok', metadata: { cookie: 'sid=ok' } }))
    assert.equal(r.outcome, 'claimed')
    assert.equal(r.credit, 30)
  } finally {
    good.restore()
  }

  const bad = stubFetch([[isClaim, { status: 401, body: {} }]])
  try {
    const r = await auth.checkin(async () => ({ type: 'success', access: 'sid=old' }))
    // 不能用 failed：那会让宿主当天每 30 分钟重试一次
    assert.equal(r.signIn, 'expired')
  } finally {
    bad.restore()
  }
})

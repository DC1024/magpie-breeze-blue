// index.mjs 里 auth 方法的接线契约。
//
// 这组用例守的是 v0.6.0 的核心结论：**登录页由 magpie 打开，插件不 spawn 浏览器**。
// 网页版的 openSignInPage 是 window.open(url)，桌面版是系统浏览器
// （internal/gui/assets/app.js、internal/gui/api.go 的 openSignIn），
// 所以只要 authorize 把地址交回去、opened 留 false，页面就开在用户自己电脑上。
// 一旦有人把 opened 改成 true，NAS 部署就又变回「窗口开在 NAS 那块屏幕上」——这里会红。
import test from 'node:test'
import assert from 'node:assert/strict'

import plugin from '../index.mjs'
import { LOGIN_PAGE_URL } from '../lib/browser-login.mjs'

// 插件工厂是纯函数，每个用例拿一份新的 hooks。
async function hooks() {
  return await plugin()
}

// 把 globalThis.fetch 换成受控的桩，记下每次请求。
// verifyCookie 用的是默认的 globalThis.fetch，所以这里能拦住。
function stubFetch(reply) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} })
    const r = typeof reply === 'function' ? reply(String(url), init) : reply
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, restore: () => { globalThis.fetch = real } }
}

test('第一个登录方法是「magpie 打开登录页 + 粘贴」', async () => {
  const { auth } = await hooks()
  const m = auth.methods[0]
  assert.equal(m.type, 'oauth')

  const a = await m.authorize({}, {})
  // opened:false —— 交给 magpie 开在用户自己的浏览器里（网页版新标签页 / 桌面版系统浏览器）
  assert.equal(a.opened, false)
  // method:'code' —— 界面因此会给出一个输入框和提交按钮
  assert.equal(a.method, 'code')
  assert.equal(a.url, LOGIN_PAGE_URL)
  assert.match(a.instructions, /document\.cookie/)
  assert.equal(typeof a.callback, 'function')
})

test('粘贴有效 Cookie 存成会话凭据', async () => {
  const { auth } = await hooks()
  const m = auth.methods[0]
  const a = await m.authorize({}, {})

  const s = stubFetch({ status: 200, body: { credits: 12 } })
  try {
    const auth0 = await a.callback('cookie: sid=abc; theme=dark')
    assert.equal(auth0.type, 'success')
    // normalizeCookie 会剥掉 DevTools 里连 "cookie:" 一起复制进来的前缀
    assert.equal(auth0.access, 'sid=abc; theme=dark')
    assert.equal(auth0.metadata.cookie, 'sid=abc; theme=dark')
    assert.ok(auth0.expires > Date.now())
    // 真的把 cookie 发去校验了，而不是闭眼存下
    assert.equal(s.calls.length, 1)
    assert.match(s.calls[0].url, /\/api\/credits\/summary$/)
    assert.equal(s.calls[0].headers.cookie, 'sid=abc; theme=dark')
  } finally {
    s.restore()
  }
})

test('粘贴的 Cookie 无效时抛错，界面才会显示原因', async () => {
  const { auth } = await hooks()
  const a = await auth.methods[0].authorize({}, {})

  const s = stubFetch({ status: 401, body: { message: 'unauthenticated' } })
  try {
    await assert.rejects(() => a.callback('sid=stale'), /无效|过期/)
  } finally {
    s.restore()
  }
})

test('粘贴空内容时直接拒绝，不打网络', async () => {
  const { auth } = await hooks()
  const a = await auth.methods[0].authorize({}, {})

  const s = stubFetch({ status: 200 })
  try {
    await assert.rejects(() => a.callback('   '), /Cookie/)
    assert.equal(s.calls.length, 0)
  } finally {
    s.restore()
  }
})

// Application → Cookies 表格整块复制出来是制表符分隔的，不是 Cookie 头。
// 这条错误最容易发生（DevTools 里 Ctrl+A/Ctrl+C 就是它），提示必须指对地方。
test('从 Cookies 表格整块复制的内容会被认出来并指路', async () => {
  const { auth } = await hooks()
  const a = await auth.methods[0].authorize({}, {})

  const s = stubFetch({ status: 200 })
  try {
    await assert.rejects(() => a.callback('sid\tabc\tbreezeblue.ai\t/\t2027-01-01'), /制表符|换行/)
    assert.equal(s.calls.length, 0)
  } finally {
    s.restore()
  }
})

test('本机自动模式标记 opened:true，避免 magpie 再开第二个窗口', async () => {
  const { auth } = await hooks()
  const m = auth.methods[1]
  const ctx = { signal: { aborted: true } }
  const a = await m.authorize({}, ctx)
  assert.equal(a.opened, true)
  assert.equal(a.method, 'auto')
  // signal 已中止，callback 应当拿到一个失败结果而不是炸掉宿主
  const r = await a.callback()
  assert.equal(r.type, 'failed')
})

test('checkin 对只有 API key 的账号给出可照做的提示', async () => {
  const { auth } = await hooks()
  const r = await auth.checkin(async () => ({ type: 'api', key: 'brz_x' }))
  assert.equal(r.outcome, 'ineligible')
  assert.match(r.message, /网页登录/)
})

test('checkin 用会话 cookie 领取，401 变成需要重新登录', async () => {
  const { auth } = await hooks()
  const good = stubFetch({ status: 200, body: { credit: 30 } })
  try {
    const r = await auth.checkin(async () => ({ type: 'success', access: 'sid=ok', metadata: { cookie: 'sid=ok' } }))
    assert.equal(r.outcome, 'claimed')
    assert.equal(r.credit, 30)
  } finally {
    good.restore()
  }

  const bad = stubFetch({ status: 401, body: {} })
  try {
    const r = await auth.checkin(async () => ({ type: 'success', access: 'sid=old' }))
    // 不能用 failed：那会让宿主当天每 30 分钟重试一次，直到把账号锁死
    assert.equal(r.signIn, 'expired')
  } finally {
    bad.restore()
  }
})

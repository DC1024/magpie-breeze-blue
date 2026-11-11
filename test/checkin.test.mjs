import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildClaimRequest,
  claimDailyCredits,
  normalizeCookie,
  parseClaimPayload,
} from '../lib/checkin.mjs'

const COOKIE = 'session=abc123; other=xyz'

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('normalizeCookie 接受整行 cookie 头并拒绝多行', () => {
  assert.equal(normalizeCookie('cookie: a=1; b=2'), 'a=1; b=2')
  assert.equal(normalizeCookie('  a=1  '), 'a=1')
  assert.equal(normalizeCookie('a=1\r\nx: y'), null)
  assert.equal(normalizeCookie(''), null)
  assert.equal(normalizeCookie(undefined), null)
})

test('buildClaimRequest 打的是网页端 /api/credits/daily-claim，带同源头且不带鉴权头', () => {
  const { url, init } = buildClaimRequest(COOKIE)
  assert.equal(url, 'https://breezeblue.ai/api/credits/daily-claim')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.cookie, COOKIE)
  assert.equal(init.headers.origin, 'https://breezeblue.ai')
  assert.equal(init.headers.referer, 'https://breezeblue.ai/app/home')
  assert.ok(!('authorization' in init.headers))
  assert.ok(!('xi-api-key' in init.headers))
  assert.equal(init.body, undefined)
})

test('rewardTier 存在时才写 body', () => {
  const { init } = buildClaimRequest(COOKIE, { rewardTier: 2 })
  assert.deepEqual(JSON.parse(init.body), { reward_tier: 2 })
  assert.equal(init.headers['content-type'], 'application/json')
})

test('没有 cookie 时不发请求，直接 ineligible', async () => {
  let called = false
  const result = await claimDailyCredits({
    cookie: '',
    fetchImpl: async () => {
      called = true
      return jsonResponse(200, { ok: true })
    },
  })
  assert.equal(called, false)
  assert.equal(result.outcome, 'ineligible')
  assert.match(result.message, /cookie/)
})

test('成功领取映射成 claimed 并取出 credit/streak', async () => {
  const result = await claimDailyCredits({
    cookie: COOKIE,
    fetchImpl: async () => jsonResponse(200, { ok: true, credit: 20, streak: 3, message: 'ok' }),
  })
  assert.equal(result.outcome, 'claimed')
  assert.equal(result.credit, 20)
  assert.equal(result.streak, 3)
})

test('嵌套在 data 里的字段也能取到', () => {
  const parsed = parseClaimPayload({ ok: true, data: { credits: '15', streak_days: 7 } })
  assert.equal(parsed.credit, 15)
  assert.equal(parsed.streak, 7)
})

test('2xx 但字段未知时仍报 claimed，不编造 credit', async () => {
  const result = await claimDailyCredits({
    cookie: COOKIE,
    fetchImpl: async () => jsonResponse(200, { ok: true }),
  })
  assert.equal(result.outcome, 'claimed')
  assert.equal(result.credit, undefined)
})

test('已经领过映射成 done', async () => {
  const result = await claimDailyCredits({
    cookie: COOKIE,
    fetchImpl: async () => jsonResponse(200, { ok: false, code: 'ALREADY_CLAIMED', detail: '今天已领取' }),
  })
  assert.equal(result.outcome, 'done')
  assert.equal(result.message, '今天已领取')
})

test('401 会话失效报 ineligible（避免一天重试几十次）', async () => {
  const result = await claimDailyCredits({
    cookie: COOKIE,
    fetchImpl: async () =>
      jsonResponse(401, { ok: false, code: 'AUTH_REQUIRED', detail: 'Authentication required.' }),
  })
  assert.equal(result.outcome, 'ineligible')
  assert.match(result.message, /cookie/i)
})

test('429 与 5xx 报 failed，交给 Magpie 半小时后重试', async () => {
  for (const status of [429, 500, 503]) {
    const result = await claimDailyCredits({
      cookie: COOKIE,
      fetchImpl: async () => jsonResponse(status, { code: 'RATE_LIMITED', detail: 'too many' }),
    })
    assert.equal(result.outcome, 'failed', `status=${status}`)
  }
})

test('网络异常报 failed 且带上原因', async () => {
  const result = await claimDailyCredits({
    cookie: COOKIE,
    fetchImpl: async () => {
      throw new Error('ECONNRESET')
    },
  })
  assert.equal(result.outcome, 'failed')
  assert.match(result.message, /ECONNRESET/)
})

test('非 JSON 的 2xx 仍视为 claimed', async () => {
  const result = await claimDailyCredits({
    cookie: COOKIE,
    fetchImpl: async () => new Response('', { status: 200 }),
  })
  assert.equal(result.outcome, 'claimed')
})

test('返回值里不泄漏 cookie', async () => {
  const result = await claimDailyCredits({
    cookie: COOKIE,
    fetchImpl: async () => jsonResponse(500, { detail: 'boom' }),
  })
  assert.ok(!JSON.stringify(result).includes('abc123'))
})

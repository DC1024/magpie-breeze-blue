// Breeze Blue 每日积分领取的纯逻辑。
// 注意：这条链路用的是 Web 端会话 cookie，不是 /v1 的 API Key，两者不通用。
// 端点来自 breezeblue.ai 前端 bundle 的 claimDailyCredits 定义，无官方契约。

import { BALANCE_PLAN } from './breeze.mjs'

export const BREEZE_WEB_BASE_URL = 'https://breezeblue.ai'
export const DAILY_CLAIM_PATH = '/api/credits/daily-claim'
export const CREDITS_SUMMARY_PATH = '/api/credits/summary'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// 服务端认定「今天已经领过」的 code，逐个试，未知就靠 message 兜底。
const DONE_CODES = new Set([
  'ALREADY_CLAIMED',
  'DAILY_CLAIM_ALREADY_CLAIMED',
  'ALREADY_CHECKED_IN',
  'DAILY_CLAIM_TAKEN',
])

// 会话类失效：重试没有意义，settle 掉当天，等用户换 cookie。
const AUTH_CODES = new Set([
  'AUTH_REQUIRED',
  'UNAUTHENTICATED',
  'INVALID_SESSION',
  'SESSION_EXPIRED',
])

const CREDIT_KEYS = ['credits_issued', 'credit', 'credits', 'credit_amount', 'amount', 'reward', 'granted', 'daily_credit', 'value']
const STREAK_KEYS = ['streak', 'streak_days', 'continuous_days', 'days']

// 允许直接粘贴 DevTools 里整行 "cookie: xxx"，也允许只粘值。
export function normalizeCookie(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (!text) return null
  text = text.replace(/^cookie\s*:\s*/i, '')
  // 单行 cookie 里不该有换行，有就说明粘到了别的请求头
  if (/[\r\n]/.test(text)) return null
  return text || null
}

function pickNumber(source, keys) {
  if (!source || typeof source !== 'object') return undefined
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

// 实测奖励字段为 credits_issued；保留旧字段兼容，余额不当作本次奖励。
export function parseClaimPayload(payload) {
  const body = payload && typeof payload === 'object' ? payload : {}
  const nested = body.data && typeof body.data === 'object' ? body.data : body
  const result = {}
  const credit = pickNumber(nested, CREDIT_KEYS) ?? pickNumber(body, CREDIT_KEYS)
  const streak = pickNumber(nested, STREAK_KEYS) ?? pickNumber(body, STREAK_KEYS)
  if (credit !== undefined) result.credit = credit
  if (streak !== undefined) result.streak = streak
  const message = [body.message, body.detail, body.error].find((v) => typeof v === 'string' && v.trim())
  if (message) result.message = message.trim()
  return result
}

export function buildClaimRequest(cookie, options = {}) {
  const jar = normalizeCookie(cookie)
  if (!jar) return { error: 'cookie is empty' }
  const headers = {
    cookie: jar,
    accept: 'application/json, text/plain, */*',
    origin: BREEZE_WEB_BASE_URL,
    referer: `${BREEZE_WEB_BASE_URL}/app/home`,
    'user-agent': USER_AGENT,
  }
  const body = options.rewardTier === undefined || options.rewardTier === null
    ? undefined
    : JSON.stringify({ reward_tier: options.rewardTier })
  if (body) headers['content-type'] = 'application/json'
  return {
    url: BREEZE_WEB_BASE_URL + DAILY_CLAIM_PATH,
    init: { method: 'POST', headers, ...(body ? { body } : {}) },
  }
}

function outcomeForStatus(status) {
  if (status === 429) return 'failed'
  if (status >= 500) return 'failed'
  return 'failed'
}

// 网站自己那一天的边界：daily_claim_next_reset_at 是下一次重置的时刻，
// 减去 24 小时就是当前这一天的开始。Breeze 按 UTC 零点重置（北京时间 08:00），
// 而 Magpie 按北京时间零点记日子，两边错开 8 小时。
// 后果：Magpie 在北京时间 00:00 问「今天领了吗」，网站还在前一天，
// 答「已经领过」——那指的是昨天，今天这份要到 08:00 才存在。
function siteDay(body) {
  const reset = body?.daily_claim_next_reset_at
  if (typeof reset !== 'string') return null
  const end = Date.parse(reset)
  if (!Number.isFinite(end)) return null
  return { end, start: end - 86400000 }
}

// 现在这个时刻，网站的「一天」是不是还没跟上 Magpie 的北京日：
// 网站当天开始得比北京零点还早，说明它还停在 Magpie 认定的前一天里。
function siteDayBehind(day, now = Date.now()) {
  if (!day) return false
  const beijing = new Date(now + 8 * 3600000)
  const midnight = Date.UTC(
    beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate(),
  ) - 8 * 3600000
  return day.start < midnight
}

function beijingClock(ms) {
  return new Date(ms).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

// 返回 { outcome, credit?, streak?, message?, until? }
// outcome 取值必须是 Magpie 认的那几个：claimed / done / ineligible / inactive / captcha / failed。
// until 告诉 Magpie「到这个时候再来问一次」，这是跨日错位的解药：
// 两边日切时刻不同，不给 until 就会把昨天的答案一直当成今天已签。
export async function claimDailyCredits(options = {}) {
  const { cookie, rewardTier, fetchImpl = globalThis.fetch, timeoutMs = 15000, now = Date.now() } = options

  if (!normalizeCookie(cookie)) {
    return {
      outcome: 'ineligible',
      message: '未配置网页会话 cookie，无法领取（设置 BREEZE_COOKIE 后重试）',
    }
  }
  if (typeof fetchImpl !== 'function') {
    return { outcome: 'failed', message: 'fetch 不可用' }
  }

  const built = buildClaimRequest(cookie, { rewardTier })
  if (built.error) return { outcome: 'ineligible', message: built.error }

  const signal = timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined

  let response
  try {
    response = await fetchImpl(built.url, { ...built.init, ...(signal ? { signal } : {}) })
  } catch (error) {
    return { outcome: 'failed', message: `请求失败: ${error?.message ?? String(error)}` }
  }

  let payload = null
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  const code = typeof payload?.code === 'string' ? payload.code : undefined
  const parsed = parseClaimPayload(payload)
  const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload
  const day = siteDay(body)
  // 网站这一天的结束时刻就是下次重置，让 Magpie 到那时再来问，别在这之前反复问。
  const until = day ? { until: new Date(day.end).toISOString() } : {}
  // 「已领」发生在网站还没日切的那段（北京 00:00–08:00）里，指的是网站的前一天，
  // Magpie 这个北京日其实什么都没领到。这时不能说 done —— 那会让界面显示
  // 「已签到」却没有 +N，用户看到的就是「说已签到、其实没领」。
  // 说 inactive（界面是「当前没有签到活动」）+ until=日切，08:00 一到自动去领。
  const behind = siteDayBehind(day, now)
  const done = () => ({
    outcome: behind ? 'inactive' : 'done',
    ...until,
    message: parsed.message ?? (behind
      ? `网站新一天在北京时间 ${beijingClock(day.start)} 开始，届时自动领取`
      : '今日积分已领取'),
  })

  if (response.status === 401 || response.status === 403 || (code && AUTH_CODES.has(code))) {
    return {
      outcome: 'ineligible',
      message: '网页会话已失效，请重新导出 cookie 到 BREEZE_COOKIE',
    }
  }

  if (response.ok) {
    if ((code && DONE_CODES.has(code)) || body?.already_claimed === true) return done()
    if (payload?.ok === false || body?.ok === false || body?.claimed === false) {
      return { outcome: 'failed', message: parsed.message ?? '网站未确认领取成功，请重试' }
    }
    if (body?.claimed === true || (parsed.credit !== undefined && parsed.credit > 0)) {
      return { outcome: 'claimed', ...parsed, ...until }
    }
    if (body?.daily_claim_claimed_today === true) return done()
    return { outcome: 'failed', message: parsed.message ?? '领取响应缺少成功标记，请重试' }
  }

  if (code && DONE_CODES.has(code)) return done()

  return {
    outcome: outcomeForStatus(response.status),
    message: parsed.message ?? `HTTP ${response.status}`,
  }
}

// 只读：用于排障，确认 cookie 是否还有效。
export async function fetchCreditsSummary(options = {}) {
  const { cookie, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = options
  const jar = normalizeCookie(cookie)
  if (!jar) return { error: 'cookie is empty' }
  const signal = timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined
  try {
    const response = await fetchImpl(BREEZE_WEB_BASE_URL + CREDITS_SUMMARY_PATH, {
      method: 'GET',
      headers: {
        cookie: jar,
        accept: 'application/json, text/plain, */*',
        origin: BREEZE_WEB_BASE_URL,
        referer: `${BREEZE_WEB_BASE_URL}/app/home`,
        'user-agent': USER_AGENT,
      },
      ...(signal ? { signal } : {}),
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }
    return { status: response.status, payload }
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
}

// 网页会话余额：和签到使用同一账号，避免 API key 余额与网页积分混淆。
export async function webCreditsUsage(options = {}) {
  const result = await fetchCreditsSummary(options)
  const fail = (error) => ({ plan: BALANCE_PLAN, windows: [], error })
  if (result.error) return fail(`积分查询失败：${result.error}`)
  if (result.status === 401 || result.status === 403) return fail('网页会话已失效，请重新登录')
  if (result.status !== 200) return fail(`积分查询 HTTP ${result.status}`)
  const body = result.payload?.data ?? result.payload
  const balance = pickNumber(body, ['balance'])
  if (body?.ok === false || balance === undefined) return fail('积分响应缺少有效余额')
  const windows = [{ name: '剩余积分', balance, unit: '积分' }]
  const amount = pickNumber(body, ['daily_claim_amount'])
  const reward = amount === undefined ? '' : ` · ${amount} 积分`
  const display = body.daily_claim_claimed_today === true ? `今日已领取${reward}`
    : body.daily_claim_available === true ? `今日可领取${reward}` : '今日暂不可领取'
  windows.push({ name: '每日积分', display, aside: true })
  const reset = body.daily_claim_next_reset_at
  if (typeof reset === 'string' && Number.isFinite(Date.parse(reset))) {
    const at = new Date(reset).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    windows.push({ name: '下次重置', display: `${at}（北京时间）`, aside: true })
  }
  return { plan: BALANCE_PLAN, windows }
}

// 登录流程用：这把 cookie 能不能读到自己账户的额度。
// 只看 200；401/403 是明确的「没登录」，其他状态（限流、5xx、网络故障）不算失败，
// 否则用户网络抖一下就会被判成「Cookie 无效」。
export async function verifyCookie(cookie, options = {}) {
  const result = await fetchCreditsSummary({ cookie, ...options })
  if (result.status === 200) return { ok: true }
  if (result.status === 401 || result.status === 403) {
    return { ok: false, reason: 'Cookie 无效或已过期' }
  }
  if (result.error) return { ok: false, reason: `网络错误：${result.error}` }
  return { ok: false, reason: `Breeze 返回 HTTP ${result.status}` }
}


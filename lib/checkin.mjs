// Breeze Blue 每日积分领取的纯逻辑。
// 注意：这条链路用的是 Web 端会话 cookie，不是 /v1 的 API Key，两者不通用。
// 端点来自 breezeblue.ai 前端 bundle 的 claimDailyCredits 定义，无官方契约。

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

const CREDIT_KEYS = ['credit', 'credits', 'credit_amount', 'amount', 'reward', 'granted', 'daily_credit', 'value']
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

// 成功体结构未知（只有 401 的错误体被实测过），所以按候选字段宽松取值，取不到就不报。
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

// 返回 { outcome, credit?, streak?, message? }
// outcome 取值必须是 Magpie 认的那几个：claimed / done / ineligible / inactive / captcha / failed。
export async function claimDailyCredits(options = {}) {
  const { cookie, rewardTier, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = options

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

  if (response.status === 401 || response.status === 403 || (code && AUTH_CODES.has(code))) {
    return {
      outcome: 'ineligible',
      message: '网页会话已失效，请重新导出 cookie 到 BREEZE_COOKIE',
    }
  }

  if (response.ok) {
    if (code && DONE_CODES.has(code)) {
      return { outcome: 'done', ...(parsed.message ? { message: parsed.message } : {}) }
    }
    if (payload && payload.ok === false) {
      if (code && DONE_CODES.has(code)) return { outcome: 'done' }
      return {
        outcome: 'failed',
        ...(parsed.message ? { message: parsed.message } : { message: `HTTP ${response.status}` }),
      }
    }
    return { outcome: 'claimed', ...parsed }
  }

  if (code && DONE_CODES.has(code)) {
    return { outcome: 'done', ...(parsed.message ? { message: parsed.message } : {}) }
  }

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

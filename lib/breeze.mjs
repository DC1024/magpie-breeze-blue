// Breeze Blue 官方接口的纯逻辑：把 OpenAI TTS 请求映射成 Breeze 请求，
// 并解析余额。这里不依赖 Magpie，方便直接测试和复用。

export const BREEZE_BASE_URL = 'https://api.breeze.blue/v1'
export const DEFAULT_MODEL_ID = 'breeze-tts-2'
export const DEFAULT_LANGUAGE_CODE = 'zh'
export const DEFAULT_SPEED = 1
export const DEFAULT_GUIDANCE_SCALE = 1
export const MIN_SPEED = 0.5
export const MAX_SPEED = 2
export const MIN_GUIDANCE_SCALE = 1
export const MAX_GUIDANCE_SCALE = 10
export const BALANCE_PLAN = 'BreezeBlue'
export const BALANCE_NAME = '余额'
export const BALANCE_UNIT = '积分'

// OpenAI /v1/audio/speech 的 response_format 到 Breeze output_format 的映射。
const RESPONSE_FORMATS = new Map([
  ['mp3', 'mp3'],
  ['wav', 'wav_24000'],
  ['opus', 'opus'],
  ['aac', 'aac_24000_128'],
  ['flac', 'flac_24000'],
  ['pcm', 'pcm_24000'],
])

export function mapResponseFormat(value) {
  const format = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return RESPONSE_FORMATS.get(format) ?? 'mp3'
}

// 只接受有限数字或数字字符串；null/undefined/布尔值都视为未提供。
function numberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return null
}

export function clampSpeed(value) {
  const speed = numberOrNull(value)
  if (speed === null) return null
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))
}

export function clampGuidanceScale(value) {
  const guidance = numberOrNull(value)
  if (guidance === null) return null
  return Math.min(MAX_GUIDANCE_SCALE, Math.max(MIN_GUIDANCE_SCALE, guidance))
}

function nonEmptyString(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text || null
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// fetch 的 init.body 可能是字符串、字节、已解析对象，或者 Request 的 body。
export function parseJsonBody(raw) {
  if (raw === undefined || raw === null) return { error: 'request body is empty' }
  if (typeof raw === 'string') {
    if (!raw.trim()) return { error: 'request body is empty' }
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      return { error: 'request body is not valid JSON' }
    }
    return isRecord(value) ? { value } : { error: 'request body must be a JSON object' }
  }
  if (raw instanceof ArrayBuffer) return parseJsonBody(new TextDecoder().decode(new Uint8Array(raw)))
  if (ArrayBuffer.isView(raw)) {
    return parseJsonBody(new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)))
  }
  if (typeof raw.getReader === 'function' || typeof raw.pipe === 'function') {
    return { error: 'request body must be JSON text' }
  }
  if (isRecord(raw)) return { value: raw }
  return { error: 'request body must be JSON text or an object' }
}

// 把一个 OpenAI TTS 请求体转换成 Breeze 的请求参数。
// 返回 { voice, format, payload }，校验失败时返回 { error }。
export function buildSpeechRequest(body) {
  if (!isRecord(body)) return { error: 'request body must be a JSON object' }

  const text = nonEmptyString(body.input)
  if (!text) return { error: 'input is required and must be a non-empty string' }

  const voice = nonEmptyString(body.voice)
  if (!voice) return { error: 'voice is required: pass a Breeze voice id (voc_…)' }

  const payload = {
    text,
    model_id: nonEmptyString(body.model_id) ?? DEFAULT_MODEL_ID,
    language_code: nonEmptyString(body.language_code) ?? DEFAULT_LANGUAGE_CODE,
  }

  const instructions = nonEmptyString(body.instructions)
  if (instructions) payload.instructions = instructions

  const settings = {}
  const speed = clampSpeed(body.speed)
  if (speed !== null && speed !== DEFAULT_SPEED) settings.speed = speed

  const guidance = clampGuidanceScale(body.guidance_scale)
  if (guidance !== null && guidance !== DEFAULT_GUIDANCE_SCALE) settings.guidance_scale = guidance

  if (body.use_speaker_boost === true) settings.use_speaker_boost = true

  if (Object.keys(settings).length > 0) payload.voice_settings = settings

  return { voice, format: mapResponseFormat(body.response_format), payload }
}

export function breezeSpeechUrl(voice, format = 'mp3') {
  const query = new URLSearchParams({ output_format: format, delivery: 'sync' })
  return `${BREEZE_BASE_URL}/text-to-speech/${encodeURIComponent(voice)}?${query.toString()}`
}

function openAIErrorType(status) {
  if (status === 401 || status === 403) return 'authentication_error'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

export function openAIErrorResponse(status, message, options = {}) {
  const text = typeof message === 'string' && message.trim() ? message.trim() : 'request failed'
  const body = {
    error: {
      message: text,
      type: options.type ?? openAIErrorType(status),
      param: options.param ?? null,
      code: options.code ?? null,
    },
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textOf(value) {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('; ')
  if (value && typeof value === 'object') {
    for (const key of ['message', 'detail', 'error', 'msg']) {
      const text = textOf(value[key])
      if (text) return text
    }
  }
  return ''
}

// Breeze 的错误体是 {code, detail, error}；detail 优先，方便把服务端原因透传。
export function breezeErrorMessage(payload, fallback = '') {
  if (!payload || typeof payload !== 'object') return fallback
  for (const key of ['detail', 'error', 'message']) {
    const text = textOf(payload[key])
    if (text) return text
  }
  return fallback
}

async function upstreamErrorResponse(response) {
  let payload
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const fallback = response.statusText
    ? `${response.statusText} (HTTP ${response.status})`
    : `HTTP ${response.status}`
  return openAIErrorResponse(response.status, breezeErrorMessage(payload, fallback), {
    code: typeof payload?.code === 'string' ? payload.code : null,
  })
}

// 调 Breeze 的同步 TTS 接口，返回 OpenAI 形状的 Response：
// 成功时是原始音频，失败时是 OpenAI 错误 JSON。
export async function breezeSpeech(body, key, fetchImpl = globalThis.fetch, signal) {
  const apiKey = typeof key === 'string' ? key.trim() : ''
  if (!apiKey) return openAIErrorResponse(401, 'Breeze API key is missing')

  const built = buildSpeechRequest(body)
  if (built.error) return openAIErrorResponse(400, built.error)
  if (typeof fetchImpl !== 'function') return openAIErrorResponse(500, 'Breeze fetch implementation is missing')

  let response
  try {
    response = await fetchImpl(breezeSpeechUrl(built.voice, built.format), {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(built.payload),
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    return openAIErrorResponse(502, `Breeze request failed: ${error?.message ?? String(error)}`)
  }

  if (!response.ok) return upstreamErrorResponse(response)

  try {
    const headers = new Headers()
    headers.set('content-type', response.headers.get('content-type') || 'audio/mpeg')
    return new Response(response.body, { status: response.status || 200, headers })
  } catch (error) {
    return openAIErrorResponse(502, `Breeze response could not be read: ${error?.message ?? String(error)}`)
  }
}

// 查 Breeze 余额，转换成 Magpie 的 wallet window。
// 任何失败都返回 windows: [] 和 error，不向 Magpie 外层抛错。
export async function breezeBalance(key, fetchImpl = globalThis.fetch) {
  const apiKey = typeof key === 'string' ? key.trim() : ''
  const fail = (message) => ({
    plan: BALANCE_PLAN,
    windows: [],
    error: `Breeze balance: ${message}`,
  })

  if (!apiKey) return fail('not signed in')
  if (typeof fetchImpl !== 'function') return fail('fetch implementation is missing')

  let response
  try {
    response = await fetchImpl(`${BREEZE_BASE_URL}/balance`, {
      method: 'GET',
      headers: {
        'xi-api-key': apiKey,
        accept: 'application/json',
      },
    })
  } catch (error) {
    return fail(error?.message ?? String(error))
  }

  let text
  try {
    text = await response.text()
  } catch (error) {
    return fail(error?.message ?? String(error))
  }

  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) return fail(breezeErrorMessage(payload, response.statusText || `HTTP ${response.status}`))
  if (!payload || typeof payload !== 'object') return fail(`HTTP ${response.status}: response is not JSON`)

  const balance = numberOrNull(payload.balance)
  if (balance === null) return fail('response has no numeric balance')

  const window = {
    name: BALANCE_NAME,
    balance: Math.max(0, balance),
    unit: BALANCE_UNIT,
  }
  if (payload.settlement_pending === true) window.aside = true

  return { plan: BALANCE_PLAN, windows: [window] }
}

// Magpie auth.loader 的 fetch：只接收 /v1/audio/speech，其余路径不转发到 Breeze。
export function createBreezeSpeechFetch(key, fetchImpl = globalThis.fetch) {
  return async function breezeFetch(input, init = {}) {
    let url
    try {
      const target = typeof input === 'string' || input instanceof URL ? String(input) : input?.url
      url = new URL(target)
    } catch {
      return openAIErrorResponse(400, 'invalid request URL')
    }

    if (!/\/audio\/speech\/?$/.test(url.pathname)) {
      return openAIErrorResponse(404, 'Breeze plugin only serves /v1/audio/speech')
    }

    const method = String(init?.method ?? (input instanceof Request ? input.method : 'POST')).toUpperCase()
    if (method !== 'POST') {
      return openAIErrorResponse(405, 'Breeze plugin only serves POST /v1/audio/speech')
    }

    let raw = init?.body
    if (raw === undefined && input instanceof Request) {
      try {
        raw = await input.text()
      } catch {
        return openAIErrorResponse(400, 'could not read request body')
      }
    }

    const parsed = parseJsonBody(raw)
    if (parsed.error) return openAIErrorResponse(400, parsed.error)

    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    return breezeSpeech(parsed.value, key, fetchImpl, signal)
  }
}

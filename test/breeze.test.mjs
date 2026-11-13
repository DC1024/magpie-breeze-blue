import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BALANCE_PLAN,
  BALANCE_NAME,
  BALANCE_UNIT,
  BREEZE_BASE_URL,
  DEFAULT_GUIDANCE_SCALE,
  DEFAULT_LANGUAGE_CODE,
  DEFAULT_MODEL_ID,
  MAX_GUIDANCE_SCALE,
  MAX_SPEED,
  MIN_GUIDANCE_SCALE,
  MIN_SPEED,
  breezeBalance,
  breezeErrorMessage,
  breezeSpeech,
  buildSpeechRequest,
  clampGuidanceScale,
  clampSpeed,
  createBreezeSpeechFetch,
  mapResponseFormat,
  parseJsonBody,
} from '../lib/breeze.mjs'

import breezePlugin from '../index.mjs'

const AUDIO_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00])

function audioResponse({ status = 200, type = 'audio/mpeg', body = AUDIO_BYTES } = {}) {
  return new Response(body, { status, headers: { 'content-type': type } })
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function recorder(handler) {
  const calls = []
  return {
    calls,
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), init })
      return handler(input, init)
    },
  }
}

async function bytes(response) {
  return new Uint8Array(await response.arrayBuffer())
}

test('response_format 映射到 Breeze output_format', () => {
  const cases = new Map([
    ['mp3', 'mp3'],
    ['wav', 'wav_24000'],
    ['opus', 'opus'],
    ['aac', 'aac_24000_128'],
    ['flac', 'flac_24000'],
    ['pcm', 'pcm_24000'],
    ['MP3', 'mp3'],
    ['wav_24000', 'mp3'],
  ])
  for (const [input, expected] of cases) assert.equal(mapResponseFormat(input), expected, input)
  assert.equal(mapResponseFormat(undefined), 'mp3')
  assert.equal(mapResponseFormat(123), 'mp3')
})

test('buildSpeechRequest 默认省略 model_id、language_code 之外的字段', () => {
  const built = buildSpeechRequest({ input: ' 晚安啦 ', voice: ' voc_test ', response_format: 'wav' })
  assert.equal(built.error, undefined)
  assert.equal(built.voice, 'voc_test')
  assert.equal(built.format, 'wav_24000')
  assert.deepEqual(built.payload, {
    text: '晚安啦',
    model_id: DEFAULT_MODEL_ID,
    language_code: DEFAULT_LANGUAGE_CODE,
  })
  assert.ok(!('instructions' in built.payload))
  assert.ok(!('voice_settings' in built.payload))
})

test('buildSpeechRequest 映射扩展字段与非默认 voice_settings', () => {
  const built = buildSpeechRequest({
    input: '晚安啦',
    voice: 'voc_test',
    response_format: 'aac',
    instructions: ' 用温柔的语气说 ',
    language_code: 'en',
    model_id: 'custom-model',
    speed: 1.05,
    guidance_scale: 4,
    use_speaker_boost: true,
  })
  assert.equal(built.format, 'aac_24000_128')
  assert.deepEqual(built.payload, {
    text: '晚安啦',
    model_id: 'custom-model',
    language_code: 'en',
    instructions: '用温柔的语气说',
    voice_settings: {
      speed: 1.05,
      guidance_scale: 4,
      use_speaker_boost: true,
    },
  })
})

test('speed 夹取到 0.5–2，等于 1 时不发送', () => {
  assert.equal(clampSpeed(0.1), MIN_SPEED)
  assert.equal(clampSpeed(9), MAX_SPEED)
  assert.equal(clampSpeed('1.25'), 1.25)
  assert.equal(clampSpeed(undefined), null)
  assert.equal(clampSpeed(true), null)
  assert.equal(clampSpeed('abc'), null)

  assert.deepEqual(buildSpeechRequest({ input: 'x', voice: 'v', speed: 0.1 }).payload.voice_settings, { speed: MIN_SPEED })
  assert.deepEqual(buildSpeechRequest({ input: 'x', voice: 'v', speed: 9 }).payload.voice_settings, { speed: MAX_SPEED })
  assert.ok(!('voice_settings' in buildSpeechRequest({ input: 'x', voice: 'v', speed: 1 }).payload))
})

test('guidance_scale 夹取到 1–10，等于 1 时不发送', () => {
  assert.equal(clampGuidanceScale(0), MIN_GUIDANCE_SCALE)
  assert.equal(clampGuidanceScale(99), MAX_GUIDANCE_SCALE)
  assert.equal(clampGuidanceScale(4), 4)
  assert.equal(clampGuidanceScale(null), null)

  assert.ok(!('voice_settings' in buildSpeechRequest({ input: 'x', voice: 'v', guidance_scale: DEFAULT_GUIDANCE_SCALE }).payload))
  assert.ok(!('voice_settings' in buildSpeechRequest({ input: 'x', voice: 'v', guidance_scale: 0 }).payload))
  assert.deepEqual(
    buildSpeechRequest({ input: 'x', voice: 'v', guidance_scale: 99 }).payload.voice_settings,
    { guidance_scale: MAX_GUIDANCE_SCALE },
  )
  assert.ok(!('voice_settings' in buildSpeechRequest({ input: 'x', voice: 'v', use_speaker_boost: false }).payload))
})

test('缺少 input 或 voice 返回 400 且不访问 Breeze', async () => {
  const fake = recorder(() => audioResponse())

  const noInput = await breezeSpeech({ voice: 'voc_test' }, 'brz_key', fake.fetch)
  assert.equal(noInput.status, 400)
  assert.match((await noInput.json()).error.message, /input/)

  const noVoice = await breezeSpeech({ input: '你好' }, 'brz_key', fake.fetch)
  assert.equal(noVoice.status, 400)
  assert.match((await noVoice.json()).error.message, /voice/)

  assert.equal(fake.calls.length, 0)
})

test('breezeSpeech 发送正确的 URL、鉴权头和 JSON 体', async () => {
  const fake = recorder(() => audioResponse())
  const response = await breezeSpeech({
    input: '晚安啦',
    voice: 'voc_test',
    response_format: 'mp3',
    speed: 1.05,
    instructions: '用温柔的语气说',
  }, ' brz_key ', fake.fetch)

  assert.equal(fake.calls.length, 1)
  const call = fake.calls[0]
  assert.equal(call.url, `${BREEZE_BASE_URL}/text-to-speech/voc_test?output_format=mp3&delivery=sync`)
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers['xi-api-key'], 'brz_key')
  assert.equal(call.init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(call.init.body), {
    text: '晚安啦',
    model_id: DEFAULT_MODEL_ID,
    language_code: DEFAULT_LANGUAGE_CODE,
    instructions: '用温柔的语气说',
    voice_settings: { speed: 1.05 },
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'audio/mpeg')
  assert.deepEqual(await bytes(response), AUDIO_BYTES)
})

test('voice 作为 URL path 段编码', async () => {
  const fake = recorder(() => audioResponse())
  await breezeSpeech({ input: 'x', voice: 'voc_a/b' }, 'key', fake.fetch)
  assert.equal(
    fake.calls[0].url,
    `${BREEZE_BASE_URL}/text-to-speech/voc_a%2Fb?output_format=mp3&delivery=sync`,
  )
})

test('保留 Breeze 返回的 content-type', async () => {
  const fake = recorder(() => audioResponse({ type: 'audio/wav' }))
  const response = await breezeSpeech({ input: 'x', voice: 'v', response_format: 'wav' }, 'key', fake.fetch)
  assert.equal(response.headers.get('content-type'), 'audio/wav')
})

test('Breeze 错误 detail 透传为 OpenAI 错误 JSON', async () => {
  const fake = recorder(() => jsonResponse({ code: 'invalid_voice', detail: 'voice not found', error: 'bad_request' }, 404))
  const response = await breezeSpeech({ input: 'x', voice: 'voc_x' }, 'key', fake.fetch)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), {
    error: {
      message: 'voice not found',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_voice',
    },
  })
})

test('Breeze 非 JSON 错误保留 HTTP 状态并分类', async () => {
  const failure = recorder(() => new Response('upstream down', { status: 503, statusText: 'Service Unavailable' }))
  const response = await breezeSpeech({ input: 'x', voice: 'v' }, 'key', failure.fetch)
  assert.equal(response.status, 503)
  const body = await response.json()
  assert.equal(body.error.type, 'api_error')
  assert.match(body.error.message, /Service Unavailable/)
  assert.equal(body.error.code, null)

  const limited = recorder(() => jsonResponse({ detail: 'slow down' }, 429))
  const rate = await breezeSpeech({ input: 'x', voice: 'v' }, 'key', limited.fetch)
  assert.equal((await rate.json()).error.type, 'rate_limit_error')
})

test('网络失败返回 502 且不泄漏 API Key', async () => {
  const secret = 'brz_super_secret'
  const response = await breezeSpeech({ input: 'x', voice: 'v' }, secret, async () => {
    throw new Error('socket closed')
  })
  assert.equal(response.status, 502)
  const body = await response.json()
  assert.match(body.error.message, /socket closed/)
  assert.ok(!JSON.stringify(body).includes(secret))
})

test('parseJsonBody 接受字符串、字节和对象', () => {
  assert.deepEqual(parseJsonBody('{"input":"x"}'), { value: { input: 'x' } })
  assert.deepEqual(parseJsonBody(new TextEncoder().encode('{"input":"x"}')), { value: { input: 'x' } })
  assert.deepEqual(parseJsonBody({ input: 'x' }), { value: { input: 'x' } })
  assert.match(parseJsonBody('').error, /empty/)
  assert.match(parseJsonBody('not json').error, /not valid JSON/)
  assert.match(parseJsonBody('[]').error, /JSON object/)
})

test('createBreezeSpeechFetch 只转发 POST /audio/speech', async () => {
  const fake = recorder(() => audioResponse())
  const fetch = createBreezeSpeechFetch('brz_key', fake.fetch)

  const response = await fetch(new Request('https://api.breeze.blue/v1/audio/speech', {
    method: 'POST',
    body: JSON.stringify({ input: '你好', voice: 'voc_test' }),
  }))
  assert.equal(response.status, 200)
  assert.equal(fake.calls.length, 1)
  assert.equal(
    fake.calls[0].url,
    `${BREEZE_BASE_URL}/text-to-speech/voc_test?output_format=mp3&delivery=sync`,
  )

  const wrongPath = await fetch('https://api.breeze.blue/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(wrongPath.status, 404)
  assert.equal(fake.calls.length, 1)

  const wrongMethod = await fetch('https://api.breeze.blue/v1/audio/speech', { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(fake.calls.length, 1)

  const badJson = await fetch('https://api.breeze.blue/v1/audio/speech', { method: 'POST', body: '{' })
  assert.equal(badJson.status, 400)
  assert.equal(fake.calls.length, 1)
})

test('breezeBalance 返回 Magpie wallet window', async () => {
  const fake = recorder(() => jsonResponse({
    balance: 1635.6,
    balance_millicredits: 1635600,
    settlement_pending: false,
  }))
  const usage = await breezeBalance(' brz_key ', fake.fetch)

  assert.deepEqual(usage, {
    plan: BALANCE_PLAN,
    windows: [{ name: BALANCE_NAME, balance: 1635.6, unit: BALANCE_UNIT }],
  })
  assert.equal(fake.calls[0].url, `${BREEZE_BASE_URL}/balance`)
  assert.equal(fake.calls[0].init.method, 'GET')
  assert.equal(fake.calls[0].init.headers['xi-api-key'], 'brz_key')
})

test('breezeBalance 标记 settlement_pending 并把余额限制为非负', async () => {
  const pending = await breezeBalance('key', async () => jsonResponse({ balance: 12.5, settlement_pending: true }))
  assert.deepEqual(pending.windows[0], {
    name: BALANCE_NAME,
    balance: 12.5,
    unit: BALANCE_UNIT,
    aside: true,
  })

  const negative = await breezeBalance('key', async () => jsonResponse({ balance: -3 }))
  assert.equal(negative.windows[0].balance, 0)
})

test('breezeBalance 失败时返回空 windows 和 error', async () => {
  const unauthorized = await breezeBalance('key', async () => jsonResponse({
    code: 'unauthorized',
    detail: 'invalid key',
    error: 'auth',
  }, 401))
  assert.deepEqual(unauthorized.windows, [])
  assert.match(unauthorized.error, /invalid key/)
  assert.equal(unauthorized.plan, BALANCE_PLAN)

  const offline = await breezeBalance('key', async () => {
    throw new Error('offline')
  })
  assert.deepEqual(offline.windows, [])
  assert.match(offline.error, /offline/)

  const invalid = await breezeBalance('key', async () => jsonResponse({ balance: null }))
  assert.deepEqual(invalid.windows, [])
  assert.match(invalid.error, /numeric balance/)

  const noKey = await breezeBalance('', async () => {
    throw new Error('should not call')
  })
  assert.deepEqual(noKey.windows, [])
  assert.match(noKey.error, /not signed in/)
})

test('breezeErrorMessage 优先 detail 并兼容数组与对象', () => {
  assert.equal(breezeErrorMessage({ detail: 'a', error: 'b' }), 'a')
  assert.equal(breezeErrorMessage({ detail: [{ msg: 'x' }, { msg: 'y' }] }), 'x; y')
  assert.equal(breezeErrorMessage({ error: { message: 'nested' } }), 'nested')
  assert.equal(breezeErrorMessage(null, 'fallback'), 'fallback')
})

test('插件 config 声明 breeze provider 和 audio 模型', async () => {
  const hooks = await breezePlugin()
  const config = { provider: {} }
  await hooks.config(config)

  const provider = config.provider.breeze
  assert.equal(provider.name, 'BreezeBlue')
  assert.equal(provider.npm, '@ai-sdk/openai-compatible')
  assert.equal(provider.api, BREEZE_BASE_URL)

  const model = provider.models['breeze-tts-2']
  assert.equal(model.name, 'Breeze TTS 2')
  assert.deepEqual(model.capabilities, { input: { text: true }, output: { audio: true } })
  assert.deepEqual(model.limit, { context: 1000, output: 0 })
  assert.equal(model.tool_call, false)

  assert.equal(hooks.provider.id, 'breeze')
  assert.equal(await hooks.provider.models({ models: provider.models }), provider.models)
})

test('插件 config 保留用户已有设置和额外模型', async () => {
  const hooks = await breezePlugin()
  const config = { provider: { breeze: { name: 'My Breeze', models: { extra: { name: 'Extra' } } } } }
  await hooks.config(config)

  assert.equal(config.provider.breeze.name, 'My Breeze')
  assert.equal(config.provider.breeze.models.extra.name, 'Extra')
  assert.deepEqual(
    config.provider.breeze.models['breeze-tts-2'].capabilities,
    { input: { text: true }, output: { audio: true } },
  )
})

test('auth.loader 返回 baseURL 并注入 Breeze fetch', async () => {
  const original = globalThis.fetch
  const fake = recorder(() => audioResponse())
  globalThis.fetch = fake.fetch
  try {
    const hooks = await breezePlugin()
    const options = await hooks.auth.loader(async () => ({ type: 'api', key: 'brz_loader_key' }))

    assert.equal(options.baseURL, BREEZE_BASE_URL)
    assert.equal(typeof options.fetch, 'function')

    const response = await options.fetch('https://api.breeze.blue/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: 'Bearer brz_loader_key' },
      body: JSON.stringify({ input: '晚安啦', voice: 'voc_test', response_format: 'wav' }),
    })
    assert.equal(response.status, 200)
    assert.equal(fake.calls.length, 1)
    assert.equal(
      fake.calls[0].url,
      `${BREEZE_BASE_URL}/text-to-speech/voc_test?output_format=wav_24000&delivery=sync`,
    )
    assert.equal(fake.calls[0].init.headers['xi-api-key'], 'brz_loader_key')
    assert.ok(!('authorization' in fake.calls[0].init.headers))

    const missing = await options.fetch('https://api.breeze.blue/v1/chat/completions', { method: 'POST', body: '{}' })
    assert.equal(missing.status, 404)
    assert.equal(fake.calls.length, 1)

    const noKey = await hooks.auth.loader(async () => ({ type: 'api', key: '' }))
    assert.deepEqual(noKey, {})
  } finally {
    globalThis.fetch = original
  }
})

test('auth.usage 用 API key 查询余额，不编造网页领取状态', async () => {
  const original = globalThis.fetch
  const fake = recorder(() => jsonResponse({ balance: 1635.6, settlement_pending: false }))
  globalThis.fetch = fake.fetch
  try {
    const hooks = await breezePlugin()
    const usage = await hooks.auth.usage(async () => ({ type: 'api', key: 'brz_usage_key' }))

    assert.deepEqual(usage, {
      plan: BALANCE_PLAN,
      windows: [
        { name: BALANCE_NAME, balance: 1635.6, unit: BALANCE_UNIT },
      ],
    })
    assert.equal(fake.calls[0].url, `${BREEZE_BASE_URL}/balance`)
    assert.equal(fake.calls[0].init.headers['xi-api-key'], 'brz_usage_key')
  } finally {
    globalThis.fetch = original
  }
})

test('auth.usage 失败不抛到 Magpie 外层', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  try {
    const hooks = await breezePlugin()
    const usage = await hooks.auth.usage(async () => ({ type: 'api', key: 'brz_key' }))
    assert.deepEqual(usage.windows, [])
    assert.match(usage.error, /offline/)
    assert.equal(usage.plan, BALANCE_PLAN)

    const noAuth = await hooks.auth.usage(async () => {
      throw new Error('no auth')
    })
    assert.deepEqual(noAuth.windows, [])
    assert.match(noAuth.error, /no auth/)
  } finally {
    globalThis.fetch = original
  }
})

// 用浏览器登录的账号只有会话 cookie、没有 API key。
// 过去这里只给一句「由每日签到自动领取」，用户看不到真实剩余积分。
test('auth.usage 只有 cookie 时读取网页真实剩余积分', async () => {
  const original = globalThis.fetch
  const fake = recorder(() => jsonResponse({
    balance: 3090.9, daily_claim_amount: 400, daily_claim_claimed_today: true,
    daily_claim_next_reset_at: '2026-11-14T00:00:00Z',
  }))
  globalThis.fetch = fake.fetch
  try {
    const hooks = await breezePlugin()
    const usage = await hooks.auth.usage(async () => ({
      type: 'success',
      access: 'sid=abc',
      metadata: { cookie: 'sid=abc' },
    }))

    assert.equal(usage.plan, BALANCE_PLAN)
    assert.equal(usage.windows[0].name, '剩余积分')
    assert.equal(usage.windows[0].balance, 3090.9)
    assert.match(usage.windows[1].display, /今日已领取/)
    assert.equal(usage.error, undefined)
    assert.match(fake.calls[0].url, /\/api\/credits\/summary$/)
  } finally {
    globalThis.fetch = original
  }
})

test('auth.usage 既无 key 也无 cookie 时说明缺 key', async () => {
  const hooks = await breezePlugin()
  const usage = await hooks.auth.usage(async () => ({}))
  assert.deepEqual(usage.windows, [])
  assert.match(usage.error, /API key/)
})

// TTS 的 key 不能用来签到，这是最常见的误区，文案要能指出来。
test('auth.checkin 只有 API key 时提示需要网页登录态', async () => {
  const hooks = await breezePlugin()
  const result = await hooks.auth.checkin(async () => ({ type: 'api', key: 'brz_x' }))
  assert.equal(result.outcome, 'ineligible')
  assert.match(result.message, /浏览器登录/)
})

test('auth.checkin 完全没有登录态时提示登录', async () => {
  const hooks = await breezePlugin()
  const result = await hooks.auth.checkin(async () => ({}))
  assert.equal(result.outcome, 'ineligible')
  assert.match(result.message, /浏览器登录/)
})

test('auth.checkin getAuth 抛错时不把异常漏给宿主', async () => {
  const hooks = await breezePlugin()
  const result = await hooks.auth.checkin(async () => {
    throw new Error('no auth')
  })
  assert.equal(result.outcome, 'ineligible')
  assert.equal(typeof result.message, 'string')
})

# magpie-breeze-blue

Breeze Blue (BreezeBlue) 的 Magpie provider 插件：把 OpenAI 兼容的 `POST /v1/audio/speech` 转成 Breeze 官方 `/v1/text-to-speech/{voice_id}`，并**每个北京日自动领取 Breeze 的每日积分**。

- provider id：`breeze`
- 显示名：`BreezeBlue`
- 模型：`breeze-tts-2`（显示名 `Breeze TTS 2`）
- 联网目标：`https://api.breeze.blue`（TTS / 余额）、`https://breezeblue.ai`（每日签到）

> 本仓库基于 [LumenMarch/magpie-breeze-blue](https://github.com/LumenMarch/magpie-breeze-blue)（MIT）扩展，新增每日签到能力。上游版权归原作者。

## 安装

```bash
# GitHub 直装（Magpie 用 Bun 拉取仓库）
magpie plugin add DC1024/magpie-breeze-blue

# 或指定分支 / tag / commit
magpie plugin add DC1024/magpie-breeze-blue#main

# 本地目录
git clone https://github.com/DC1024/magpie-breeze-blue
magpie plugin add ./magpie-breeze-blue
```

需要 Magpie ≥ 0.1.1083（每日签到 hook 从该版本起提供）。

## 两种登录方式

插件提供两个登录方式，按需选择：

| 方式 | 用途 | 凭证 |
|---|---|---|
| `Breeze API key` | TTS、余额 | `brz_…` API Key |
| `Breeze 网页 Cookie（每日签到）` | 自动领取每日积分 | 网页会话 Cookie |

```bash
magpie plugin login breeze     # 终端里会让你选方式
```

### 只做 TTS

选 `Breeze API key`，填 `brz_…` 即可。

### 要每日签到

1. 浏览器登录 https://breezeblue.ai/app
2. F12 → Network → 点任一 `/api/*` 请求 → 复制 Request Headers 里 `cookie:` 整行
3. `magpie plugin login breeze`，选「Breeze 网页 Cookie（每日签到）」，粘贴
4. 插件会先调 `GET /api/credits/summary` 验证，通过后由 Magpie 写入自己的 `plugin-auth.json`
5. 打开 设置 → 用量 → 插件 → BreezeBlue → 每日签到

Cookie 过期后重新执行第 3 步即可，不需要环境变量或外部脚本。

## 签到是怎么跑的

Magpie 内建了 `auth.checkin` 契约，宿主自己负责调度，插件只提供函数：

- 每个已登录、启用中的账号，**每个北京日调用一次**；首次询问时间取 设置 → 用量 → 插件 里的配置，未配置则在零点。
- 返回 `{ outcome, credit?, streak?, message?, until? }`，`outcome ∈ claimed / done / ineligible / inactive / captcha / failed`。
- 只有 `failed` 当天重试（30 分钟后）；其他结论当天定案。
- 结果写 `plugin-checkin.json`，同时在账号卡片上显示。
- 手动触发：`magpie accounts checkin`，或设置里的「立即签到」。

### outcome 映射

| 上游情况 | 返回 |
|---|---|
| `POST /api/credits/daily-claim` 2xx | `claimed`（能取到 `credit`/`streak` 就带上） |
| 2xx 且 `code` 表示今日已领 | `done` |
| 401 / 403 / `AUTH_REQUIRED` | `signIn: "expired"`，提示重新登录 |
| 429 / 5xx / 网络异常 | `failed`（交给宿主当天重试） |

Cookie 失效时故意**不**返回 `failed`：那会导致一天重试近 48 次。改用 `signIn: "expired"` 让账号标记为需重新登录，当天不再打扰。

## 使用 `/v1/audio/speech`

Magpie 网关默认监听 `http://127.0.0.1:3425`。

```bash
curl http://127.0.0.1:3425/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"model":"breeze/breeze-tts-2","input":"晚安啦","voice":"voc_...","response_format":"mp3","instructions":"用温柔的语气说","speed":1.05}' \
  --output out.mp3
```

### 参数

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `input` | 是 | — | 朗读文本；空白返回 400 |
| `voice` | 是 | — | Breeze 音色 ID（`voc_…`），作为 URL path 段编码 |
| `response_format` | 否 | `mp3` | `mp3` / `wav` / `opus` / `aac` / `flac` / `pcm`，未知值按 `mp3` |
| `speed` | 否 | `1` | 夹取到 0.5–2；等于 1 时不发送 |
| `instructions` | 否 | 不发送 | 语气/情绪指令 |
| `language_code` | 否 | `zh` | 两位 ISO 639-1 |
| `model_id` | 否 | `breeze-tts-2` | Breeze 扩展字段 |
| `guidance_scale` | 否 | `1` | 夹取到 1–10；等于 1 时不发送 |
| `use_speaker_boost` | 否 | `false` | 仅 `true` 时发送 |

`voice_settings` 只在 `speed` / `guidance_scale` / `use_speaker_boost` 有非默认值时出现。

### 格式映射

| `response_format` | Breeze `output_format` |
|---|---|
| `mp3` | `mp3` |
| `wav` | `wav_24000` |
| `opus` | `opus` |
| `aac` | `aac_24000_128` |
| `flac` | `flac_24000` |
| `pcm` | `pcm_24000` |

### 错误

Breeze 的 `{code, detail, error}` 会被改成 OpenAI 形状，保留 HTTP 状态：

```json
{
  "error": {
    "message": "voice not found",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_voice"
  }
}
```

本地校验失败 400；非 `/v1/audio/speech` 404；非 POST 405。

## 余额

`auth.usage` 调 `GET /v1/balance`，把余额显示在 provider 卡片上：

```json
{ "plan": "BreezeBlue", "windows": [{ "name": "余额", "balance": 1635.6, "unit": "积分" }] }
```

`settlement_pending` 为真时窗口带 `aside: true`。查询失败返回 `windows: []` 和 `error` 文本，不抛到外层。

## 网络与安全

- TTS 只访问 `https://api.breeze.blue`；签到只访问 `https://breezeblue.ai`。
- 自定义 `fetch` 只处理 `/v1/audio/speech`，其他路径直接返回 JSON 错误，不转发上游。
- 发往 Breeze 的请求只带该服务需要的头：TTS 用 `xi-api-key`，签到用 `cookie`；不转发 Magpie 收到的 `authorization`。
- 凭证不出现在日志、错误消息或返回体中。
- API Key 与网页 Cookie 都由 Magpie 保存在 `plugin-auth.json`（mode 600），不写进本仓库文件。
- 包本身没有任何 npm 运行时依赖。

## 开发与测试

```bash
node --test          # 需要 Node 18+
```

- `test/breeze.test.mjs`：上游的 TTS 映射 / 错误 / 余额测试。
- `test/checkin.test.mjs`：签到的请求构造、outcome 映射、凭证不泄漏，注入 `fetchImpl`，不访问真实网络。

## 已知边界

- 签到走的是 Breeze Web 端的内部接口 `POST /api/credits/daily-claim`，无公开契约，前端改版即可能失效。
- 成功响应体的字段结构未由官方定义，解析采用多候选字段兜底；取不到就不报 credit。
- 脚本化领取可能与 Breeze 服务条款冲突，账号风险由使用者承担。

## 许可证

MIT，见 `LICENSE`。原始版权 `Copyright (c) 2026 LumenMarch`，本仓库的签到扩展同样以 MIT 发布。

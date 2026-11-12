# magpie-breeze-blue

Breeze Blue (BreezeBlue) 的 Magpie provider 插件：把 OpenAI 兼容的 `POST /v1/audio/speech` 转成 Breeze 官方 `/v1/text-to-speech/{voice_id}`，并**每个北京日自动领取 Breeze 的每日积分**。签到需要 Web 会话，登录页由 Magpie 直接开在你自己的浏览器里（NAS / Docker 部署同样可用）。

- provider id：`breeze`
- 显示名：`BreezeBlue`
- 模型：`breeze-tts-2`（显示名 `Breeze TTS 2`）
- 联网目标：`https://api.breeze.blue`（TTS / 余额）、`https://breezeblue.ai`（每日签到）

> 本仓库基于 [LumenMarch/magpie-breeze-blue](https://github.com/LumenMarch/magpie-breeze-blue)（MIT）扩展，新增每日签到与浏览器一键登录能力。上游版权归原作者。

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

## 四种登录方法

```bash
magpie plugin login breeze     # 终端里会让你选方式
```

| 方式 | 能做什么 | 你要做的 |
|---|---|---|
| `浏览器登录（推荐）` | 每日签到 | 登录一次，把 cookie 粘回来（一次性的） |
| `本机自动读 Cookie` | 每日签到 | 在弹出来的窗口里登录，什么都不用复制 |
| `直接粘贴 Cookie` | 每日签到 | 手工复制 `cookie:` 整行 |
| `Breeze API key` | TTS、余额 | 填 `brz_…` |

> **TTS 与签到用的是两套凭证，互不替代。** TTS 打的是 `api.breeze.blue`，需要 `xi-api-key`；签到打的是 `breezeblue.ai` 的 Web 会话，需要 cookie。只登录网页账号不会让 TTS 可用，反之亦然。想两个都要，就在 Magpie 里给这个 provider 配两个账号：一个填 API key 负责 TTS，一个用浏览器登录负责签到（签到调度是按账号逐个跑的）。

### 浏览器登录（推荐，NAS / Docker 都能用）

1. 设置 → 添加 provider → BreezeBlue → 选「浏览器登录」
2. **Magpie 自己会打开登录页**：网页版是当前浏览器新开一个标签页，桌面版是系统默认浏览器。页面开在**你自己的电脑**上，不是开在 NAS 上。
3. 你在那个页面正常登录（邮箱密码、Google 都行）
4. 回到 Magpie，在登录卡片的输入框里粘贴 cookie，点提交
5. 插件先调 `GET /api/credits/summary` 验一次，通过才收下

拿 cookie 两种办法，任选：

```js
// 在那个已登录的页面按 F12 → Console，执行：
copy(document.cookie)
```

若粘出来是空的（会话 cookie 带 HttpOnly，JS 读不到），改用 Network：

```
F12 → Network → 点任一条 /api 请求 → Request Headers 里对 cookie: 那一行右键 Copy value
```

⚠️ 不要从 `应用 / Application → Cookies` 表格里整块复制 —— 那是制表符分隔的表格，不是 Cookie 头，插件会认出来并提示你换位置。

一次性动作。cookie 能撑很久，之后签到每天自动跑。

#### 为什么这里非要粘一次（而不是「点一下就自动拿到」）

这是 Breeze 这个站点决定的，不是插件偷懒。看过 Magpie 源码后，`authorize` 能交回去的东西只有三种收尾方式（`internal/plugin/host.js` 的 `authorize`/`callback`、`internal/provider/pluginsignin.go` 的 `pluginBegin`）：

| 收尾方式 | 触发条件 | Breeze 适用吗 |
|---|---|---|
| `method: "auto"` | 插件自己完成（自己跑了个本地 http 服务，或者读本机浏览器） | 只在「Magpie 与浏览器同机」时成立（见下一种方式） |
| `method: "code"` | 登录页上会出现一串 code，用户粘回来 | 不适用：Breeze 登录不发 code |
| `PasteCallback` | 登录页把浏览器重定向到插件开的回环端口，用户把**落地地址**粘回来 | 不适用：Breeze 不是 OAuth，登录成功只是给自己的域名种 cookie，不往外跳 |

也就是说，Magpie 官方留给「远程部署 + 非 OAuth 站点」的通道只有「让用户粘一段文本回来」。OTP / OAuth 类插件（Devin、Kiro、Trae、Zed、Command Code）之所以看着「点一下就成」，是因为它们的站点会在登录后把 code 或重定向地址交出来 —— Breeze 没有这一步。cookie 只存在于浏览器的 cookie jar 里，服务器侧无从获取，所以要么读本机 jar（同机才行），要么用户粘一次。

`opened` 字段的含义顺带说清（v0.5.0 曾搞错）：`authorize` 返回 `opened: true` 表示**插件自己已经开过窗口了**，Magpie 不要再开一个；返回 `false` 才会由 Magpie 去开。网页版走的是 `window.open(url)`（`internal/gui/assets/app.js` 的 `openSignInPage`），桌面版走 `w.OpenURL`（`internal/gui/api.go` 的 `openSignIn`）。**两边都不在服务端开浏览器** —— 所以 NAS 部署下页面本来就该开在你电脑上，不需要任何隧道。

### 本机自动读 Cookie（Magpie 与浏览器在同一台电脑）

1. 选「本机自动读 Cookie」
2. 插件拉起一个独立的 Chrome / Edge 窗口（走 CDP 读 cookie），打开 Breeze
3. 你在窗口里登录，登录成功那一刻插件读到会话 Cookie，验一次，**窗口自动关闭**
4. 全程不需要 F12、不需要复制任何东西

登录用的是独立 profile，目录在：

```
~/.config/magpie/breeze-login-profile              # Linux / macOS（遵守 XDG_CONFIG_HOME）
%USERPROFILE%\.config\magpie\breeze-login-profile  # Windows
```

你日常浏览器的 profile 完全不受影响。删掉这个目录即可让插件下次重新登录。

**找不到浏览器时**，用环境变量指定可执行文件路径：

```bash
MAGPIE_BREEZE_BROWSER="D:\Program Files\Google\Chrome\Application\chrome.exe" magpie plugin login breeze
```

默认会依次尝试 Chrome、Edge、Chromium、Brave 的常见安装路径（Windows / macOS / Linux）。整个过程有超时，超时后窗口会被杀掉并报「等待登录超时」。

> 这条路径**要求 Magpie 和浏览器在同一台机器上**。Magpie 装在 NAS / Docker 里时，这里 spawn 出来的窗口会开在 NAS 自己的显示器上——你既看不到也点不到。那种情况请用上面的「浏览器登录」。

### 只做 TTS

选 `Breeze API key`，填 `brz_…` 即可。

### 手动粘贴 Cookie（不想开浏览器时）

1. 浏览器登录 https://breezeblue.ai/app
2. F12 → Network → 点任一 `/api/*` 请求 → 复制 Request Headers 里 `cookie:` 整行
3. `magpie plugin login breeze`，选「直接粘贴 Cookie」，粘贴
4. 插件先调 `GET /api/credits/summary` 验证，通过后由 Magpie 写入自己的 `plugin-auth.json`
5. 打开 设置 → 用量 → 插件 → BreezeBlue → 每日签到

Cookie 过期后重跑一次登录即可。签到返回 `signIn: "expired"` 时，账号卡片会提示你重新登录。

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

> 这一节要求账号里配了 **Breeze API key**（`brz_…`）。只做了「浏览器登录」的账号没有 key，调用会 401 —— 那是签到专用凭证。

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
- 浏览器登录用的临时 profile 由插件自己创建和清理进程，登录态只落在上面那个目录里，与你的日常浏览器隔离。
- 包本身没有任何 npm 运行时依赖。

## 开发与测试

```bash
node --test          # 需要 Node 18+
```

- `test/breeze.test.mjs`：上游的 TTS 映射 / 错误 / 余额测试。
- `test/checkin.test.mjs`：签到的请求构造、outcome 映射、凭证不泄漏，注入 `fetchImpl`，不访问真实网络。
- `test/auth-flow.test.mjs`：auth 方法的接线契约——第一个方法是 `opened: false` + `method: "code"`（保证登录页由 Magpie 开在用户浏览器里）、粘贴后先验再存、无效/空 cookie 的报错、本机自动模式标记 `opened: true`、`checkin` 对「只有 API key」的账号给出可照做的提示。
- `test/browser-login.test.mjs`：CDP 端口解析、Cookie 拼接与域名/路径优先级、浏览器探测、超时与 abort、`Storage.getCookies` 与页面级回退、无 DISPLAY 的 Linux 直接拒绝。
- 全部用例都不触网、不启动真实浏览器。

### 手工验证 CDP 读取

```bash
# 终端 A：起一个带调试端口的 Chrome，登录 Breeze
chrome --remote-debugging-port=9222 --remote-allow-origins='*' --user-data-dir=/tmp/cdp https://breezeblue.ai/app/home

# 终端 B：用插件代码从 CDP 读 cookie
node -e "import('./lib/browser-login.mjs').then(async m => {
  const c = await m.readCookiesViaCdp('http://127.0.0.1:9222')
  console.log(c.length, m.cookiesToHeader(c).slice(0, 60))
})"
```

## 已知边界

- 签到走的是 Breeze Web 端的内部接口 `POST /api/credits/daily-claim`，无公开契约，前端改版即可能失效。
- 成功响应体的字段结构未由官方定义，解析采用多候选字段兜底；取不到就不报 credit。
- **Breeze 登录不发 code、也不做 OAuth 回调**，所以「浏览器登录」必须让用户粘一次 cookie 回来。这是站点性质决定的，Magpie 的 `code` / `PasteCallback` / `auto` 三种收尾方式里只有「粘一段文本」适用于它（详见上文表格）。
- 「本机自动读 Cookie」依赖 Chromium 内核浏览器 + CDP，**只在 Magpie 与浏览器同机时可用**；NAS / Docker 下请用「浏览器登录」。
- 无图形界面（纯 SSH、无 `DISPLAY` 的服务器）下本机模式会直接报错并指向上面的「浏览器登录」，不会让你干等 5 分钟超时。
- 插件跑在 Magpie 的 provider 进程（Bun）里，因此能用 `child_process` / WebSocket；middleware 与 agent 所在的 moejs 环境没有这些能力，不要把这段代码搬过去。
- 脚本化领取可能与 Breeze 服务条款冲突，账号风险由使用者承担。

## 许可证

MIT，见 `LICENSE`。原始版权 `Copyright (c) 2026 LumenMarch`，本仓库的签到扩展同样以 MIT 发布。

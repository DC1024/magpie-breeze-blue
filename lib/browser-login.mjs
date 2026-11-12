// 用 Chromium 内核浏览器登录 Breeze，并通过 CDP 读回会话 cookie。
//
// 只在「Magpie 与浏览器在同一台电脑」时用得上（桌面版）。Magpie 装在 NAS /
// Docker 上时走 index.mjs 里的「浏览器登录」——登录页由 magpie 的前端
// window.open 在用户自己的浏览器里打开，插件这边不 spawn 任何进程。
//
// 设计要点：
// - 独立的 user-data-dir（不复用日常浏览器的 profile，避免被占用）。
// - profile 持久化，所以第一次登录之后，再点一次就能直接读到 cookie。
// - --remote-debugging-port=0 让浏览器自己挑端口，读 DevToolsActivePort 拿回来。
// - --disable-blink-features=AutomationControlled 抵消调试端口带来的「自动化浏览器」标记，
//   否则 Google 账号登录会被直接拒绝（见下面 LAUNCH_ARGS 的注释）。
// - 只读 cookie，不注入脚本、不改页面，登录动作全部由用户完成。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 登录页。opened 由调用方决定：交给 magpie 开，还是插件自己开一个窗口。
export const LOGIN_PAGE_URL = 'https://breezeblue.ai/auth/login?next=%2Fapp%2Fhome'
// 登录后落地的页面，也是 spawn 出来的窗口的起始地址。
export const LOGIN_URL = 'https://breezeblue.ai/app/home'
export const COOKIE_DOMAIN = 'breezeblue.ai'

// Google 的账号登录域。插件打开的浏览器一旦落到这里，多半正在被「此浏览器或应用
// 可能不安全」挡住 —— 那是 Google 对自动化浏览器的拦截，不是登录本身失败。
export const GOOGLE_SIGNIN_HOST = 'accounts.google.com'

// 除 --user-data-dir / --remote-debugging-port 之外的固定参数。
//
// `--disable-blink-features=AutomationControlled` 不是可有可无的：
// Chrome 157 实测（探针见仓库讨论）只要开了 `--remote-debugging-port`，即使没有
// `--enable-automation`，页面里的 `navigator.webdriver` 也是 **true**；而 Google 的
// 「此浏览器或应用可能不安全」判定读的就是这个信号。关掉这个 Blink 特性后
// webdriver 变回 false，调试端口照常可用，Google 登录也能正常走。
export const LAUNCH_ARGS = [
  '--remote-allow-origins=*', // Chrome 111 起会校验 ws 的 Origin，不放开 CDP 连不上
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate',
]

// 登录窗口的 profile 放在 Magpie 配置目录旁边，卸载插件不会带走它。
export function profileDir(env = process.env) {
  const base = String(env.XDG_CONFIG_HOME ?? '').trim() || join(homedir(), '.config')
  return join(base, 'magpie', 'breeze-login-profile')
}

// 候选浏览器路径，环境变量 MAGPIE_BREEZE_BROWSER 优先。
export function chromiumCandidates(options = {}) {
  const { platform = process.platform, env = process.env } = options
  const out = []
  const custom = String(env.MAGPIE_BREEZE_BROWSER ?? '').trim()
  if (custom) out.push(custom)

  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files'
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const local = env.LOCALAPPDATA || ''
    out.push(
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    )
    if (local) {
      out.push(
        join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(local, '360Chrome', 'Chrome', 'Application', '360chrome.exe'),
        join(local, '360ChromeX', 'Chrome', 'Application', '360ChromeX.exe'),
      )
    }
    out.push(
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    )
  } else if (platform === 'darwin') {
    out.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    out.push('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge')
  }
  return [...new Set(out)]
}

// 返回第一个真实存在的候选。Linux/macOS 下的命令名要真的能在 PATH 里找到，
// 不能想当然直接返回 —— 否则会拿着一个不存在的命令去 spawn，报 ENOENT
// （实测某 NAS 上只有 google-chrome-stable，没有 google-chrome）。
export function findChromium(options = {}) {
  const { exists = existsSync, platform = process.platform, env = process.env, which } = options
  // 没显式给 which 时，用同一个 exists 去查 PATH，这样测试注入 exists 就能全程生效
  const resolve = which ?? ((cmd, e) => whichInPath(cmd, e, platform, exists))

  for (const candidate of chromiumCandidates(options)) {
    // 带路径分隔符的候选：直接看文件在不在
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (exists(candidate)) return candidate
      continue
    }
    // 纯命令名（Linux / macOS 常见）：按 PATH 解析成绝对路径
    const resolved = resolve(candidate, env)
    if (resolved) return resolved
  }
  return ''
}

// 在 PATH 各目录里找可执行文件，返回绝对路径；找不到返回空串。
export function whichInPath(command, env = process.env, platform = process.platform, exists = existsSync) {
  const sep = platform === 'win32' ? ';' : ':'
  // Windows 的 PATH 键大小写不定，两个都看
  const dirs = String(env.PATH ?? env.Path ?? '').split(sep)
  for (const dir of dirs) {
    if (!dir) continue
    // 不能用 node:path 的 join：在 Windows 上跑 Linux 分支时它会拼出反斜杠
    const full = platform === 'win32' ? join(dir, command) : `${dir.replace(/\/+$/, '')}/${command}`
    try {
      if (exists(full)) return full
    } catch {}
  }
  return ''
}

// DevToolsActivePort 第一行是端口，第二行是浏览器 ws 路径。
export function parseDevToolsActivePort(text) {
  const port = Number(String(text ?? '').split(/\r?\n/)[0]?.trim())
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0
}

// 只取目标域的 cookie，拼成 Cookie 请求头。
// 同名 cookie 按 path 更长的优先，与浏览器行为一致。
export function cookiesToHeader(cookies, domain = COOKIE_DOMAIN) {
  if (!Array.isArray(cookies)) return ''
  const bare = String(domain).replace(/^\./, '').toLowerCase()
  const picked = cookies
    .filter((c) => {
      if (!c || typeof c.name !== 'string' || !c.name) return false
      if (typeof c.value !== 'string') return false
      const host = String(c.domain ?? '').replace(/^\./, '').toLowerCase()
      if (!host) return false
      return host === bare || host.endsWith('.' + bare)
    })
    // path 越具体越靠后，同名 cookie 由更具体的那个覆盖
    .sort((a, b) => String(a.path || '/').length - String(b.path || '/').length)

  const seen = new Map()
  for (const c of picked) seen.set(c.name, c.value)
  return [...seen].map(([k, v]) => `${k}=${v}`).join('; ')
}

// 把用户填的地址规范成 http://host:port。
// 允许「127.0.0.1:9222」「http://x:9222/json/list」「ws://x:9222/devtools/browser/…」这几种写法。
export function normalizeCdpBase(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return ''
  let text = raw
  if (/^wss?:\/\//i.test(text)) text = text.replace(/^ws(s?):\/\//i, 'http$1://')
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`
  try {
    const u = new URL(text)
    if (!u.hostname) return ''
    return `${u.protocol === 'https:' ? 'https' : 'http'}://${u.host}`
  } catch {
    return ''
  }
}

// 浏览器自报的 webSocketDebuggerUrl 里，host:port 是「它自己认为的地址」，
// 不一定等于我们实际连得上的地址（容器映射、端口转发、代理都会让它对不上）。
// 统一改写成 baseUrl 的 host:port，避免去连一个对本进程不可达的地址。
export function rewriteWsUrl(wsUrl, baseUrl) {
  try {
    const base = new URL(baseUrl)
    const ws = new URL(String(wsUrl ?? ''))
    ws.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    // 不能只设 host：URL 的 host setter 不会清掉原 port，
    // https 的 443 又是默认端口（base.port 为空串），会留下对端那个 9222。
    ws.hostname = base.hostname
    ws.port = base.port
    return ws.toString()
  } catch {
    return String(wsUrl ?? '')
  }
}

// 用 node:http 而不是 fetch 去问调试端口。
// 原因：宿主（Bun）的 fetch 会读 HTTP_PROXY / http_proxy，打 127.0.0.1 的本地端口
// 也会被代理劫持（实测 curl 因此返回 502 假象）。node:http 是直连，绕开这层。
export function httpGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let req
    try {
      req = httpRequest(url, { timeout: timeoutMs, agent: false }, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          done(null)
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
          // /json/list 正常就几十 KB，超过 4MB 说明不对，别把内存吃满
          if (body.length > 4 * 1024 * 1024) {
            try {
              req.destroy()
            } catch {}
            done(null)
          }
        })
        res.on('end', () => {
          try {
            done(JSON.parse(body))
          } catch {
            done(null)
          }
        })
      })
      req.on('timeout', () => {
        try {
          req.destroy()
        } catch {}
        done(null)
      })
      req.on('error', () => done(null))
      req.end()
    } catch {
      done(null)
    }
  })
}

// 连一个 CDP ws，发一条命令，等对应 id 的回复。
function cdpCall(wsUrl, method, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false
    let socket
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.close()
      } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)

    try {
      socket = new WebSocket(wsUrl)
    } catch {
      clearTimeout(timer)
      resolve(null)
      return
    }

    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ id: 1, method }))
      } catch {
        finish(null)
      }
    }
    socket.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      if (message?.id !== 1) return
      finish(message)
    }
    socket.onerror = () => finish(null)
    socket.onclose = () => finish(null)
  })
}

// 从一个 CDP 端点读出全部 cookie。
// 优先用浏览器级 session 的 Storage.getCookies：不依赖「当前有没有开着 breezeblue.ai 页面」，
// 用户随便开个窗口登录完就行。老浏览器不支持 Storage 域时退回页面级 Network.getAllCookies。
export async function readCookiesViaCdp(baseUrl, options = {}) {
  const { httpGet = httpGetJson, timeoutMs = 8000 } = options
  const base = normalizeCdpBase(baseUrl)
  if (!base) return []

  const version = await httpGet(`${base}/json/version`)
  if (version?.webSocketDebuggerUrl) {
    const reply = await cdpCall(rewriteWsUrl(version.webSocketDebuggerUrl, base), 'Storage.getCookies', timeoutMs)
    if (Array.isArray(reply?.result?.cookies)) return reply.result.cookies
  }

  const targets = await httpGet(`${base}/json/list`)
  const pages = Array.isArray(targets)
    ? targets.filter((t) => t?.type === 'page' && t.webSocketDebuggerUrl)
    : []
  if (pages.length === 0) return []
  const target = pages.find((p) => String(p.url ?? '').includes(COOKIE_DOMAIN)) ?? pages[0]
  const reply = await cdpCall(rewriteWsUrl(target.webSocketDebuggerUrl, base), 'Network.getAllCookies', timeoutMs)
  return Array.isArray(reply?.result?.cookies) ? reply.result.cookies : []
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 浏览器当前是不是停在 Google 账号页 / 被 Google 拦住的错误页。
async function stuckOnGoogleSignIn(httpGet, base) {
  const targets = await httpGet(`${base}/json/list`)
  if (!Array.isArray(targets)) return false
  return targets.some((t) => {
    if (t?.type !== 'page') return false
    try {
      return new URL(String(t.url ?? '')).hostname === GOOGLE_SIGNIN_HOST
    } catch {
      return false
    }
  })
}

// 把 spawn 的 errno 翻成用户能照做的说法。这些错误码在 Windows 上很常见：
// 火绒 / 360 / Defender 的「程序启动拦截」通常表现为 EACCES 或 EPERM。
function describeSpawnError(error, browser = '') {
  const code = String(error?.code ?? '')
  const name = browser || '浏览器'
  if (code === 'ENOENT') {
    return `找不到浏览器可执行文件（${name}）。请用 MAGPIE_BREEZE_BROWSER 指向真实路径，或改用「浏览器登录」方式。`
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `没有权限启动 ${name}，通常是被安全软件（火绒 / 360 / Defender）拦截了。请放行该浏览器，或改用「浏览器登录」方式。`
  }
  const detail = error?.message ?? String(error)
  return `启动浏览器失败：${detail}。可改用「浏览器登录」方式。`
}

// 轮询 cookie → 变了就验一次 → 通过就返回。
// 未登录时页面也会写 _ga 之类的匿名 cookie，header 一开始就非空；
// 只在 cookie 发生变化时才打验证接口，否则一次登录会白打上百次请求。
//
// watchPages 用来顺带看一眼浏览器当前停在哪个域名：如果一直卡在 accounts.google.com，
// 说明用户撞上了 Google 的自动化浏览器拦截，再等下去也只是空耗 5 分钟，早点说清楚。
export const GOOGLE_BLOCKED_MESSAGE =
  'Google 拒绝了这次登录：它不认插件打开的浏览器（页面上写「此浏览器或应用可能不安全」）。' +
  '可以这样绕过去：① 改用「邮箱密码登录」，完全不开浏览器，最省事；' +
  '② 关掉这个窗口，改用「浏览器登录」——在你自己的浏览器里登录一次，再把 Cookie 粘回来；' +
  '③ 如果这个账号是 Google 注册、从没设过密码，那只能用 ②。'

async function pollForCookie({
  readCookies,
  verify,
  deadline,
  signal,
  pollMs,
  watchPages,
  googleGraceMs = 90 * 1000,
}) {
  let lastTried = ''
  let onGoogleSince = 0
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, error: '登录已取消' }
    let header = ''
    try {
      header = cookiesToHeader(await readCookies())
    } catch {
      header = ''
    }
    if (header && header !== lastTried) {
      lastTried = header
      let accepted = true
      if (typeof verify === 'function') {
        try {
          accepted = await verify(header)
        } catch {
          accepted = false
        }
      }
      if (accepted) return { ok: true, cookie: header }
    }
    if (typeof watchPages === 'function') {
      let stuck = false
      try {
        stuck = await watchPages()
      } catch {
        stuck = false
      }
      if (stuck) {
        if (!onGoogleSince) onGoogleSince = Date.now()
        else if (Date.now() - onGoogleSince >= googleGraceMs) {
          return { ok: false, error: GOOGLE_BLOCKED_MESSAGE }
        }
      } else {
        onGoogleSince = 0
      }
    }
    await sleep(pollMs)
  }
  return { ok: false, error: '等待登录超时，请重试' }
}


// 启动浏览器 → 等用户登录 → 读 cookie → 关浏览器。
// verify(cookieHeader) 返回 true 表示这把 cookie 可用，用来判断「登录已完成」。
export async function loginWithBrowser(options = {}) {
  const {
    verify,
    signal,
    timeoutMs = 5 * 60 * 1000,
    pollMs = 1500,
    googleGraceMs = 90 * 1000,
    httpGet = httpGetJson,
    spawnImpl = spawn,
    exists = existsSync,
    env = process.env,
    platform = process.platform,
    dir = profileDir(env),
    url = LOGIN_URL,
    log = () => {},
  } = options

  // Linux 上没有 DISPLAY / WAYLAND_DISPLAY，浏览器进程起来就退，窗口根本画不出来。
  // 与其让用户等 5 分钟超时，不如直接说清楚该怎么改。
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return {
      ok: false,
      error:
        '这台机器没有图形界面（DISPLAY 未设置），浏览器窗口开不出来。请改用「浏览器登录」——magpie 会把登录页开在你自己的浏览器里，或用「直接粘贴 Cookie」。',
    }
  }

  const browser = findChromium({ exists, env, platform })
  if (!browser) {
    return {
      ok: false,
      error:
        '这台机器上没找到 Chrome / Edge / Brave 等 Chromium 内核浏览器。装一个，或用 MAGPIE_BREEZE_BROWSER 指向它的可执行文件；更省事的做法是改用「浏览器登录」（magpie 会把登录页开在你自己的浏览器里）。',
    }
  }

  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, error: `无法创建登录 profile 目录：${error?.message ?? error}` }
  }

  // 上一次登录留下的 DevToolsActivePort 是死端口，不删会让我们连到旧地址空转到超时。
  const portFile = join(dir, 'DevToolsActivePort')
  try {
    rmSync(portFile, { force: true })
  } catch {}

  let child
  try {
    child = spawnImpl(
      browser,
      [`--user-data-dir=${dir}`, '--remote-debugging-port=0', ...LAUNCH_ARGS, url],
      { stdio: 'ignore', detached: false },
    )
  } catch (error) {
    return { ok: false, error: describeSpawnError(error, browser) }
  }

  // spawn 失败（ENOENT / EACCES / 被安全软件拦截）不会抛异常，而是异步 emit 'error'。
  // 没人监听时 Node 与 Bun 都会把它升级成未捕获异常，**整个插件宿主直接退出（exit 1）**——
  // 用户看到的就是「the plugin host quit: exit status 1」。这里必须接住。
  let spawnError = null
  try {
    child?.on?.('error', (error) => {
      spawnError = error
    })
  } catch {}

  const stop = () => {
    try {
      child?.kill()
    } catch {}
  }

  const deadline = Date.now() + timeoutMs

  try {
    let port = 0
    const portDeadline = Math.min(deadline, Date.now() + 20000)
    while (Date.now() < portDeadline) {
      if (signal?.aborted) return { ok: false, error: '登录已取消' }
      // 浏览器根本没起来，别再空等端口。
      if (spawnError) return { ok: false, error: describeSpawnError(spawnError, browser) }
      try {
        port = parseDevToolsActivePort(readFileSync(portFile, 'utf8'))
      } catch {
        port = 0
      }
      if (port) break
      await sleep(300)
    }
    if (!port) return { ok: false, error: '浏览器没有打开调试端口，可能被安全策略拦截' }

    log(`browser ready on 127.0.0.1:${port}`)

    const base = `http://127.0.0.1:${port}`
    const result = await pollForCookie({
      readCookies: () => readCookiesViaCdp(base, { httpGet }),
      verify,
      deadline,
      signal,
      pollMs,
      watchPages: () => stuckOnGoogleSignIn(httpGet, base),
      ...(googleGraceMs ? { googleGraceMs } : {}),
    })
    return result.ok ? { ...result, browser } : result
  } catch (error) {
    // 这个函数对调用方的契约是「只返回结果对象、永不 reject」。
    // 抛出去的话，宿主那侧就是未处理的拒绝 → Bun 退出码 1，整个插件宿主消失。
    return { ok: false, error: `浏览器登录出错：${error?.message ?? error}` }
  } finally {
    stop()
  }
}

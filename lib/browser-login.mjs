// 用本机 Chromium 内核浏览器登录 Breeze，并通过 CDP 读回会话 cookie。
//
// 设计要点：
// 1. 独立的 user-data-dir（不复用日常浏览器的 profile，避免被占用）。
// 2. profile 持久化，所以第一次登录之后，再点一次就能直接读到 cookie。
// 3. --remote-debugging-port=0 让浏览器自己挑端口，读 DevToolsActivePort 拿回来。
// 4. 只读 cookie，不注入脚本、不改页面，登录动作全部由用户完成。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LOGIN_URL = 'https://breezeblue.ai/app/home'
export const COOKIE_DOMAIN = 'breezeblue.ai'

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

// 返回第一个真实存在的候选；Linux 下的命令名按原样返回（交给 PATH 解析）。
export function findChromium(options = {}) {
  const { exists = existsSync, platform = process.platform } = options
  for (const candidate of chromiumCandidates(options)) {
    if (platform !== 'win32' && platform !== 'darwin') {
      if (!candidate.includes('/')) return candidate
    }
    if (exists(candidate)) return candidate
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

async function listPageTargets(port, fetchImpl) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) return []
  const targets = await response.json()
  return Array.isArray(targets) ? targets.filter((t) => t?.type === 'page' && t.webSocketDebuggerUrl) : []
}

// 连到页面 target，要一次 Network.getAllCookies。
// WebSocket 由 Bun / Node 22 内建，不引第三方依赖。
async function readAllCookies(port, fetchImpl, timeoutMs = 8000) {
  const pages = await listPageTargets(port, fetchImpl)
  if (pages.length === 0) return []
  const target = pages.find((p) => String(p.url ?? '').includes(COOKIE_DOMAIN)) ?? pages[0]

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => finish([]), timeoutMs)

    let socket
    try {
      socket = new WebSocket(target.webSocketDebuggerUrl)
    } catch {
      clearTimeout(timer)
      resolve([])
      return
    }

    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }))
      } catch {
        finish([])
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
      finish(Array.isArray(message.result?.cookies) ? message.result.cookies : [])
    }
    socket.onerror = () => finish([])
    socket.onclose = () => finish([])
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 启动浏览器 → 等用户登录 → 读 cookie → 关浏览器。
// verify(cookieHeader) 返回 true 表示这把 cookie 可用，用来判断「登录已完成」。
export async function loginWithBrowser(options = {}) {
  const {
    verify,
    signal,
    timeoutMs = 5 * 60 * 1000,
    pollMs = 1500,
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    exists = existsSync,
    env = process.env,
    platform = process.platform,
    dir = profileDir(env),
    url = LOGIN_URL,
    log = () => {},
  } = options

  const browser = findChromium({ exists, env, platform })
  if (!browser) {
    return {
      ok: false,
      error:
        '没有找到 Chrome / Edge / Brave 等 Chromium 内核浏览器。装一个，或用 MAGPIE_BREEZE_BROWSER 指向它的可执行文件；也可以改用「粘贴 Cookie」方式。',
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
      [
        `--user-data-dir=${dir}`,
        '--remote-debugging-port=0',
        // Chrome 111 起会校验 ws 的 Origin，不放开的话 CDP 连不上。
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
        url,
      ],
      { stdio: 'ignore', detached: false },
    )
  } catch (error) {
    return { ok: false, error: `启动浏览器失败：${error?.message ?? error}` }
  }

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

    // 未登录时页面也会写 _ga 之类的匿名 cookie，header 一开始就非空。
    // 只在 cookie 发生变化时才去打验证接口，否则一次登录会白打上百次请求。
    let lastTried = ''
    while (Date.now() < deadline) {
      if (signal?.aborted) return { ok: false, error: '登录已取消' }
      let header = ''
      try {
        header = cookiesToHeader(await readAllCookies(port, fetchImpl))
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
        if (accepted) return { ok: true, cookie: header, browser }
      }
      await sleep(pollMs)
    }
    return { ok: false, error: '等待登录超时，请重试' }
  } finally {
    stop()
  }
}

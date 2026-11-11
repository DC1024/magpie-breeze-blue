import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  chromiumCandidates,
  cookiesToHeader,
  findChromium,
  loginWithBrowser,
  normalizeCdpBase,
  parseDevToolsActivePort,
  readCookiesViaCdp,
  rewriteWsUrl,
} from '../lib/browser-login.mjs'

// 每个用例一个独立临时目录，避免在真实磁盘上留垃圾，也避免用例互相污染。
function tempProfile() {
  return mkdtempSync(join(tmpdir(), 'breeze-login-test-'))
}

test('parseDevToolsActivePort 取第一行端口', () => {
  assert.equal(parseDevToolsActivePort('9222\n/devtools/browser/abc\n'), 9222)
  assert.equal(parseDevToolsActivePort('  \n'), 0)
  assert.equal(parseDevToolsActivePort('abc'), 0)
  assert.equal(parseDevToolsActivePort(''), 0)
  assert.equal(parseDevToolsActivePort('70000'), 0)
})

test('cookiesToHeader 只取目标域，拼成 Cookie 头', () => {
  const header = cookiesToHeader([
    { name: 'a', value: '1', domain: 'breezeblue.ai', path: '/' },
    { name: 'b', value: '2', domain: '.breezeblue.ai', path: '/' },
    { name: 'evil', value: 'x', domain: 'example.com', path: '/' },
  ])
  assert.equal(header, 'a=1; b=2')
})

test('cookiesToHeader 排除子域逃逸与空值', () => {
  const header = cookiesToHeader([
    { name: 'ok', value: '1', domain: 'breezeblue.ai' },
    { name: 'sub', value: '1', domain: 'evilbreezeblue.ai' },
    { name: 'empty', value: '', domain: 'breezeblue.ai' },
    { name: 'nodomain', value: 'v' },
  ])
  assert.equal(header, 'ok=1; empty=')
})

test('cookiesToHeader 同名时 path 更长的胜出', () => {
  const header = cookiesToHeader([
    { name: 's', value: 'root', domain: 'breezeblue.ai', path: '/' },
    { name: 's', value: 'deep', domain: 'breezeblue.ai', path: '/app' },
  ])
  assert.equal(header, 's=deep')
})

test('cookiesToHeader 非数组返回空串', () => {
  assert.equal(cookiesToHeader(null), '')
  assert.equal(cookiesToHeader('x'), '')
})

test('chromiumCandidates 优先采用 MAGPIE_BREEZE_BROWSER', () => {
  const list = chromiumCandidates({
    platform: 'win32',
    env: { MAGPIE_BREEZE_BROWSER: 'D:\\custom\\chrome.exe' },
  })
  assert.equal(list[0], 'D:\\custom\\chrome.exe')
})

test('chromiumCandidates 在 Windows 覆盖 Chrome 与 Edge', () => {
  const list = chromiumCandidates({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\LA' },
  })
  assert.ok(list.some((p) => p.includes('Google') && p.endsWith('chrome.exe')))
  assert.ok(list.some((p) => p.includes('Microsoft') && p.endsWith('msedge.exe')))
})

test('findChromium 返回第一个存在的路径', () => {
  const found = findChromium({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\PF' },
    exists: (p) => p.includes('msedge'),
  })
  assert.match(found, /msedge\.exe$/)
})

test('findChromium 找不到时返回空串', () => {
  assert.equal(findChromium({ platform: 'win32', env: {}, exists: () => false }), '')
})

test('loginWithBrowser 没有浏览器时给出可操作的原因', async () => {
  const result = await loginWithBrowser({ exists: () => false, platform: 'win32', env: {} })
  assert.equal(result.ok, false)
  assert.match(result.error, /MAGPIE_BREEZE_BROWSER|粘贴 Cookie/)
})

test('loginWithBrowser 启动失败不抛出，返回错误', async () => {
  const dir = tempProfile()
  try {
    const result = await loginWithBrowser({
      exists: () => true,
      platform: 'win32',
      env: {},
      dir,
      spawnImpl: () => {
        throw new Error('spawn EACCES')
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /启动浏览器失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loginWithBrowser 等不到调试端口时超时返回', async () => {
  const dir = tempProfile()
  const killed = []
  try {
    const result = await loginWithBrowser({
      exists: () => true,
      platform: 'win32',
      env: {},
      dir,
      timeoutMs: 1200,
      spawnImpl: () => ({ kill: () => killed.push(1) }),
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /调试端口|超时/)
    assert.equal(killed.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Chrome 退出后不会清理 DevToolsActivePort，上一次登录留下的端口是死的。
// 如果启动前不清掉，第二次登录会连到旧端口空转到超时。
test('loginWithBrowser 启动前清掉上一次残留的 DevToolsActivePort', async () => {
  const dir = tempProfile()
  const portFile = join(dir, 'DevToolsActivePort')
  writeFileSync(portFile, '9999\n/devtools/browser/stale\n')
  try {
    const result = await loginWithBrowser({
      exists: () => true,
      platform: 'win32',
      env: {},
      dir,
      timeoutMs: 1200,
      spawnImpl: () => ({ kill: () => {} }),
    })
    assert.equal(result.ok, false)
    // 关键：不能是「连上了 9999」这类假成功，必须是拿不到新端口而失败
    assert.match(result.error, /调试端口/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loginWithBrowser 收到 abort 时立即退出', async () => {
  const dir = tempProfile()
  const controller = new AbortController()
  controller.abort()
  try {
    const result = await loginWithBrowser({
      exists: () => true,
      platform: 'win32',
      env: {},
      dir,
      timeoutMs: 5000,
      signal: controller.signal,
      spawnImpl: () => ({ kill: () => {} }),
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /取消/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 未登录时页面也会写 _ga 之类的匿名 cookie，header 从一开始就非空。
// 若每轮都去验证，5 分钟会打出上百次无用请求，这里锁住「cookie 没变就不重复验证」。
test('loginWithBrowser cookie 没变化时不重复验证', async () => {
  const dir = tempProfile()
  const portFile = join(dir, 'DevToolsActivePort')

  const realWebSocket = globalThis.WebSocket
  let verifyCalls = 0

  // 极简 CDP 替身：连上就立刻回一次 getAllCookies，内容恒定。
  class FakeSocket {
    constructor() {
      setTimeout(() => {
        this.onopen?.()
        this.onmessage?.({
          data: JSON.stringify({
            id: 1,
            result: { cookies: [{ name: '_ga', value: 'anon', domain: 'breezeblue.ai', path: '/' }] },
          }),
        })
      }, 0)
    }
    send() {}
    close() {}
  }
  globalThis.WebSocket = FakeSocket

  try {
    const result = await loginWithBrowser({
      exists: () => true,
      platform: 'win32',
      env: {},
      dir,
      timeoutMs: 2500,
      pollMs: 300,
      // 真实浏览器启动后会自己写这个文件，替身也得写，否则永远拿不到端口。
      spawnImpl: () => {
        writeFileSync(portFile, '19333\n/devtools/browser/x\n')
        return { kill: () => {} }
      },
      // 调试端口的探测走 httpGet（node:http 直连，绕开 Bun fetch 的代理劫持）
      httpGet: async () => [{ type: 'page', url: 'https://breezeblue.ai/app/home', webSocketDebuggerUrl: 'ws://x' }],
      verify: async () => {
        verifyCalls += 1
        return false
      },
    })
    assert.equal(result.ok, false)
    // 2500ms / 300ms ≈ 8 轮，但 cookie 恒定，只该验证 1 次
    assert.equal(verifyCalls, 1)
  } finally {
    globalThis.WebSocket = realWebSocket
    rmSync(dir, { recursive: true, force: true })
  }
})

// 回归：spawn 失败不是抛异常，而是异步 emit 'error'。
// 没监听时 Node/Bun 会把它升级成未捕获异常，整个插件宿主以 exit 1 退出
// （用户看到的就是「the plugin host quit: exit status 1」）。
test('loginWithBrowser 接住 spawn 的异步 error 事件，不弄死宿主', async () => {
  const dir = tempProfile()
  const { EventEmitter } = await import('node:events')
  // 真实 ChildProcess 是 EventEmitter，spawn 失败时 emit('error')。
  const fakeChild = new EventEmitter()
  fakeChild.kill = () => {}

  try {
    const promise = loginWithBrowser({
      exists: () => true,
      platform: 'win32',
      env: { ProgramFiles: 'C://blocked' },
      dir,
      timeoutMs: 3000,
      spawnImpl: () => fakeChild,
    })

    // 模拟 spawn 异步失败（ENOENT / 被安全软件拦截）
    const error = new Error('spawn chrome.exe EACCES')
    error.code = 'EACCES'
    setTimeout(() => fakeChild.emit('error', error), 30)

    const result = await promise
    assert.equal(result.ok, false)
    assert.match(result.error, /权限|安全软件|粘贴 Cookie/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loginWithBrowser 对 spawn 失败的 ENOENT 给出可操作提示', async () => {
  const dir = tempProfile()
  const { EventEmitter } = await import('node:events')
  const fakeChild = new EventEmitter()
  fakeChild.kill = () => {}

  try {
    const promise = loginWithBrowser({
      exists: () => true,
      platform: 'win32',
      env: { ProgramFiles: 'C://nope' },
      dir,
      timeoutMs: 3000,
      spawnImpl: () => fakeChild,
    })
    const error = new Error('spawn chrome.exe ENOENT')
    error.code = 'ENOENT'
    setTimeout(() => fakeChild.emit('error', error), 30)

    const result = await promise
    assert.equal(result.ok, false)
    assert.match(result.error, /MAGPIE_BREEZE_BROWSER/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loginWithBrowser 内部异常也返回对象，不 reject', async () => {
  const dir = tempProfile()
  try {
    const result = await loginWithBrowser({
      exists: () => true,
      platform: 'win32',
      env: { ProgramFiles: 'C://x' },
      dir,
      timeoutMs: 1500,
      // spawn 返回的对象连 on 都没有，最坏情况
      spawnImpl: () => null,
      verify: () => {
        throw new Error('verify boom')
      },
    })
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 回归：Linux 下不能想当然返回第一个候选名。NAS 上只有 google-chrome-stable，
// 没有 google-chrome，旧实现会拿着不存在的命令去 spawn 并报 ENOENT。
test('findChromium 在 Linux 下按 PATH 解析出真实存在的命令', () => {
  const found = findChromium({
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    exists: (p) => p === '/usr/bin/google-chrome-stable',
  })
  assert.equal(found, '/usr/bin/google-chrome-stable')
})

test('findChromium 在 Linux 下找不到任何浏览器时返回空串', () => {
  const found = findChromium({
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin' },
    exists: () => false,
  })
  assert.equal(found, '')
})

test('findChromium 在 Linux 下用 POSIX 拼接，不受宿主平台影响', () => {
  // 即使测试跑在 Windows 上，Linux 分支也必须拼出正斜杠路径
  const found = findChromium({
    platform: 'linux',
    env: { PATH: '/opt/bin' },
    exists: (p) => {
      assert.ok(!p.includes('\\'), `路径不该有反斜杠: ${p}`)
      return p === '/opt/bin/chromium'
    },
  })
  assert.equal(found, '/opt/bin/chromium')
})

test('findChromium 优先用 MAGPIE_BREEZE_BROWSER 指定的绝对路径', () => {
  const found = findChromium({
    platform: 'linux',
    env: { PATH: '/usr/bin', MAGPIE_BREEZE_BROWSER: '/custom/chrome' },
    exists: (p) => p === '/custom/chrome',
  })
  assert.equal(found, '/custom/chrome')
})

// ---------- 远程模式（Magpie 装在 NAS / 服务器，浏览器在用户自己电脑上）----------

test('normalizeCdpBase 接受多种写法', () => {
  assert.equal(normalizeCdpBase('127.0.0.1:9222'), 'http://127.0.0.1:9222')
  assert.equal(normalizeCdpBase('http://127.0.0.1:9222'), 'http://127.0.0.1:9222')
  assert.equal(normalizeCdpBase('http://127.0.0.1:9222/json/list'), 'http://127.0.0.1:9222')
  // 用户从 chrome://inspect 抄下来的 ws 地址
  assert.equal(normalizeCdpBase('ws://127.0.0.1:9222/devtools/browser/abc'), 'http://127.0.0.1:9222')
  assert.equal(normalizeCdpBase('  192.168.43.96:9222  '), 'http://192.168.43.96:9222')
  assert.equal(normalizeCdpBase(''), '')
  assert.equal(normalizeCdpBase('   '), '')
  assert.equal(normalizeCdpBase('http://'), '')
})

// 走 SSH 隧道时，浏览器自报的 ws 地址是它自己视角的 127.0.0.1:9222，
// 插件这边必须换成隧道端口，否则连的是本机（不存在）的 9222。
test('rewriteWsUrl 把浏览器自报的 host:port 换成实际可达地址', () => {
  assert.equal(
    rewriteWsUrl('ws://127.0.0.1:9222/devtools/browser/abc', 'http://127.0.0.1:19222'),
    'ws://127.0.0.1:19222/devtools/browser/abc',
  )
  // https 端点要跟着变成 wss
  assert.equal(
    rewriteWsUrl('ws://127.0.0.1:9222/devtools/browser/abc', 'https://nas.local:443'),
    'wss://nas.local/devtools/browser/abc',
  )
  // 垃圾输入不炸
  assert.equal(rewriteWsUrl('', 'http://127.0.0.1:9222'), '')
})

test('readCookiesViaCdp 优先用浏览器级 Storage.getCookies', async () => {
  const realWebSocket = globalThis.WebSocket
  let sentMethod = ''
  class FakeSocket {
    constructor() {
      setTimeout(() => {
        this.onopen?.()
      }, 0)
    }
    send(payload) {
      sentMethod = JSON.parse(payload).method
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: 1,
            result: { cookies: [{ name: 'sid', value: 'v', domain: '.breezeblue.ai', path: '/' }] },
          }),
        })
      }, 0)
    }
    close() {}
  }
  globalThis.WebSocket = FakeSocket
  try {
    const cookies = await readCookiesViaCdp('http://127.0.0.1:9222', {
      httpGet: async (url) => {
        if (url.endsWith('/json/version')) {
          return { Browser: 'Chrome/157', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x' }
        }
        // 不该走到这里：浏览器级已成功
        throw new Error(`unexpected ${url}`)
      },
    })
    assert.equal(sentMethod, 'Storage.getCookies')
    assert.equal(cookies.length, 1)
    assert.equal(cookies[0].name, 'sid')
  } finally {
    globalThis.WebSocket = realWebSocket
  }
})

test('readCookiesViaCdp 老浏览器不支持 Storage 时退回页面级 getAllCookies', async () => {
  const realWebSocket = globalThis.WebSocket
  const methods = []
  let call = 0
  class FakeSocket {
    constructor() {
      setTimeout(() => this.onopen?.(), 0)
    }
    send(payload) {
      const method = JSON.parse(payload).method
      methods.push(method)
      call += 1
      setTimeout(() => {
        // 第一次（Storage.getCookies）回错误，模拟老版本不支持
        const message = call === 1
          ? { id: 1, error: { code: -32601, message: 'method not found' } }
          : { id: 1, result: { cookies: [{ name: 'p', value: '1', domain: 'breezeblue.ai' }] } }
        this.onmessage?.({ data: JSON.stringify(message) })
      }, 0)
    }
    close() {}
  }
  globalThis.WebSocket = FakeSocket
  try {
    const cookies = await readCookiesViaCdp('http://127.0.0.1:9222', {
      httpGet: async (url) => {
        if (url.endsWith('/json/version')) return { Browser: 'Chrome/100', webSocketDebuggerUrl: 'ws://x/1' }
        return [{ type: 'page', url: 'https://breezeblue.ai/app/home', webSocketDebuggerUrl: 'ws://x/2' }]
      },
    })
    assert.deepEqual(methods, ['Storage.getCookies', 'Network.getAllCookies'])
    assert.equal(cookies[0].name, 'p')
  } finally {
    globalThis.WebSocket = realWebSocket
  }
})

// 远程模式的核心：绝不能去 spawn 浏览器。
// NAS 上 spawn 出来的窗口开在 NAS 自己的显示器上，用户看不到，等于必然失败。
test('loginWithBrowser 传 cdpUrl 时不启动浏览器', async () => {
  const realWebSocket = globalThis.WebSocket
  let spawnCalls = 0
  class FakeSocket {
    constructor() {
      setTimeout(() => this.onopen?.(), 0)
    }
    send() {
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({
            id: 1,
            result: { cookies: [{ name: 'sid', value: 'ok', domain: '.breezeblue.ai', path: '/' }] },
          }),
        })
      }, 0)
    }
    close() {}
  }
  globalThis.WebSocket = FakeSocket
  try {
    const result = await loginWithBrowser({
      cdpUrl: '127.0.0.1:19222',
      // 即使这里有可用的浏览器也不该用
      exists: () => true,
      platform: 'win32',
      env: { ProgramFiles: 'C://PF' },
      timeoutMs: 4000,
      pollMs: 100,
      spawnImpl: () => {
        spawnCalls += 1
        return { kill: () => {} }
      },
      httpGet: async (url) => {
        if (url.endsWith('/json/version')) return { Browser: 'Chrome/157', webSocketDebuggerUrl: 'ws://x/1' }
        throw new Error('should not be called')
      },
      verify: async () => true,
    })
    assert.equal(spawnCalls, 0, '远程模式不该启动浏览器')
    assert.equal(result.ok, true)
    assert.equal(result.cookie, 'sid=ok')
    assert.equal(result.browser, 'http://127.0.0.1:19222')
  } finally {
    globalThis.WebSocket = realWebSocket
  }
})

test('loginWithBrowser 远程模式连不上时给出排查步骤', async () => {
  const result = await loginWithBrowser({
    cdpUrl: '127.0.0.1:19222',
    timeoutMs: 600,
    pollMs: 100,
    httpGet: async () => null,
    spawnImpl: () => ({ kill: () => {} }),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /连不上/)
  assert.match(result.error, /remote-debugging-port/)
  assert.match(result.error, /隧道/)
})

test('loginWithBrowser 远程模式地址非法时直接拒绝', async () => {
  const result = await loginWithBrowser({ cdpUrl: 'http://', timeoutMs: 500 })
  assert.equal(result.ok, false)
  assert.match(result.error, /调试地址格式/)
})

// Linux 上没有 DISPLAY 时浏览器起来就退，窗口画不出来。
// 与其让用户盯着 5 分钟超时，不如立刻告诉他该怎么做。
test('loginWithBrowser 在无图形界面的 Linux 上直接给出替代方案', async () => {
  const result = await loginWithBrowser({
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    exists: () => true,
    timeoutMs: 3000,
    spawnImpl: () => {
      throw new Error('不该走到 spawn')
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /图形界面|DISPLAY/)
  assert.match(result.error, /远程|粘贴 Cookie/)
})

test('loginWithBrowser 有 DISPLAY 的 Linux 仍走本地模式', async () => {
  const dir = tempProfile()
  let spawnCalls = 0
  try {
    const result = await loginWithBrowser({
      platform: 'linux',
      env: { PATH: '/usr/bin', DISPLAY: ':0' },
      exists: (p) => p === '/usr/bin/google-chrome-stable',
      dir,
      timeoutMs: 700,
      pollMs: 100,
      spawnImpl: () => {
        spawnCalls += 1
        return { kill: () => {} }
      },
    })
    assert.equal(spawnCalls, 1, '有 DISPLAY 就该真的去启动浏览器')
    // 浏览器没写 DevToolsActivePort，所以是端口超时
    assert.match(result.error, /调试端口|超时/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

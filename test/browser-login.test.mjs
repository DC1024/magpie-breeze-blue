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
  parseDevToolsActivePort,
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
      fetchImpl: async () => ({
        ok: true,
        json: async () => [{ type: 'page', url: 'https://breezeblue.ai/app/home', webSocketDebuggerUrl: 'ws://x' }],
      }),
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

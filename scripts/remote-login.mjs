#!/usr/bin/env node
// 远程登录助手：在你自己的电脑上跑，替你把两件事一次性做完——
//   1. 启动一个带 CDP 调试端口的 Chrome（用独立 profile，不碰你日常那个）；
//   2. 建立到 Magpie 所在机器的 SSH 反向隧道，让那边的插件能连上这个端口。
//
// 为什么需要隧道：Chrome 从 111 起强制把调试端口只绑 127.0.0.1，
// 实测即使在 157 上传 --remote-debugging-address=0.0.0.0 也无效
// （日志只打印 ws://127.0.0.1:9222，netstat 里没有 LAN 监听）。
// 所以跨机访问只能靠隧道，不能指望改 Chrome 参数。
//
// 用法：
//   node scripts/remote-login.mjs --host 192.168.43.102 --port 10000 --user 18028346079
//   node scripts/remote-login.mjs --host nas.local --user me --local-port 9222 --remote-port 19222
//
// 脚本会打印「在 Magpie 里该填什么」，照填即可。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

import { chromiumCandidates, findChromium, LOGIN_URL } from '../lib/browser-login.mjs'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}

// Chromium 上的独立 profile，和插件本地模式那个分开，
// 免得两边同时启动抢同一个 user-data-dir。
export function remoteProfileDir(env = process.env) {
  const base = env.LOCALAPPDATA || join(homedir(), '.local', 'share')
  return join(base, 'magpie', 'breeze-remote-profile')
}

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

async function waitForCdp(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const host = String(args.host ?? '').trim()
  const user = String(args.user ?? '').trim()
  const sshPort = String(args.port ?? '22').trim()
  const localPort = Number(args['local-port'] ?? 9222)
  const remotePort = Number(args['remote-port'] ?? localPort)
  const noBrowser = Boolean(args['no-browser'])

  if (!host || !user) {
    console.error('缺少参数。用法：')
    console.error('  node scripts/remote-login.mjs --host <Magpie 所在机器> --user <SSH 用户名> [--port 22]')
    console.error('  [--local-port 9222] [--remote-port 19222] [--no-browser]')
    process.exit(2)
  }

  console.log('=== Breeze 远程登录助手 ===')
  console.log(`这台电脑 : ${osPlatform()} ${process.arch}`)
  console.log(`Magpie 在: ${host}:${sshPort}（SSH 用户 ${user}）`)

  // ---- 第一步：启动带调试端口的 Chrome ----
  // 记下来，隧道断了要把它一起收掉，不然用户桌面上会留一个没人管的窗口。
  let browserChild = null
  if (noBrowser) {
    console.log('\n[1/2] 跳过启动浏览器（--no-browser），假定你已经有 Chrome 开在调试端口上')
  } else {
    const browser = findChromium()
    if (!browser) {
      console.error('\n[1/2] 没找到 Chrome / Edge / Brave。')
      console.error(`找过这些位置：${chromiumCandidates().slice(0, 4).join('、')} …`)
      console.error('装一个 Chromium 内核浏览器，或用 MAGPIE_BREEZE_BROWSER 指向它的路径。')
      process.exit(1)
    }
    console.log(`\n[1/2] 启动浏览器：${browser}`)

    const free = await isPortFree(localPort)
    if (!free) {
      console.log(`      端口 ${localPort} 已被占用，假定那是已经开好的调试端口，直接复用`)
    } else {
      const dir = remoteProfileDir()
      try {
        mkdirSync(dir, { recursive: true })
      } catch (error) {
        console.error(`      无法创建 profile 目录 ${dir}：${error?.message ?? error}`)
        process.exit(1)
      }
      const child = spawn(
        browser,
        [
          `--user-data-dir=${dir}`,
          `--remote-debugging-port=${localPort}`,
          // Chrome 111+ 会校验 CDP WebSocket 的 Origin，不放开则连不上
          '--remote-allow-origins=*',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-features=Translate',
          LOGIN_URL,
        ],
        { stdio: 'ignore' },
      )
      // spawn 失败不抛异常，只 emit('error')；没人接会把整个进程带崩。
      child.on('error', (error) => {
        console.error(`      启动浏览器失败：${error?.message ?? error}`)
        process.exit(1)
      })
      browserChild = child

      const ready = await waitForCdp(localPort)
      if (!ready) {
        console.error(`      浏览器起来了，但 ${localPort} 端口没响应。`)
        console.error('      常见原因：安全软件拦截、或被已运行的 Chrome 抢了 profile 锁。')
        closeBrowser()
        process.exit(1)
      }
      console.log(`      调试端口就绪：http://127.0.0.1:${localPort}`)
    }
  }

  function closeBrowser() {
    try {
      browserChild?.kill()
    } catch {}
  }

  // ---- 第二步：反向隧道 ----
  console.log(`\n[2/2] 建立 SSH 反向隧道：本机 ${localPort} → ${host} 的 ${remotePort}`)
  console.log('      可能会提示输入 SSH 密码。保持这个窗口开着，登录完再关。\n')

  const sshArgs = [
    '-N',
    '-R', `${remotePort}:127.0.0.1:${localPort}`,
    // 只绑对端回环，不把调试端口暴露给整个局域网
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-p', String(sshPort),
    `${user}@${host}`,
  ]

  const ssh = spawn('ssh', sshArgs, { stdio: 'inherit' })
  ssh.on('error', (error) => {
    console.error(`启动 ssh 失败：${error?.message ?? error}`)
    console.error('Windows 10/11 自带 OpenSSH 客户端；没有的话在「设置 → 应用 → 可选功能」里装。')
    closeBrowser()
    process.exit(1)
  })
  ssh.on('exit', (code) => {
    if (code === 0) {
      console.log('\n隧道已关闭。')
    } else {
      console.error(`\nssh 退出，代码 ${code}。常见原因：密码错、对端 sshd 禁了 AllowTcpForwarding、端口被占用。`)
    }
    // 隧道一断，那个 Chrome 就再也没用了，顺手收掉，别在桌面上留垃圾。
    closeBrowser()
    process.exit(code ?? 1)
  })

  // Ctrl+C 也要收干净
  const cleanup = () => {
    try {
      ssh.kill()
    } catch {}
    closeBrowser()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  // 给用户打印该填什么，等隧道真正建立再提示
  setTimeout(() => {
    console.log('\n' + '='.repeat(52))
    console.log('现在回到 Magpie，选「远程浏览器登录」，地址填：')
    console.log(`\n    127.0.0.1:${remotePort}\n`)
    console.log(`然后在这个刚打开的 Chrome 窗口里登录 Breeze，插件会自动读取登录态。`)
    console.log('='.repeat(52) + '\n')
  }, 2500)
}

// 只在直接执行时跑，被 import 时（比如测试）不跑
if (process.argv[1] && process.argv[1].endsWith('remote-login.mjs')) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error))
    process.exit(1)
  })
}

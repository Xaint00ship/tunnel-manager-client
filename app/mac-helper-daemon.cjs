#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const HELPER_VERSION = '1'

let current = null
let server = null
let daemonLogFile = null

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function log(line) {
  const text = `${new Date().toISOString()} [helper] ${line}\n`
  if (!daemonLogFile) return process.stderr.write(text)
  try {
    fs.appendFileSync(daemonLogFile, text)
  } catch {
    process.stderr.write(text)
  }
}

function readToken(tokenFile) {
  return fs.readFileSync(tokenFile, 'utf8').trim()
}

function configFromArgs(args) {
  const index = args.indexOf('-c')
  return index >= 0 ? args[index + 1] : null
}

function runtimeFiles(args) {
  const config = configFromArgs(args)
  const dir = config ? path.dirname(config) : os.tmpdir()
  const base = config ? path.basename(config) : `magnetgate-vpn-${process.pid}.json`
  return {
    pidFile: path.join(dir, `${base}.privileged.pid`),
    logFile: path.join(dir, `${base}.privileged.log`)
  }
}

function pidExists(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

async function waitUntilGone(pid, timeoutMs = 5000) {
  const started = Date.now()
  while (pidExists(pid) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !pidExists(pid)
}

async function stopPid(pid) {
  if (!pid || !pidExists(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    if (err.code !== 'ESRCH') throw err
  }
  if (await waitUntilGone(pid)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch (err) {
    if (err.code !== 'ESRCH') throw err
  }
  await waitUntilGone(pid, 1000)
}

async function stopCurrent(pid = null) {
  const target = pid || current?.pid
  if (!target) return { stopped: false }
  await stopPid(target)
  if (!current || current.pid === target) {
    current?.logStream?.end()
    current = null
  }
  return { stopped: true }
}

async function startVpn({ exe, args, cwd }) {
  if (!path.isAbsolute(exe)) throw new Error('engine path must be absolute')
  if (!Array.isArray(args)) throw new Error('engine args must be an array')
  await stopCurrent()
  const { pidFile, logFile } = runtimeFiles(args)
  await fsp.mkdir(path.dirname(logFile), { recursive: true })
  await Promise.allSettled([fsp.unlink(pidFile), fsp.unlink(logFile)])
  const logStream = fs.createWriteStream(logFile, { flags: 'a', mode: 0o644 })
  const child = spawn(exe, args, {
    cwd,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise((resolve, reject) => {
    let done = false
    const finish = (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      err ? reject(err) : resolve()
    }
    const timer = setTimeout(() => finish(), 300)
    child.once('spawn', () => finish())
    child.once('error', finish)
  })
  current = { child, pid: child.pid, pidFile, logFile, logStream }
  await fsp.writeFile(pidFile, `${child.pid}\n`, { mode: 0o644 })
  child.stdout.pipe(logStream, { end: false })
  child.stderr.pipe(logStream, { end: false })
  child.once('exit', (code, signal) => {
    logStream.write(`\n[helper] sing-box exited code=${code} signal=${signal || ''}\n`)
    logStream.end()
    if (current?.child === child) current = null
  })
  child.once('error', (err) => {
    logStream.write(`\n[helper] sing-box error: ${err.message}\n`)
  })
  log(`started sing-box pid=${child.pid}`)
  return { pid: child.pid, pidFile, logFile }
}

async function handleRequest(request, tokenFile) {
  const token = readToken(tokenFile)
  if (request.token !== token) throw new Error('unauthorized')
  if (request.op === 'ping') return { version: HELPER_VERSION, pid: current?.pid || null }
  if (request.op === 'start') return startVpn(request)
  if (request.op === 'stop') return stopCurrent(Number(request.pid))
  if (request.op === 'status')
    return { version: HELPER_VERSION, pid: current?.pid || null, running: pidExists(current?.pid) }
  throw new Error(`unknown op: ${request.op}`)
}

function writeResponse(socket, value) {
  socket.end(JSON.stringify(value) + '\n')
}

async function main() {
  if (process.argv.includes('--version')) {
    process.stdout.write(HELPER_VERSION + '\n')
    return
  }
  if (!process.argv.includes('--daemon')) throw new Error('usage: mac-helper-daemon.cjs --daemon')
  const socketPath = argValue('--socket')
  const tokenFile = argValue('--token-file')
  daemonLogFile = argValue('--log-file')
  if (!socketPath || !tokenFile || !daemonLogFile) throw new Error('missing helper arguments')
  await fsp.mkdir(path.dirname(socketPath), { recursive: true })
  await fsp.mkdir(path.dirname(daemonLogFile), { recursive: true })
  await fsp.rm(socketPath, { force: true })
  server = net.createServer((socket) => {
    let buffer = ''
    socket.on('data', async (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index < 0) return
      const line = buffer.slice(0, index)
      buffer = ''
      try {
        const request = JSON.parse(line)
        const result = await handleRequest(request, tokenFile)
        writeResponse(socket, { ok: true, ...result })
      } catch (err) {
        log(`request failed: ${err.message}`)
        writeResponse(socket, { ok: false, error: err.message })
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  fs.chmodSync(socketPath, 0o666)
  log(`listening on ${socketPath}`)
}

async function shutdown() {
  try {
    await stopCurrent()
  } catch (err) {
    log(`shutdown stop failed: ${err.message}`)
  }
  server?.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

main().catch((err) => {
  log(err.stack || err.message)
  process.exit(1)
})

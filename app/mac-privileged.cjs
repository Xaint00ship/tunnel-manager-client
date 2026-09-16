const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function appleScriptString(value) {
  // The generated shell snippets use single-quote shell escaping, so the AppleScript string only
  // needs double-quote/backslash/newline escaping.
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

function runAdmin(command, { spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      'osascript',
      ['-e', `do shell script ${appleScriptString(command)} with administrator privileges`],
      { windowsHide: true }
    )
    let output = ''
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (b) => {
        if (output.length < 131072) output += b
      })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(output.trim())
      else reject(new Error(output.trim() || `administrator command failed (${code})`))
    })
  })
}

function runtimeFiles(args) {
  const config = args[args.indexOf('-c') + 1]
  const dir = config ? path.dirname(config) : os.tmpdir()
  const base = config ? path.basename(config) : `magnetgate-vpn-${process.pid}.json`
  return {
    pidFile: path.join(dir, `${base}.privileged.pid`),
    logFile: path.join(dir, `${base}.privileged.log`)
  }
}

function buildStartCommand(exe, args, options = {}) {
  const { pidFile, logFile } = runtimeFiles(args)
  const cwd = options.cwd || process.cwd()
  return {
    pidFile,
    logFile,
    command: [
      `cd ${shellQuote(cwd)}`,
      `rm -f ${shellQuote(pidFile)} ${shellQuote(logFile)}`,
      `(${[
        "trap '' HUP;",
        shellQuote(exe),
        ...args.map(shellQuote),
        '</dev/null',
        `>${shellQuote(logFile)}`,
        '2>&1',
        '&',
        `echo $! > ${shellQuote(pidFile)}`
      ].join(' ')})`,
      `chmod 644 ${shellQuote(pidFile)} ${shellQuote(logFile)} 2>/dev/null || true`
    ].join(' && ')
  }
}

function buildStopCommand(pid) {
  const quoted = shellQuote(String(pid))
  return [
    `kill -TERM ${quoted} 2>/dev/null || true`,
    'i=0',
    `while kill -0 ${quoted} 2>/dev/null && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.1; done`,
    `if kill -0 ${quoted} 2>/dev/null; then kill -KILL ${quoted} 2>/dev/null || true; fi`
  ].join('; ')
}

function pidExists(pid, { kill = process.kill } = {}) {
  if (!pid) return false
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

function watchLog(child, logFile, { readFile = fsp.readFile, stat = fsp.stat } = {}) {
  let offset = 0
  const flush = async () => {
    try {
      const info = await stat(logFile)
      if (info.size < offset) offset = 0
      if (info.size === offset) return
      const data = await readFile(logFile)
      const chunk = data.subarray(offset)
      offset = data.length
      if (chunk.length) child.stderr.write(chunk)
    } catch {}
  }
  const timer = setInterval(flush, 250)
  timer.unref?.()
  child.once('exit', () => clearInterval(timer))
  void flush()
}

function finishChild(child, code, signal = null) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.exitCode = code
  child.signalCode = signal
  child.emit('exit', code, signal)
  child.stdout.end()
  child.stderr.end()
}

function spawnMacPrivileged(exe, args, options = {}, deps = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 0
  child.exitCode = null
  child.signalCode = null
  child.killed = false
  const run = deps.runAdmin || runAdmin
  const readFile = deps.readFile || fsp.readFile
  const exists = deps.pidExists || pidExists
  const { command, pidFile, logFile } = buildStartCommand(exe, args, options)

  child.kill = (signal = 'SIGTERM') => {
    child.killed = true
    if (!child.rootPid) return false
    void stopMacPrivileged(child, { runAdmin: run, signal }).catch((err) => child.emit('error', err))
    return true
  }

  queueMicrotask(async () => {
    try {
      await run(command)
      const text = await readFile(pidFile, 'utf8')
      const pid = Number(text.trim())
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Privileged VPN process did not report a PID')
      child.pid = pid
      child.rootPid = pid
      child.pidFile = pidFile
      child.logFile = logFile
      child.stderr.write(`Started privileged VPN process ${pid}\n`)
      watchLog(child, logFile, deps)
      const timer = setInterval(() => {
        if (child.exitCode !== null || child.signalCode !== null) return clearInterval(timer)
        if (!exists(pid)) {
          clearInterval(timer)
          finishChild(child, child.killed ? 0 : 1)
        }
      }, 1000)
      timer.unref?.()
      child.once('exit', () => clearInterval(timer))
    } catch (err) {
      child.stderr.write(String(err?.message || err) + '\n')
      child.emit('error', err)
      finishChild(child, 1)
    }
  })
  return child
}

async function stopMacPrivileged(child, { runAdmin: run = runAdmin } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.killed = true
  const pid = child.rootPid || child.pid
  if (!pid) {
    finishChild(child, 0)
    return
  }
  await run(buildStopCommand(pid))
  finishChild(child, 0, 'SIGTERM')
}

module.exports = {
  spawnMacPrivileged,
  stopMacPrivileged,
  shellQuote,
  buildStartCommand,
  buildStopCommand,
  pidExists
}

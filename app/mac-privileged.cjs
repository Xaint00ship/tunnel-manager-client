const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')

const HELPER_VERSION = '1'
const HELPER_LABEL = 'org.magnetgate.privileged-helper'
const HELPER_PLIST = `/Library/LaunchDaemons/${HELPER_LABEL}.plist`
const HELPER_SOCKET = '/private/var/run/magnetgate/helper.sock'
const DEFAULT_TIMEOUT_MS = 7000

let helperReady = null

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
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

function helperFiles(args) {
  const config = configFromArgs(args)
  const logDir = config ? path.dirname(config) : os.tmpdir()
  const userData = config ? path.dirname(logDir) : os.tmpdir()
  return {
    tokenFile: path.join(userData, 'mac-helper.token'),
    helperLogFile: path.join(logDir, 'mac-helper.log'),
    socketPath: HELPER_SOCKET
  }
}

function helperScriptPath(base = __dirname) {
  const packed = path.join(base, 'mac-helper-daemon.cjs')
  return packed.includes(`${path.sep}app.asar${path.sep}`)
    ? packed.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    : packed
}

function buildLaunchDaemonPlist({
  execPath = process.execPath,
  scriptPath = helperScriptPath(),
  socketPath = HELPER_SOCKET,
  tokenFile,
  helperLogFile
}) {
  const args = [
    execPath,
    scriptPath,
    '--daemon',
    '--socket',
    socketPath,
    '--token-file',
    tokenFile,
    '--log-file',
    helperLogFile
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(HELPER_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(helperLogFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(helperLogFile)}</string>
</dict>
</plist>
`
}

function buildInstallCommand(tempPlist, { socketPath = HELPER_SOCKET } = {}) {
  return [
    `install -d -m 755 ${shellQuote(path.dirname(socketPath))}`,
    `cp ${shellQuote(tempPlist)} ${shellQuote(HELPER_PLIST)}`,
    `chown root:wheel ${shellQuote(HELPER_PLIST)}`,
    `chmod 644 ${shellQuote(HELPER_PLIST)}`,
    `{ launchctl bootout system ${shellQuote(HELPER_PLIST)} >/dev/null 2>&1 || true; }`,
    `launchctl bootstrap system ${shellQuote(HELPER_PLIST)}`,
    `launchctl kickstart -k system/${shellQuote(HELPER_LABEL)}`
  ].join(' && ')
}

async function ensureToken(tokenFile, { randomBytes = crypto.randomBytes } = {}) {
  try {
    return (await fsp.readFile(tokenFile, 'utf8')).trim()
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  await fsp.mkdir(path.dirname(tokenFile), { recursive: true })
  const token = randomBytes(32).toString('hex')
  try {
    await fsp.writeFile(tokenFile, token + '\n', { mode: 0o600, flag: 'wx' })
    return token
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    return (await fsp.readFile(tokenFile, 'utf8')).trim()
  }
}

function requestHelper(payload, { socketPath = HELPER_SOCKET, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath)
    let buffer = '',
      done = false
    const finish = (err, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      client.destroy()
      err ? reject(err) : resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('privileged helper timeout')), timeoutMs)
    client.once('error', (err) => finish(err))
    client.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index < 0) return
      try {
        const response = JSON.parse(buffer.slice(0, index))
        if (response.ok) finish(null, response)
        else finish(new Error(response.error || 'privileged helper failed'))
      } catch (err) {
        finish(err)
      }
    })
    client.once('connect', () => client.write(JSON.stringify(payload) + '\n'))
  })
}

async function installHelper(args, deps = {}) {
  const { tokenFile, helperLogFile, socketPath } = helperFiles(args)
  const token = await ensureToken(tokenFile, deps)
  const scriptPath = deps.scriptPath || helperScriptPath(deps.baseDir || __dirname)
  const execPath = deps.execPath || process.execPath
  const tempPlist = path.join(path.dirname(tokenFile), `${HELPER_LABEL}.plist`)
  await fsp.mkdir(path.dirname(helperLogFile), { recursive: true })
  await fsp.writeFile(
    tempPlist,
    buildLaunchDaemonPlist({ execPath, scriptPath, socketPath, tokenFile, helperLogFile }),
    { mode: 0o600 }
  )
  await (deps.runAdmin || runAdmin)(buildInstallCommand(tempPlist, { socketPath }))
  return { token, tokenFile, helperLogFile, socketPath, scriptPath, execPath }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function pingHelper(context, deps = {}) {
  const request = deps.requestHelper || requestHelper
  const response = await request(
    { op: 'ping', token: context.token },
    { socketPath: context.socketPath, timeoutMs: 1500 }
  )
  if (response.version !== HELPER_VERSION) throw new Error('privileged helper version mismatch')
  return response
}

async function ensureHelper(args, deps = {}) {
  const { tokenFile, helperLogFile, socketPath } = helperFiles(args)
  const token = await ensureToken(tokenFile, deps)
  const context = {
    token,
    tokenFile,
    helperLogFile,
    socketPath,
    scriptPath: deps.scriptPath || helperScriptPath(deps.baseDir || __dirname),
    execPath: deps.execPath || process.execPath
  }
  try {
    await pingHelper(context, deps)
    return context
  } catch {}
  const installed = await installHelper(args, deps)
  let last
  for (let i = 0; i < 20; i++) {
    try {
      await pingHelper(installed, deps)
      return installed
    } catch (err) {
      last = err
      await delay(250)
    }
  }
  throw new Error(`privileged helper did not start: ${last?.message || 'unknown error'}`)
}

function helperOnce(args, deps = {}) {
  if (!helperReady)
    helperReady = ensureHelper(args, deps).catch((err) => {
      helperReady = null
      throw err
    })
  return helperReady
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
  const request = deps.requestHelper || requestHelper
  const exists = deps.pidExists || pidExists

  child.kill = () => {
    child.killed = true
    if (!child.rootPid) return false
    void stopMacPrivileged(child, deps).catch((err) => child.emit('error', err))
    return true
  }

  queueMicrotask(async () => {
    try {
      const context = await (deps.ensureHelper || helperOnce)(args, deps)
      const response = await request(
        {
          op: 'start',
          token: context.token,
          exe,
          args,
          cwd: options.cwd || process.cwd()
        },
        { socketPath: context.socketPath, timeoutMs: DEFAULT_TIMEOUT_MS }
      )
      const pid = Number(response.pid)
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Privileged VPN process did not report a PID')
      child.pid = pid
      child.rootPid = pid
      child.pidFile = response.pidFile
      child.logFile = response.logFile
      child.helperContext = context
      child.stderr.write(`Started privileged VPN process ${pid}\n`)
      watchLog(child, response.logFile, deps)
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

async function stopMacPrivileged(child, deps = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.killed = true
  const pid = child.rootPid || child.pid
  if (!pid) {
    finishChild(child, 0)
    return
  }
  const context =
    child.helperContext ||
    (await (deps.ensureHelper || helperOnce)(['run', '-c', child.configPath || child.pidFile || ''], deps))
  await (deps.requestHelper || requestHelper)(
    { op: 'stop', token: context.token, pid },
    { socketPath: context.socketPath, timeoutMs: DEFAULT_TIMEOUT_MS }
  )
  finishChild(child, 0, 'SIGTERM')
}

module.exports = {
  HELPER_LABEL,
  HELPER_PLIST,
  HELPER_SOCKET,
  HELPER_VERSION,
  spawnMacPrivileged,
  stopMacPrivileged,
  shellQuote,
  appleScriptString,
  buildInstallCommand,
  buildLaunchDaemonPlist,
  ensureHelper,
  helperFiles,
  helperScriptPath,
  pidExists,
  requestHelper,
  runtimeFiles
}

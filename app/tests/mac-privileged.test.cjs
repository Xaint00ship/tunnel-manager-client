const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const {
  HELPER_LABEL,
  HELPER_PLIST,
  HELPER_SOCKET,
  HELPER_VERSION,
  buildInstallCommand,
  buildLaunchDaemonPlist,
  ensureHelper,
  helperFiles,
  helperScriptPath,
  runtimeFiles,
  shellQuote,
  spawnMacPrivileged,
  stopMacPrivileged
} = require('../mac-privileged.cjs')

test('shellQuote keeps paths with spaces as one argument', () => {
  assert.equal(shellQuote("/tmp/a b/it's.json"), "'/tmp/a b/it'\\''s.json'")
})

test('runtime and helper files are derived from the VPN config location', () => {
  const config = path.join(os.tmpdir(), 'Tunnel Manager Client', 'logs', 'vpn-config.json')
  assert.deepEqual(runtimeFiles(['run', '-c', config]), {
    pidFile: `${config}.privileged.pid`,
    logFile: `${config}.privileged.log`
  })
  assert.deepEqual(helperFiles(['run', '-c', config]), {
    tokenFile: path.join(os.tmpdir(), 'Tunnel Manager Client', 'mac-helper.token'),
    helperLogFile: path.join(os.tmpdir(), 'Tunnel Manager Client', 'logs', 'mac-helper.log'),
    socketPath: HELPER_SOCKET
  })
})

test('helperScriptPath uses the asar.unpacked helper in packaged apps', () => {
  const base = path.join('/Applications/magnetgate.app/Contents/Resources/app.asar')
  assert.equal(
    helperScriptPath(base),
    '/Applications/magnetgate.app/Contents/Resources/app.asar.unpacked/mac-helper-daemon.cjs'
  )
})

test('launch daemon plist runs the helper as node through Electron', () => {
  const plist = buildLaunchDaemonPlist({
    execPath: '/Applications/magnetgate.app/Contents/MacOS/magnetgate',
    scriptPath: '/Applications/magnetgate.app/Contents/Resources/app.asar.unpacked/mac-helper-daemon.cjs',
    tokenFile: '/Users/me/Library/Application Support/Tunnel Manager Client/mac-helper.token',
    helperLogFile: '/Users/me/Library/Application Support/Tunnel Manager Client/logs/mac-helper.log'
  })
  assert.match(plist, new RegExp(`<string>${HELPER_LABEL}</string>`))
  assert.match(plist, /<key>ELECTRON_RUN_AS_NODE<\/key>/)
  assert.match(plist, /mac-helper-daemon\.cjs/)
  assert.match(plist, /mac-helper\.token/)
  assert.match(plist, /mac-helper\.log/)
})

test('install command replaces the exact helper LaunchDaemon', () => {
  const command = buildInstallCommand('/tmp/org.magnetgate.privileged-helper.plist')
  assert.match(command, new RegExp(shellQuote(HELPER_PLIST).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(command, /launchctl bootout system/)
  assert.match(command, /launchctl bootstrap system/)
  assert.match(command, /launchctl kickstart -k system\/'org\.magnetgate\.privileged-helper'/)
})

test('ensureHelper installs the daemon once when ping is unavailable', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magnetgate-helper-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const config = path.join(dir, 'logs', 'vpn-config.json')
  const calls = []
  const context = await ensureHelper(['run', '-c', config], {
    execPath: '/Applications/magnetgate.app/Contents/MacOS/magnetgate',
    scriptPath: '/Applications/magnetgate.app/Contents/Resources/app.asar.unpacked/mac-helper-daemon.cjs',
    randomBytes: () => Buffer.alloc(32, 7),
    runAdmin: async (command) => calls.push(['admin', command]),
    requestHelper: async (payload) => {
      calls.push(['request', payload.op])
      if (calls.filter((c) => c[0] === 'request').length === 1) throw new Error('offline')
      return { ok: true, version: HELPER_VERSION }
    }
  })
  assert.equal(context.token, '0707070707070707070707070707070707070707070707070707070707070707')
  assert.equal(calls[0][1], 'ping')
  assert.equal(calls[1][0], 'admin')
  assert.equal(calls[2][1], 'ping')
})

test('spawnMacPrivileged starts through the already installed helper', async () => {
  const requests = []
  const child = spawnMacPrivileged(
    '/Applications/magnetgate.app/Contents/Resources/tools/sing-box/sing-box',
    ['run', '-c', '/tmp/vpn.json'],
    { cwd: '/Applications/magnetgate.app/Contents/Resources/tools/sing-box' },
    {
      ensureHelper: async () => ({ token: 'secret', socketPath: '/tmp/helper.sock' }),
      requestHelper: async (payload, options) => {
        requests.push({ payload, options })
        return {
          ok: true,
          pid: 777,
          pidFile: '/tmp/vpn.json.privileged.pid',
          logFile: '/tmp/vpn.json.privileged.log'
        }
      },
      stat: async () => ({ size: 0 }),
      pidExists: () => true
    }
  )
  const [chunk] = await once(child.stderr, 'data')
  assert.match(String(chunk), /Started privileged VPN process 777/)
  assert.equal(child.pid, 777)
  assert.deepEqual(requests[0].payload, {
    op: 'start',
    token: 'secret',
    exe: '/Applications/magnetgate.app/Contents/Resources/tools/sing-box/sing-box',
    args: ['run', '-c', '/tmp/vpn.json'],
    cwd: '/Applications/magnetgate.app/Contents/Resources/tools/sing-box'
  })
  assert.equal(requests[0].options.socketPath, '/tmp/helper.sock')
})

test('spawnMacPrivileged surfaces helper installation failures', async () => {
  const child = spawnMacPrivileged('sing-box', ['run', '-c', '/tmp/vpn.json'], {}, {
    ensureHelper: async () => {
      throw new Error('User canceled')
    }
  })
  const [err] = await once(child, 'error')
  assert.match(err.message, /User canceled/)
  assert.equal(child.exitCode, 1)
})

test('stopMacPrivileged uses the captured root pid through the helper', async () => {
  const requests = []
  const child = spawnMacPrivileged('sing-box', ['run', '-c', '/tmp/vpn.json'], {}, {
    ensureHelper: async () => ({ token: 'secret', socketPath: '/tmp/helper.sock' }),
    requestHelper: async (payload) => {
      requests.push(payload)
      return {
        ok: true,
        pid: 777,
        pidFile: '/tmp/vpn.json.privileged.pid',
        logFile: '/tmp/vpn.json.privileged.log'
      }
    },
    stat: async () => ({ size: 0 }),
    pidExists: () => true
  })
  await once(child.stderr, 'data')
  await stopMacPrivileged(child, {
    requestHelper: async (payload) => {
      requests.push(payload)
      return { ok: true, stopped: true }
    }
  })
  assert.equal(child.exitCode, 0)
  assert.deepEqual(requests.at(-1), { op: 'stop', token: 'secret', pid: 777 })
})

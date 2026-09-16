const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')
const os = require('node:os')
const {
  buildStartCommand,
  buildStopCommand,
  spawnMacPrivileged,
  stopMacPrivileged,
  shellQuote
} = require('../mac-privileged.cjs')

test('shellQuote keeps paths with spaces as one argument', () => {
  assert.equal(shellQuote("/tmp/a b/it's.json"), "'/tmp/a b/it'\\''s.json'")
})

test('privileged start command backgrounds sing-box and writes pid/log files next to config', () => {
  const config = path.join(os.tmpdir(), 'Tunnel Manager Client', 'vpn-config.json')
  const { command, pidFile, logFile } = buildStartCommand(
    '/Applications/magnetgate.app/Contents/Resources/tools/sing-box/sing-box',
    ['run', '-c', config],
    { cwd: '/Applications/magnetgate.app/Contents/Resources/tools/sing-box' }
  )
  assert.equal(pidFile, `${config}.privileged.pid`)
  assert.equal(logFile, `${config}.privileged.log`)
  assert.match(command, /trap '' HUP/)
  assert.match(command, /<\/dev\/null/)
  assert.match(command, /& echo \$!/)
  assert.match(command, /chmod 644/)
  assert.ok(command.includes(shellQuote(config)))
})

test('privileged stop command terminates and then kills a stuck process', () => {
  const command = buildStopCommand(123)
  assert.match(command, /kill -TERM '123'/)
  assert.match(command, /kill -KILL '123'/)
})

test('spawnMacPrivileged surfaces administrator prompt failures', async () => {
  const child = spawnMacPrivileged('sing-box', ['run', '-c', '/tmp/vpn.json'], {}, {
    runAdmin: async () => {
      throw new Error('User canceled')
    }
  })
  const [err] = await once(child, 'error')
  assert.match(err.message, /User canceled/)
  assert.equal(child.exitCode, 1)
})

test('stopMacPrivileged uses the captured root pid', async () => {
  const commands = []
  const child = spawnMacPrivileged('sing-box', ['run', '-c', '/tmp/vpn.json'], {}, {
    runAdmin: async (command) => {
      commands.push(command)
    },
    readFile: async () => '777\n',
    stat: async () => ({ size: 0 }),
    pidExists: () => true
  })
  const [chunk] = await once(child.stderr, 'data')
  assert.match(String(chunk), /Started privileged VPN process 777/)
  await stopMacPrivileged(child, {
    runAdmin: async (command) => {
      commands.push(command)
    }
  })
  assert.equal(child.exitCode, 0)
  assert.match(commands.at(-1), /kill -TERM '777'/)
})

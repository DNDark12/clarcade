import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDaemonClient } from '../plugins/clarcade/hooks/daemon-client.js'
import { parseLink, roomLinks } from '../plugins/clarcade/hooks/link.js'

test('invites round trip and only accept an entire short or direct link', () => {
  const { link, directLink } = roomLinks('K7M2QX', '192.168.0.2', 52000)
  assert.deepEqual(parseLink(link), { roomCode: 'K7M2QX' })
  assert.deepEqual(parseLink(directLink), { roomCode: 'K7M2QX', address: '192.168.0.2', port: 52000 })
  assert.equal(parseLink(`Mở ${link} nhé`), null)
  assert.equal(parseLink(`${link}@192.168.0.2:65536`), null)
  assert.equal(parseLink(`${link}@192.168.000.2:42`), null)
  assert.equal(parseLink(`${link}@192.168.256.2:42`), null)
})

test('polling locates the socket without starting a daemon, while Host starts it', async () => {
  const runs = []
  const calls = []
  const emulator = {
    plugin: { root: '/local/clarcade' },
    session: { id: async () => 'thread-A' },
    env: { get: async () => '/profiles/dev' },
    process: { run: async (argv, options) => {
      runs.push({ argv, options })
      return { exitCode: 0, stdout: '{"socketPath":"/tmp/test.sock"}' }
    } },
    http: { fetch: async (url, options) => {
      calls.push({ url, options })
      return { status: 204, text: '' }
    } },
  }
  const client = createDaemonClient(emulator, { nodePath: '/tools/node', udpPort: 48900 })
  assert.deepEqual(await client.request('/state?v=one%3A0'), { status: 204, body: null })
  await client.request('/host', { roomName: 'A', name: 'B' })

  assert.deepEqual(runs.map(run => run.argv), [
    ['/tools/node', '/local/clarcade/helper/launch.mjs', '--udp-port', '48900', '--locate'],
    ['/tools/node', '/local/clarcade/helper/launch.mjs', '--udp-port', '48900'],
  ])
  assert.deepEqual(runs[0].options.env, { CLAUDE_CONFIG_DIR: '/profiles/dev' })
  assert.equal(calls[0].options.socketPath, '/tmp/test.sock')
  assert.equal(calls[1].options.headers['x-clarcade-thread'], 'thread-A')
  assert.equal(calls[1].options.method, 'POST')
})

test('missing Node is cached for one minute and manual recovery can retry immediately', async () => {
  let now = 0
  let probes = 0
  let installed = false
  const client = createDaemonClient({
    plugin: { root: '/local/clarcade' }, env: { get: async () => undefined },
    clock: { now: async () => now }, session: { id: async () => 'thread-A' },
    process: { run: async argv => {
      if (argv[0].endsWith('/node')) return { exitCode: 0, stdout: '{"socketPath":"/tmp/test.sock"}' }
      probes++
      return { exitCode: installed ? 0 : 1, stdout: installed ? '/usr/bin/node\n' : '' }
    } },
    http: { fetch: async () => ({ status: 204, text: '' }) },
  })
  const poll = () => client.request('/state')
  await assert.rejects(poll, /could not find Node/)
  assert.equal(probes, 2)
  now = 59_999
  await assert.rejects(poll, /could not find Node/)
  assert.equal(probes, 2)
  now = 60_000
  await assert.rejects(poll, /could not find Node/)
  assert.equal(probes, 4)
  installed = true
  await client.start({ retryNode: true })
  assert.equal(probes, 5)
  assert.equal((await poll()).status, 204)
})

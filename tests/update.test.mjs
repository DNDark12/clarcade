import assert from 'node:assert/strict'
import test from 'node:test'
import { AUTO_UPDATE_EVERY_MS, autoUpdate, updatePlugin } from '../plugins/clarcade/hooks/update.js'

const ROOT = '/home/an/.claude/plugins/cache/clarcade/clarcade/0.1.4'

// A stand-in for the capability object register.tsx builds from `$`.
function fakeApi({ installs, run, env = {}, now = 1_000_000_000, store = {} } = {}) {
  const calls = []
  const state = { installs: installs ?? [{ scope: 'user', installPath: ROOT, version: '0.1.4' }], store: { ...store } }
  const api = {
    plugin: { root: ROOT },
    env: { get: async key => ({ HOME: '/home/an', ...env })[key] },
    fs: {
      read: async path => {
        assert.equal(path, '/home/an/.claude/plugins/installed_plugins.json')
        return JSON.stringify({ plugins: { 'clarcade@clarcade': state.installs } })
      },
      stat: async () => { throw new Error('no such file') },
    },
    process: {
      run: async (argv, init) => {
        calls.push({ argv, init })
        if (argv[0] === '/bin/sh') return { exitCode: 0, stdout: '4242\n', stderr: '' }
        if (argv[0] === '/bin/ps') return { exitCode: 1, stdout: '', stderr: '' }
        return run ? run(argv, state) : { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    clock: { now: async () => now },
    store: { get: async key => state.store[key], set: async (key, value) => { state.store[key] = value } },
  }
  return { api, calls, state }
}

const cliCalls = calls => calls.filter(call => !call.argv[0].startsWith('/bin/')).map(call => call.argv)

test('refreshes the marketplace, then updates the plugin in its scope, and reports the new version', async () => {
  const { api, calls } = fakeApi({
    env: { CLAUDE_CODE_EXECPATH: '/Applications/Claude.app/claude' },
    run: (argv, state) => {
      if (argv.includes('update') && argv.includes('clarcade@clarcade')) state.installs = [{ ...state.installs[0], version: '0.1.5' }]
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })
  assert.deepEqual(await updatePlugin(api), { status: 'updated', from: '0.1.4', to: '0.1.5' })
  assert.deepEqual(cliCalls(calls), [
    ['/Applications/Claude.app/claude', 'plugin', 'marketplace', 'update', 'clarcade'],
    ['/Applications/Claude.app/claude', 'plugin', 'update', 'clarcade@clarcade', '--scope', 'user'],
  ])
})

test('says so when the newest version is already installed', async () => {
  const { api } = fakeApi()
  assert.deepEqual(await updatePlugin(api), { status: 'current', version: '0.1.4', marketplace: 'clarcade' })
})

test('a copy not installed from a marketplace does not run the CLI', async () => {
  const { api, calls } = fakeApi({ installs: [{ scope: 'user', installPath: '/elsewhere', version: '0.1.4' }] })
  assert.deepEqual(await updatePlugin(api), { status: 'not-installed' })
  assert.deepEqual(cliCalls(calls), [])
})

test('stops at the failing step and reports its exit code', async () => {
  const { api } = fakeApi({
    run: argv => argv.includes('marketplace') ? { exitCode: 0, stdout: '', stderr: '' }
      : { exitCode: 3, stdout: '', stderr: 'network down' },
  })
  assert.deepEqual(await updatePlugin(api), { status: 'failed', step: 'plugin update', code: 3, detail: 'network down' })
})

test('reports a missing CLI when no candidate starts', async () => {
  const { api } = fakeApi({ run: () => { throw new Error('spawn claude ENOENT') } })
  const result = await updatePlugin(api)
  assert.equal(result.status, 'no-cli')
  assert.match(result.detail, /ENOENT/)
})

test('a project install is updated from its own project folder', async () => {
  const { api, calls } = fakeApi({ installs: [{ scope: 'project', projectPath: '/work/app', installPath: ROOT, version: '0.1.4' }] })
  await updatePlugin(api)
  const cli = calls.filter(call => !call.argv[0].startsWith('/bin/'))
  assert.ok(cli.every(call => call.init.cwd === '/work/app'))
  assert.deepEqual(cli[1].argv.slice(-2), ['--scope', 'project'])
})

test('the automatic update runs on each session start, skips one soon after the last check, claims the time first, and skips a game or disabled traffic', async () => {
  const interval = AUTO_UPDATE_EVERY_MS
  const fresh = fakeApi({ now: 10 * interval })
  assert.equal((await autoUpdate(fresh.api, { busy: () => false }))?.status, 'current')
  assert.deepEqual(fresh.state.store.update, { checkedAt: 10 * interval })

  const recent = fakeApi({ now: 10 * interval, store: { update: { checkedAt: 10 * interval - interval + 1 } } })
  assert.equal(await autoUpdate(recent.api, { busy: () => false }), null)
  assert.deepEqual(cliCalls(recent.calls), [])

  const playing = fakeApi({ now: 10 * interval })
  assert.equal(await autoUpdate(playing.api, { busy: () => true }), null)
  assert.equal(playing.state.store.update, undefined)

  const quiet = fakeApi({ now: 10 * interval, env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
  assert.equal(await autoUpdate(quiet.api, { busy: () => false }), null)
  assert.deepEqual(cliCalls(quiet.calls), [])
})

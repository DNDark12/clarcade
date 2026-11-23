import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CHECK_EVERY_MS, checkForUpdate, chooseApp, compareVersions, installRelease, installedApp, newestRelease,
} from '../plugins/clarcade-chat/bootstrap.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const release = (version, extra = {}) => ({
  tag_name: `clarcade-chat-v${version}`, draft: false, prerelease: false,
  assets: [{ name: `clarcade-chat-${version}.mcpb`, digest: `sha256:${'a'.repeat(64)}`,
    browser_download_url: `https://github.com/DNDark12/clarcade/releases/download/clarcade-chat-v${version}/clarcade-chat-${version}.mcpb` }],
  ...extra,
})

// A stand-in for unzip: writes what a packed extension holds.
const fakeUnzip = (name = 'clarcade-chat', version) => async (_archive, destination) => {
  mkdirSync(join(destination, 'server'), { recursive: true })
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ name, version }))
  writeFileSync(join(destination, 'server', 'server.mjs'), '')
}

function tempApps(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clarcade-chat-update-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'app')
}

test('versions compare by number, not as text', () => {
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0)
  assert.equal(compareVersions('0.1.3', '0.1.3'), 0)
  assert.ok(compareVersions('0.2.0', '1.0.0') < 0)
})

test('picks the newest published release above the running version that has a digest', () => {
  const releases = [
    release('0.1.2'), release('0.1.4'), release('0.1.9', { draft: true }), release('0.1.8', { prerelease: true }),
    release('0.1.7', { assets: [{ name: 'clarcade-chat-0.1.7.mcpb', browser_download_url: 'https://x/y' }] }),
    { tag_name: 'v0.9.0', assets: [] }, release('0.1.5'),
  ]
  assert.deepEqual(newestRelease(releases, '0.1.3'), {
    version: '0.1.5', sha256: 'a'.repeat(64),
    url: 'https://github.com/DNDark12/clarcade/releases/download/clarcade-chat-v0.1.5/clarcade-chat-0.1.5.mcpb',
  })
  assert.equal(newestRelease(releases, '0.1.5'), null)
})

test('installs a verified package, makes it current, and the launcher then prefers it', async t => {
  const apps = tempApps(t)
  const bytes = Buffer.from('package')
  const version = await installRelease({ version: '0.1.5', url: 'https://x', sha256: sha(bytes) }, apps,
    { fetchBytes: async () => bytes, unzip: fakeUnzip(undefined, '0.1.5') })
  assert.equal(version, '0.1.5')
  const installed = installedApp(apps)
  assert.deepEqual(installed, { version: '0.1.5', dir: join(apps, '0.1.5') })
  const bundled = { version: '0.1.3', dir: '/ext' }
  assert.equal(chooseApp(bundled, installed), installed)
  // A newer extension installed by hand wins over an older download.
  assert.equal(chooseApp({ version: '0.1.6', dir: '/ext' }, installed).dir, '/ext')
})

test('refuses a download whose digest does not match, or a package that is not Clarcade for Chat', async t => {
  const apps = tempApps(t)
  await assert.rejects(installRelease({ version: '0.1.5', url: 'https://x', sha256: 'b'.repeat(64) }, apps,
    { fetchBytes: async () => Buffer.from('tampered'), unzip: fakeUnzip(undefined, '0.1.5') }), /digest-mismatch/)
  const bytes = Buffer.from('other')
  await assert.rejects(installRelease({ version: '0.1.5', url: 'https://x', sha256: sha(bytes) }, apps,
    { fetchBytes: async () => bytes, unzip: fakeUnzip('something-else', '0.1.5') }), /bad-package/)
  assert.equal(installedApp(apps), null)
  assert.equal(existsSync(join(apps, '0.1.5')), false)
})

test('a current.json that points at a broken copy is ignored', async t => {
  const apps = tempApps(t)
  mkdirSync(join(apps, '0.1.5'), { recursive: true })
  writeFileSync(join(apps, 'current.json'), JSON.stringify({ version: '0.1.5' }))
  assert.equal(installedApp(apps), null)
})

test('checks on each start, skips a start soon after the last check, and claims it first', async t => {
  const apps = tempApps(t)
  let asked = 0
  const fetchJson = async () => { asked++; return [release('0.1.5')] }
  const install = async item => item.version
  assert.equal(await checkForUpdate({ appsDir: apps, running: '0.1.3', now: 10 * CHECK_EVERY_MS, fetchJson, install }), '0.1.5')
  assert.equal(await checkForUpdate({ appsDir: apps, running: '0.1.3', now: 11 * CHECK_EVERY_MS - 1, fetchJson, install }), null)
  assert.equal(asked, 1)
  assert.equal(JSON.parse(readFileSync(join(apps, 'update.json'), 'utf8')).checkedAt, 10 * CHECK_EVERY_MS)
  assert.equal(await checkForUpdate({ appsDir: apps, running: '0.1.5', now: 11 * CHECK_EVERY_MS, fetchJson, install }), null)
  assert.equal(asked, 2)
})

test('unpacks a real .mcpb with ditto', { skip: process.platform !== 'darwin' }, async t => {
  const apps = tempApps(t)
  const source = join(apps, '..', 'source')
  mkdirSync(join(source, 'server'), { recursive: true })
  writeFileSync(join(source, 'manifest.json'), JSON.stringify({ name: 'clarcade-chat', version: '0.1.5' }))
  writeFileSync(join(source, 'server', 'server.mjs'), '// server\n')
  const archive = join(apps, '..', 'package.mcpb')
  execFileSync('/usr/bin/zip', ['-qr', archive, 'manifest.json', 'server'], { cwd: source })
  const bytes = readFileSync(archive)
  await installRelease({ version: '0.1.5', url: 'https://x', sha256: sha(bytes) }, apps, { fetchBytes: async () => bytes })
  assert.equal(readFileSync(join(apps, '0.1.5', 'server', 'server.mjs'), 'utf8'), '// server\n')
})

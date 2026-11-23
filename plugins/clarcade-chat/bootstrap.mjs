// Entry point of the Clarcade for Chat extension.
//
// Claude Desktop cannot update a side-loaded extension by itself, and an
// extension cannot reinstall itself. So this small launcher runs the newest
// copy of the app it has: the one bundled in the extension, or one it
// downloaded earlier from the GitHub releases of DNDark12/clarcade into its data
// folder. Each time Claude Desktop starts the extension it looks for a newer
// release a few seconds later, checks the download against the SHA-256 digest
// GitHub publishes for it, unpacks it, and the next start of the extension runs
// it. The running copy is never replaced under a game.

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { get } from 'node:https'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

export const REPO = 'DNDark12/clarcade'
export const NAME = 'clarcade-chat'
const TAG = /^clarcade-chat-v(\d+\.\d+\.\d+)$/
// Desktop restarts an extension's server often (a new chat, a reloaded
// window), so checks closer than this to the last one are skipped. That keeps
// well inside GitHub's limit of 60 unauthenticated API calls an hour.
export const CHECK_EVERY_MS = 10 * 60 * 1000
const FIRST_CHECK_MS = 5 * 1000
const MAX_DOWNLOAD = 8 * 1024 * 1024
const KEEP = 2
const execute = promisify(execFile)
const log = message => console.error(`[clarcade-chat] update: ${message}`)

export function compareVersions(left, right) {
  const a = String(left).split('.').map(Number)
  const b = String(right).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  return 0
}

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, path)
}

// The bundled copy: manifest.json beside server/ in a packed extension.
export function bundledApp(serverDir = dirname(fileURLToPath(import.meta.url))) {
  const root = dirname(serverDir)
  const manifest = readJson(join(root, 'manifest.json'))
  return { version: manifest?.version ?? '0.0.0', dir: root }
}

// A downloaded copy counts only when its own manifest says what current.json does.
export function installedApp(appsDir) {
  const current = readJson(join(appsDir, 'current.json'))
  if (!current || typeof current.version !== 'string' || !TAG.test(`${NAME}-v${current.version}`)) return null
  const dir = join(appsDir, current.version)
  const manifest = readJson(join(dir, 'manifest.json'))
  if (manifest?.name !== NAME || manifest.version !== current.version) return null
  if (!existsSync(join(dir, 'server', 'server.mjs'))) return null
  return { version: current.version, dir }
}

export function chooseApp(bundled, installed) {
  return installed && compareVersions(installed.version, bundled.version) > 0 ? installed : bundled
}

// The newest published release above `current` that carries its .mcpb with a digest.
export function newestRelease(releases, current) {
  let best = null
  for (const release of Array.isArray(releases) ? releases : []) {
    const version = TAG.exec(release?.tag_name ?? '')?.[1]
    if (!version || release.draft || release.prerelease || compareVersions(version, current) <= 0) continue
    const asset = release.assets?.find(item => item?.name === `${NAME}-${version}.mcpb`)
    const digest = /^sha256:([0-9a-f]{64})$/.exec(asset?.digest ?? '')?.[1]
    if (!asset || !digest || !/^https:\/\//.test(asset.browser_download_url ?? '')) continue
    if (!best || compareVersions(version, best.version) > 0) {
      best = { version, url: asset.browser_download_url, sha256: digest }
    }
  }
  return best
}

// GET over HTTPS with redirects (release downloads redirect to GitHub's storage).
export function download(url, { limit = MAX_DOWNLOAD, redirects = 5, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { 'user-agent': 'clarcade-chat-updater', ...headers }, timeout: 30000 }, response => {
      const { statusCode = 0, headers: replyHeaders } = response
      if (statusCode >= 300 && statusCode < 400 && replyHeaders.location) {
        response.resume()
        const next = new URL(replyHeaders.location, url).toString()
        if (!redirects || !next.startsWith('https://')) return reject(new Error('bad-redirect'))
        return resolve(download(next, { limit, redirects: redirects - 1, headers }))
      }
      if (statusCode !== 200) {
        response.resume()
        return reject(new Error(`http-${statusCode}`))
      }
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > limit) request.destroy(new Error('too-large'))
        else chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}

// Unpack a verified package into appsDir/<version> and make it current.
export async function installRelease(release, appsDir, { fetchBytes = download, unzip = unzipWithDitto } = {}) {
  const bytes = await fetchBytes(release.url)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== release.sha256) throw new Error('digest-mismatch')
  mkdirSync(appsDir, { recursive: true, mode: 0o700 })
  const target = join(appsDir, release.version)
  if (!existsSync(target)) {
    const work = join(appsDir, `.${release.version}.${randomUUID()}`)
    mkdirSync(work, { mode: 0o700 })
    try {
      const archive = join(work, 'package.mcpb')
      writeFileSync(archive, bytes, { mode: 0o600 })
      const unpacked = join(work, 'app')
      await unzip(archive, unpacked)
      const manifest = readJson(join(unpacked, 'manifest.json'))
      if (manifest?.name !== NAME || manifest.version !== release.version ||
          !existsSync(join(unpacked, 'server', 'server.mjs'))) throw new Error('bad-package')
      renameSync(unpacked, target)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  writeJson(join(appsDir, 'current.json'), { version: release.version })
  prune(appsDir, release.version)
  return release.version
}

async function unzipWithDitto(archive, destination) {
  // The extension runs on macOS only, where ditto unpacks zip archives.
  await execute('/usr/bin/ditto', ['-x', '-k', archive, destination], { timeout: 60000 })
}

// Keep the newest few downloaded copies; a running server may still use an older one.
function prune(appsDir, keep) {
  const versions = readdirSync(appsDir).filter(entry => /^\d+\.\d+\.\d+$/.test(entry))
    .sort(compareVersions).reverse()
  for (const version of versions.slice(KEEP)) {
    if (version !== keep) rmSync(join(appsDir, version), { recursive: true, force: true })
  }
}

// Once per start, at most every CHECK_EVERY_MS, claimed before the network is
// used so servers started together check once.
export async function checkForUpdate({ appsDir, running, now = Date.now(), fetchJson, install = installRelease }) {
  mkdirSync(appsDir, { recursive: true, mode: 0o700 })
  const statePath = join(appsDir, 'update.json')
  const state = readJson(statePath)
  if (Number.isFinite(state?.checkedAt) && now - state.checkedAt < CHECK_EVERY_MS) return null
  writeJson(statePath, { checkedAt: now })
  const releases = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=30`)
  const release = newestRelease(releases, running)
  if (!release) return null
  const version = await install(release, appsDir)
  writeJson(statePath, { checkedAt: now, installed: version })
  return version
}

const fetchJson = async url => JSON.parse((await download(url, {
  limit: 1024 * 1024, headers: { accept: 'application/vnd.github+json' },
})).toString('utf8'))

async function main() {
  const dataDir = process.env.CLARCADE_CHAT_DATA_DIR || join(homedir(), '.clarcade-chat-preview')
  const appsDir = join(dataDir, 'app')
  const app = chooseApp(bundledApp(), installedApp(appsDir))
  console.error(`[clarcade-chat] running ${app.version} from ${app.dir === bundledApp().dir ? 'the extension' : 'the update folder'}`)
  await import(pathToFileURL(join(app.dir, 'server', 'server.mjs')).href)
  if (process.env.CLARCADE_CHAT_AUTO_UPDATE === 'false') return
  setTimeout(() => {
    checkForUpdate({ appsDir, running: app.version, fetchJson })
      .then(version => { if (version) log(`installed ${version}; it runs the next time Claude Desktop starts the extension`) })
      .catch(error => log(`skipped (${error.message})`))
  }, FIRST_CHECK_MS).unref()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()

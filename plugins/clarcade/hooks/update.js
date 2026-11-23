// Updating Clarcade from the marketplace it was installed from, as Agent
// Arbiter's /arbiter update does: refresh the marketplace, then update the
// plugin with the Claude Code CLI. The new version loads after a restart.
//
// `api` is the capability object register.tsx builds from `$`.

const TIMEOUT_MS = 120000
export const AUTO_UPDATE_EVERY_MS = 24 * 60 * 60 * 1000
const trim = path => typeof path === 'string' ? path.replace(/\/+$/, '') : ''

export async function configRoot(api) {
  const configured = await api.env.get('CLAUDE_CONFIG_DIR')
  const path = configured || `${await api.env.get('HOME') || ''}/.claude`
  if (!path.startsWith('/') || path.includes('\0') || path === '/.claude') throw new Error('No absolute Claude config directory')
  return path.replace(/\/+$/, '')
}

async function installations(api) {
  const data = JSON.parse(await api.fs.read(`${await configRoot(api)}/plugins/installed_plugins.json`))
  const plugins = data?.plugins && typeof data.plugins === 'object' ? data.plugins : {}
  return Object.entries(plugins).flatMap(([id, list]) => Array.isArray(list) ? list.map(entry => ({ ...entry, id })) : [])
}

const sameInstall = (left, right) => left.id === right.id && left.scope === right.scope &&
  (left.scope === 'user' || left.projectPath === right.projectPath)

// The installation whose files are running now. A copy loaded from a source
// folder (--plugin-dir, a dev mod) has none and is updated from its source.
export async function currentInstall(api) {
  const root = trim(api.plugin.root)
  try {
    return (await installations(api)).find(entry =>
      trim(entry.installPath) === root && /^[^@\s]+@[^@\s]+$/.test(entry.id)) ?? null
  } catch { return null }
}

// Where the Claude Code CLI may be, best first. The desktop app runs its own
// copy that is not on PATH and sets CLAUDE_CODE_EXECPATH only for its children,
// so the engine's own executable is asked for as well.
export async function executables(api) {
  const found = []
  const add = path => { if (typeof path === 'string' && path && !found.includes(path)) found.push(path) }
  add(await api.env.get('CLAUDE_CODE_EXECPATH'))
  add(await engineExecutable(api))
  add('claude')
  return found
}

// The engine's own executable: the parent of a command it starts. Only the
// shell's own $PPID and absolute tools are used, so nothing on PATH runs, and
// the answer must be a real file named claude.
async function engineExecutable(api) {
  try {
    const shell = await api.process.run(['/bin/sh', '-c', 'echo "$PPID"'], { timeoutMs: 5000 })
    const pid = String(shell.stdout ?? '').trim()
    if (shell.exitCode !== 0 || !/^[1-9][0-9]*$/.test(pid)) return null
    let path = null
    try { path = (await api.fs.stat(`/proc/${pid}/exe`, { resolve: true })).realPath ?? null } catch { /* Not Linux. */ }
    if (!path) {
      const ps = await api.process.run(['/bin/ps', '-o', 'comm=', '-p', pid], { timeoutMs: 5000 })
      path = ps.exitCode === 0 ? String(ps.stdout ?? '').trim() : null
    }
    if (!path?.startsWith('/') || path.split('/').at(-1) !== 'claude') return null
    const file = await api.fs.stat(path, { resolve: true })
    return file.kind === 'file' ? file.realPath || path : null
  } catch { return null }
}

const tail = result => String(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 400)

// Resolves { status, ... }: `not-installed`, `no-cli`, `failed` (step, code,
// detail), `current` (version) or `updated` (from, to).
export async function updatePlugin(api) {
  const install = await currentInstall(api)
  if (!install) return { status: 'not-installed' }
  const marketplace = install.id.slice(install.id.indexOf('@') + 1)
  // A project or local install is updated from its own project folder.
  const init = { timeoutMs: TIMEOUT_MS, ...(install.scope !== 'user' && install.projectPath ? { cwd: install.projectPath } : {}) }
  const steps = [
    ['marketplace update', ['plugin', 'marketplace', 'update', marketplace]],
    ['plugin update', ['plugin', 'update', install.id, ...(install.scope ? ['--scope', install.scope] : [])]],
  ]
  let candidates = await executables(api)
  let failure = ''
  for (const [step, args] of steps) {
    let result = null
    // The first step keeps the first executable that starts; the second reuses it.
    while (!result && candidates.length) {
      try { result = await api.process.run([candidates[0], ...args], init) } catch (error) {
        failure = String(error?.message || error).slice(0, 400)
        candidates = candidates.slice(1)
      }
    }
    if (!result) return step === steps[0][0] ? { status: 'no-cli', detail: failure } : { status: 'failed', step, code: '-', detail: failure }
    candidates = candidates.slice(0, 1)
    if (result.exitCode !== 0) return { status: 'failed', step, code: result.exitCode, detail: tail(result) }
  }
  let after = null
  try { after = (await installations(api)).find(entry => sameInstall(entry, install)) ?? null } catch { /* Report what is known. */ }
  const version = after?.version ?? install.version
  return version === install.version ? { status: 'current', version, marketplace }
    : { status: 'updated', from: install.version, to: version }
}

// At most once a day, and never while a game is on or when the person turned
// nonessential traffic off. The time is claimed before the CLI runs, so a
// second thread that starts meanwhile skips its turn.
export async function autoUpdate(api, { busy }) {
  if (await api.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) return null
  if (busy()) return null
  const now = await api.clock.now()
  const last = await api.store.get('update')
  if (Number.isFinite(last?.checkedAt) && now - last.checkedAt < AUTO_UPDATE_EVERY_MS) return null
  await api.store.set('update', { checkedAt: now })
  return updatePlugin(api)
}

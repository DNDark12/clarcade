import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { record, validId, validPort } from './protocol.mjs'

export const VERSION = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version

// The daemon outlives mod reloads, so the launcher compares these before reusing it.
export const networkKey = options => JSON.stringify([
  options.udpPort, options.loopback, options.allowTailscale, options.allowIpv6Ula,
])

export function olderVersion(running, current) {
  const parse = value => /^(\d+)\.(\d+)\.(\d+)/.exec(typeof value === 'string' ? value : '')?.slice(1).map(Number)
  const a = parse(running)
  const b = parse(current)
  if (!a) return true
  if (!b) return false
  const index = a.findIndex((part, i) => part !== b[i])
  return index >= 0 && a[index] < b[index]
}

export function runtime(args, prepare = true) {
  const options = { '--loopback': false }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (['--loopback', '--allow-tailscale', '--allow-ipv6-ula'].includes(flag)) {
      options[flag] = true
      continue
    }
    if (!['--data-dir', '--udp-port', '--lock-fd'].includes(flag) || !args[i + 1] ||
        args[i + 1].startsWith('--')) throw new Error('Invalid Clarcade helper arguments')
    options[flag] = args[++i]
  }
  const udpPort = Number(options['--udp-port'] ?? 47979)
  if (!validPort(udpPort)) throw new Error('Invalid Clarcade UDP port')
  if (options['--loopback'] && !options['--data-dir']) throw new Error('Loopback requires a dedicated data directory')
  const profile = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const directory = resolve(options['--data-dir'] || join(profile, 'clarcade'))
  if (prepare) privateDirectory(directory)
  let socketPath = join(directory, 'd.sock')
  if (Buffer.byteLength(socketPath) > 100) {
    const suffix = createHash('sha256').update(directory).digest('hex').slice(0, 20)
    const short = join(tmpdir(), `clarcade-${process.getuid()}`, suffix)
    socketPath = join(Buffer.byteLength(join(short, 'd.sock')) <= 100 ? short :
      join('/tmp', `clarcade-${process.getuid()}`, suffix), 'd.sock')
    if (prepare) {
      privateDirectory(resolve(socketPath, '..', '..'))
      privateDirectory(resolve(socketPath, '..'))
    }
  }
  return {
    directory, socketPath, lockPath: join(directory, 'daemon.lock'), udpPort,
    loopback: options['--loopback'], lockFd: Number(options['--lock-fd']),
    allowTailscale: options['--allow-tailscale'] === true,
    allowIpv6Ula: options['--allow-ipv6-ula'] === true,
  }
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const entry = lstatSync(path)
  if (!entry.isDirectory() || entry.uid !== process.getuid()) throw new Error('Invalid Clarcade data directory')
  if ((entry.mode & 0o777) !== 0o700) chmodSync(path, 0o700)
}

export function readJson(path, empty, valid = () => true) {
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return empty
    if (!(error instanceof SyntaxError)) throw error
    quarantine(path, error)
    return empty
  }
  if (valid(value)) return value
  quarantine(path, new Error('unexpected contents'))
  return empty
}

// Keep an unreadable state file for inspection instead of failing every daemon start.
export function quarantine(path, error) {
  const target = `${path}.corrupt-${Date.now()}`
  renameSync(path, target)
  console.error(`[clarcade] moved unreadable ${path} to ${target}: ${error.message}`)
}

export function writeJson(path, value, publish = renameSync) {
  const temporary = `${path}.tmp`
  try {
    const fd = openSync(temporary, 'w', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(value))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    publish(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function playerId(path, link) {
  const valid = value => record(value) && validId(value.playerId)
  let player = readJson(path, null, valid)
  if (!player) {
    try {
      writeJson(path, { playerId: randomUUID() }, link)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    player = readJson(path, null, valid)
  }
  return player.playerId
}

export function health(socketPath) {
  return new Promise(resolveHealth => {
    const request = http.get({ socketPath, path: '/health', timeout: 200 }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        text += chunk
        if (text.length > 1024) request.destroy()
      })
      response.on('end', () => {
        try {
          const reply = JSON.parse(text)
          resolveHealth(response.statusCode === 200 && Number.isInteger(reply.pid) ? reply : null)
        } catch { resolveHealth(null) }
      })
      response.on('error', () => resolveHealth(null))
    })
    request.on('error', () => resolveHealth(null))
    request.on('close', () => resolveHealth(null))
    request.on('timeout', () => request.destroy())
  })
}

import { randomUUID } from 'node:crypto'
import { chmodSync, fstatSync, linkSync, lstatSync, statSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { discover } from './discovery.mjs'
import { name, record } from './protocol.mjs'
import { Room, problem } from './room.mjs'
import { VERSION, networkKey, playerId, runtime } from './runtime.mjs'
import { openStats } from './stats.mjs'

const FOCUS_TTL = 10000
const IDLE_TTL = 10 * 60000
const MAX_BODY = 8192

async function main(options) {
  // The launcher passes the open descriptor through exec; its lifetime is the lock lifetime.
  if (!Number.isInteger(options.lockFd) || options.lockFd < 3) throw new Error('Start Clarcade via launch.mjs')
  const locked = fstatSync(options.lockFd)
  const expected = statSync(options.lockPath)
  if (locked.dev !== expected.dev || locked.ino !== expected.ino) throw new Error('Invalid daemon lock descriptor')

  const boot = randomUUID()
  let revision = 0
  let lastActivity = Date.now()
  let focus = null
  let focusSeen = 0
  let notifications = []
  let stopping = false
  let roomSearch
  const me = playerId(join(options.directory, 'player.json'), linkSync)
  const stats = openStats(join(options.directory, 'stats.json'))
  const room = new Room(options, me, stats, change)
  await room.restore()

  function change(event) {
    revision++
    if (event && focus && Date.now() - focusSeen <= FOCUS_TTL) {
      notifications.push({ id: `${boot}:${revision}`, thread: focus, event })
      notifications = notifications.slice(-32)
    }
  }

  function setFocus(thread) {
    if (focus !== thread) {
      notifications = []
      focus = thread
      change()
    }
    focusSeen = Date.now()
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://clarcade')
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, 200, {
        pid: process.pid, version: VERSION, network: networkKey(options), room: Boolean(room.saved || room.opening),
      })
    }
    const thread = request.headers['x-clarcade-thread']
    if (typeof thread !== 'string' || !/^[\w-]{1,128}$/.test(thread)) throw problem('invalid-thread')
    if (stopping) throw problem('shutting-down', 503)
    lastActivity = Date.now()
    if (request.method === 'GET') {
      switch (url.pathname) {
        case '/me':
          return send(response, 200, {
            playerId: me, name: room.saved?.[room.saved.role]?.name ?? null,
          })
        case '/state': {
          if (focus && Date.now() - focusSeen > FOCUS_TTL) {
            focus = null
            notifications = []
            change()
          }
          if (thread === focus) focusSeen = Date.now()
          const version = `${boot}:${revision}`
          if (url.searchParams.get('v') === version) return send(response, 204)
          return send(response, 200, {
            version, room: room.snapshot(), notificationThread: focus,
            notifications: notifications.filter(item => item.thread === thread)
              .map(({ id, event }) => ({ id, event })),
          })
        }
        case '/rooms': {
          const roomName = url.searchParams.get('name')
          if (roomName !== null) {
            if (!name(roomName)) throw problem('invalid-room-name')
            return send(response, 200, { rooms: await discover(options, { roomName }) })
          }
          roomSearch ??= discover(options).finally(() => { roomSearch = null })
          return send(response, 200, { rooms: await roomSearch })
        }
        case '/stats':
          return send(response, 200, stats.summary())
      }
    }
    if (request.method === 'POST') {
      if (!['/focus', '/host', '/join', '/move', '/action'].includes(url.pathname)) {
        throw problem('not-found', 404)
      }
      const body = await readBody(request)
      if (stopping) throw problem('shutting-down', 503)
      setFocus(thread)
      switch (url.pathname) {
        case '/focus':
          return send(response, 200, { thread })
        case '/host':
          return send(response, 200, { room: await room.host(body) })
        case '/join':
          return send(response, 200, { room: await room.join(body) })
        case '/move': {
          const result = await room.move(body)
          return send(response, result.ok ? 200 : 409, result)
        }
        case '/action':
          await room.action(body)
          return send(response, 200, { ok: true })
      }
    }
    throw problem('not-found', 404)
  }

  const server = createServer({ requestTimeout: 20000, headersTimeout: 10000 }, (request, response) => {
    handle(request, response).catch(error => {
      if (!error.status) console.error('[clarcade] Unix API:', error.message)
      if (!response.destroyed) send(response, error.status ?? 500,
        { ok: false, reason: error.status ? error.message : 'daemon-error' })
    })
  })
  const listen = new Promise((resolve, reject) => {
    server.once('error', reject)
    removeSocket(options.socketPath)
    server.listen(options.socketPath, () => {
      chmodSync(options.socketPath, 0o600)
      resolve()
    })
  })
  try {
    await listen
  } catch (error) {
    await room.stop()
    throw error
  }
  console.error(`[clarcade] daemon ${process.pid} ready`)

  const idle = setInterval(() => {
    if (!room.saved && !room.opening && Date.now() - lastActivity >= IDLE_TTL) void shutdown()
  }, 1000)
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  async function shutdown() {
    if (stopping) return
    stopping = true
    clearInterval(idle)
    const closed = new Promise(resolve => server.close(resolve))
    server.closeIdleConnections?.()
    await room.stop()
    await closed
    removeSocket(options.socketPath)
    console.error(`[clarcade] daemon ${process.pid} stopped`)
    // A launcher waits for this process to exit before starting its replacement.
    setTimeout(() => process.exit(0), 1000).unref()
  }
}

function removeSocket(path) {
  try {
    if (!lstatSync(path).isSocket()) throw new Error('Expected a Clarcade Unix socket')
    unlinkSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function readBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_BODY) throw problem('body-too-large', 413)
    chunks.push(chunk)
  }
  if (!length) return {}
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw problem('invalid-json')
  }
  if (!record(value)) throw problem('invalid-body')
  return value
}

function send(response, status, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    ...(body !== undefined && { 'content-type': 'application/json; charset=utf-8' }),
  })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

try {
  await main(runtime(process.argv.slice(2)))
} catch (error) {
  console.error('[clarcade]', error)
  process.exitCode = 1
}

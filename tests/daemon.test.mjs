import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, lstat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createConnection, createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { channel } from '../plugins/clarcade/helper/net.mjs'
import { stateFrames } from '../plugins/clarcade/helper/protocol.mjs'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'

const execute = promisify(execFile)
const launcher = fileURLToPath(new URL('../plugins/clarcade/helper/launch.mjs', import.meta.url))

async function udpPort() {
  const socket = createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', resolve)
  })
  const { port } = socket.address()
  await new Promise(resolve => socket.close(resolve))
  return port
}

async function fixture(t) {
  const directory = await mkdtemp('/tmp/clarcade-test-')
  const pids = new Set()
  t.after(async () => {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    await Promise.all([...pids].map(waitForExit))
    await rm(directory, { recursive: true, force: true })
  })
  const port = await udpPort()

  return (name, discoveryPort = port) => {
    const data = join(directory, name)
    const socketPath = join(data, 'd.sock')
    return {
      data,
      socketPath,
      port: discoveryPort,
      async launch(entry = launcher) {
        const { stdout } = await execute(process.execPath, [
          entry, '--data-dir', data, '--udp-port', String(discoveryPort), '--loopback',
        ], { timeout: 8000 })
        const endpoint = JSON.parse(stdout)
        pids.add(endpoint.pid)
        assert.equal(endpoint.socketPath, socketPath)
        return endpoint
      },
      request(path, body, thread = 'test-thread') {
        return new Promise((resolve, reject) => {
          const request = http.request({
            socketPath, path, method: body === undefined ? 'GET' : 'POST',
            headers: { 'x-clarcade-thread': thread },
            timeout: 5000,
          }, response => {
            let text = ''
            response.setEncoding('utf8')
            response.on('data', chunk => { text += chunk })
            response.on('end', () => resolve({
              status: response.statusCode,
              body: text.length ? JSON.parse(text) : null,
            }))
          })
          request.on('timeout', () => request.destroy(new Error('Unix HTTP timeout')))
          request.on('error', reject)
          request.end(body === undefined ? undefined : JSON.stringify(body))
        })
      },
    }
  }
}

async function waitForExit(pid) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await delay(20)
  }
  throw new Error(`Daemon ${pid} did not exit`)
}

async function until(read, predicate) {
  for (let i = 0; i < 200; i++) {
    const value = await read()
    if (predicate(value)) return value
    await delay(25)
  }
  throw new Error('Expected daemon state was not observed')
}

test('two real launchers recover one daemon after SIGKILL and retain the lock inode', { timeout: 20000 }, async t => {
  const make = await fixture(t)
  const host = make('host')
  const [first, concurrent] = await Promise.all([host.launch(), host.launch()])
  assert.equal(first.pid, concurrent.pid)
  const lock = join(host.data, 'daemon.lock')
  const inode = (await stat(lock)).ino
  const [me1, me2] = await Promise.all([host.request('/me'), host.request('/me', undefined, 'second')])
  assert.equal(me1.body.playerId, me2.body.playerId)
  const waiting = (await host.request('/host', { roomName: 'Recover', name: 'An' })).body.room

  process.kill(first.pid, 'SIGKILL')
  await waitForExit(first.pid)
  assert((await lstat(host.socketPath)).isSocket())
  const [a, b] = await Promise.all([host.launch(), host.launch()])
  assert.notEqual(a.pid, first.pid)
  assert.equal(a.pid, b.pid)
  assert.equal((await stat(lock)).ino, inode)
  assert.equal((await stat(host.socketPath)).mode & 0o777, 0o600)
  assert.equal((await host.request('/health')).body.pid, a.pid)
  assert.equal((await host.request('/me')).body.playerId, me1.body.playerId)
  assert.equal((await host.request('/state')).body.room.port, waiting.port)
})

test('a 15x15 game reconnects with a snapshot over 4 KB and draws on a full board', { timeout: 45000 }, async t => {
  const make = await fixture(t)
  const host = make('host')
  const guest = make('guest')
  const [originalHost] = await Promise.all([host.launch(), guest.launch()])
  const created = await host.request('/host', { roomName: 'Long game', name: 'An', moveLimit: 200 })
  assert.equal(created.status, 200)
  assert.equal(created.body.room.ruleset, 'freestyle')
  assert.equal(created.body.room.boardSize, 15)
  assert.equal(created.body.room.moveLimit, 0)
  const { link, directLink, port } = created.body.room
  const found = await guest.request('/rooms')
  assert(found.body.rooms.some(room => room.roomCode === created.body.room.roomCode))
  const joined = await guest.request('/join', { link, name: 'Binh' })
  assert.equal(joined.status, 200)
  assert.equal(joined.body.room.boardSize, 15)

  const opened = (await host.request('/state')).body.room
  for (const actor of [host, guest]) {
    assert.equal((await actor.request('/move', { gameId: opened.gameId, moveNo: 1, x: 8, y: 0 })).status, 400)
  }
  // Alternate marks in this final pattern without creating a five-stone line in any direction.
  const xCells = [{ x: 0, y: 0 }]
  const oCells = []
  for (let y = -7; y <= 7; y++) {
    for (let x = -7; x <= 7; x++) {
      if (x === 0 && y === 0) continue
      const cells = ((x + 2 * y) & 3) < 2 ? xCells : oCells
      cells.push({ x, y })
    }
  }
  const moves = xCells.flatMap((cell, index) => index < oCells.length ? [cell, oCells[index]] : [cell])
  for (let index = 0; index < 190; index++) {
    const actor = index % 2 ? guest : host
    const response = await actor.request('/move', { gameId: opened.gameId, moveNo: index + 1, ...moves[index] })
    assert.equal(response.status, 200, JSON.stringify(response.body))
  }
  const before = (await host.request('/state')).body.room
  assert(Buffer.byteLength(JSON.stringify(before.moves)) > 4096)
  assert(directLink.endsWith(`:${port}`))

  process.kill(originalHost.pid, 'SIGKILL')
  await waitForExit(originalHost.pid)
  const occupiedPort = createServer(socket => socket.destroy())
  await new Promise((resolve, reject) => {
    occupiedPort.once('error', reject)
    occupiedPort.listen(port, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => occupiedPort.close(resolve)))
  await until(() => guest.request('/state'), state => state.body.room.connection === 'reconnecting')
  await host.launch()
  const state = await until(() => guest.request('/state'), value =>
    value.body.room.connection === 'connected' && value.body.room.moves.length === before.moves.length)
  assert.notEqual((await host.request('/state')).body.room.port, port)
  assert.deepEqual(state.body.room.moves, before.moves)
  assert.equal(state.body.room.boardSize, 15)
  assert.equal(state.body.room.gameId, before.gameId)
  assert.equal(state.body.room.turn, before.turn)
  for (let index = before.moves.length; index < moves.length; index++) {
    const actor = index % 2 ? guest : host
    assert.equal((await actor.request('/move', {
      gameId: before.gameId, moveNo: index + 1, ...moves[index],
    })).status, 200)
  }
  const finished = await until(() => guest.request('/state'), result => result.body.room.finished?.reason === 'board-full')
  assert.equal(finished.body.room.finished.winner, null)
  assert.equal(finished.body.room.finished.moves, 225)
  assert.deepEqual((await host.request('/state')).body.room.finished, finished.body.room.finished)
})

test('direct invites, focus, move replay and results survive a guest crash', { timeout: 25000 }, async t => {
  const make = await fixture(t)
  const host = make('host')
  const guest = make('guest')
  const extra = make('extra')
  const [, originalGuest] = await Promise.all([host.launch(), guest.launch(), extra.launch()])
  const created = await host.request('/host', { roomName: 'Round', name: 'An' }, 'focused')
  const { directLink, gameId } = created.body.room
  await host.request('/state', undefined, 'background')
  assert.equal((await guest.request('/join', { link: directLink, name: 'Binh' })).status, 200)

  const focused = (await host.request('/state', undefined, 'focused')).body
  const background = (await host.request('/state', undefined, 'background')).body
  assert.equal(background.notificationThread, 'focused')
  assert.deepEqual(focused.notifications.map(item => item.event), ['joined'])
  assert.deepEqual(background.notifications, [])
  assert.equal((await host.request(`/state?v=${encodeURIComponent(focused.version)}`,
    undefined, 'focused')).status, 204)

  const third = await extra.request('/join', { link: directLink, name: 'Chi' })
  assert.equal(third.body.reason, 'room-full')
  const first = { gameId, moveNo: 1, x: 0, y: 0 }
  const second = { gameId, moveNo: 2, x: 1, y: 0 }
  assert.equal((await host.request('/move', first)).status, 200)
  assert.equal((await guest.request('/move', second)).status, 200)
  assert((await host.request('/state')).body.notifications.some(item => item.event === 'turn'))
  assert.equal((await guest.request('/move', second)).status, 200)
  assert.equal((await guest.request('/move', { ...second, x: -1 })).body.reason, 'conflict')
  assert.equal((await host.request('/state')).body.room.moves.length, 2)
  await until(() => guest.request('/state'), value => value.body.room.connection === 'connected')

  process.kill(originalGuest.pid, 'SIGKILL')
  await waitForExit(originalGuest.pid)
  await until(() => host.request('/state'), value => value.body.room.connection === 'reconnecting')
  assert.equal((await host.request('/action', { gameId, action: 'resign' })).status, 200)
  const persisted = async () => JSON.parse(await readFile(join(host.data, 'room.json'), 'utf8'))
  assert.equal((await persisted()).pendingResults.length, 1)
  await guest.launch()
  await until(() => guest.request('/stats'), value => value.body.total.wins === 1)
  await until(persisted, value => value.pendingResults.length === 0)
  assert.equal((await host.request('/stats')).body.total.losses, 1)
  assert.equal((await host.request('/stats')).body.opponents[0].name, 'Binh')
  assert.equal((await host.request('/action', { gameId, action: 'rematch' })).status, 200)
  const firstVote = await until(() => guest.request('/state'), value =>
    value.body.room.connection === 'syncing' || value.body.room.rematchVotes.length === 1)
  assert.equal(firstVote.body.room.connection, 'connected')
  assert.equal(firstVote.body.room.rematchVotes.length, 1)
  assert.equal((await guest.request('/action', { gameId, action: 'rematch' })).status, 200)
  const rematch = await until(() => guest.request('/state'), value => value.body.room.gameId !== gameId)
  assert.equal(rematch.body.room.mark, 'X')
  assert.deepEqual(rematch.body.room.moves, [])
  assert.equal((await guest.request('/move', second)).status, 409)
  assert.equal((await host.request('/stats')).body.total.played, 1)
  assert.equal((await guest.request('/stats')).body.total.played, 1)
})

function chatClient(t, daemon) {
  const server = spawn(process.execPath, [
    '--import', 'data:text/javascript,' + encodeURIComponent(`process.execPath = ${JSON.stringify(join(daemon.data, 'Claude'))}`),
    fileURLToPath(new URL('../plugins/clarcade-chat/server.mjs', import.meta.url)),
    '--loopback', '--udp-port', String(daemon.port),
  ], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, CLARCADE_CHAT_DATA_DIR: daemon.data,
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) },
  })
  const replies = createInterface({ input: server.stdout })[Symbol.asyncIterator]()
  t.after(() => { server.stdin.end(); server.kill() })
  let sequence = 0
  async function rpc(method, params) {
    const id = ++sequence
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    const reply = await replies.next()
    assert.equal(reply.done, false, 'MCP server closed before answering')
    const message = JSON.parse(reply.value)
    assert.equal(message.id, id)
    assert.equal(message.error, undefined)
    return message.result
  }
  return { rpc, invoke: (name, args = {}) => rpc('tools/call', { name, arguments: args }) }
}

test('Chat MCP guest joins and plays with a direct invite when the discovery ports differ', { timeout: 20000 }, async t => {
  const make = await fixture(t)
  const host = make('code')
  const guest = make('chat', host.port === 47979 ? 47980 : 47979)
  await Promise.all([host.launch(), guest.launch()])
  const created = await host.request('/host', { roomName: 'Chat preview', name: 'Code', visibility: 'private', pin: '0042' })
  assert.equal(created.status, 200)
  const { link, directLink, gameId } = created.body.room
  const { rpc, invoke } = chatClient(t, guest)
  assert.equal((await rpc('initialize', { protocolVersion: '2025-11-25' })).protocolVersion, '2025-11-25')
  const { tools } = await rpc('tools/list')
  const open = tools.find(tool => tool.name === 'open_clarcade')
  assert(open?._meta.ui.resourceUri.startsWith('ui://'))
  assert.deepEqual(tools.find(tool => tool.name === 'play_move')._meta.ui.visibility, ['app'])
  const view = (await rpc('resources/read', { uri: open._meta.ui.resourceUri })).contents[0]
  assert.equal(view.mimeType, 'text/html;profile=mcp-app')
  assert.match(view.text, /ui\/initialize/)
  assert.equal((await invoke('get_state')).structuredContent.room, null)
  const unresolved = await invoke('join_room', { link, name: 'Free', pin: '0042' })
  assert.equal(unresolved.isError, true)
  assert.equal(unresolved.structuredContent.reason, 'room-not-found')
  const incorrect = await invoke('join_room', { link: directLink, name: 'Free', pin: '0043' })
  assert.equal(incorrect.isError, true)
  assert.equal(incorrect.structuredContent.reason, 'wrong-pin')
  const { room, version } = (await invoke('join_room', { link: directLink, name: 'Free', pin: '0042' })).structuredContent
  assert.equal(room.gameId, gameId)
  assert.equal(room.mark, 'O')
  assert(!Object.hasOwn(room, 'directLink'))
  assert.equal((await invoke('get_state', { version })).structuredContent.unchanged, true)
  assert.equal((await host.request('/move', { gameId, moveNo: 1, moveEpoch: 0, x: 0, y: 0 })).status, 200)
  const afterHostMove = await until(() => invoke('get_state', { version }), result =>
    result.structuredContent.room?.boardVersion === 1)
  assert.deepEqual(afterHostMove.structuredContent.room.moves.map(({ x, y, mark }) => ({ x, y, mark })),
    [{ x: 0, y: 0, mark: 'X' }])
  const played = await invoke('play_move', { gameId, moveNo: 2, moveEpoch: 0, x: 1, y: 0 })
  assert.equal(played.structuredContent.ok, true)
  assert.equal((await host.request('/state')).body.room.moves.at(-1).mark, 'O')
  const stale = await invoke('play_move', { gameId, moveNo: 2, moveEpoch: 0, x: 2, y: 0 })
  assert.equal(stale.isError, true)
  assert.equal((await host.request('/state')).body.room.boardVersion, 2)
})

test('two Chat clients host, join by direct link, play, reopen and rematch', { timeout: 20000 }, async t => {
  const make = await fixture(t)
  const host = make('host')
  const guest = make('guest')
  await Promise.all([host.launch(), guest.launch()])
  const first = chatClient(t, host)
  const second = chatClient(t, guest)
  const settings = { name: 'An', roomName: 'Caro Free', visibility: 'private' }
  const tools = (await first.rpc('tools/list')).tools
  assert.deepEqual(tools.find(tool => tool.name === 'host_room')?._meta.ui.visibility, ['app'])
  assert.equal((await first.invoke('host_room', settings)).structuredContent.reason, 'invalid-pin')
  const created = await first.invoke('host_room', { ...settings, pin: '0042' })
  assert.equal(created.isError, undefined)
  const { role, directLink, link, gameId, status } = created.structuredContent.room
  assert.equal(role, 'host')
  assert.equal(status, 'waiting')
  assert.match(directLink, /^clarcade:\/\/j\/[A-Z0-9]{6}@127\.0\.0\.1:\d+$/)
  assert.equal(directLink.split('@')[0], link)
  assert.doesNotMatch(JSON.stringify(created), /"(?:pin|pinHash|token|playerId)"\s*:/)
  assert.equal((await first.invoke('host_room', { ...settings, pin: '0042' })).structuredContent.reason, 'room-active')
  const joins = { link: directLink, name: 'Binh' }
  assert.equal((await second.invoke('join_room', { ...joins, pin: '0043' })).structuredContent.reason, 'wrong-pin')
  const joined = (await second.invoke('join_room', { ...joins, pin: '0042' })).structuredContent.room
  assert.equal(joined.gameId, gameId)
  assert.equal(joined.role, 'guest')
  assert.equal(joined.mark, 'O')
  assert.equal((await first.invoke('get_state')).structuredContent.room.directLink, undefined)
  assert.equal((await first.invoke('play_move', { gameId, moveNo: 1, moveEpoch: 0, x: -7, y: -7 })).structuredContent.ok, true)
  await until(() => second.invoke('get_state'), result => result.structuredContent.room?.boardVersion === 1)
  assert.equal((await second.invoke('play_move', { gameId, moveNo: 2, moveEpoch: 0, x: 1, y: 0 })).structuredContent.ok, true)
  const reopened = chatClient(t, host)
  const current = (await reopened.invoke('get_state')).structuredContent.room
  assert.deepEqual(current.moves.map(({ x, y, mark }) => ({ x, y, mark })), [
    { x: -7, y: -7, mark: 'X' }, { x: 1, y: 0, mark: 'O' },
  ])
  assert.equal(current.gameId, gameId)
  const ended = (await reopened.invoke('game_action', { gameId, action: 'resign' })).structuredContent.room
  assert.equal(ended.won, false)
  assert.deepEqual(ended.score, { you: 0, opponent: 1, draws: 0 })
  const other = await until(() => second.invoke('get_state'), result => result.structuredContent.room?.status === 'finished')
  assert.equal(other.structuredContent.room.won, true)
  assert.deepEqual(other.structuredContent.room.score, { you: 1, opponent: 0, draws: 0 })
  assert.equal((await reopened.invoke('rematch', { gameId })).structuredContent.room.rematchVoted, true)
  await until(() => second.invoke('get_state'), result => result.structuredContent.room?.rematchOffered)
  assert.equal((await second.invoke('rematch', { gameId })).structuredContent.ok, true)
  const next = await until(() => reopened.invoke('get_state'), result => result.structuredContent.room?.gameId !== gameId)
  assert.equal(next.structuredContent.room.boardVersion, 0)
  assert.equal(next.structuredContent.room.mark, 'O')
  const nextGame = next.structuredContent.room
  await until(() => second.invoke('get_state'), result => result.structuredContent.room?.gameId === nextGame.gameId)
  const opening = { gameId: nextGame.gameId, moveNo: 1, moveEpoch: nextGame.moveEpoch, x: 7, y: 7 }
  assert.equal((await second.invoke('play_move', opening)).structuredContent.ok, true)
  const observed = await until(() => reopened.invoke('get_state'), result => result.structuredContent.room?.boardVersion === 1)
  assert.deepEqual(observed.structuredContent.room.moves.map(({ x, y, mark }) => ({ x, y, mark })), [{ x: 7, y: 7, mark: 'X' }])
})

test('opening a saved Chat room upgrades a daemon that still requires the first move at the center', { timeout: 20000 }, async t => {
  const folder = await mkdtemp('/tmp/clarcade-old-')
  t.after(() => rm(folder, { recursive: true, force: true }))
  await cp(new URL('../plugins/clarcade/', import.meta.url), folder, { recursive: true })
  const manifest = join(folder, '.claude-plugin', 'plugin.json')
  await writeFile(manifest, JSON.stringify({ ...JSON.parse(await readFile(manifest, 'utf8')), version: '0.1.5' }))
  const rules = join(folder, 'games', 'gomoku', 'rules.js')
  await writeFile(rules, (await readFile(rules, 'utf8')).replace(
    '  const key =',
    "  if (!state.board.size && (x !== 0 || y !== 0)) return { ok: false, reason: 'first-move-origin' }\n  const key =",
  ))
  const oldLauncher = join(folder, 'helper', 'launch.mjs')
  const make = await fixture(t)
  const host = make('host')
  const guest = make('guest')
  const [old] = await Promise.all([host.launch(oldLauncher), guest.launch()])
  const { body: { room } } = await host.request('/host', { roomName: 'Saved room', name: 'An' })
  assert.equal((await guest.request('/join', { link: room.directLink, name: 'Binh' })).status, 200)
  const opening = { gameId: room.gameId, moveNo: 1, moveEpoch: 0, x: -7, y: -7 }
  assert.equal((await host.request('/move', opening)).body.reason, 'first-move-origin')

  const chat = chatClient(t, host)
  const reopened = await chat.invoke('get_state')
  const { body: running } = await host.request('/health')
  await host.launch(oldLauncher)
  assert.notEqual(running.pid, old.pid)
  assert.equal(reopened.structuredContent.room.gameId, room.gameId)
  await until(() => chat.invoke('get_state'), result => result.structuredContent.room?.connection === 'connected')
  assert.equal((await chat.invoke('play_move', opening)).structuredContent.ok, true)
  const synced = await until(() => guest.request('/state'), result => result.body.room?.boardVersion === 1)
  assert.equal(synced.body.room.moves[0].x, -7)
})

test('a Chat host is listed on the LAN and a Code guest can join by short or discovered direct link', { timeout: 20000 }, async t => {
  const make = await fixture(t)
  const host = make('host')
  const guest = make('code')
  await Promise.all([host.launch(), guest.launch()])
  const chat = chatClient(t, host)
  const settings = { name: 'An', roomName: 'Caro LAN', visibility: 'public' }
  for (const useShortLink of [true, false]) {
    const { room } = (await chat.invoke('host_room', settings)).structuredContent
    const { body: { rooms } } = await guest.request('/rooms')
    const found = rooms.find(candidate => candidate.roomCode === room.link.split('/').at(-1))
    assert.equal(found?.roomName, settings.roomName)
    const link = useShortLink ? room.link : `${room.link}@${found.address}:${found.port}`
    assert.equal((await guest.request('/join', { link, name: 'Binh' })).body.room.gameId, room.gameId)
    assert.equal((await chat.invoke('leave_room', { gameId: room.gameId })).structuredContent.room, null)
    await until(() => guest.request('/state'), result => result.body.room === null)
  }
})

test('guest requests a fresh snapshot for a missing part and a bad digest', { timeout: 20000 }, async t => {
  const make = await fixture(t)
  const guest = make('guest')
  await guest.launch()
  const guestId = (await guest.request('/me')).body.playerId
  const gameId = randomUUID()
  const moves = [{ x: 0, y: 0, mark: 'X' }]
  const hostId = randomUUID()
  const frames = [...stateFrames(gameId, moves, {
    host: { playerId: hostId, name: 'Host' }, guest: { playerId: guestId, name: 'Guest' },
    roomName: 'Snapshot', ruleset: 'freestyle', firstPlayerId: hostId, turn: 'O',
    finished: null, startedAt: Date.now(), holdMs: 1800000, rematchVotes: [],
  })]
  const roomCode = 'K7M2QX'
  let requests = 0
  let peer
  let checks = Promise.resolve()
  const server = createServer(socket => {
    peer = channel(socket, roomCode, (frame, link) => {
      if (frame.type === 'hello') {
        link.send({ type: 'welcome', sessionToken: 'a'.repeat(32) })
        link.send(frames[0])
        link.send(frames[2])
      }
      if (frame.type !== 'stateReq') return
      requests++
      const attempt = requests
      checks = checks.then(async () => {
        assert.equal((await guest.request('/state')).body.room, null)
        if (attempt === 1) {
          link.send(frames[0])
          link.send(frames[1])
          link.send({ ...frames[2], digest: '0'.repeat(64) })
        } else {
          for (const part of frames) link.send(part)
        }
      })
    }, () => {})
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    peer?.close()
    return new Promise(resolve => server.close(resolve))
  })
  const link = `clarcade://j/${roomCode}@127.0.0.1:${server.address().port}`
  const result = await guest.request('/join', { link, name: 'Guest' })
  await checks
  assert.equal(result.status, 200)
  assert.equal(requests, 2)
  assert.deepEqual(result.body.room.moves, moves)
})

test('initial join can retry after TCP closes before snapshot installation', { timeout: 12000 }, async t => {
  const make = await fixture(t)
  const host = make('host')
  await host.launch()
  const { room } = (await host.request('/host', { roomName: 'Retry', name: 'Host' })).body
  const playerId = randomUUID()
  const joinNonce = 'c'.repeat(32)

  function hello(secret) {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: room.port })
      const timeout = setTimeout(() => link.close(), 2000)
      const link = channel(socket, room.roomCode, (frame, peer) => {
        if (frame.type !== 'welcome' && frame.type !== 'reject') return
        resolve(frame)
        peer.close()
      }, () => {
        clearTimeout(timeout)
        reject(new Error('Connection ended before welcome or rejection'))
      })
      socket.once('connect', () => link.send({ type: 'hello', playerId, name: 'Guest', joinNonce: secret }))
    })
  }

  const first = await hello(joinNonce)
  assert.equal(first.type, 'welcome')
  assert.equal((await hello('f'.repeat(32))).reason, 'invalid-session')
  const retry = await hello(joinNonce)
  assert.equal(retry.type, 'welcome')
  assert.equal(retry.sessionToken, first.sessionToken)
})

test('private Caro room requires a PIN, appears by exact name and preserves rules through agreed undo', { timeout: 18000 }, async t => {
  const make = await fixture(t)
  const host = make('host')
  const guest = make('guest')
  await Promise.all([host.launch(), guest.launch()])
  const created = await host.request('/host', {
    roomName: 'Phòng Caro', name: 'An', ruleset: 'vn', visibility: 'private', pin: '0042',
  })
  assert.equal(created.status, 200)
  const room = created.body.room
  assert.equal(room.ruleset, 'vn')
  assert.equal(room.pin, undefined)
  assert.equal(room.pinHash, undefined)
  assert.deepEqual((await guest.request('/rooms')).body.rooms, [])
  assert.equal((await guest.request('/rooms?name=Ph%C3%B2ng')).body.rooms.length, 0)
  const matches = (await guest.request('/rooms?name=Ph%C3%B2ng%20Caro')).body.rooms
  assert.equal(matches.length, 1)
  assert.equal(matches[0].visibility, 'private')
  assert.equal((await guest.request('/join', { link: room.link, name: 'Bình' })).body.reason, 'pin-required')
  assert.equal((await guest.request('/join', { link: room.directLink, name: 'Bình', pin: '1111' })).body.reason, 'wrong-pin')
  const saved = JSON.parse(await readFile(join(host.data, 'room.json'), 'utf8'))
  assert.equal(saved.pinAttempts['127.0.0.1'].count, 1)
  assert.equal(saved.pin, undefined)
  const joined = await guest.request('/join', { link: room.directLink, name: 'Bình', pin: '0042' })
  assert.equal(joined.status, 200)
  assert.equal(joined.body.room.ruleset, 'vn')
  const gameId = room.gameId
  const first = { gameId, moveNo: 1, moveEpoch: 0, x: 0, y: 0 }
  assert.equal((await host.request('/move', first)).status, 200)
  assert.equal((await host.request('/action', { gameId, action: 'undoReq' })).status, 200)
  const offered = await until(() => guest.request('/state'), result => result.body.room.offer?.kind === 'undo')
  const offerId = offered.body.room.offer.id
  assert.equal((await host.request('/action', { gameId, action: 'undoResp', offerId, accepted: true })).status, 409)
  assert.equal((await guest.request('/action', { gameId, action: 'undoResp', offerId, accepted: true })).status, 200)
  const rewound = await until(() => guest.request('/state'), result => result.body.room.moveEpoch === 1)
  assert.equal(rewound.body.room.moves.length, 0)
  assert.equal(rewound.body.room.turn, 'X')
  assert.equal((await host.request('/move', first)).body.reason, 'stale-move')
  assert.equal((await host.request('/move', { ...first, moveEpoch: 1 })).status, 200)
  assert.equal((await guest.request('/action', { gameId, action: 'emote', emote: 'gg' })).status, 200)
  await until(() => host.request('/state'), result => result.body.room.emote?.value === 'gg')
  await until(() => guest.request('/state'), result => result.body.room.moves.length === 1)
  assert.equal((await guest.request('/action', { gameId, action: 'drawReq' })).status, 200)
  const draw = await until(() => host.request('/state'), result => result.body.room.offer?.kind === 'draw')
  assert.equal((await host.request('/action', {
    gameId, action: 'drawResp', offerId: draw.body.room.offer.id, accepted: true,
  })).status, 200)
  assert.equal((await until(() => guest.request('/state'), result => result.body.room.finished?.reason === 'draw-agreed')).body.room.finished.winner, null)
  const stats = await until(() => guest.request('/stats'), result => result.body.total.draws === 1)
  assert.equal(stats.body.total.byRuleset.vn.draws, 1)
  assert.equal(stats.body.total.byMark.O.draws, 1)

  await host.request('/action', { gameId, action: 'rematch' })
  await guest.request('/action', { gameId, action: 'rematch' })
  const rematch = (await until(() => guest.request('/state'), result => result.body.room.gameId !== gameId)).body.room
  assert.equal(rematch.mark, 'X')
  assert.equal(rematch.ruleset, 'vn')
  const turns = [
    [0, 0], [-1, 0], [1, 0], [5, 0], [2, 0], [-3, 7], [3, 0], [-1, 7], [4, 0],
    [1, 7], [0, 1], [3, 7], [0, 2], [5, 7], [0, 3], [7, 7], [0, 4],
  ]
  for (const [index, [x, y]] of turns.entries()) {
    const player = index % 2 ? host : guest
    const response = await player.request('/move', { gameId: rematch.gameId, moveNo: index + 1, x, y })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    if (index === 8) assert.equal((await host.request('/state')).body.room.status, 'playing')
  }
  const won = await until(() => guest.request('/state'), result => result.body.room.finished?.reason === 'line')
  assert.equal(won.body.room.finished.winner, won.body.room.guest.playerId)
  assert.deepEqual(won.body.room.winLine, Array.from({ length: 5 }, (_, y) => ({ x: 0, y })))
})

test('TCP accepts forty buffered frames and still caps the burst', async t => {
  const received = []
  let link
  const listening = createServer(socket => {
    link = channel(socket, 'K7M2QX', frame => received.push(frame.seq), () => {})
  })
  await new Promise(resolve => listening.listen(0, '127.0.0.1', resolve))
  const socket = createConnection(listening.address().port, '127.0.0.1')
  const closed = new Promise(resolve => socket.once('close', resolve))
  t.after(async () => {
    socket.destroy()
    link?.close()
    await new Promise(resolve => listening.close(resolve))
  })
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const frames = (first, last) => Array.from({ length: last - first + 1 }, (_, i) =>
    JSON.stringify({ type: 'move', roomCode: 'K7M2QX', seq: first + i }) + '\n').join('')
  socket.write(frames(1, 40))
  await until(async () => received.length, count => count === 40)
  socket.write(frames(41, 70))
  await closed
  assert.equal(received.length, 60)
})

test('guest departure records a forfeit on both machines and keeps the host room', { timeout: 18000 }, async t => {
  const make = await fixture(t)
  const host = make('host')
  const guest = make('guest')
  const next = make('next')
  await Promise.all([host.launch(), guest.launch(), next.launch()])
  const { room } = (await host.request('/host', { roomName: 'Stay', name: 'An', ruleset: 'vn' })).body
  assert.equal((await guest.request('/join', { link: room.directLink, name: 'Bình' })).status, 200)
  assert.equal((await host.request('/move', { gameId: room.gameId, moveNo: 1, x: 0, y: 0 })).status, 200)
  assert.equal((await guest.request('/action', { action: 'leave', gameId: room.gameId })).status, 200)
  const waiting = (await host.request('/state')).body.room
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.roomCode, room.roomCode)
  assert.equal(waiting.ruleset, 'vn')
  assert.notEqual(waiting.gameId, room.gameId)
  assert.deepEqual(waiting.moves, [])
  assert.equal((await guest.request('/state')).body.room, null)
  assert.equal((await host.request('/stats')).body.total.byReason.disconnected.wins, 1)
  assert.equal((await guest.request('/stats')).body.total.byReason.disconnected.losses, 1)
  assert.equal((await next.request('/join', { link: room.directLink, name: 'Chi' })).status, 200)
  assert.equal((await next.request('/stats')).body.total.played, 0)
  assert.equal((await host.request('/action', { action: 'leave' })).status, 200)
  await until(() => next.request('/state'), result => result.body.room === null)
  assert.equal((await host.request('/state')).body.room, null)
})

test('host departure from a live game records a forfeit on both machines', { timeout: 18000 }, async t => {
  const make = await fixture(t)
  const host = make('host')
  const guest = make('guest')
  await Promise.all([host.launch(), guest.launch()])
  const { room } = (await host.request('/host', { roomName: 'Quit', name: 'An' })).body
  assert.equal((await guest.request('/join', { link: room.directLink, name: 'Bình' })).status, 200)
  assert.equal((await host.request('/move', { gameId: room.gameId, moveNo: 1, x: 0, y: 0 })).status, 200)
  assert.equal((await host.request('/action', { action: 'leave' })).status, 200)
  await until(() => guest.request('/state'), result => result.body.room === null)
  assert.equal((await host.request('/state')).body.room, null)
  assert.equal((await host.request('/stats')).body.total.byReason.disconnected.losses, 1)
  assert.equal((await guest.request('/stats')).body.total.byReason.disconnected.wins, 1)
})

test('unreadable state files are set aside and the daemon still starts', { timeout: 12000 }, async t => {
  const make = await fixture(t)
  const host = make('host')
  await mkdir(host.data, { mode: 0o700 })
  await writeFile(join(host.data, 'room.json'), '{"role":"host"}')
  await writeFile(join(host.data, 'stats.json'), '[{"gameId":')
  await writeFile(join(host.data, 'player.json'), '[]')
  await host.launch()
  assert.equal((await host.request('/state')).body.room, null)
  assert.equal((await host.request('/stats')).body.total.played, 0)
  assert.match((await host.request('/me')).body.playerId, /^[a-f0-9-]{36}$/)
  const files = await readdir(host.data)
  for (const file of ['room.json', 'stats.json', 'player.json']) {
    assert(files.some(item => item.startsWith(`${file}.corrupt-`)), `${file} was not set aside`)
  }
  assert.equal((await host.request('/host', { roomName: 'Fresh', name: 'An' })).status, 200)
})

test('launchers replace an older daemon and apply network changes only without a room', { timeout: 30000 }, async t => {
  const directory = await mkdtemp('/tmp/clarcade-test-')
  const data = join(directory, 'host')
  const socketPath = join(data, 'd.sock')
  const pids = new Set()
  t.after(async () => {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    await Promise.all([...pids].map(waitForExit))
    await rm(directory, { recursive: true, force: true })
  })
  const [first, second] = await Promise.all([udpPort(), udpPort()])
  const launch = async (port, locate = false) => {
    const { stdout } = await execute(process.execPath, [
      launcher, '--data-dir', data, '--udp-port', String(port), '--loopback', ...(locate ? ['--locate'] : []),
    ], { timeout: 12000 })
    const endpoint = JSON.parse(stdout)
    if (endpoint.pid) pids.add(endpoint.pid)
    return endpoint
  }
  const health = () => new Promise(resolve => {
    http.get({ socketPath, path: '/health' }, response => {
      let text = ''
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve(JSON.parse(text)))
    }).on('error', () => resolve(null))
  })
  const request = (path, body) => new Promise((resolve, reject) => {
    const call = http.request({ socketPath, path, method: body ? 'POST' : 'GET',
      headers: { 'x-clarcade-thread': 'test-thread' } }, response => {
      let text = ''
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }))
    })
    call.on('error', reject)
    call.end(body && JSON.stringify(body))
  })

  assert.deepEqual(await launch(first, true), { socketPath })
  assert.equal(await health(), null)

  // A daemon from before version reporting answers health with its pid only.
  await mkdir(data, { recursive: true, mode: 0o700 })
  const legacy = spawn(process.execPath, ['-e',
    'require("http").createServer((q, r) => r.end(JSON.stringify({ pid: process.pid }))).listen(process.argv[1])',
    socketPath], { stdio: 'ignore' })
  pids.add(legacy.pid)
  await until(health, reply => reply?.pid === legacy.pid)
  const current = await launch(first, true)
  assert.notEqual(current.pid, legacy.pid)
  await waitForExit(legacy.pid)
  assert.equal(typeof current.version, 'string')

  const changed = await launch(second)
  assert.notEqual(changed.pid, current.pid)
  assert.equal(changed.network, JSON.stringify([second, true, false, false]))

  assert.equal((await request('/host', { roomName: 'Keep', name: 'An' })).status, 200)
  assert.equal((await launch(first, true)).pid, changed.pid)
  assert.equal((await request('/action', { action: 'leave' })).status, 200)
  const applied = await launch(first, true)
  assert.notEqual(applied.pid, changed.pid)
  assert.equal(applied.network, JSON.stringify([first, true, false, false]))
})

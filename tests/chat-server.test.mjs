import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'

const SERVER = new URL('../plugins/clarcade-chat/server.mjs', import.meta.url).pathname

// A room as the daemon reports it to a guest, mid-game.
const room = (extra = {}) => ({
  role: 'guest', gameId: 'game-1', roomName: 'TEST', boardSize: 15, boardVersion: 2, moveEpoch: 0,
  moves: [{ x: 0, y: 0, mark: 'X' }, { x: 1, y: 0, mark: 'O' }], status: 'playing', connection: 'connected',
  mark: 'O', turn: 'X', pendingMove: null, winLine: null, finished: null, ruleset: 'freestyle',
  turnMs: 30000, turnEndsAt: 1_700_000_000_000, moveLimit: 200, rematchVotes: [], offer: null,
  score: { host: 1, guest: 2, draws: 1 },
  host: { playerId: 'host-id', name: 'An' }, guest: { playerId: 'guest-id', name: 'Binh' }, ...extra,
})

// Runs the Chat MCP server against a stand-in daemon on its Unix socket.
async function harness(t, current) {
  const dataDir = mkdtempSync('/tmp/cc-')
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const actions = []
  const daemon = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      if (request.url.startsWith('/action')) actions.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(request.url.startsWith('/state') ? { version: '1', room: current() } : { ok: true }))
    })
  })
  await new Promise(resolve => daemon.listen(join(dataDir, 'd.sock'), resolve))
  t.after(() => daemon.close())
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, CLARCADE_CHAT_DATA_DIR: dataDir } })
  t.after(() => child.kill())
  const replies = new Map()
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line)
    replies.get(message.id)?.(message)
  })
  let id = 0
  const call = (name, args) => new Promise(resolve => {
    replies.set(++id, message => resolve(message.result))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
  })
  return { call, actions }
}

test('the guest snapshot carries the clock, move limit, reason and an offer from the host', async t => {
  const { call } = await harness(t, () => room({ offer: { id: 'offer-1', kind: 'draw', playerId: 'host-id' } }))
  const { structuredContent: { room: snapshot } } = await call('get_state', {})
  assert.equal(snapshot.turnMs, 30000)
  assert.equal(snapshot.turnEndsAt, 1_700_000_000_000)
  assert.equal(snapshot.moveLimit, 200)
  assert.equal(snapshot.reason, null)
  assert.deepEqual(snapshot.offer, { id: 'offer-1', kind: 'draw', mine: false })
  assert.deepEqual(snapshot.score, { you: 2, opponent: 1, draws: 1 })
})

test('undo, draw, answers and resignation reach the daemon with the board version', async t => {
  let current = room({ offer: { id: 'offer-1', kind: 'undo', playerId: 'host-id' } })
  const { call, actions } = await harness(t, () => current)
  assert.equal((await call('game_action', { gameId: 'game-1', action: 'undoResp', offerId: 'offer-1', accepted: true })).isError, undefined)
  current = room()
  await call('game_action', { gameId: 'game-1', action: 'undoReq' })
  await call('game_action', { gameId: 'game-1', action: 'drawReq' })
  await call('game_action', { gameId: 'game-1', action: 'resign' })
  assert.deepEqual(actions, [
    { gameId: 'game-1', action: 'undoResp', moveEpoch: 0, boardVersion: 2, offerId: 'offer-1', accepted: true },
    { gameId: 'game-1', action: 'undoReq', moveEpoch: 0, boardVersion: 2 },
    { gameId: 'game-1', action: 'drawReq', moveEpoch: 0, boardVersion: 2 },
    { gameId: 'game-1', action: 'resign', moveEpoch: 0, boardVersion: 2 },
  ])
})

test('game actions are refused for another game, an unknown action, a finished game or a bare answer', async t => {
  let current = room()
  const { call, actions } = await harness(t, () => current)
  const reason = async args => (await call('game_action', args)).structuredContent.reason
  assert.equal(await reason({ gameId: 'other', action: 'drawReq' }), 'stale-game')
  assert.equal(await reason({ gameId: 'game-1', action: 'emote' }), 'invalid-action')
  assert.equal(await reason({ gameId: 'game-1', action: 'drawResp' }), 'invalid-offer')
  current = room({ status: 'finished', finished: { winner: 'host-id', reason: 'resign' } })
  assert.equal(await reason({ gameId: 'game-1', action: 'drawReq' }), 'action-unavailable')
  assert.deepEqual(actions, [])
})

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { allowedAddress } from '../plugins/clarcade/helper/discovery.mjs'
import { createPin, checkPin } from '../plugins/clarcade/helper/pin.mjs'
import { Room } from '../plugins/clarcade/helper/room.mjs'
import { addStatePart, beginState, restoreGame } from '../plugins/clarcade/helper/protocol.mjs'
import { olderVersion } from '../plugins/clarcade/helper/runtime.mjs'
import { openStats } from '../plugins/clarcade/helper/stats.mjs'
import { parseLink, roomLinks } from '../plugins/clarcade/hooks/link.js'

test('guest PIN attempts are limited to five each minute and ten for the room', () => {
  const pin = createPin('0001')
  assert.equal(checkPin(pin, undefined, undefined, 0).reason, 'pin-required')
  let attempts
  for (let i = 0; i < 5; i++) attempts = checkPin(pin, '0002', attempts, 100000).attempt
  assert.equal(checkPin(pin, '0001', attempts, 100001).reason, 'pin-rate-limit')
  assert.deepEqual(checkPin(pin, '0001', attempts, 160000), {})
  for (let i = 0; i < 4; i++) attempts = checkPin(pin, '0002', attempts, 160000).attempt
  const banned = checkPin(pin, '0002', attempts, 160000)
  assert.equal(banned.reason, 'pin-blocked')
  assert.equal(banned.attempt.count, 10)
  assert.equal(checkPin(pin, '0001', banned.attempt, 1000000).reason, 'pin-blocked')
  assert.deepEqual(checkPin(pin, '0001', undefined, 160000), {})
})

test('Tailscale and IPv6 ULA are opt-in and IPv6 direct links round trip', () => {
  const tailscale = { allowTailscale: true }
  const ula = { allowIpv6Ula: true }
  assert.equal(allowedAddress('100.64.0.0'), false)
  assert.equal(allowedAddress('100.64.0.0', tailscale), true)
  assert.equal(allowedAddress('100.127.255.255', tailscale), true)
  assert.equal(allowedAddress('100.128.0.0', tailscale), false)
  assert.equal(allowedAddress('::ffff:192.168.1.20', ula), true)
  assert.equal(allowedAddress('::ffff:c0a8:114', ula), true)
  assert.equal(allowedAddress('fd00::42'), false)
  assert.equal(allowedAddress('fd00::42', ula), true)
  assert.equal(allowedAddress('fc00::42', ula), false)
  assert.equal(allowedAddress('fe80::42', ula), false)
  assert.equal(allowedAddress('2001:db8::42', ula), false)
  assert.deepEqual(parseLink(roomLinks('K7M2QX', 'fd00::42', 12345).directLink),
    { roomCode: 'K7M2QX', address: 'fd00::42', port: 12345 })
  assert.equal(parseLink('clarcade://j/K7M2QX@[fd00:::42]:12345'), null)
})

test('stats read legacy history, dedupe replays, retain streak chronology and summarize marks', t => {
  const directory = mkdtempSync(join(tmpdir(), 'clarcade-stats-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'stats.json')
  const stats = openStats(path)
  const base = { playerId: 'me', opponentId: 'peer', opponentName: 'Bình', durationMs: 2000, moves: 11 }
  const legacy = { ...base, gameId: 'old', reason: 'line', winner: 'me', ruleset: 'freestyle' }
  stats.record(legacy)
  stats.record({ ...base, gameId: '3', endedAt: 3, firstPlayerId: 'peer', ruleset: 'vn',
    reason: 'timeout', winner: 'peer' })
  const winner = { ...base, gameId: '2', endedAt: 2, firstPlayerId: 'me', ruleset: 'vn',
    reason: 'resign', winner: 'me', moves: 8 }
  stats.record(winner)
  stats.record(winner)
  const { total, opponents } = openStats(path).summary()
  assert.equal(total.played, 3)
  assert.equal(total.bestStreak, 2)
  assert.equal(total.streak, 0)
  assert.equal(total.fastestWinMoves, 8)
  assert.equal(total.longestGameMoves, 11)
  assert.equal(total.durationMs, 6000)
  assert.equal(total.byMark.X.wins, 1)
  assert.equal(total.byMark.O.losses, 1)
  assert.equal(total.byRuleset.freestyle.played, 1)
  assert.equal(total.byRuleset.vn.played, 2)
  assert.deepEqual(total.byReason.timeout, { wins: 0, losses: 1 })
  assert.equal(total.mostPlayedOpponent.name, 'Bình')
  assert.deepEqual(opponents[0].recent.map(game => game.gameId), ['3', '2', 'old'])
  assert.equal(opponents[0].recent.at(-1).endedAt, null)
})

test('host clock records one forfeit, sends the result and rejects a late move', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clarcade-clock-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const stats = openStats(join(directory, 'stats.json'))
  const frames = []
  const room = new Room({ directory }, 'host', stats, () => {})
  room.peer = { send: frame => frames.push(frame), close() {} }
  room.connection = 'connected'
  room.commit({
    role: 'host', host: { playerId: 'host' }, guest: { playerId: 'guest', name: 'Guest' },
    gameId: 'game', firstPlayerId: 'host', ruleset: 'vn', moveEpoch: 0,
    finished: null, turnMs: 30000, turnRemainingMs: 35, turnEndsAt: Date.now() + 35,
    startedAt: Date.now(), moves: [], results: [], pendingResults: [],
  }, restoreGame([], 'vn'))
  t.after(() => room.stop())
  for (let attempt = 0; room.status !== 'finished' && attempt < 20; attempt++) await delay(15)
  assert.equal(room.saved.finished?.reason, 'timeout')
  assert.equal(room.saved.finished?.winner, 'guest')
  assert.equal(stats.summary().total.byReason.timeout.losses, 1)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].type, 'result')
  assert.deepEqual(room.hostMove({ gameId: 'game', moveNo: 1, x: 0, y: 0 }, 'host'),
    { ok: false, reason: 'finished' })
})

test('only a daemon from an older plugin version is outdated', () => {
  assert.equal(olderVersion(undefined, '0.1.0'), true)
  assert.equal(olderVersion('0.1.0', '0.1.1'), true)
  assert.equal(olderVersion('0.9.9', '0.10.0'), true)
  assert.equal(olderVersion('0.1.1', '0.1.0'), false)
  assert.equal(olderVersion('0.1.0', '0.1.0'), false)
})

test('restores a legacy game with outside moves and starts the rematch on a 15x15 board', t => {
  const directory = mkdtempSync(join(tmpdir(), 'clarcade-legacy-board-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const host = { playerId: '00000000-0000-4000-8000-000000000001', name: 'An' }
  const guest = { playerId: '00000000-0000-4000-8000-000000000002', name: 'Binh' }
  const gameId = '00000000-0000-4000-8000-000000000003'
  const moves = [{ x: 0, y: 0, mark: 'X' }, { x: 12, y: -12, mark: 'O' }]
  writeFileSync(join(directory, 'room.json'), JSON.stringify({
    role: 'host', roomCode: 'K7M2QX', roomName: 'Legacy', host, guest, gameId, firstPlayerId: host.playerId,
    startedAt: Date.now(), moves, moveLimit: 400, results: [], pendingResults: [], rematchVotes: [], finished: null,
  }))
  const stats = openStats(join(directory, 'stats.json'))
  const room = new Room({ directory }, host.playerId, stats, () => {})
  assert.equal(room.snapshot().boardSize, 201)
  assert.deepEqual(room.snapshot().moves, moves)
  room.endGame(null, 'draw-agreed')
  room.voteRematch(host.playerId)
  room.voteRematch(guest.playerId)
  assert.notEqual(room.saved.gameId, gameId)
  assert.equal(room.snapshot().boardSize, 15)
  assert.equal(room.snapshot().moveLimit, 0)
  assert.equal(stats.summary().total.draws, 1)
})

test('the snapshot scores the games played in this room with the current guest', t => {
  const directory = mkdtempSync(join(tmpdir(), 'clarcade-score-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const host = { playerId: '00000000-0000-4000-8000-000000000001', name: 'An' }
  const guest = { playerId: '00000000-0000-4000-8000-000000000002', name: 'Binh' }
  writeFileSync(join(directory, 'room.json'), JSON.stringify({
    role: 'host', roomCode: 'K7M2QX', roomName: 'Score', host, guest, gameId: '00000000-0000-4000-8000-000000000003',
    firstPlayerId: host.playerId, startedAt: Date.now(), moves: [], results: [], pendingResults: [],
    rematchVotes: [], finished: null,
  }))
  const room = new Room({ directory }, host.playerId, openStats(join(directory, 'stats.json')), () => {})
  assert.deepEqual(room.snapshot().score, { host: 0, guest: 0, draws: 0 })
  for (const winner of [host.playerId, null, guest.playerId, guest.playerId]) {
    room.endGame(winner, winner ? 'resign' : 'draw-agreed')
    room.voteRematch(host.playerId)
    room.voteRematch(guest.playerId)
  }
  assert.deepEqual(room.snapshot().score, { host: 1, guest: 2, draws: 1 })
})

test('a 15x15 snapshot rejects more than 225 moves or a move past an edge', () => {
  const gameId = '00000000-0000-4000-8000-000000000003'
  const meta = { boardSize: 15 }
  assert.equal(beginState({ gameId, boardVersion: 226, parts: 3, meta }), null)
  const snapshot = beginState({ gameId, boardVersion: 2, parts: 1, meta })
  const moves = [{ x: 0, y: 0, mark: 'X' }, { x: 8, y: 0, mark: 'O' }]
  assert.equal(addStatePart(snapshot, { index: 0, moves }), false)
})

test('a private room stops checking PINs after thirty failures across all addresses', t => {
  const directory = mkdtempSync(join(tmpdir(), 'clarcade-pin-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const hostId = '00000000-0000-4000-8000-000000000001'
  const room = new Room({ directory }, hostId, openStats(join(directory, 'stats.json')), () => {})
  room.commit({
    role: 'host', host: { playerId: hostId, name: 'An' }, guest: null, visibility: 'private',
    pinHash: createPin('4321'), pinAttempts: {}, gameId: 'game', firstPlayerId: hostId,
    moves: [], results: [], pendingResults: [], finished: null, turnEndsAt: null,
  }, restoreGame([]))
  const hello = pin => ({
    playerId: '00000000-0000-4000-8000-000000000002', name: 'Bình', joinNonce: 'a'.repeat(32), pin,
  })
  for (let i = 0; i < 30; i++) {
    assert.equal(room.helloRejection(room.saved, hello('0000'), `10.0.${Math.floor(i / 5)}.${i}`), 'wrong-pin')
  }
  assert.equal(Object.keys(room.saved.pinAttempts).length, 30)
  assert.equal(room.helloRejection(room.saved, hello('4321'), '10.0.9.9'), 'room-locked')
  assert.equal(Object.keys(room.saved.pinAttempts).length, 30)
})

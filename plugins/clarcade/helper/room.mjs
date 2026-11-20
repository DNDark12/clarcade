import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createConnection, createServer, isIP } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DEFAULT_RULESET, applyMove, validRuleset } from '../games/gomoku/rules.js'
import { ROOM_CODE, parseLink, roomCodeFromBytes, roomLinks } from '../hooks/link.js'
import { advertise, allowedAddress, discover, lanAddresses, normalizeAddress } from './discovery.mjs'
import { channel } from './net.mjs'
import { checkPin, createPin, validPin } from './pin.mjs'
import {
  MAX_MOVES, addStatePart, beginState, finishState, name, record,
  restoreGame, stateFrames, validEpoch, validId, validMove, validToken,
} from './protocol.mjs'
import { quarantine, readJson, writeJson } from './runtime.mjs'

const TURN_TIMES = [0, 30000, 60000, 120000, 300000]
const MOVE_LIMITS = [0, 200, 400]
const VISIBILITIES = ['public', 'private']
const EMOTES = ['gg', 'nice', 'thinking']
const EXTRA_ACTIONS = ['undoReq', 'undoResp', 'drawReq', 'drawResp', 'emote']
const HOLD_TIMES = [5 * 60000, 30 * 60000, 120 * 60000]
const SYNC_TIMEOUT = 10000
const CONNECT_TIMEOUT = 4500
const MAX_PIN_FAILURES = 30

export class Room {
  constructor(options, me, stats, change) {
    this.options = options
    this.me = me
    this.stats = stats
    this.change = change
    this.path = join(options.directory, 'room.json')
    this.joinPath = join(options.directory, 'join.json')
    this.saved = readJson(this.path, null, record)
    try {
      if (this.saved) this.saved = normalizeRoom(this.saved)
      if (this.saved && !validSavedRoom(this.saved)) throw new Error('invalid-room')
      this.game = this.saved && restoreGame(this.saved.moves, this.saved.ruleset)
    } catch (error) {
      quarantine(this.path, error)
      this.saved = null
      this.game = null
    }
    this.lastEmote = new Map()
    this.inbound = new Set()
    this.reconnectDelay = 1000
    this.connection = this.saved?.guest ? 'reconnecting' : 'waiting'
  }

  async restore() {
    if (!this.saved) return
    for (const result of [...(this.saved.departedResults ?? []), ...this.saved.results]) this.recordResult(result)
    if (this.saved.departedResults?.length) this.commit({ ...this.saved, departedResults: [] })
    if (this.saved.role === 'host') {
      await this.listen()
      if (this.saved.guest) this.noteDisconnection(true)
      this.commit(this.saved)
    } else {
      this.scheduleReconnect()
    }
  }

  commit(saved, game = this.game) {
    writeJson(this.path, saved)
    this.saved = saved
    this.game = game
    this.armClock()
    this.change()
  }

  get roomCode() { return this.saved?.roomCode }

  get status() {
    if (this.saved.finished) return 'finished'
    return this.saved.guest ? 'playing' : 'waiting'
  }

  get mark() {
    return this.saved.firstPlayerId === this.me ? 'X' : 'O'
  }

  snapshot() {
    const room = this.saved
    if (!room) return null
    return {
      role: room.role, roomCode: room.roomCode, roomName: room.roomName,
      host: room.host, guest: room.guest, gameId: room.gameId, ruleset: room.ruleset,
      visibility: room.visibility, turnMs: room.turnMs, moveLimit: room.moveLimit,
      firstPlayerId: room.firstPlayerId,
      status: this.status, connection: this.connection, moves: room.moves,
      boardVersion: room.moves.length, moveEpoch: room.moveEpoch, turn: room.finished ? null : this.game.turn,
      mark: this.mark, winLine: this.game.winLine, finished: room.finished,
      rematchVotes: room.rematchVotes, holdMs: room.holdMs,
      disconnectedAt: room.disconnectedAt, pendingMove: this.pendingMove?.move ?? null,
      port: room.port, address: room.address, turnEndsAt: room.turnEndsAt,
      turnRemainingMs: room.turnRemainingMs, offer: room.offer, emote: this.emote ?? null,
      directLinks: (room.addresses ?? [room.address]).filter(Boolean)
        .map(address => ({ address, link: roomLinks(room.roomCode, address, room.port).directLink })),
      ...roomLinks(room.roomCode, room.address, room.port),
    }
  }

  async host({
    roomName, name: hostName, holdMs = HOLD_TIMES[1], ruleset = DEFAULT_RULESET,
    visibility = 'public', pin, turnMs = 0, moveLimit = 0,
  }) {
    if (this.saved || this.opening || this.stopping) throw problem('room-active', 409)
    if (!name(roomName) || !name(hostName) || !HOLD_TIMES.includes(holdMs) ||
        !validRuleset(ruleset) || !VISIBILITIES.includes(visibility) ||
        !TURN_TIMES.includes(turnMs) || !MOVE_LIMITS.includes(moveLimit)) {
      throw problem('invalid-room')
    }
    if (visibility === 'private' && !validPin(pin)) throw problem('invalid-pin')
    this.opening = true
    try {
      const room = {
        role: 'host', roomCode: roomCodeFromBytes(randomBytes(6)), roomName,
        host: { playerId: this.me, name: hostName }, guest: null, token: null,
        holdMs, ruleset, visibility, turnMs, moveLimit, disconnectedAt: null,
        ...(visibility === 'private' && { pinHash: createPin(pin), pinAttempts: {} }),
        results: [], pendingResults: [], ...newGame(this.me),
      }
      await this.listen(room)
      this.connection = 'waiting'
      this.commit(room, restoreGame([], ruleset))
      return this.snapshot()
    } catch (error) {
      this.stopListening()
      throw error
    } finally {
      this.opening = false
    }
  }

  async listen(room = this.saved) {
    const server = createServer(socket => this.accept(socket))
    this.server = server
    await new Promise((resolve, reject) => {
      const host = this.options.loopback ? '127.0.0.1' : this.options.allowIpv6Ula ? '::' : '0.0.0.0'
      let port = room.port ?? 0
      const ready = () => {
        server.off('error', failed)
        server.on('error', error => console.error('[clarcade] listener:', error.message))
        resolve()
      }
      const failed = error => {
        server.off('listening', ready)
        if (!port || !['EADDRINUSE', 'EACCES'].includes(error.code)) {
          server.off('error', failed)
          reject(error)
          return
        }
        port = 0
        server.listen({ host, port }, ready)
      }
      server.on('error', failed)
      server.listen({ host, port }, ready)
    })
    const addresses = lanAddresses(this.options)
    const endpoint = { port: server.address().port, address: addresses[0], addresses }
    Object.assign(room, endpoint)
    this.stopAdvertising = advertise(this.options, () => {
      if (this.saved?.role !== 'host') return null
      return {
        roomCode: this.roomCode, roomName: this.saved.roomName, hostName: this.saved.host.name,
        visibility: this.saved.visibility, status: this.status, ruleset: this.saved.ruleset, port: this.saved.port,
      }
    })
  }

  accept(socket) {
    if (this.saved?.role !== 'host' || this.inbound.size >= 8 ||
        !allowedAddress(socket.remoteAddress, this.options)) {
      socket.destroy()
      return
    }
    const timeout = setTimeout(() => peer.close(), CONNECT_TIMEOUT)
    const peer = channel(socket, this.roomCode, (frame, link) => {
      try {
        if (link === this.peer) this.hostFrame(frame)
        else if (frame.type === 'hello') {
          clearTimeout(timeout)
          this.welcome(frame, link, normalizeAddress(socket.remoteAddress))
        }
      } catch (error) {
        console.error('[clarcade] host frame:', error.message)
        link.close()
      }
    }, link => {
      clearTimeout(timeout)
      this.inbound.delete(link)
      if (link !== this.peer) return
      this.peer = undefined
      if (!this.stopping && this.saved) this.noteDisconnection()
    })
    this.inbound.add(peer)
  }

  welcome(frame, link, address) {
    const rejection = this.helloRejection(this.saved, frame, address)
    const room = this.saved
    if (rejection) {
      link.send({ type: 'reject', reason: rejection })
      setTimeout(() => link.close(), 100).unref()
      return
    }

    const firstJoin = !room.guest
    const token = room.token ?? randomBytes(16).toString('hex')
    const guest = { playerId: frame.playerId, name: frame.name }
    const clock = !room.finished && (firstJoin || room.disconnectedAt) ? startClock(room,
      firstJoin ? room.turnMs : room.turnRemainingMs) : {}
    this.commit({ ...room, ...clock, guest, token, disconnectedAt: null,
      joinNonce: firstJoin ? frame.joinNonce : room.joinNonce,
      startedAt: room.startedAt ?? Date.now() })
    this.peer?.close()
    this.peer = link
    this.connection = 'connected'
    this.change(firstJoin ? 'joined' : 'reconnected')
    link.send({ type: 'welcome', sessionToken: token })
    this.sendState()
    for (const result of this.saved.pendingResults) link.send({ type: 'result', ...result })
  }

  helloRejection(room, frame, address) {
    if (!validId(frame.playerId) || frame.playerId === this.me || !name(frame.name)) return 'invalid-player'
    if (!room.guest) {
      if (frame.sessionToken !== undefined || !validToken(frame.joinNonce)) return 'invalid-session'
      if (room.visibility === 'public') return null
      // The per-address limit alone can be multiplied by adding addresses, so cap the whole room too.
      const failures = Object.values(room.pinAttempts).reduce((total, item) => total + item.count, 0)
      if (failures >= MAX_PIN_FAILURES) return 'room-locked'
      const result = checkPin(room.pinHash, frame.pin, room.pinAttempts[address], Date.now())
      if (result.attempt) {
        this.commit({ ...room, pinAttempts: { ...room.pinAttempts, [address]: result.attempt } })
      }
      return result.reason ?? null
    }
    if (frame.playerId !== room.guest.playerId) return 'room-full'
    if (frame.sessionToken === undefined && validToken(frame.joinNonce) &&
        validToken(room.joinNonce) &&
        timingSafeEqual(Buffer.from(room.joinNonce), Buffer.from(frame.joinNonce))) return null
    if (!validToken(frame.sessionToken) ||
        !timingSafeEqual(Buffer.from(room.token), Buffer.from(frame.sessionToken))) return 'invalid-session'
    return null
  }

  sendState() {
    const room = this.saved
    const meta = {
      host: room.host, guest: room.guest, roomName: room.roomName, ruleset: room.ruleset,
      visibility: room.visibility, turnMs: room.turnMs, moveLimit: room.moveLimit,
      moveEpoch: room.moveEpoch, offer: room.offer,
      clockLeftMs: room.turnEndsAt === null ? null : Math.max(0, room.turnEndsAt - Date.now()),
      firstPlayerId: room.firstPlayerId, turn: room.finished ? null : this.game.turn,
      finished: room.finished, startedAt: room.startedAt, holdMs: room.holdMs,
      rematchVotes: room.rematchVotes,
    }
    for (const frame of stateFrames(room.gameId, room.moves, meta)) this.peer?.send(frame)
  }

  async join({ link, name: guestName, pin }) {
    if (this.saved || this.opening || this.stopping) throw problem('room-active', 409)
    const invite = parseLink(link)
    if (!invite || !name(guestName) ||
        (invite.address && !allowedAddress(invite.address, this.options))) throw problem('invalid-link')
    this.opening = true
    try {
      const target = invite.address ? invite : await this.findRoom(invite.roomCode)
      if (!target) throw problem('room-not-found', 404)
      if (this.stopping) throw problem('shutting-down', 503)
      const previous = readJson(this.joinPath, null, record)
      const joinNonce = previous?.roomCode === invite.roomCode && validToken(previous.joinNonce)
        ? previous.joinNonce : randomBytes(16).toString('hex')
      writeJson(this.joinPath, { roomCode: invite.roomCode, joinNonce })
      await this.connect(target, guestName, joinNonce, pin)
      return this.snapshot()
    } finally {
      this.opening = false
    }
  }

  async findRoom(code, knownAddress) {
    const rooms = await discover(this.options, { roomCode: code }, knownAddress)
    const known = rooms.find(room => room.address === knownAddress)
    if (known) return known
    if (rooms.length > 1) throw problem('room-code-ambiguous', 409)
    return rooms[0]
  }

  connect(target, guestName, joinNonce, pin) {
    if (!allowedAddress(target.address, this.options)) return Promise.reject(problem('invalid-link'))
    return new Promise((resolve, reject) => {
      let completed = false
      let token
      const socket = createConnection({ host: target.address, port: target.port, family: isIP(target.address) })
      const timeout = setTimeout(() => {
        fail(problem('connect-timeout', 504))
        peer.close()
      }, CONNECT_TIMEOUT)
      const fail = error => {
        if (completed) return
        completed = true
        clearTimeout(timeout)
        reject(error)
      }
      const ready = () => {
        if (completed) return
        completed = true
        clearTimeout(timeout)
        this.reconnectDelay = 1000
        resolve()
      }
      const peer = channel(socket, target.roomCode, frame => {
        try {
          if (frame.type === 'reject') {
            fail(problem(typeof frame.reason === 'string' ? frame.reason : 'join-rejected', 409))
            peer.close()
            return
          }
          if (frame.type === 'welcome' && validToken(frame.sessionToken)) {
            if (this.saved && this.saved.token !== frame.sessionToken) {
              peer.close()
              return
            }
            token = frame.sessionToken
            clearTimeout(timeout)
            this.awaitSync()
            return
          }
          if (!token) return
          if (this.guestFrame(frame, target, token)) ready()
        } catch (error) {
          console.error('[clarcade] guest frame:', error.message)
          fail(error)
          peer.close()
        }
      }, link => {
        clearTimeout(timeout)
        fail(problem('connection-lost', 503))
        if (link !== this.peer) return
        this.peer = undefined
        this.cancelSync()
        this.replyMove({ ok: false, reason: 'connection-lost' })
        if (this.departure) this.departure()
        else if (!this.stopping && this.saved) {
          this.connection = 'reconnecting'
          this.change()
          this.scheduleReconnect()
        }
      })
      this.peer = peer
      socket.once('connect', () => {
        peer.send({ type: 'hello', playerId: this.me, name: guestName,
          ...(this.saved ? { sessionToken: this.saved.token } : { joinNonce, ...(pin !== undefined && { pin }) }) })
      })
    })
  }

  awaitSync() {
    this.connection = 'syncing'
    this.change()
    clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => this.retrySync(), SYNC_TIMEOUT)
  }

  retrySync() {
    this.assembly = null
    this.syncRetries = (this.syncRetries ?? 0) + 1
    if (this.syncRetries > 2) {
      this.peer?.close()
      return
    }
    this.peer?.send({ type: 'stateReq' })
    this.awaitSync()
  }

  cancelSync() {
    clearTimeout(this.syncTimer)
    this.assembly = null
    this.syncRetries = 0
  }

  guestFrame(frame, target, token) {
    if (frame.type === 'stateBegin') {
      this.assembly = beginState(frame)
      if (this.assembly) this.assembly.receivedAt = Date.now()
      if (this.assembly) this.awaitSync()
      else this.retrySync()
      return
    }
    if (frame.type === 'statePart' || frame.type === 'stateEnd') {
      const current = this.assembly
      if (!current || frame.gameId !== current.gameId || frame.boardVersion !== current.boardVersion) return
      if (frame.type === 'statePart') {
        if (addStatePart(current, frame)) this.awaitSync()
        else this.retrySync()
        return
      }
      const moves = finishState(current, frame.digest)
      if (!moves || !this.installState(current, moves, target, token)) {
        this.retrySync()
        return
      }
      this.cancelSync()
      return true
    }
    if (!this.saved) return
    if (frame.type === 'moveAck' && validMove(frame)) this.ackMove(frame)
    if (frame.type === 'moveReject' && validMove(frame) && this.matchesPending(frame)) {
      this.awaitSync()
      this.replyMove({ ok: false, reason: frame.reason })
    }
    if (frame.type === 'result') this.receiveResult(frame)
    if (frame.type === 'emote' && frame.gameId === this.saved.gameId &&
        [this.me, this.saved.host.playerId].includes(frame.playerId) && EMOTES.includes(frame.value)) {
      this.setEmote(frame.playerId, frame.value)
    }
    if (frame.type === 'actionReject' && frame.gameId === this.saved.gameId) {
      this.change('action-rejected')
    }
    if (frame.type === 'offer' && frame.gameId === this.saved.gameId && this.status === 'playing' &&
        frame.moveEpoch === this.saved.moveEpoch && frame.boardVersion === this.saved.moves.length &&
        validOffer(frame.offer, this.saved.host.playerId, this.me)) {
      this.commit({ ...this.saved, offer: frame.offer })
    }
    if (frame.type === 'rematch' && frame.gameId === this.saved.gameId &&
        this.status === 'finished' && Array.isArray(frame.votes) &&
        frame.votes.length === 1 && [this.saved.host.playerId, this.me].includes(frame.votes[0])) {
      this.commit({ ...this.saved, rematchVotes: frame.votes })
    }
    if (frame.type === 'bye' || frame.type === 'left') {
      if (this.departure) this.departure()
      else if (frame.type === 'bye') this.remoteLeft()
    }
  }

  installState({ gameId, meta, receivedAt }, moves, target, token) {
    const properties = normalizeRoom(meta)
    if (!validPlayer(meta.host) || !validPlayer(meta.guest) || meta.guest.playerId !== this.me ||
        meta.host.playerId === this.me || !name(meta.roomName) || !validRuleset(properties.ruleset) ||
        !VISIBILITIES.includes(properties.visibility) || !TURN_TIMES.includes(properties.turnMs) ||
        !MOVE_LIMITS.includes(properties.moveLimit) || !validEpoch(properties.moveEpoch) ||
        !validOffer(properties.offer, meta.host.playerId, this.me) ||
        (meta.clockLeftMs != null && (!Number.isInteger(meta.clockLeftMs) ||
          meta.clockLeftMs < 0 || meta.clockLeftMs > properties.turnMs)) ||
        ![meta.host.playerId, this.me].includes(meta.firstPlayerId) ||
        !HOLD_TIMES.includes(meta.holdMs) || !Array.isArray(meta.rematchVotes) ||
        !meta.rematchVotes.every(id => [meta.host.playerId, this.me].includes(id)) ||
        meta.rematchVotes.length > 2 || !Number.isSafeInteger(meta.startedAt) ||
        (this.saved && meta.host.playerId !== this.saved.host.playerId)) return false
    let game
    try { game = restoreGame(moves, properties.ruleset) } catch { return false }
    if (meta.finished !== null && !validResult(meta.finished, meta.host.playerId, this.me)) return false
    if (meta.finished && (meta.finished.gameId !== gameId || meta.finished.moves !== moves.length ||
        meta.finished.ruleset !== properties.ruleset)) return false
    if (meta.turn !== (meta.finished ? null : game.turn)) return false
    if (this.saved?.gameId !== gameId) this.emote = undefined
    this.connection = 'connected'
    this.commit({
      role: 'guest', roomCode: target.roomCode, roomName: meta.roomName, host: meta.host, guest: meta.guest,
      address: target.address, port: target.port, token, holdMs: meta.holdMs,
      ruleset: properties.ruleset, visibility: properties.visibility, turnMs: properties.turnMs,
      moveLimit: properties.moveLimit, moveEpoch: properties.moveEpoch, offer: properties.offer,
      turnEndsAt: meta.clockLeftMs == null ? null : receivedAt + meta.clockLeftMs,
      turnRemainingMs: meta.clockLeftMs ?? 0,
      gameId, moves, firstPlayerId: meta.firstPlayerId, startedAt: meta.startedAt,
      finished: meta.finished, rematchVotes: meta.rematchVotes, disconnectedAt: null,
      results: this.saved?.results ?? [], pendingResults: [],
    }, game)
    if (this.pendingMove) {
      const sent = this.pendingMove.move
      const actual = moves[sent.moveNo - 1]
      const accepted = sent.gameId === gameId && sent.moveEpoch === properties.moveEpoch && actual?.mark === this.mark &&
        actual.x === sent.x && actual.y === sent.y
      this.replyMove(accepted ? { ok: true } : { ok: false, reason: 'move-not-confirmed' })
    }
    return true
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer || this.reconnecting ||
        !this.saved || this.connection === 'connected') return
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined
      const room = this.saved
      if (room?.role !== 'guest') return
      this.reconnecting = true
      const target = { roomCode: room.roomCode, address: room.address, port: room.port }
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
      try {
        try { await this.connect(target, room.guest.name) } catch {
          if (this.stopping || this.saved?.gameId !== room.gameId) return
          const discovered = await this.findRoom(room.roomCode, room.address)
          if (discovered && !this.stopping && this.saved?.role === 'guest' && this.saved.roomCode === room.roomCode) {
            await this.connect(discovered, room.guest.name)
          }
        }
      } catch (error) {
        console.error('[clarcade] reconnect:', error.message)
      } finally {
        this.reconnecting = false
        this.scheduleReconnect()
      }
    }, this.reconnectDelay)
    this.reconnectTimer.unref()
  }

  noteDisconnection(afterCrash = false) {
    const room = this.saved
    if (!afterCrash) this.expireTurn()
    this.connection = 'reconnecting'
    if (!room.disconnectedAt) {
      const now = Date.now()
      const remaining = afterCrash || room.turnEndsAt === null ? room.turnRemainingMs
        : Math.max(0, room.turnEndsAt - now)
      this.commit({ ...this.saved, turnEndsAt: null, turnRemainingMs: remaining, disconnectedAt: now })
    }
    this.change()
  }

  armClock() {
    clearTimeout(this.turnTimer)
    const room = this.saved
    if (room?.role !== 'host' || room.finished || room.turnEndsAt === null) return
    this.turnTimer = setTimeout(() => {
      try {
        if (!this.expireTurn()) this.armClock()
      } catch (error) {
        console.error('[clarcade] clock:', error.message)
      }
    }, Math.max(0, room.turnEndsAt - Date.now()))
    this.turnTimer.unref()
  }

  expireTurn() {
    const room = this.saved
    if (room?.role !== 'host' || room.finished || room.turnEndsAt === null ||
        Date.now() < room.turnEndsAt) return false
    const other = room.firstPlayerId === this.me ? room.guest.playerId : this.me
    this.endGame(this.game.turn === 'X' ? other : room.firstPlayerId, 'timeout')
    return true
  }

  hostFrame(frame) {
    if (!this.saved) return
    if (frame.type === 'move' && validMove(frame)) {
      const result = this.hostMove(frame, this.saved.guest.playerId)
      if (!result.ok && this.peer) {
        if (result.reason !== 'stale-game') {
          this.peer.send({ type: 'moveReject', ...moveFields(frame), reason: result.reason })
        }
        this.sendState()
      }
    }
    if (frame.type === 'stateReq' && !this.peer.busy) this.sendState()
    if (frame.type === 'resultAck' && validId(frame.gameId) &&
        this.saved.pendingResults.some(result => result.gameId === frame.gameId)) {
      this.commit({ ...this.saved, pendingResults: this.saved.pendingResults.filter(result => result.gameId !== frame.gameId) })
    }
    if (frame.gameId === this.saved.gameId) {
      if (frame.type === 'rematch') this.voteRematch(this.saved.guest.playerId)
      if (frame.type === 'resign' && this.status === 'playing' && !this.expireTurn()) this.endGame(this.me, 'resign')
      if (EXTRA_ACTIONS.includes(frame.type)) {
        try { this.handleExtra({ ...frame, action: frame.type }, this.saved.guest.playerId) } catch (error) {
          if (!error.status) throw error
          this.peer.send({ type: 'actionReject', gameId: frame.gameId, reason: error.message })
        }
      }
    }
    if (frame.type === 'bye') this.releaseGuest()
  }

  async move(move) {
    if (!this.saved) throw problem('no-room', 404)
    if (this.departure) throw problem('peer-unavailable', 409)
    if (!validMove(move)) throw problem('invalid-move')
    if (this.saved.role === 'host') return this.hostMove(move, this.me)
    if (this.connection !== 'connected') return { ok: false, reason: 'syncing' }
    if (this.pendingMove) return { ok: false, reason: 'move-pending' }
    const pending = moveFields(move)
    return new Promise(resolve => {
      this.pendingMove = { move: pending, resolve }
      this.pendingMove.timer = setTimeout(() => {
        this.retrySync()
        this.replyMove({ ok: false, reason: 'move-timeout' })
      }, 4000)
      this.change()
      this.peer.send({ type: 'move', ...pending })
    })
  }

  hostMove(move, playerId) {
    const room = this.saved
    const frame = moveFields(move)
    if (frame.gameId !== room.gameId) return { ok: false, reason: 'stale-game' }
    if (frame.moveEpoch !== room.moveEpoch) return { ok: false, reason: 'stale-move' }
    const mark = playerId === room.firstPlayerId ? 'X' : 'O'
    const previous = room.moves[frame.moveNo - 1]
    const ack = { type: 'moveAck', ...frame, mark, clockLeftMs: room.turnMs || null }
    if (previous) {
      if (previous.mark !== mark || previous.x !== frame.x || previous.y !== frame.y) {
        return { ok: false, reason: 'conflict' }
      }
      if (playerId !== this.me) this.peer?.send(ack)
      return { ok: true, duplicate: true }
    }
    if (this.status !== 'playing' || this.expireTurn()) return { ok: false, reason: this.status }
    if (this.connection !== 'connected') return { ok: false, reason: 'peer-unavailable' }
    if (frame.moveNo !== room.moves.length + 1) return { ok: false, reason: 'move-number' }

    const result = applyMove(this.game, { x: frame.x, y: frame.y, mark })
    if (!result.ok) return result
    const next = { ...room, ...startClock(room), offer: null,
      moves: [...room.moves, { x: frame.x, y: frame.y, mark }] }
    const limitReached = room.moveLimit && next.moves.length >= room.moveLimit
    const finished = result.state.winLine || limitReached || next.moves.length === MAX_MOVES
    if (finished) {
      this.finishRoom(next, result.state.winLine ? playerId : null,
        result.state.winLine ? 'line' : limitReached ? 'move-limit' : 'board-full', result.state)
    } else {
      this.commit(next, result.state)
      if (result.state.turn === this.mark) this.change('turn')
    }
    this.peer?.send(ack)
    if (finished) this.publishResult(this.saved.finished)
    return { ok: true }
  }

  matchesPending(move) {
    const sent = this.pendingMove?.move
    return sent && sent.gameId === move.gameId && sent.moveNo === move.moveNo &&
      sent.moveEpoch === (move.moveEpoch ?? 0) &&
      sent.x === move.x && sent.y === move.y
  }

  ackMove(frame) {
    const room = this.saved
    if (frame.gameId !== room.gameId || this.connection !== 'connected') return
    if ((frame.moveEpoch ?? 0) < room.moveEpoch) return
    if ((frame.moveEpoch ?? 0) > room.moveEpoch) { this.retrySync(); return }
    if (frame.moveNo === room.moves.length + 1) {
      const moved = applyMove(this.game, frame)
      if (!moved.ok) { this.retrySync(); return }
      const clockLeftMs = Number.isInteger(frame.clockLeftMs) && frame.clockLeftMs > 0 &&
        frame.clockLeftMs <= room.turnMs ? frame.clockLeftMs : 0
      this.commit({ ...room, ...startClock(room, clockLeftMs), offer: null,
        moves: [...room.moves, { x: frame.x, y: frame.y, mark: frame.mark }] }, moved.state)
      if (moved.state.turn === this.mark) this.change('turn')
    } else if (frame.moveNo > room.moves.length) {
      this.retrySync()
      return
    }
    if (this.matchesPending(frame)) this.replyMove({ ok: true })
  }

  replyMove(result) {
    if (!this.pendingMove) return
    const { timer, resolve } = this.pendingMove
    clearTimeout(timer)
    this.pendingMove = undefined
    this.change()
    resolve(result)
  }

  async action(request) {
    const { action, gameId } = request
    const room = this.saved
    if (!room) throw problem('no-room', 404)
    if (this.departure) throw problem('peer-unavailable', 409)
    if (action === 'leave') {
      if (room.role === 'guest' && this.peer && this.connection === 'connected') {
        await this.requestDeparture()
        return
      }
      // Leaving while the opponent is connected forfeits, matching a guest departure.
      if (room.role === 'host' && this.peer && this.connection === 'connected') {
        this.expireTurn()
        if (this.status === 'playing') this.endGame(room.guest.playerId, 'disconnected')
      }
      await this.leave(true)
      return
    }
    if (gameId !== room.gameId) throw problem('stale-game', 409)
    if (EXTRA_ACTIONS.includes(action)) {
      if (room.role === 'host') return this.handleExtra(request, this.me)
      if (this.connection !== 'connected') throw problem('peer-unavailable', 409)
      this.validateExtra(request, this.me)
      this.peer.send({ type: action, gameId, offerId: request.offerId, accepted: request.accepted,
        emote: request.emote, moveEpoch: room.moveEpoch, boardVersion: room.moves.length })
      return
    }
    if (room.role === 'guest') {
      if (this.connection !== 'connected') throw problem('peer-unavailable', 409)
      if ((action === 'rematch' && this.status === 'finished') ||
          (action === 'resign' && this.status === 'playing')) {
        this.peer.send({ type: action, gameId })
        return
      }
    } else {
      if (action === 'rematch' && this.status === 'finished') { this.voteRematch(this.me); return }
      if (action === 'resign' && this.status === 'playing' && !this.expireTurn()) { this.endGame(room.guest.playerId, action); return }
      if (this.status === 'playing' && room.disconnectedAt && Date.now() - room.disconnectedAt >= room.holdMs) {
        if (action === 'claim') { this.endGame(this.me, 'disconnected'); return }
        if (action === 'extend') { this.commit({ ...room, disconnectedAt: Date.now() }); return }
      }
    }
    throw problem('invalid-action')
  }

  validateExtra({ action, offerId, accepted, emote, moveEpoch, boardVersion }, playerId) {
    const room = this.saved
    if (this.status !== 'playing' || this.connection !== 'connected') throw problem('invalid-action', 409)
    if (action === 'emote') {
      if (!EMOTES.includes(emote)) throw problem('invalid-action')
      return
    }
    if ((moveEpoch !== undefined && moveEpoch !== room.moveEpoch) ||
        (boardVersion !== undefined && boardVersion !== room.moves.length)) throw problem('stale-move', 409)
    const kind = action.startsWith('undo') ? 'undo' : 'draw'
    if (action.endsWith('Req')) {
      if (room.offer) throw problem('offer-active', 409)
      const mark = playerId === room.firstPlayerId ? 'X' : 'O'
      if (kind === 'undo' && room.moves.at(-1)?.mark !== mark) throw problem('undo-last-move', 409)
      return
    }
    if (room.offer?.kind !== kind || room.offer.id !== offerId ||
        room.offer.playerId === playerId || typeof accepted !== 'boolean') throw problem('invalid-offer', 409)
  }

  handleExtra(request, playerId) {
    const { action } = request
    if (this.expireTurn()) throw problem('finished', 409)
    this.validateExtra(request, playerId)
    const room = this.saved
    if (action === 'emote') {
      if (Date.now() - (this.lastEmote.get(playerId) ?? 0) < 1000) throw problem('emote-rate-limit', 429)
      this.lastEmote.set(playerId, Date.now())
      this.setEmote(playerId, request.emote)
      this.peer.send({ type: 'emote', gameId: room.gameId, playerId, value: request.emote })
      return
    }
    if (action.endsWith('Req')) {
      const kind = action === 'undoReq' ? 'undo' : 'draw'
      this.commit({ ...room, offer: { id: randomUUID(), kind, playerId } })
    } else if (!request.accepted) {
      this.commit({ ...room, offer: null })
    } else if (action === 'drawResp') {
      this.endGame(null, 'draw-agreed')
      return
    } else {
      const moves = room.moves.slice(0, -1)
      this.commit({ ...room, ...startClock(room), moves, offer: null, moveEpoch: room.moveEpoch + 1 },
        restoreGame(moves, room.ruleset))
      this.sendState()
      return
    }
    this.peer.send({ type: 'offer', gameId: room.gameId, moveEpoch: room.moveEpoch,
      boardVersion: room.moves.length, offer: this.saved.offer })
  }

  setEmote(playerId, value) {
    this.emote = { playerId, value, expiresAt: Date.now() + 5000 }
    this.change()
  }

  voteRematch(playerId) {
    if (this.status !== 'finished' || this.saved.rematchVotes.includes(playerId)) return
    const votes = [...this.saved.rematchVotes, playerId]
    if (votes.length < 2) {
      this.commit({ ...this.saved, rematchVotes: votes })
      this.peer?.send({ type: 'rematch', gameId: this.saved.gameId, votes })
      return
    }
    const first = this.saved.firstPlayerId === this.me ? this.saved.guest.playerId : this.me
    this.emote = undefined
    this.lastEmote.clear()
    this.commit({ ...this.saved, ...newGame(first), ...startClock(this.saved),
      startedAt: Date.now() }, restoreGame([], this.saved.ruleset))
    this.change('rematch')
    this.sendState()
  }

  endGame(winner, reason) {
    this.finishRoom(this.saved, winner, reason, this.game)
    this.publishResult(this.saved.finished)
  }

  finishRoom(room, winner, reason, game) {
    const result = gameResult(room, winner, reason)
    this.commit({ ...room, finished: result, offer: null, turnEndsAt: null, turnRemainingMs: 0, results: [...room.results, result],
      pendingResults: [...room.pendingResults, result] }, game)
    this.recordResult(result)
    this.change('finished')
  }

  publishResult(result) {
    this.peer?.send({ type: 'result', ...result })
  }

  receiveResult(frame) {
    const room = this.saved
    if (!validResult(frame, room.host.playerId, this.me) || frame.ruleset !== room.ruleset) return
    if (frame.gameId === room.gameId && (frame.moves !== room.moves.length ||
        (frame.firstPlayerId !== undefined && frame.firstPlayerId !== room.firstPlayerId))) {
      this.retrySync()
      return
    }
    const { gameId, winner, reason, moves, ruleset, durationMs, firstPlayerId, endedAt } = frame
    const result = { gameId, winner, reason, moves, ruleset, durationMs, firstPlayerId, endedAt }
    if (!room.results.some(previous => previous.gameId === gameId)) {
      this.commit({ ...room, results: [...room.results, result],
        ...(gameId === room.gameId && { finished: result, offer: null, turnEndsAt: null, turnRemainingMs: 0 }) })
      if (gameId === room.gameId) this.change('finished')
    }
    this.recordResult(result)
    this.peer?.send({ type: 'resultAck', gameId })
  }

  recordResult(result) {
    const { opponent = this.saved.role === 'host' ? this.saved.guest : this.saved.host, ...game } = result
    this.stats.record({ ...game, playerId: this.me, opponentId: opponent.playerId, opponentName: opponent.name })
  }

  releaseGuest() {
    this.expireTurn()
    const room = this.saved
    const peer = this.peer
    const result = this.status === 'playing' ? gameResult(room, this.me, 'disconnected') : null
    const archive = result ? [{ ...result, opponent: room.guest }] : []
    this.commit({
      ...room, ...newGame(this.me), guest: null, token: null, joinNonce: null, disconnectedAt: null,
      results: [], pendingResults: [], departedResults: archive,
    }, restoreGame([], room.ruleset))
    this.peer = undefined
    this.connection = 'waiting'
    this.emote = undefined
    this.lastEmote.clear()
    if (result) {
      this.recordResult(archive[0])
      this.commit({ ...this.saved, departedResults: [] })
    }
    for (const pending of room.pendingResults) peer.send({ type: 'result', ...pending })
    if (result) peer.send({ type: 'result', ...result })
    peer.send({ type: 'left' })
    setTimeout(() => peer.close(), 2500).unref()
  }

  async requestDeparture() {
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 3000)
      this.departure = () => { clearTimeout(timeout); resolve() }
      this.peer.send({ type: 'bye' })
    })
    // Keep the room available until the final result has been accepted locally.
    try { await this.leave(false) } finally { this.departure = undefined }
  }

  stopListening() {
    this.stopAdvertising?.()
    this.stopAdvertising = undefined
    const server = this.server
    this.server = undefined
    return new Promise(resolve => {
      if (!server) { resolve(); return }
      server.close(resolve)
    })
  }

  async leave(notify) {
    if (!this.saved || this.stopping) return
    this.commit(null, null)
    this.emote = undefined
    this.lastEmote.clear()
    this.stopping = true
    const peer = this.peer
    if (notify && peer) {
      // end() drops queued frames, so let a final result leave the paced queue first.
      for (let waited = 0; peer.busy && waited < 1000; waited += 25) await delay(25)
      const timeout = setTimeout(() => peer.close(), 200)
      try { await peer.end({ type: 'bye' }) } finally { clearTimeout(timeout) }
    }
    await this.stop()
    this.connection = 'waiting'
    this.stopping = false
    this.change()
  }

  remoteLeft() {
    this.leave(false).catch(error => console.error('[clarcade] close room:', error.message))
  }

  async stop() {
    this.stopping = true
    clearTimeout(this.turnTimer)
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.cancelSync()
    this.replyMove({ ok: false, reason: 'connection-lost' })
    this.peer?.close()
    this.peer = undefined
    for (const peer of this.inbound) peer.close()
    await this.stopListening()
  }
}

function gameResult(room, winner, reason) {
  const endedAt = Date.now()
  return {
    gameId: room.gameId, winner, reason, moves: room.moves.length, ruleset: room.ruleset,
    firstPlayerId: room.firstPlayerId, endedAt, durationMs: Math.max(0, endedAt - room.startedAt),
  }
}

function newGame(firstPlayerId) {
  return {
    gameId: randomUUID(), firstPlayerId, moves: [], finished: null, startedAt: null, rematchVotes: [],
    moveEpoch: 0, offer: null, turnEndsAt: null, turnRemainingMs: 0,
  }
}

function normalizeRoom(room) {
  return {
    ruleset: DEFAULT_RULESET, visibility: 'public', moveEpoch: 0, turnMs: 0, moveLimit: 0,
    turnEndsAt: null, turnRemainingMs: 0, offer: null, ...room,
  }
}

function startClock(room, remaining = room.turnMs) {
  return {
    turnEndsAt: room.turnMs ? Date.now() + remaining : null,
    turnRemainingMs: remaining,
  }
}

function validOffer(offer, hostId, guestId) {
  return offer === null || (record(offer) && validId(offer.id) &&
    ['undo', 'draw'].includes(offer.kind) && [hostId, guestId].includes(offer.playerId))
}

function validSavedRoom(room) {
  const results = value => Array.isArray(value) && value.every(record)
  return ['host', 'guest'].includes(room.role) && ROOM_CODE.test(room.roomCode ?? '') && name(room.roomName) &&
    validPlayer(room.host) && (room.guest === null || validPlayer(room.guest)) &&
    validId(room.gameId) && validId(room.firstPlayerId) && validRuleset(room.ruleset) &&
    results(room.results) && results(room.pendingResults) &&
    (room.departedResults === undefined || results(room.departedResults)) &&
    (room.role === 'host' || (room.guest !== null && validToken(room.token) &&
      typeof room.address === 'string' && Number.isInteger(room.port)))
}

function validPlayer(player) {
  return record(player) && validId(player.playerId) && name(player.name)
}

function validResult(result, hostId, guestId) {
  return record(result) && validId(result.gameId) &&
    [hostId, guestId, null].includes(result.winner) &&
    ['line', 'resign', 'disconnected', 'board-full', 'timeout', 'move-limit', 'draw-agreed'].includes(result.reason) &&
    (result.firstPlayerId === undefined || [hostId, guestId].includes(result.firstPlayerId)) &&
    (result.endedAt === undefined || (Number.isSafeInteger(result.endedAt) && result.endedAt >= 0 &&
      result.endedAt <= 8640000000000000)) &&
    Number.isInteger(result.moves) && result.moves >= 0 && result.moves <= MAX_MOVES &&
    Number.isSafeInteger(result.durationMs) && result.durationMs >= 0 && validRuleset(result.ruleset)
}

function moveFields({ gameId, moveNo, x, y, moveEpoch = 0 }) {
  return { gameId, moveNo, x, y, moveEpoch }
}

export function problem(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

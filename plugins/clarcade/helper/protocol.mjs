import { createHash } from 'node:crypto'
import { ROOM_CODE } from '../hooks/link.js'
import { DEFAULT_RULESET, findWinLine } from '../games/gomoku/rules.js'

export const MAX_FRAME_BYTES = 4096
export const MAX_MOVES = 201 * 201
const MOVES_PER_PART = 100
export const TOKEN = /^[a-f0-9]{32}$/
export const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/

export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const name = value => typeof value === 'string' && value === value.trim() &&
  value.length >= 1 && value.length <= 32 && !/[\u0000-\u001f\u007f]/u.test(value)
export const validId = value => typeof value === 'string' && ID.test(value)
export const validToken = value => typeof value === 'string' && TOKEN.test(value)
export const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535
export const coordinate = value => Number.isInteger(value) && Math.abs(value) <= 100
export const validEpoch = value => Number.isSafeInteger(value) && value >= 0
export const validMove = value => record(value) && validId(value.gameId) &&
  Number.isInteger(value.moveNo) && value.moveNo >= 1 && value.moveNo <= MAX_MOVES &&
  (value.moveEpoch === undefined || validEpoch(value.moveEpoch)) &&
  coordinate(value.x) && coordinate(value.y)

export function envelope(value) {
  return record(value) && typeof value.type === 'string' &&
    typeof value.roomCode === 'string' && ROOM_CODE.test(value.roomCode) &&
    Number.isSafeInteger(value.seq) && value.seq > 0
}

export function digest(moves) {
  return createHash('sha256').update(JSON.stringify(moves)).digest('hex')
}

export function* stateFrames(gameId, moves, meta) {
  const boardVersion = moves.length
  const parts = Math.ceil(boardVersion / MOVES_PER_PART)
  yield { type: 'stateBegin', gameId, boardVersion, parts, meta }
  for (let index = 0; index < parts; index++) {
    const start = index * MOVES_PER_PART
    yield { type: 'statePart', gameId, boardVersion, index, moves: moves.slice(start, start + MOVES_PER_PART) }
  }
  yield { type: 'stateEnd', gameId, boardVersion, digest: digest(moves) }
}

export function beginState(frame) {
  const { gameId, boardVersion, parts, meta } = frame
  if (!validId(gameId) || !Number.isInteger(boardVersion) || boardVersion < 0 ||
      boardVersion > MAX_MOVES || parts !== Math.ceil(boardVersion / MOVES_PER_PART) ||
      !record(meta)) return null

  return { gameId, boardVersion, parts, meta, chunks: new Map() }
}

export function addStatePart(snapshot, { index, moves }) {
  if (!Number.isInteger(index) || index < 0 || index >= snapshot.parts || !Array.isArray(moves)) return false
  const expected = Math.min(MOVES_PER_PART, snapshot.boardVersion - index * MOVES_PER_PART)
  if (moves.length !== expected || snapshot.chunks.has(index)) return false
  if (!moves.every(isHistoryMove)) return false
  snapshot.chunks.set(index, moves)
  return true
}

export function finishState(snapshot, expectedDigest) {
  if (snapshot.chunks.size !== snapshot.parts) return null
  const moves = []
  for (let index = 0; index < snapshot.parts; index++) moves.push(...snapshot.chunks.get(index))
  return digest(moves) === expectedDigest ? moves : null
}

function isHistoryMove(value) {
  return record(value) && Object.keys(value).length === 3 &&
    coordinate(value.x) && coordinate(value.y) && (value.mark === 'X' || value.mark === 'O')
}

export function restoreGame(moves, ruleset = DEFAULT_RULESET) {
  if (!Array.isArray(moves) || moves.length > MAX_MOVES) throw new Error('invalid-history')
  const board = new Map()
  let turn = 'X'
  let winLine = null
  for (const move of moves) {
    if (!isHistoryMove(move) || move.mark !== turn || (board.size === 0 && (move.x || move.y))) {
      throw new Error('invalid-history')
    }
    const key = `${move.x},${move.y}`
    if (board.has(key)) throw new Error('invalid-history')
    board.set(key, turn)
    winLine = findWinLine(board, move, ruleset)
    turn = winLine || board.size === MAX_MOVES ? null : turn === 'X' ? 'O' : 'X'
  }
  return { board, turn, winLine, ruleset }
}

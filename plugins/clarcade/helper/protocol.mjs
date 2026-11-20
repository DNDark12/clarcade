import { createHash } from 'node:crypto'
import { ROOM_CODE } from '../hooks/link.js'
import { BOARD_SIZE, DEFAULT_RULESET, LEGACY_BOARD_SIZE, findWinLine, validBoardSize, validCoordinate } from '../games/gomoku/rules.js'

export const MAX_FRAME_BYTES = 4096
export const MAX_MOVES = LEGACY_BOARD_SIZE ** 2
const MOVES_PER_PART = 100
export const TOKEN = /^[a-f0-9]{32}$/
export const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/

export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const name = value => typeof value === 'string' && value === value.trim() &&
  value.length >= 1 && value.length <= 32 && !/[\u0000-\u001f\u007f]/u.test(value)
export const validId = value => typeof value === 'string' && ID.test(value)
export const validToken = value => typeof value === 'string' && TOKEN.test(value)
export const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535
export const validEpoch = value => Number.isSafeInteger(value) && value >= 0
export const validMove = (value, boardSize = BOARD_SIZE) => record(value) && validId(value.gameId) &&
  Number.isInteger(value.moveNo) && value.moveNo >= 1 && value.moveNo <= boardSize ** 2 &&
  (value.moveEpoch === undefined || validEpoch(value.moveEpoch)) &&
  validCoordinate(value.x, boardSize) && validCoordinate(value.y, boardSize)

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
  if (!record(meta)) return null
  const boardSize = meta.boardSize === undefined ? LEGACY_BOARD_SIZE : meta.boardSize
  if (!validId(gameId) || !Number.isInteger(boardVersion) || boardVersion < 0 ||
      !validBoardSize(boardSize) || boardVersion > boardSize ** 2 ||
      parts !== Math.ceil(boardVersion / MOVES_PER_PART)) return null

  return { gameId, boardVersion, boardSize, parts, meta, chunks: new Map() }
}

export function addStatePart(snapshot, { index, moves }) {
  if (!Number.isInteger(index) || index < 0 || index >= snapshot.parts || !Array.isArray(moves)) return false
  const expected = Math.min(MOVES_PER_PART, snapshot.boardVersion - index * MOVES_PER_PART)
  if (moves.length !== expected || snapshot.chunks.has(index)) return false
  if (!moves.every(move => isHistoryMove(move, snapshot.boardSize))) return false
  snapshot.chunks.set(index, moves)
  return true
}

export function finishState(snapshot, expectedDigest) {
  if (snapshot.chunks.size !== snapshot.parts) return null
  const moves = []
  for (let index = 0; index < snapshot.parts; index++) moves.push(...snapshot.chunks.get(index))
  return digest(moves) === expectedDigest ? moves : null
}

function isHistoryMove(value, boardSize) {
  return record(value) && Object.keys(value).length === 3 &&
    validCoordinate(value.x, boardSize) && validCoordinate(value.y, boardSize) &&
    (value.mark === 'X' || value.mark === 'O')
}

export function restoreGame(moves, ruleset = DEFAULT_RULESET, boardSize = BOARD_SIZE) {
  const capacity = boardSize ** 2
  if (!validBoardSize(boardSize) || !Array.isArray(moves) || moves.length > capacity) throw new Error('invalid-history')
  const board = new Map()
  let turn = 'X'
  let winLine = null
  for (const move of moves) {
    if (!isHistoryMove(move, boardSize) || move.mark !== turn || (board.size === 0 && (move.x || move.y))) {
      throw new Error('invalid-history')
    }
    const key = `${move.x},${move.y}`
    if (board.has(key)) throw new Error('invalid-history')
    board.set(key, turn)
    winLine = findWinLine(board, move, ruleset, boardSize)
    turn = winLine || board.size === capacity ? null : turn === 'X' ? 'O' : 'X'
  }
  return { board, turn, winLine, ruleset, boardSize }
}

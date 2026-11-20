export const BOARD_SIZE = 15
export const LEGACY_BOARD_SIZE = 201
const WIN_LENGTH = 5
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]]
export const DEFAULT_RULESET = 'freestyle'
export const validRuleset = value => value === DEFAULT_RULESET || value === 'vn'
export const validBoardSize = value => value === BOARD_SIZE || value === LEGACY_BOARD_SIZE
export const validCoordinate = (value, boardSize = BOARD_SIZE) =>
  Number.isInteger(value) && Math.abs(value) <= (boardSize - 1) / 2

export function applyMove(state, { x, y, mark }) {
  const { boardSize = BOARD_SIZE } = state
  if (state.turn === null) {
    return { ok: false, reason: 'finished' }
  }
  if (mark !== state.turn) {
    return { ok: false, reason: 'wrong-turn' }
  }
  if (!validCoordinate(x, boardSize) || !validCoordinate(y, boardSize)) {
    return { ok: false, reason: 'invalid-coordinates' }
  }
  if (state.board.size === 0 && (x !== 0 || y !== 0)) {
    return { ok: false, reason: 'first-move-origin' }
  }

  const key = `${x},${y}`
  if (state.board.has(key)) {
    return { ok: false, reason: 'occupied' }
  }

  const board = new Map(state.board)
  board.set(key, mark)
  const winLine = findWinLine(board, { x, y }, state.ruleset, boardSize)
  const nextTurn = mark === 'X' ? 'O' : 'X'

  return {
    ok: true,
    state: { ...state, board, turn: winLine || board.size === boardSize ** 2 ? null : nextTurn, winLine },
  }
}

export function findWinLine(board, { x, y }, ruleset = DEFAULT_RULESET, boardSize = BOARD_SIZE) {
  if (!validRuleset(ruleset)) {
    throw new RangeError(`Unsupported Gomoku ruleset: ${ruleset}`)
  }

  const mark = board.get(`${x},${y}`)
  if (mark === undefined) return null

  for (const [dx, dy] of DIRECTIONS) {
    const before = matchingNeighbors(board, x, y, -dx, -dy, mark)
    const after = matchingNeighbors(board, x, y, dx, dy, mark)

    if (before.length + after.length + 1 < WIN_LENGTH) continue
    const opponent = mark === 'X' ? 'O' : 'X'
    if (ruleset === 'vn' &&
        blockedEnd(board, x, y, -dx, -dy, before.length + 1, opponent, boardSize) &&
        blockedEnd(board, x, y, dx, dy, after.length + 1, opponent, boardSize)) continue
    return [...before.reverse(), { x, y }, ...after]
  }

  return null
}

function blockedEnd(board, x, y, dx, dy, distance, opponent, boardSize) {
  const endX = x + dx * distance
  const endY = y + dy * distance
  return validCoordinate(endX, boardSize) && validCoordinate(endY, boardSize) &&
    board.get(`${endX},${endY}`) === opponent
}

function matchingNeighbors(board, x, y, dx, dy, mark) {
  const cells = []
  let nextX = x + dx
  let nextY = y + dy

  while (board.get(`${nextX},${nextY}`) === mark) {
    cells.push({ x: nextX, y: nextY })
    nextX += dx
    nextY += dy
  }

  return cells
}

export function bounds(boardSize = BOARD_SIZE) {
  const edge = (boardSize - 1) / 2
  return { minX: -edge, maxX: edge, minY: -edge, maxY: edge }
}

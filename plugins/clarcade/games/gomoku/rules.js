const BOARD_LIMIT = 100
const VIEW_PADDING = 3
const WIN_LENGTH = 5
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]]
export const DEFAULT_RULESET = 'freestyle'
export const validRuleset = value => value === DEFAULT_RULESET || value === 'vn'

export function applyMove(state, { x, y, mark }) {
  if (state.turn === null) {
    return { ok: false, reason: 'finished' }
  }
  if (mark !== state.turn) {
    return { ok: false, reason: 'wrong-turn' }
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) ||
      Math.abs(x) > BOARD_LIMIT || Math.abs(y) > BOARD_LIMIT) {
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
  const winLine = findWinLine(board, { x, y }, state.ruleset)
  const nextTurn = mark === 'X' ? 'O' : 'X'

  return {
    ok: true,
    state: { ...state, board, turn: winLine ? null : nextTurn, winLine },
  }
}

export function findWinLine(board, { x, y }, ruleset = DEFAULT_RULESET) {
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
        blockedEnd(board, x, y, -dx, -dy, before.length + 1, opponent) &&
        blockedEnd(board, x, y, dx, dy, after.length + 1, opponent)) continue
    return [...before.reverse(), { x, y }, ...after]
  }

  return null
}

function blockedEnd(board, x, y, dx, dy, distance, opponent) {
  const endX = x + dx * distance
  const endY = y + dy * distance
  return Math.abs(endX) <= BOARD_LIMIT && Math.abs(endY) <= BOARD_LIMIT &&
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

export function bounds(board) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  if (board.size === 0) {
    minX = maxX = minY = maxY = 0
  }

  for (const key of board.keys()) {
    const [x, y] = key.split(',').map(Number)
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }

  return {
    minX: Math.max(-BOARD_LIMIT, minX - VIEW_PADDING),
    maxX: Math.min(BOARD_LIMIT, maxX + VIEW_PADDING),
    minY: Math.max(-BOARD_LIMIT, minY - VIEW_PADDING),
    maxY: Math.min(BOARD_LIMIT, maxY + VIEW_PADDING),
  }
}

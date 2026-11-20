import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyMove, bounds, findWinLine } from '../plugins/clarcade/games/gomoku/rules.js'

const directions = [
  ['horizontal', 1, 0],
  ['vertical', 0, 1],
  ['descending diagonal', 1, 1],
  ['ascending diagonal', 1, -1],
]

for (const [name, dx, dy] of directions) {
  test(`finds five in a row along the ${name} after filling the middle`, () => {
    const line = [-2, -1, 0, 1, 2].map(offset => ({ x: offset * dx || 0, y: offset * dy || 0 }))
    const board = new Map(line.map(({ x, y }) => [`${x},${y}`, 'O']))

    assert.deepEqual(findWinLine(board, { x: 0, y: 0 }, 'freestyle'), line)
  })
}

for (const length of [5, 6]) {
  test(`${length} in a row wins even when both ends are blocked`, () => {
    const line = Array.from({ length }, (_, x) => ({ x, y: 0 }))
    const board = new Map(line.map(({ x, y }) => [`${x},${y}`, 'X']))
    board.set('-1,0', 'O')
    board.set(`${length},0`, 'O')

    assert.deepEqual(findWinLine(board, { x: 2, y: 0 }), line)
  })
}

test('four contiguous marks do not win across a gap or an opponent mark', () => {
  const board = new Map([
    ['-2,0', 'X'], ['-1,0', 'X'], ['0,0', 'X'], ['1,0', 'X'], ['3,0', 'X'],
  ])

  assert.equal(findWinLine(board, { x: 0, y: 0 }), null)
  board.set('2,0', 'O')
  assert.equal(findWinLine(board, { x: 0, y: 0 }), null)
})

test('only checks lines that pass through the last move', () => {
  const board = new Map([
    ['0,0', 'X'], ['1,0', 'X'], ['2,0', 'X'], ['3,0', 'X'], ['4,0', 'X'], ['1,1', 'O'],
  ])

  assert.equal(findWinLine(board, { x: 1, y: 1 }), null)
  assert.equal(findWinLine(board, { x: 5, y: 0 }), null)
})

test('rejects an unsupported ruleset instead of scoring it as freestyle', () => {
  assert.throws(() => findWinLine(new Map(), { x: 0, y: 0 }, 'renju'), RangeError)
})

test('accepts X at the origin and alternates turns without mutating the previous board', () => {
  const initial = { board: new Map(), turn: 'X', winLine: null }
  const first = applyMove(initial, { x: 0, y: 0, mark: 'X' })
  assert.deepEqual(first, {
    ok: true, state: { board: new Map([['0,0', 'X']]), turn: 'O', winLine: null },
  })
  const second = applyMove(first.state, { x: -2, y: 1, mark: 'O' })
  assert.deepEqual(second, {
    ok: true,
    state: { board: new Map([['0,0', 'X'], ['-2,1', 'O']]), turn: 'X', winLine: null },
  })
  assert.equal(initial.board.size, 0)
  assert.equal(first.state.board.size, 1)
})

test('requires the first move at the origin', () => {
  const state = { board: new Map(), turn: 'X', winLine: null }

  assert.deepEqual(applyMove(state, { x: 1, y: 0, mark: 'X' }), {
    ok: false, reason: 'first-move-origin',
  })
  assert.equal(state.board.size, 0)
})

test('rejects the wrong mark and an occupied cell', () => {
  const state = { board: new Map([['0,0', 'X']]), turn: 'O', winLine: null }

  assert.deepEqual(applyMove(state, { x: -1, y: 0, mark: 'X' }), {
    ok: false, reason: 'wrong-turn',
  })
  assert.deepEqual(applyMove(state, { x: 0, y: 0, mark: 'O' }), {
    ok: false, reason: 'occupied',
  })
  assert.deepEqual(state.board, new Map([['0,0', 'X']]))
})

test('accepts both boundaries and rejects invalid coordinates on either axis', () => {
  const state = { board: new Map([['0,0', 'X']]), turn: 'O', winLine: null }

  assert.equal(applyMove(state, { x: -100, y: 100, mark: 'O' }).ok, true)
  assert.equal(applyMove(state, { x: 100, y: -100, mark: 'O' }).ok, true)
  for (const [x, y] of [[-101, 0], [101, 0], [0, -101], [0, 101], [0.5, 0], [0, NaN], ['1', 0]]) {
    assert.deepEqual(applyMove(state, { x, y, mark: 'O' }), {
      ok: false, reason: 'invalid-coordinates',
    })
  }
})

test('the winning move records the line at the board edge and ends the game', () => {
  const initial = { board: new Map(), turn: 'X', winLine: null, ruleset: 'freestyle' }
  const moves = [
    [0, 0], [1, 0], [96, 100], [2, 0], [97, 100],
    [3, 0], [98, 100], [4, 0], [99, 100], [6, 0], [100, 100],
  ]
  const finished = moves.reduce((state, [x, y]) => {
    const result = applyMove(state, { x, y, mark: state.turn })
    assert.equal(result.ok, true)
    return result.state
  }, initial)

  assert.equal(finished.turn, null)
  assert.equal(finished.ruleset, 'freestyle')
  assert.deepEqual(finished.winLine, [96, 97, 98, 99, 100].map(x => ({ x, y: 100 })))
  assert.deepEqual(applyMove(finished, { x: 5, y: 0, mark: 'O' }), {
    ok: false, reason: 'finished',
  })
})

test('starts with a seven-by-seven board centered on the origin', () => {
  assert.deepEqual(bounds(new Map()), { minX: -3, maxX: 3, minY: -3, maxY: 3 })
})

for (const [x, y, key, expected] of [
  [3, 0, 'maxX', 6], [-3, 0, 'minX', -6], [0, 3, 'maxY', 6], [0, -3, 'minY', -6],
]) {
  test(`extends the board three cells past (${x}, ${y})`, () => {
    assert.equal(bounds(new Map([['0,0', 'X'], [`${x},${y}`, 'O']]))[key], expected)
  })
}

test('clips padding against both board limits', () => {
  assert.deepEqual(bounds(new Map([['-98,98', 'X'], ['99,-99', 'O']])),
    { minX: -100, maxX: 100, minY: -100, maxY: 100 })
})

for (const [length, left, right, wins] of [
  [5, false, false, true], [5, true, false, true], [5, true, true, false],
  [6, true, false, true], [6, true, true, false],
]) {
  test(`Caro evaluates the full ${length}-stone run with blocked ends ${left}/${right}`, () => {
    const line = Array.from({ length }, (_, x) => ({ x, y: 0 }))
    const board = new Map(line.map(({ x, y }) => [`${x},${y}`, 'X']))
    if (left) board.set('-1,0', 'O')
    if (right) board.set(`${length},0`, 'O')
    assert.deepEqual(findWinLine(board, { x: 2, y: 0 }, 'vn'), wins ? line : null)
  })
}

test('Caro counts the edge as open and checks the other directions after a blocked run', () => {
  const line = Array.from({ length: 5 }, (_, i) => ({ x: 0, y: 96 + i }))
  const board = new Map(line.map(({ x, y }) => [`${x},${y}`, 'X']))
  board.set('0,95', 'O')
  for (const x of [-2, -1, 1, 2]) board.set(`${x},100`, 'X')
  board.set('-3,100', 'O')
  board.set('3,100', 'O')
  assert.deepEqual(findWinLine(board, { x: 0, y: 100 }, 'vn'), line)
})

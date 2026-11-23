import assert from 'node:assert/strict'
import test from 'node:test'
import { boardLayout, boardProps, DESKTOP_GRID, pointerCell } from '../plugins/clarcade/games/gomoku/board-view.js'

const room = { moves: [], boardVersion: 0, gameId: 'game' }
const grid = { board: 'grid', pieces: 'xo' }

test('the grid accepts clicks on outer edges, dividers and intersections', () => {
  const layout = {
    grid: true, width: 3, height: 2, cellWidth: 3, cellHeight: 2,
    offset: 4, ruler: 4, view: { left: -1, top: 0 },
  }
  const click = (x, y) => pointerCell(layout, true, { x, y })
  // Subtract each origin offset, then use the right or lower cell at a shared edge.
  assert.deepEqual(click(8, 1), { x: -1, y: 0 })
  assert.deepEqual(click(11, 2), { x: 0, y: 0 })
  assert.deepEqual(click(9, 3), { x: -1, y: 1 })
  assert.deepEqual(click(11, 3), { x: 0, y: 1 })
  assert.deepEqual(click(17, 5), { x: 1, y: 1 })
  assert.equal(click(7, 2), null)
  assert.equal(click(8, 0), null)
  assert.equal(click(18, 5), null)
  assert.equal(click(17, 6), null)
})

test('compacts the grid and reports when the viewport hides cells', () => {
  const wide = boardProps(room, null, true, 80, 32, grid)
  const narrow = boardProps({ ...room, moves: [{ x: 0, y: 0, mark: 'X' }, { x: 5, y: 0, mark: 'O' }] }, null, true, 24, 30, grid)
  assert.equal(boardLayout(wide).drawnWidth, 50)
  assert.equal(boardLayout(wide).height, 15)
  assert.equal(wide.cropped, false)
  assert.equal(narrow.cropped, true)
})

test('scrolls to a new move just outside the current viewport', () => {
  const saved = { x: 0, y: 0, left: -4, top: -2, boardVersion: 1, moveEpoch: 0 }
  const props = boardProps({ ...room, boardVersion: 2, moves: [{ x: 0, y: 0, mark: 'X' }, { x: 5, y: 0, mark: 'O' }] },
    saved, true, 24, 19, grid)
  const layout = boardLayout(props, saved)
  assert.equal(layout.view.x, 5)
  assert(layout.view.left + layout.width > 5)
})

test('Desktop grid uses one native row per cell and shares the pointer origin', () => {
  const wide = boardProps(room, null, true, 80, 18, grid, true)
  const layout = boardLayout(wide)
  assert.equal(wide.cropped, false)
  assert.equal(layout.cellHeight, 1)
  assert.equal(layout.cellWidth * 8.8, layout.cellHeight * 20)
  assert.deepEqual(pointerCell(layout, wide.rulers, { x: 41, y: 8 }), { x: 0, y: 0 })
  assert.deepEqual(pointerCell(layout, wide.rulers, { x: 57, y: 15 }), { x: 7, y: 7 })
  assert.equal(pointerCell(layout, wide.rulers, { x: 57, y: 16 }), null)
  assert.equal(pointerCell(layout, wide.rulers, { x: 59, y: 15 }), null)

  const narrow = boardProps({ ...room, moves: [{ x: 0, y: 0, mark: 'X' }, { x: 5, y: 0, mark: 'O' }] }, null, true, 24, 18, grid, true)
  assert.equal(narrow.cropped, true)
  assert.equal(boardLayout(narrow).width, 10)
})

test('Desktop uses square 16px tiles with even 4px gaps and rejects ambiguous coarse clicks', () => {
  const props = boardProps(room, null, true, 80, 18, grid, true)
  const layout = boardLayout(props)
  const gapX = (layout.cellWidth - DESKTOP_GRID.tileWidth) * 8.8
  const gapY = (layout.cellHeight - DESKTOP_GRID.tileHeight) * 20
  assert.equal(Math.round(gapX), 4)
  assert.equal(Math.round(gapY), 4)
  const origin = layout.offset + layout.ruler
  for (let column = 0; column < layout.width; column++) {
    const left = origin + column * layout.cellWidth + (layout.cellWidth - DESKTOP_GRID.tileWidth) / 2
    for (const y of [1, 15]) {
      const expected = { x: column - 7, y: y - 8 }
      for (let px = 0; px < 16; px++) {
        const fineX = left + (px + 0.5) / 8.8
        const coarseX = Math.floor(fineX)
        const overlaps = Array.from({ length: layout.width }, (_, index) =>
          origin + index * layout.cellWidth + gapX / 2 / 8.8)
          .filter(start => start < coarseX + 1 && start + DESKTOP_GRID.tileWidth > coarseX)
        assert.deepEqual(pointerCell(layout, true, { x: coarseX, y }), overlaps.length === 1 ? expected : null)
        assert.deepEqual(pointerCell(layout, true, { x: Math.floor(fineX), y,
          fine: { x: fineX, y: y + 0.75 } }), expected)
      }
    }
  }
})

test('Desktop keeps the same fifteen-by-fifteen grid through edge moves', () => {
  const moves = Array.from({ length: 8 }, (_, x) => ({ x, y: 0, mark: x % 2 ? 'O' : 'X' }))
  for (let count = 0; count <= moves.length; count++) {
    const props = boardProps({ ...room, moves: moves.slice(0, count) }, null, true, 80, 18, grid, true)
    const layout = boardLayout(props)
    assert.deepEqual([props.minX, props.maxX, props.minY, props.maxY, layout.width, layout.height], [-7, 7, -7, 7, 15, 15])
    assert.equal(props.cells.length, 225)
    assert.equal(DESKTOP_GRID.tileWidth * 8.8, DESKTOP_GRID.tileHeight * 20)
  }
})

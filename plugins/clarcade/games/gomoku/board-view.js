import { bounds } from './rules.js'

const GRID_CELL_WIDTH = 3
const DESKTOP_COLUMN_PX = 8.8
const DESKTOP_ROW_PX = 20

// Desktop converts native Box dimensions to CSS pixels. Fractional pixel advances
// or an oversized stroke let the renderer snap some grid lines wider than others.
export const DESKTOP_GRID = {
  cellWidth: DESKTOP_ROW_PX / DESKTOP_COLUMN_PX,
  verticalStroke: 1 / DESKTOP_COLUMN_PX,
  horizontalStroke: 1 / DESKTOP_ROW_PX,
}

const GLYPHS = {
  xo: { X: 'X', O: 'O' },
  oo: { X: '●', O: '○' },
  pixel: { X: '■', O: '□' },
}

const DESKTOP_XO = { X: '✕', O: '○' }

export function pieceGlyphs(style, desktop) {
  return desktop && style === 'xo' ? DESKTOP_XO : GLYPHS[style] ?? GLYPHS.xo
}

export function boardProps(room, view, enabled, columns, lines, { board: style, pieces }, desktop = false) {
  const area = bounds(room.boardSize)
  const width = area.maxX - area.minX + 1
  const cells = Array(width * (area.maxY - area.minY + 1)).fill('.')
  for (const { x, y, mark } of room.moves) cells[(y - area.minY) * width + x - area.minX] = mark
  const pending = room.pendingMove
  const last = room.moves.at(-1)
  const rulers = columns >= 48
  const boardHeight = area.maxY - area.minY + 1
  const grid = style === 'grid'
  const cellWidth = grid ? (desktop ? DESKTOP_GRID.cellWidth : GRID_CELL_WIDTH) : 2
  const cellHeight = grid && !desktop ? 2 : 1
  const fullHeight = boardHeight * cellHeight + Number(grid) + Number(rulers)
  const cropped = fullHeight > lines || width * cellWidth + (rulers ? 4 : 0) + Number(grid) > columns
  return {
    ...area, width, cells: cells.join(''), pending: pending ? { x: pending.x, y: pending.y, mark: room.mark } : null,
    last: last ?? null, win: room.winLine ?? [], gameId: room.gameId,
    view, enabled, columns, lines: Math.min(lines, fullHeight), rulers, cropped,
    style, pieces, desktop, cellWidth, cellHeight, first: room.moves.length === 0, boardVersion: room.boardVersion, moveEpoch: room.moveEpoch ?? 0,
  }
}

export function boardLayout(props, saved) {
  const grid = props.style === 'grid'
  const ruler = props.rulers ? 4 : 0
  const { cellWidth, cellHeight, desktop } = props
  const width = clamp(Math.floor((props.columns - ruler - Number(grid)) / cellWidth), 1, props.width)
  const height = clamp(Math.floor((props.lines - Number(props.rulers) - Number(grid)) / cellHeight),
    1, props.maxY - props.minY + 1)
  const drawnWidth = width * cellWidth + Number(grid) + ruler
  const offset = Math.max(0, Math.floor((props.columns - drawnWidth) / 2))
  const center = props.last ?? { x: 0, y: 0 }

  function fit({ x, y }, left, top) {
    x = clamp(x, props.minX, props.maxX)
    y = clamp(y, props.minY, props.maxY)
    return {
      x, y,
      left: clamp(clamp(left, x - width + 1, x), props.minX, props.maxX - width + 1),
      top: clamp(clamp(top, y - height + 1, y), props.minY, props.maxY - height + 1),
    }
  }

  let view = saved ? fit(saved, saved.left, saved.top)
    : fit(center, center.x - Math.floor(width / 2), center.y - Math.floor(height / 2))
  if (saved && (saved.boardVersion !== props.boardVersion || saved.moveEpoch !== props.moveEpoch) &&
      !contains(view, center, width, height)) view = fit(center, view.left, view.top)

  return { grid, desktop, ruler, width, height, drawnWidth, offset, view, fit, cellWidth, cellHeight }
}

export function pointerCell(layout, rulers, { x, y, fine }) {
  const column = (fine?.x ?? Math.floor(x)) - layout.offset - layout.ruler
  const row = Math.floor(y) - Number(rulers)
  const border = Number(layout.grid)
  if (column < 0 || row < 0 || column >= layout.width * layout.cellWidth + border ||
      row >= layout.height * layout.cellHeight + border ||
      (layout.desktop && column > Math.floor(layout.width * layout.cellWidth))) return null
  // Desktop reports whole UI columns. Assign a column touched by a divider to the cell on its right.
  const cellX = layout.desktop && layout.grid && !fine
    ? Math.ceil((column + 1) / layout.cellWidth) - 1
    : Math.floor(column / layout.cellWidth)
  return {
    x: layout.view.left + Math.min(layout.width - 1, cellX),
    y: layout.view.top + Math.min(layout.height - 1, Math.floor(row / layout.cellHeight)),
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function contains(view, cell, width, height) {
  return cell.x >= view.left && cell.x < view.left + width &&
    cell.y >= view.top && cell.y < view.top + height
}

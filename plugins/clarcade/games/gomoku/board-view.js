import { bounds } from './rules.js'

const GRID_CELL_WIDTH = 3
const DESKTOP_COLUMN_PX = 8.8
const DESKTOP_ROW_PX = 20
const DESKTOP_TILE_PX = 16
// A dense viewport must stay below the Client's 100,000-character tree limit.
const DESKTOP_VIEW_COLUMNS = 20
const DESKTOP_VIEW_CELLS = 240

// Use the same pixel step and tile size in both directions.
export const DESKTOP_GRID = {
  cellWidth: DESKTOP_ROW_PX / DESKTOP_COLUMN_PX,
  tileWidth: DESKTOP_TILE_PX / DESKTOP_COLUMN_PX,
  tileHeight: DESKTOP_TILE_PX / DESKTOP_ROW_PX,
  verticalStroke: 1 / DESKTOP_COLUMN_PX,
  horizontalStroke: 1 / DESKTOP_ROW_PX,
}

// Desktop centres a piece's text line in its 16 px tile, but each glyph sits at
// its own height in that line. Lifts measured on Claude Desktop screenshots
// (2026-11-23): letters are already centred, the solid disc sits 1 px low and
// the outlined disc, drawn from a fallback font, lower still. Pixel pieces are
// drawn with Boxes instead (see board.client.tsx).
export const DESKTOP_GLYPH_LIFT_PX = { X: 0, O: 0, '●': 1, '◉': 1.5 }

const GLYPHS = {
  xo: { X: 'X', O: 'O' },
  oo: { X: '●', O: '○' },
  pixel: { X: '■', O: '□' },
}
const DESKTOP_OUTLINED_GLYPH = { oo: '◉', pixel: '▣' }

export function pieceGlyphs(style, desktop) {
  const glyphs = GLYPHS[style] ?? GLYPHS.xo
  const outlined = desktop && DESKTOP_OUTLINED_GLYPH[style]
  return outlined ? { ...glyphs, O: outlined } : glyphs
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
  const cellWidth = desktop ? DESKTOP_GRID.cellWidth : grid ? GRID_CELL_WIDTH : 2
  const cellHeight = grid && !desktop ? 2 : 1
  const geometry = { ...area, width, desktop, style, cellWidth, cellHeight, rulers, columns, lines }
  const visible = viewportSize(geometry)
  return {
    ...geometry, cells: cells.join(''), pending: pending ? { x: pending.x, y: pending.y, mark: room.mark } : null,
    last: last ?? null, win: room.winLine ?? [], gameId: room.gameId,
    view, enabled, lines: visible.height * cellHeight + Number(grid) + Number(rulers),
    cropped: visible.width < width || visible.height < boardHeight,
    pieces, boardVersion: room.boardVersion, moveEpoch: room.moveEpoch ?? 0,
  }
}

function viewportSize(props) {
  const grid = props.style === 'grid'
  const ruler = props.rulers ? 4 : 0
  const { cellWidth, cellHeight, desktop } = props
  const maxWidth = desktop ? Math.min(props.width, DESKTOP_VIEW_COLUMNS) : props.width
  const width = clamp(Math.floor((props.columns - ruler - Number(grid)) / cellWidth), 1, maxWidth)
  const boardHeight = props.maxY - props.minY + 1
  const maxHeight = desktop ? Math.min(boardHeight, Math.floor(DESKTOP_VIEW_CELLS / width)) : boardHeight
  const height = clamp(Math.floor((props.lines - Number(props.rulers) - Number(grid)) / cellHeight),
    1, maxHeight)
  return { grid, ruler, width, height }
}

export function boardLayout(props, saved) {
  const { grid, ruler, width, height } = viewportSize(props)
  const { cellWidth, cellHeight, desktop } = props
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

export function pointerCell(layout, rulers, { x, y, fine }, rejectAmbiguous = true) {
  const column = (fine?.x ?? Math.floor(x)) - layout.offset - layout.ruler
  const row = (fine?.y ?? Math.floor(y)) - Number(rulers)
  const border = Number(layout.grid && !layout.desktop)
  if (column < 0 || row < 0 || column >= layout.width * layout.cellWidth + border ||
      row >= layout.height * layout.cellHeight + border) return null
  let cellX = Math.floor(column / layout.cellWidth)
  if (layout.desktop && fine?.x == null) {
    // A whole-column event can overlap the painted edges of two tiles. Ignore
    // that input so releasing close to a shared edge cannot place the wrong piece.
    const inset = (layout.cellWidth - DESKTOP_GRID.tileWidth) / 2
    const first = Math.max(0, Math.floor((column + inset) / layout.cellWidth))
    const last = Math.min(layout.width - 1, Math.ceil((column + 1 - inset) / layout.cellWidth) - 1)
    if (first === last) cellX = first
    else if (rejectAmbiguous) return null
    else cellX = Math.floor((column + 0.5) / layout.cellWidth)
  }
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

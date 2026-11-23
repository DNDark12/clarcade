import { boardLayout, DESKTOP_GLYPH_LIFT_PX, DESKTOP_GRID, pieceGlyphs, pointerCell } from './board-view.js'
import { desktopDotColor, desktopTileColor, grid as gridLine, muted, piecePalette, winFill } from '../../hooks/ui/tokens.ts'

const ARROWS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
const matches = (a, b) => a?.x === b.x && a?.y === b.y
// Pixel pieces on Desktop are drawn with Boxes in whole pixels, so they sit
// exactly in the tile's centre whatever the font does with ■ and ▣. Played
// pieces are solid 12 px squares in the player's color; on the latest tile,
// which is already filled with that color, the piece is a 10 px inverse mark
// (solid for X, a frame for O).
const PIXEL_PIECE_PX = 12
const PIXEL_LATEST_PX = 10
const PIXEL_STROKE_PX = 2

export default function Board(props, surface) {
  const { Box, Text } = surface.elements
  const palette = piecePalette(Boolean(props.desktop))
  const tone = mark => palette[mark] ?? muted.color
  const saved = surface.state?.gameId === props.gameId ? surface.state : null
  const layout = boardLayout(props, saved ?? props.view)
  let dragging = Boolean(props.enabled && saved?.dragging &&
    saved.boardVersion === props.boardVersion && saved.moveEpoch === props.moveEpoch)
  if (saved?.dragging && !dragging) surface.setState({ ...saved, dragging: false })
  const { grid, ruler, width, height, drawnWidth, offset, fit, cellWidth } = layout
  const glyphs = pieceGlyphs(props.pieces, props.desktop)
  const pieceSize = props.pieces === 'oo' || props.pieces === 'pixel' ? 'title' : 'heading'
  const markAt = ({ x, y }) => props.cells[(y - props.minY) * props.width + x - props.minX]

  function go(cell, action = 'view') {
    const { left, top } = layout.view
    const view = fit(cell, left, top)
    layout.view = view
    const state = { ...view, gameId: props.gameId, boardVersion: props.boardVersion, moveEpoch: props.moveEpoch }
    surface.setState({ ...state, dragging })
    if (!action) return
    const legal = props.enabled && markAt(view) === '.'
    surface.post({ ...state, kind: action === 'move' && legal ? 'move' : 'view' })
  }

  surface.onKey(({ key, shift }) => {
    if (dragging) return
    const { x, y } = layout.view
    if (Object.hasOwn(ARROWS, key)) {
      const [dx, dy] = ARROWS[key]
      const step = shift ? 5 : 1
      go({ x: x + dx * step, y: y + dy * step })
    } else if (key.toLowerCase() === 'c' && props.last) go(props.last)
    else if (key.toLowerCase() === 'h') go({ x: 0, y: 0 })
    else if (key === 'return' || key === ' ') go(layout.view, 'move')
  })

  surface.onPointer(event => {
    if (event.button && event.button !== 'left') return
    const point = pointerCell(layout, props.rulers, event, event.type !== 'move' || dragging)
    if (event.type === 'move' && props.enabled && point && !matches(layout.view, point)) {
      go(point, null)
    } else if (event.type === 'down' && event.button === 'left') {
      if (props.enabled && (point || pointerCell(layout, props.rulers, event, false))) {
        dragging = true
        go(point ?? layout.view, null)
      } else if (point) {
        go(point, 'view')
      }
    } else if (dragging && event.type === 'up' && event.button === 'left') {
      dragging = false
      go(point ?? layout.view, point ? 'move' : 'view')
    }
  })

  const line = spans => Text({
    mono: true, wrap: 'truncate-end',
    children: spans.map(([text, style]) => style ? Text({ ...style, children: text }) : text),
  })
  const boardLine = spans => line([[' '.repeat(offset)], ...spans])
  const tick = value => value !== null && value % 5 === 0 ? String(value) : ''
  const label = y => ruler ? [[`${tick(y).padStart(ruler - 1)} `, muted]] : []
  const border = (left, middle, right) => boardLine([
    ...label(null), [left + Array(width).fill('─'.repeat(cellWidth - 1)).join(middle) + right, gridLine],
  ])
  const lines = []
  const view = layout.view

  // Desktop's monospace text and pointer cells have different widths.
  // Match the pointer by building its rows with the native Box dimensions.
  const { verticalStroke, horizontalStroke, tileWidth, tileHeight } = DESKTOP_GRID
  const spacer = Box({ width: cellWidth, flexShrink: 0 })
  const centered = { alignItems: 'center', justifyContent: 'center' }
  function desktopOverlay(key, point, child, alignItems = 'center') {
    return Box({
      key, position: 'absolute', top: Number(props.rulers) + point.y - view.top, left: offset + ruler,
      width: (point.x - view.left + 1) * cellWidth, height: 1, flexDirection: 'row', justifyContent: 'flex-end',
      children: [Box({ alignItems, justifyContent: 'center', width: cellWidth, height: 1, flexShrink: 0, children: [child] })],
    })
  }
  function desktopCursor() {
    const bar = (width, height, key = undefined) => Box({ key, width, height, backgroundColor: 'text', flexShrink: 0 })
    const ends = (width, height, key = undefined) => Box({
      flexDirection: 'row', justifyContent: 'space-between', height, flexShrink: 0,
      children: [bar(width, height, key), bar(width, height)],
    })
    const tips = ends(3 * verticalStroke, horizontalStroke, 'board-cursor-top-left')
    const legs = ends(verticalStroke, 2 * horizontalStroke)
    return desktopOverlay('board-cursor', view, Box({
      key: 'board-cursor-corners', flexDirection: 'column', justifyContent: 'space-between',
      width: tileWidth - 2 * verticalStroke, height: tileHeight - 2 * horizontalStroke,
      children: [
        Box({ flexDirection: 'column', children: [tips, legs] }),
        Box({ flexDirection: 'column', children: [legs, ends(3 * verticalStroke, horizontalStroke)] }),
      ],
    }))
  }
  const desktopCell = child => Box({
    ...centered, width: cellWidth, height: 1, flexShrink: 0, children: [child],
  })
  // Positions take whole cells only, so a glyph's lift is padding: the tile
  // centres the wrapper, and twice the lift below the glyph raises it by the lift.
  const centeredGlyph = (text, glyph) => {
    const lift = (DESKTOP_GLYPH_LIFT_PX[glyph] ?? 0) * horizontalStroke
    return lift
      ? Box({ key: 'board-piece', flexDirection: 'column', paddingBottom: 2 * lift, flexShrink: 0, children: [text] })
      : text
  }
  // A solid square, or on the latest tile an O frame: six Boxes at most per piece.
  const pixelPiece = (mark, color, latest) => {
    const px = n => n * verticalStroke
    const py = n => n * horizontalStroke
    const bar = (w, h) => Box({ width: px(w), height: py(h), backgroundColor: color, flexShrink: 0 })
    const size = latest ? PIXEL_LATEST_PX : PIXEL_PIECE_PX
    const stroke = PIXEL_STROKE_PX
    if (mark === 'X' || !latest) {
      return Box({ key: 'board-piece', width: px(size), height: py(size), backgroundColor: color, flexShrink: 0 })
    }
    return Box({
      key: 'board-piece', flexDirection: 'column', width: px(size), height: py(size), flexShrink: 0,
      children: [
        bar(size, stroke),
        Box({
          flexDirection: 'row', justifyContent: 'space-between', width: px(size), height: py(size - 2 * stroke),
          flexShrink: 0, children: [bar(stroke, size - 2 * stroke), bar(stroke, size - 2 * stroke)],
        }),
        bar(size, stroke),
      ],
    })
  }
  const tile = (child, fill = null, latest = false) => Box({
    ...centered, flexDirection: 'column', key: latest ? 'board-last-move' : grid ? 'grid-tile' : undefined,
    width: tileWidth, height: tileHeight,
    marginX: (cellWidth - tileWidth) / 2, flexShrink: 0,
    ...(fill || grid ? { backgroundColor: fill ?? desktopTileColor } : {}),
    children: child ? [child] : [],
  })
  const emptyCell = props.desktop && (grid ? tile(null) : desktopCell(Box({
    width: 2 * verticalStroke, height: 2 * horizontalStroke, backgroundColor: desktopDotColor,
  })))
  const desktopRow = (y, cells) => Box({
    flexDirection: 'row', alignItems: 'center', height: 1, children: [
      Box({ flexDirection: 'column', width: offset + ruler, flexShrink: 0, alignItems: 'flex-end',
        children: tick(y) && ruler ? [line([[`${tick(y)} `, muted]])] : [] }),
      ...cells,
    ],
  })

  if (ruler && props.desktop) {
    lines.push(desktopRow(null, Array.from({ length: width }, (_, i) => {
      const label = tick(view.left + i)
      return label ? desktopCell(line([[label, muted]])) : spacer
    })))
  } else if (ruler) {
    const scale = Array(drawnWidth).fill(' ')
    for (let i = 0; i < width; i++) {
      const x = view.left + i
      if (x % 5 !== 0) continue
      const label = String(x)
      const col = ruler + i * cellWidth + Number(grid)
      const start = Math.min(col, scale.length - label.length)
      for (let j = 0; j < label.length; j++) scale[start + j] = label[j]
    }
    lines.push(boardLine([[scale.join(''), muted]]))
  }

  if (grid && !props.desktop) lines.push(border('┌', '┬', '┐'))
  for (let y = view.top; y < view.top + height; y++) {
    const spans = label(y)
    const cells = []
    for (let x = view.left; x < view.left + width; x++) {
      const point = { x, y }
      const played = markAt(point)
      const pending = played === '.' && matches(props.pending, point)
      const mark = pending ? props.pending.mark : played
      const glyph = glyphs[mark]
      const fill = props.win.some(cell => matches(cell, point)) ? winFill
        : !props.desktop && matches(props.last, point) ? tone(mark) : null
      const cursor = props.enabled && matches(view, point)
      const ink = {
        color: fill ? 'inverseText' : tone(mark),
        weight: 'bold', ...(pending && { dimColor: true }),
      }
      if (props.desktop) {
        // The latest move is a solid tile in the mover's color with the piece
        // knocked out in inverse text, as on the terminal. The win line keeps its fill.
        const latest = !fill && matches(props.last, point)
        const color = fill || latest ? 'inverseText' : pending ? 'inactive' : tone(mark)
        const piece = !glyph ? null : props.pieces === 'pixel'
          ? pixelPiece(mark, color, latest)
          : centeredGlyph(Text({ mono: true, size: pieceSize, ...ink, color, children: glyph }), glyph)
        cells.push(piece ? tile(piece, latest ? tone(mark) : fill, latest) : emptyCell)
      } else {
        const style = {
          ...(glyph ? ink : gridLine), ...(fill && { backgroundColor: fill }),
          ...(cursor && { underline: true, ...(glyph ? {} : { color: 'text', dimColor: false }) }),
        }
        if (grid) spans.push(['│', gridLine], [`${glyph ?? ' '} `, style])
        else spans.push([glyph ?? '·', style], [' '])
      }
    }
    if (props.desktop) lines.push(desktopRow(y, cells))
    else {
      if (grid) spans.push(['│', gridLine])
      lines.push(boardLine(spans))
      if (grid) lines.push(y === view.top + height - 1 ? border('└', '┴', '┘') : border('├', '┼', '┤'))
    }
  }

  if (props.desktop && props.enabled) lines.push(desktopCursor())
  return Box({ key: props.desktop && grid ? 'board-grid' : undefined,
    flexDirection: 'column', width: '100%', children: lines })
}

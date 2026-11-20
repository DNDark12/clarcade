import { boardLayout, DESKTOP_GRID, pieceGlyphs, pointerCell } from './board-view.js'
import { muted, pieceColor } from '../../hooks/ui/tokens.ts'

const ARROWS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
const matches = (a, b) => a?.x === b.x && a?.y === b.y
const tone = mark => pieceColor[mark] ?? muted.color

export default function Board(props, surface) {
  const { Box, Text } = surface.elements
  const saved = surface.state?.gameId === props.gameId ? surface.state : props.view
  const layout = boardLayout(props, saved)
  const { grid, ruler, width, height, drawnWidth, offset, fit, cellWidth } = layout
  const glyphs = pieceGlyphs(props.pieces, props.desktop)
  const markAt = ({ x, y }) => props.cells[(y - props.minY) * props.width + x - props.minX]

  function go(cell, place = false) {
    const { left, top } = layout.view
    const view = fit(cell, left, top)
    layout.view = view
    const state = { ...view, gameId: props.gameId, boardVersion: props.boardVersion, moveEpoch: props.moveEpoch }
    surface.setState(state)
    const legal = props.enabled && markAt(view) === '.' && (!props.first || (view.x === 0 && view.y === 0))
    surface.post({ ...state, kind: place && legal ? 'move' : 'view' })
  }

  surface.onKey(({ key, shift }) => {
    const { x, y } = layout.view
    if (Object.hasOwn(ARROWS, key)) {
      const [dx, dy] = ARROWS[key]
      const step = shift ? 5 : 1
      go({ x: x + dx * step, y: y + dy * step })
    } else if (key.toLowerCase() === 'c' && props.last) go(props.last)
    else if (key.toLowerCase() === 'h') go({ x: 0, y: 0 })
    else if (key === 'return' || key === ' ') go(layout.view, true)
  })

  surface.onPointer(event => {
    if (event.type !== 'down' || event.button !== 'left') return
    const point = pointerCell(layout, props.rulers, event)
    if (point) go(point, true)
  })

  const line = spans => Text({
    mono: true, wrap: 'truncate-end',
    children: spans.map(([text, style]) => style ? Text({ ...style, children: text }) : text),
  })
  const boardLine = spans => line([[' '.repeat(offset)], ...spans])
  const tick = value => value !== null && value % 5 === 0 ? String(value) : ''
  const label = y => ruler ? [[`${tick(y).padStart(ruler - 1)} `, muted]] : []
  const border = (left, middle, right) => boardLine([
    ...label(null), [left + Array(width).fill('─'.repeat(cellWidth - 1)).join(middle) + right, muted],
  ])
  const lines = []
  const view = layout.view

  // Desktop's monospace text and pointer cells have different widths.
  // Match the pointer by building its rows with the native Box dimensions.
  const desktopCell = (children = [], fill) => Box({
    flexDirection: 'column', width: cellWidth, height: 1, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center', children, ...(fill && { backgroundColor: fill }),
  })
  const desktopRow = (y, cells) => Box({
    flexDirection: 'row', height: 1, children: [
      Box({ flexDirection: 'column', width: offset + ruler, flexShrink: 0, alignItems: 'flex-end',
        children: tick(y) && ruler ? [line([[`${tick(y)} `, muted]])] : [] }),
      ...cells,
    ],
  })

  if (ruler && props.desktop) {
    lines.push(desktopRow(null, Array.from({ length: width }, (_, i) => {
      const label = tick(view.left + i)
      return desktopCell(label ? [line([[label, muted]])] : [])
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
      const glyph = glyphs[mark] ?? (grid ? ' ' : '·')
      const isLast = matches(props.last, point)
      const won = props.win.some(cell => matches(cell, point))
      const selected = matches(view, point)
      const highlight = won ? 'success' : isLast ? 'warning' : null
      const style = {
        color: highlight ? 'inverseText' : tone(mark),
        bold: mark !== '.',
        ...(highlight && { backgroundColor: highlight }),
        ...(selected && !highlight && { inverse: true }),
        ...((pending || (selected && !props.enabled && !highlight)) && { dimColor: true }),
        ...((pending || (selected && highlight)) && { underline: true }),
      }
      if (props.desktop) {
        const fill = highlight || (selected ? props.enabled ? 'text' : 'subtle' : null)
        cells.push(desktopCell([Text({
          mono: true, color: fill ? 'inverseText' : tone(mark), bold: mark !== '.',
          ...(pending && { dimColor: true, underline: true }), children: glyph,
        })], fill))
      }
      else if (grid && isLast) spans.push([`[${glyph}]`, style])
      else if (grid) spans.push(['│', muted], [`${glyph} `, style])
      else spans.push([glyph, style], [' '])
    }
    if (props.desktop) lines.push(desktopRow(y, cells))
    else {
      if (grid) spans.push(['│', muted])
      lines.push(boardLine(spans))
      if (grid) lines.push(y === view.top + height - 1 ? border('└', '┴', '┘') : border('├', '┼', '┤'))
    }
  }

  if (props.desktop && grid) {
    const left = offset + ruler
    const top = Number(props.rulers)
    const stroke = DESKTOP_GRID.verticalStroke
    const vertical = Box({ width: stroke, height, flexShrink: 0, backgroundColor: muted.color })
    lines.push(Box({
      key: 'grid-columns', position: 'absolute', top, left, flexDirection: 'row',
      children: [
        ...Array.from({ length: width }, () => Box({ width: cellWidth, flexShrink: 0, children: [vertical] })),
        vertical,
      ],
    }))
    for (let i = 0; i <= height; i++) lines.push(Box({
      key: `grid-row-${i}`, position: 'absolute', left, top: top + i,
      width: width * cellWidth + stroke, height: DESKTOP_GRID.horizontalStroke, backgroundColor: muted.color,
    }))
    lines.push(Box({ height: 1 }))
  }
  return Box({ flexDirection: 'column', width: '100%', children: lines })
}

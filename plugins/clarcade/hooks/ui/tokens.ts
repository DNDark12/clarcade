export const pieceColor = { X: 'claude', O: 'suggestion' } as const
// `claude` is the same orange in both modes and falls under 3:1 on Desktop's
// light background. Desktop paints CSS, so X takes a darker orange in light mode
// and keeps the brand orange in dark mode. The terminal keeps the theme key.
export const desktopPieceColor = { X: 'light-dark(#a8481f, #d77757)', O: 'suggestion' } as const
export const piecePalette = (desktop: boolean) => desktop ? desktopPieceColor : pieceColor
export const muted = { color: 'inactive' } as const
export const grid = { color: 'subtle', dimColor: true } as const
// Mods cannot read whether Desktop is light or dark, so the neutrals are a
// translucent mid-gray that lands at the same low contrast on either background
// (about 1.15:1 on white and on Desktop's dark gray). 0.19 tiled the light
// theme with a glaring checkerboard of white gutters.
export const desktopTileColor = 'rgba(127, 127, 127, 0.12)'
export const desktopDotColor = 'rgba(127, 127, 127, 0.26)'
export const winFill = 'success'

export function statusColor(room) {
  if (room.connection === 'reconnecting' || room.connection === 'syncing' || room.pendingMove) return 'warning'
  if (room.status === 'playing') return room.turn === room.mark ? 'success' : 'subtle'
  return 'inactive'
}

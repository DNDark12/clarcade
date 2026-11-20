export const pieceColor = { X: 'claude', O: 'suggestion' } as const
export const muted = { color: 'inactive' } as const

export function statusColor(room) {
  if (room.connection === 'reconnecting' || room.connection === 'syncing' || room.pendingMove) return 'warning'
  if (room.status === 'playing') return room.turn === room.mark ? 'success' : 'subtle'
  return 'inactive'
}

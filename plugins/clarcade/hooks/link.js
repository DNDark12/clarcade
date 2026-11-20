const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export const ROOM_CODE = new RegExp(`^[${ALPHABET}]{6}$`)
const LINK = new RegExp(String.raw`^clarcade://j/([${ALPHABET}]{6})(?:@(\[[0-9a-f:]+\]|(?:[0-9]{1,3}\.){3}[0-9]{1,3}):([0-9]{1,5}))?$`, 'i')

export function parseLink(input) {
  if (typeof input !== 'string') return null
  const match = LINK.exec(input.trim())
  if (!match) return null
  const [, code, endpoint, rawPort] = match
  if (!endpoint) return { roomCode: code.toUpperCase() }
  const port = Number(rawPort)
  if (port < 1 || port > 65535) return null
  const ipv6 = endpoint.startsWith('[')
  const address = ipv6 ? endpoint.slice(1, -1).toLowerCase() : endpoint
  if (ipv6 ? !validIPv6(address) : address.split('.').some(part =>
    String(Number(part)) !== part || Number(part) > 255)) return null
  return { roomCode: code.toUpperCase(), address, port }
}

function validIPv6(address) {
  const halves = address.split('::')
  if (halves.length > 2) return false
  const groups = halves.flatMap(part => part ? part.split(':') : [])
  return groups.every(part => /^[0-9a-f]{1,4}$/.test(part)) &&
    (halves.length === 2 ? groups.length < 8 : groups.length === 8)
}

export function roomLinks(roomCode, address, port) {
  const link = `clarcade://j/${roomCode}`
  const host = address?.includes(':') ? `[${address}]` : address
  return { link, directLink: host ? `${link}@${host}:${port}` : null }
}

export function roomCodeFromBytes(bytes) {
  return Array.from(bytes, byte => ALPHABET[byte & 31]).join('')
}

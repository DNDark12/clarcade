import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { isIPv4, isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { ROOM_CODE } from '../hooks/link.js'
import { validRuleset } from '../games/gomoku/rules.js'
import { name, record, validPort, validToken } from './protocol.mjs'

const MAGIC = 'clarcade-lan'
const VERSION = 1
const GROUP = '239.255.67.75'
const BROADCAST = '255.255.255.255'
const BASE = ['magic', 'version', 'type', 'nonce']
const QUERY = [...BASE, 'roomCode']
const REPLY = [...QUERY, 'roomName', 'hostName', 'visibility', 'status', 'ruleset', 'port']
const STATUSES = ['waiting', 'playing', 'finished']

export function normalizeAddress(address) {
  const mapped = /^::ffff:(.+)$/i.exec(address ?? '')
  if (!mapped) return address?.toLowerCase()
  if (isIPv4(mapped[1])) return mapped[1]
  const hex = /^([a-f0-9]{1,4}):([a-f0-9]{1,4})$/i.exec(mapped[1])
  if (!hex) return address.toLowerCase()
  const high = parseInt(hex[1], 16)
  const low = parseInt(hex[2], 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

export function allowedAddress(address, { loopback = false, allowTailscale = false, allowIpv6Ula = false } = {}) {
  address = normalizeAddress(address)
  if (!address) return false
  if (loopback) return address === '127.0.0.1'
  if (isIPv6(address)) return allowIpv6Ula && /^fd[0-9a-f]{2}:/i.test(address)
  if (!isIPv4(address)) return false
  const [a, b] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254) ||
    (allowTailscale && a === 100 && b >= 64 && b <= 127)
}

export function lanAddresses(options) {
  if (options.loopback) return ['127.0.0.1']
  return [...new Set(Object.values(networkInterfaces()).flat()
    .filter(item => item && !item.internal && allowedAddress(item.address, options))
    .map(item => item.address))]
    .sort((a, b) => Number(!allowedAddress(a)) - Number(!allowedAddress(b)) ||
      Number(a.startsWith('169.254.')) - Number(b.startsWith('169.254.')))
}

function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function parseDiscovery(buffer) {
  if (!buffer.length || buffer.length > 1024) return null
  let message
  try { message = JSON.parse(buffer.toString('utf8')) } catch { return null }
  if (!record(message) || message.magic !== MAGIC || message.version !== VERSION || !validToken(message.nonce)) {
    return null
  }
  const validCode = typeof message.roomCode === 'string' && ROOM_CODE.test(message.roomCode)
  if (message.type === 'discover' && (exactKeys(message, BASE) ||
      (validCode && exactKeys(message, QUERY)) ||
      (name(message.roomName) && exactKeys(message, [...BASE, 'roomName'])))) return message
  if (message.type === 'here' && exactKeys(message, REPLY) && validCode &&
      name(message.roomName) && name(message.hostName) && ['public', 'private'].includes(message.visibility) &&
      STATUSES.includes(message.status) && validRuleset(message.ruleset) && validPort(message.port)) return message
  return null
}

const encode = message => Buffer.from(JSON.stringify({ magic: MAGIC, version: VERSION, ...message }))

function close(socket) {
  try { socket.close() } catch (error) {
    if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error
  }
}

export function advertise(options, roomInfo) {
  const sockets = []
  for (const family of options.allowIpv6Ula && !options.loopback ? ['udp4', 'udp6'] : ['udp4']) {
    const ipv6 = family === 'udp6'
    const socket = createSocket({ type: family, reuseAddr: !options.loopback, ipv6Only: ipv6 })
    sockets.push(socket)
    socket.on('error', error => console.error('[clarcade] discovery:', error.message))
    socket.on('message', (buffer, remote) => {
      if (!allowedAddress(remote.address, options)) return
      const query = parseDiscovery(buffer)
      const room = roomInfo()
      if (!room || query?.type !== 'discover') return
      if (query.roomCode && query.roomCode !== room.roomCode) return
      if (query.roomName && query.roomName.normalize('NFC') !== room.roomName.normalize('NFC')) return
      if (room.visibility === 'private' && !query.roomCode && !query.roomName) return
      socket.send(encode({ type: 'here', nonce: query.nonce, ...room }), remote.port, remote.address, () => {})
    })
    const address = ipv6 ? '::' : options.loopback ? '127.0.0.1' : '0.0.0.0'
    socket.bind(options.udpPort, address, () => {
      if (ipv6 || options.loopback) return
      const local = lanAddresses(options).filter(isIPv4)
      for (const ipv4 of local.length ? local : [undefined]) {
        try { socket.addMembership(GROUP, ipv4) } catch (error) {
          console.error('[clarcade] multicast:', error.message)
        }
      }
    })
  }
  return () => { for (const socket of sockets) close(socket) }
}

export function discover(options, selector = {}, knownAddress) {
  const { udpPort, loopback } = options
  return new Promise(resolve => {
    const ipv6 = isIPv6(knownAddress ?? '') && allowedAddress(knownAddress, options)
    const socket = createSocket(ipv6 ? 'udp6' : 'udp4')
    const nonce = randomBytes(16).toString('hex')
    const rooms = new Map()
    const start = Date.now()
    const timer = setTimeout(finish, 450)
    let finished = false
    function finish() {
      if (finished) return
      finished = true
      clearTimeout(timer)
      close(socket)
      resolve([...rooms.values()])
    }
    socket.once('error', finish)
    socket.on('message', (buffer, remote) => {
      if (!allowedAddress(remote.address, options) || remote.port !== udpPort) return
      const reply = parseDiscovery(buffer)
      if (reply?.type !== 'here' || reply.nonce !== nonce ||
          (selector.roomCode && reply.roomCode !== selector.roomCode) ||
          (selector.roomName && reply.roomName.normalize('NFC') !== selector.roomName.normalize('NFC')) ||
          (!selector.roomCode && !selector.roomName && reply.visibility !== 'public')) return
      const key = `${reply.roomCode}@${remote.address}:${reply.port}`
      if (rooms.has(key)) return
      rooms.set(key, {
        roomCode: reply.roomCode, roomName: reply.roomName, hostName: reply.hostName,
        visibility: reply.visibility, status: reply.status, ruleset: reply.ruleset,
        address: remote.address, port: reply.port, latencyMs: Date.now() - start,
      })
    })
    socket.bind(0, ipv6 ? '::' : loopback ? '127.0.0.1' : '0.0.0.0', () => {
      const query = encode({ type: 'discover', nonce, ...selector })
      if (loopback || ipv6) {
        socket.send(query, udpPort, loopback ? '127.0.0.1' : knownAddress, () => {})
        return
      }
      try {
        if (knownAddress && allowedAddress(knownAddress, options)) {
          socket.send(query, udpPort, knownAddress, () => {})
        }
        socket.setMulticastTTL(1)
        socket.send(query, udpPort, GROUP, () => {})
        socket.setBroadcast(true)
        socket.send(query, udpPort, BROADCAST, () => {})
      } catch (error) {
        console.error('[clarcade] discovery query:', error.message)
      }
    })
  })
}

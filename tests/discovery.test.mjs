import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import test from 'node:test'
import { DISCOVERY_SENDS_MS, DISCOVERY_WINDOW_MS, discover } from '../plugins/clarcade/helper/discovery.mjs'

// A stand-in host on loopback that answers a code query for one room, and
// can be told to ignore the first queries it gets, as a Wi-Fi link drops them.
async function fakeHost({ drop = 0 } = {}) {
  const socket = createSocket('udp4')
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
  let seen = 0
  socket.on('message', (buffer, remote) => {
    const query = JSON.parse(buffer.toString('utf8'))
    if (query.type !== 'discover' || ++seen <= drop) return
    const reply = {
      magic: 'clarcade-lan', version: 1, type: 'here', nonce: query.nonce, roomCode: 'H3B0RX',
      roomName: 'ok', hostName: 'Camhm', visibility: 'public', status: 'waiting', ruleset: 'freestyle', port: 58355,
    }
    socket.send(Buffer.from(JSON.stringify(reply)), remote.port, remote.address)
  })
  return { port: socket.address().port, queries: () => seen, close: () => socket.close() }
}

test('a short link still finds its room when the first queries are lost', async () => {
  const host = await fakeHost({ drop: DISCOVERY_SENDS_MS.length - 1 })
  try {
    const options = { udpPort: host.port, loopback: true }
    const rooms = await discover(options, { roomCode: 'H3B0RX' })
    assert.deepEqual(rooms.map(room => room.roomCode), ['H3B0RX'])
    assert.equal(host.queries(), DISCOVERY_SENDS_MS.length)
  } finally { host.close() }
})

test('repeated replies to the same query list the room once, and the search ends on time', async () => {
  const host = await fakeHost()
  try {
    const started = Date.now()
    const rooms = await discover({ udpPort: host.port, loopback: true }, { roomCode: 'H3B0RX' })
    assert.equal(rooms.length, 1)
    assert.ok(Date.now() - started < DISCOVERY_WINDOW_MS + 300)
  } finally { host.close() }
})

test('every send happens inside the search window', () => {
  assert.ok(DISCOVERY_SENDS_MS.every(at => at < DISCOVERY_WINDOW_MS - 300))
})

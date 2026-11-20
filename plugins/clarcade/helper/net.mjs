import { MAX_FRAME_BYTES, envelope } from './protocol.mjs'

const MAX_QUEUE = 1024
const INTERVAL_MS = 53
const MAX_RATE = 20
const BURST = 60
const KEEP_ALIVE_MS = 5000

// The same pacing applies to live moves and chunks, including reconnect bursts.
export function channel(socket, roomCode, onFrame, onClose) {
  let outgoing = 0
  let incoming = 0
  let pending = Buffer.alloc(0)
  let sent = 0
  let timer
  let closed = false
  const queue = []
  let tokens = BURST
  let refillAt = process.hrtime.bigint()

  socket.setNoDelay(true)
  socket.setTimeout(16000, () => socket.destroy())
  socket.on('error', () => socket.destroy())

  function flush() {
    timer = undefined
    if (closed || socket.destroyed || !queue.length) return
    const wait = INTERVAL_MS - (Date.now() - sent)
    if (wait > 0) {
      timer = setTimeout(flush, wait)
      return
    }
    sent = Date.now()
    if (!socket.write(queue.shift())) {
      socket.once('drain', flush)
      return
    }
    if (queue.length) timer = setTimeout(flush, INTERVAL_MS)
  }

  const peer = {
    send(frame) {
      if (closed || socket.destroyed) return
      const body = Buffer.from(JSON.stringify({ ...frame, roomCode, seq: ++outgoing }) + '\n')
      if (body.length > MAX_FRAME_BYTES + 1 || queue.length >= MAX_QUEUE) {
        socket.destroy()
        return
      }
      queue.push(body)
      if (!timer && !socket.writableNeedDrain) flush()
    },
    end(frame) {
      if (closed || socket.destroyed) return Promise.resolve()
      clearTimeout(timer)
      queue.length = 0
      return new Promise(resolve => {
        socket.once('close', resolve)
        socket.end(JSON.stringify({ ...frame, roomCode, seq: ++outgoing }) + '\n', resolve)
      })
    },
    close() { socket.destroy() },
    get busy() { return queue.length > 0 || socket.writableNeedDrain },
  }

  socket.on('data', chunk => {
    let start = 0
    while (start < chunk.length && !socket.destroyed) {
      const newline = chunk.indexOf(10, start)
      const end = newline < 0 ? chunk.length : newline
      const fragment = chunk.subarray(start, end)
      if (pending.length + fragment.length > MAX_FRAME_BYTES) {
        socket.destroy()
        return
      }
      pending = Buffer.concat([pending, fragment])
      if (newline < 0) return

      const now = process.hrtime.bigint()
      tokens = Math.min(BURST, tokens + Number(now - refillAt) * MAX_RATE / 1e9)
      refillAt = now
      if (tokens < 1) {
        socket.destroy()
        return
      }
      tokens--

      let frame
      try { frame = JSON.parse(pending.toString('utf8')) } catch { /* skip invalid JSON */ }
      pending = Buffer.alloc(0)
      start = end + 1
      if (!envelope(frame) || frame.roomCode !== roomCode || frame.seq <= incoming) continue
      incoming = frame.seq
      if (frame.type === 'ping') peer.send({ type: 'pong' })
      else if (frame.type !== 'pong') onFrame(frame, peer)
    }
  })

  const heartbeat = setInterval(() => {
    if (!peer.busy) peer.send({ type: 'ping' })
  }, KEEP_ALIVE_MS)
  socket.once('close', () => {
    closed = true
    clearInterval(heartbeat)
    clearTimeout(timer)
    onClose(peer)
  })
  return peer
}

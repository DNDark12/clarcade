import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runtime } from '../clarcade/helper/runtime.mjs'
import { parseLink } from '../clarcade/hooks/link.js'
import { name as validName, validMove } from '../clarcade/helper/protocol.mjs'

const execute = promisify(execFile)
const dataDir = process.env.CLARCADE_CHAT_DATA_DIR || join(homedir(), '.clarcade-chat-preview')
const args = [...process.argv.slice(2), '--data-dir', dataDir]
const { socketPath } = runtime(args, false)
const launcher = fileURLToPath(new URL('../clarcade/helper/launch.mjs', import.meta.url))
const thread = `chat-${randomUUID()}`
const uri = 'ui://clarcade-chat/board.html'
const mimeType = 'text/html;profile=mcp-app'
const resource = { uri, name: 'Clarcade board', mimeType }
const html = readFileSync(new URL('./board.html', import.meta.url), 'utf8')
const protocols = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string' }
const integer = { type: 'integer' }
const privateTool = { ui: { visibility: ['app'] } }
const tools = [
  { name: 'open_clarcade', title: 'Open Clarcade', description: 'Open the Caro / Gomoku board to join a LAN match.',
    inputSchema: object(), annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: uri } } },
  { name: 'join_room', description: 'Join a LAN match from the board using the invitation text and optional room PIN.',
    inputSchema: object({ link: string, name: string, pin: string }, ['link', 'name']), _meta: privateTool },
  { name: 'get_state', description: 'Read the current Clarcade board revision.',
    inputSchema: object({ version: string }), annotations: { readOnlyHint: true }, _meta: privateTool },
  { name: 'play_move', description: 'Place the guest stone at the clicked coordinates.',
    inputSchema: object({ gameId: string, moveNo: integer, moveEpoch: integer, x: integer, y: integer },
      ['gameId', 'moveNo', 'moveEpoch', 'x', 'y']), _meta: privateTool },
  { name: 'leave_room', description: 'Leave the current LAN match.',
    inputSchema: object({ gameId: string }, ['gameId']), _meta: privateTool },
]

function result(data, summary, isError = false) {
  return { content: [{ type: 'text', text: summary ?? JSON.stringify(data) }],
    structuredContent: data, ...(isError && { isError: true }) }
}

function failure(reason) {
  return result({ ok: false, reason }, undefined, true)
}

function daemon(path, body) {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath, path, method: body ? 'POST' : 'GET',
      headers: { 'x-clarcade-thread': thread, 'content-type': 'application/json' },
      timeout: 8000,
    }, response => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { data += chunk })
      response.on('error', reject)
      response.on('end', () => {
        try { resolve({ status: response.statusCode, data: data ? JSON.parse(data) : null }) }
        catch (error) { reject(error) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('Daemon request timed out')))
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

let launching
let systemNode
async function nodeForDaemon() {
  if (basename(process.execPath) === 'node') return process.execPath
  if (systemNode) return systemNode
  // Desktop's built-in Node can run the MCP server, but its executable is the Electron host.
  for (const candidate of ['node', '/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try {
      const { stdout } = await execute(candidate, ['-p', 'process.versions.node + "\\n" + process.execPath'], { timeout: 2000 })
      const [version, executable] = stdout.trim().split('\n')
      if (Number(version.split('.')[0]) >= 22 && executable?.startsWith('/') && basename(executable) === 'node') {
        systemNode = executable
        return systemNode
      }
    } catch {}
  }
  throw Object.assign(new Error('Install Node.js 22 or newer to run the Clarcade LAN daemon.'), { code: 'node-required' })
}

function start() {
  launching ??= nodeForDaemon().then(node => execute(node, [launcher, ...args], { timeout: 8000 }))
    .finally(() => { launching = undefined })
  return launching
}

function guestSnapshot(snapshot) {
  const { version, room } = snapshot
  if (room?.role !== 'guest') return { version, room: null }
  const { gameId, roomName, boardSize, boardVersion, moveEpoch, moves, status, connection, mark, turn,
    pendingMove, winLine, finished, host, guest } = room
  return { version, room: { gameId, roomName, boardSize, boardVersion, moveEpoch, moves, status, connection, mark, turn,
    pendingMove: Boolean(pendingMove), winLine, finished,
    hostName: host.name, guestName: guest?.name, won: finished?.winner === guest?.playerId } }
}

async function state(version) {
  const path = typeof version === 'string' && version.length <= 128 ? `/state?v=${encodeURIComponent(version)}` : '/state'
  let response
  try {
    response = await daemon(path)
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error
    if (!existsSync(join(dataDir, 'room.json'))) return { version: null, room: null }
    await start()
    response = await daemon(path)
  }
  if (response.status === 204) return { unchanged: true }
  if (response.status !== 200) throw new Error('Daemon state unavailable')
  return guestSnapshot(response.data)
}

async function call(name, input) {
  switch (name) {
    case 'open_clarcade':
      return result({ ok: true }, 'Clarcade LAN board. Enter the invitation text in the board to join a game.')
    case 'get_state':
      return result(await state(input.version))
    case 'join_room': {
      const { link, name: guestName, pin } = input
      if (!parseLink(link)) return failure('invalid-link')
      if (!validName(guestName)) return failure('invalid-name')
      if (pin !== undefined && (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin))) return failure('invalid-pin')
      await start()
      const response = await daemon('/join', { link, name: guestName, pin })
      return response.status === 200 ? result(await state()) : failure(response.data?.reason ?? 'join-failed')
    }
    case 'play_move': {
      const { room } = await state()
      if (!room || !validMove(input, room.boardSize)) return failure('invalid-move')
      const { gameId, moveNo, moveEpoch, x, y } = input
      if (gameId !== room.gameId || moveNo !== room.boardVersion + 1 || moveEpoch !== room.moveEpoch) {
        return failure('stale-move')
      }
      if (room.status !== 'playing' || room.connection !== 'connected' || room.turn !== room.mark || room.pendingMove) {
        return failure('move-unavailable')
      }
      const response = await daemon('/move', { gameId, moveNo, moveEpoch, x, y })
      return response.status === 200 ? result({ ok: true, ...await state() }) : failure(response.data?.reason ?? 'move-failed')
    }
    case 'leave_room': {
      const { room } = await state()
      if (!room || room.gameId !== input.gameId) return failure('stale-game')
      const response = await daemon('/action', { gameId: room.gameId, action: 'leave' })
      return response.status === 200 ? result({ ok: true, ...await state() }) : failure(response.data?.reason ?? 'leave-failed')
    }
    default:
      return failure('unknown-tool')
  }
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
}

async function handle({ id, method, params = {} }) {
  if (id === undefined) return
  let payload
  switch (method) {
    case 'initialize':
      payload = { protocolVersion: protocols.includes(params.protocolVersion) ? params.protocolVersion : protocols[0],
        capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'clarcade-chat-preview', version: '0.1.1' } }
      break
    case 'ping': payload = {}; break
    case 'tools/list': payload = { tools }; break
    case 'resources/list': payload = { resources: [resource] }; break
    case 'resources/templates/list': payload = { resourceTemplates: [] }; break
    case 'prompts/list': payload = { prompts: [] }; break
    case 'resources/read':
      if (params.uri !== uri) return send({ id, error: { code: -32002, message: 'Resource not found' } })
      payload = { contents: [{ ...resource, text: html }] }
      break
    case 'tools/call':
      try { payload = await call(params.name, params.arguments ?? {}) }
      catch (error) {
        console.error(`[clarcade-chat] ${params.name}: ${error.code ?? error.name}`)
        payload = failure(error.code === 'node-required' ? error.code : 'daemon-unavailable')
      }
      break
    default:
      return send({ id, error: { code: -32601, message: 'Method not found' } })
  }
  if (method !== 'tools/call' || params.name !== 'get_state' || !payload.structuredContent?.unchanged) {
    console.error(`[clarcade-chat] ${method}${method === 'tools/call' ? ` ${params.name}` : ''}`)
  }
  send({ id, result: payload })
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  let message
  try { message = JSON.parse(line) }
  catch { return send({ id: null, error: { code: -32700, message: 'Invalid JSON' } }) }
  if (message?.jsonrpc === '2.0') {
    void handle(message).catch(() => send({ id: message.id, error: { code: -32603, message: 'Internal MCP error' } }))
  }
})

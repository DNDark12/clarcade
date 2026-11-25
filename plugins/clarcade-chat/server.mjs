import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { validPin } from '../clarcade/helper/pin.mjs'
import { runtime } from '../clarcade/helper/runtime.mjs'
import { parseLink } from '../clarcade/hooks/link.js'
import { name as validName, validMove } from '../clarcade/helper/protocol.mjs'

const execute = promisify(execFile)
// Kept from the 0.1.1 preview so a game in progress survives the upgrade.
const dataDir = process.env.CLARCADE_CHAT_DATA_DIR || join(homedir(), '.clarcade-chat-preview')
const args = [...process.argv.slice(2), '--data-dir', dataDir]
const { socketPath } = runtime(args, false)
const launcher = fileURLToPath(new URL('../clarcade/helper/launch.mjs', import.meta.url))
const thread = `chat-${randomUUID()}`
const uri = 'ui://clarcade-chat/board.html'
const mimeType = 'text/html;profile=mcp-app'
const resource = { uri, name: 'Clarcade board', mimeType }
const sourceManifest = new URL('./manifest.json', import.meta.url)
const { version: appVersion } = JSON.parse(readFileSync(
  existsSync(sourceManifest) ? sourceManifest : new URL('../manifest.json', import.meta.url), 'utf8'))
const html = readFileSync(new URL('./board.html', import.meta.url), 'utf8').replace('__CLARCADE_CHAT_VERSION__', appVersion)
const protocols = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string' }
const integer = { type: 'integer' }
const visibilities = ['public', 'private']
const privateTool = { ui: { visibility: ['app'] } }
const tools = [
  { name: 'open_clarcade', title: 'Open Clarcade', description: 'Open the Caro / Gomoku board to host or join a LAN match.',
    inputSchema: object(), annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: uri } } },
  { name: 'host_room', description: 'Create a LAN room from the board.',
    inputSchema: object({ roomName: string, name: string, visibility: { type: 'string', enum: visibilities }, pin: string },
      ['roomName', 'name', 'visibility']), _meta: privateTool },
  { name: 'join_room', description: 'Join a LAN match from the board using the invitation text and optional room PIN.',
    inputSchema: object({ link: string, name: string, pin: string }, ['link', 'name']), _meta: privateTool },
  { name: 'get_state', description: 'Read the current Clarcade board revision.',
    inputSchema: object({ version: string }), annotations: { readOnlyHint: true }, _meta: privateTool },
  { name: 'play_move', description: 'Place your stone at the clicked coordinates.',
    inputSchema: object({ gameId: string, moveNo: integer, moveEpoch: integer, x: integer, y: integer },
      ['gameId', 'moveNo', 'moveEpoch', 'x', 'y']), _meta: privateTool },
  { name: 'rematch', description: 'Vote to play again after the game ends. A new game starts when both players vote.',
    inputSchema: object({ gameId: string }, ['gameId']), _meta: privateTool },
  { name: 'game_action', description: 'During a game: request an undo or a draw, answer the opponent\'s request, or resign.',
    inputSchema: object({ gameId: string, action: { type: 'string', enum: ['undoReq', 'drawReq', 'undoResp', 'drawResp', 'resign'] },
      offerId: string, accepted: { type: 'boolean' } }, ['gameId', 'action']), _meta: privateTool },
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
let daemonChecked = false
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
    .then(() => { daemonChecked = true })
    .finally(() => { launching = undefined })
  return launching
}

function boardSnapshot(snapshot) {
  const { version, room } = snapshot
  if (!room) return { version, room: null }
  const { role, gameId, roomName, boardSize, boardVersion, moveEpoch, moves, status, connection, mark, turn,
    pendingMove, winLine, finished, host, guest, rematchVotes = [], ruleset, turnMs = 0, turnEndsAt = null,
    moveLimit = 0, offer = null, score = null } = room
  const opponentRole = role === 'host' ? 'guest' : 'host'
  const mine = room[role].playerId
  const opponent = room[opponentRole]?.playerId
  const invitation = role === 'host' && status === 'waiting' ?
    { link: room.link, directLink: room.directLink, directLinks: room.directLinks, visibility: room.visibility } : {}
  return { version, room: { role, gameId, roomName, boardSize, boardVersion, moveEpoch, moves, status, connection, mark, turn,
    pendingMove: Boolean(pendingMove), winLine, finished: finished ? { draw: finished.winner === null } : null,
    hostName: host.name, guestName: guest?.name, won: finished?.winner === mine,
    rematchVoted: rematchVotes.includes(mine), rematchOffered: rematchVotes.includes(opponent),
    ruleset, turnMs, turnEndsAt, moveLimit, reason: finished?.reason ?? null,
    offer: offer ? { id: offer.id, kind: offer.kind, mine: offer.playerId === mine } : null,
    score: score ? { you: score[role], opponent: score[opponentRole], draws: score.draws } : null,
    ...invitation } }
}

async function state(version) {
  // Reopening an existing game also checks the version of the detached daemon.
  if (!daemonChecked && existsSync(join(dataDir, 'room.json'))) await start()
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
  return boardSnapshot(response.data)
}

async function call(name, input) {
  switch (name) {
    case 'open_clarcade':
      return result({ ok: true }, 'Clarcade LAN board. Use the board to create a room or join with an invitation.')
    case 'get_state':
      return result(await state(input.version))
    case 'host_room': {
      const { roomName, name, visibility, pin } = input
      if (!validName(name)) return failure('invalid-name')
      if (!validName(roomName) || !visibilities.includes(visibility)) return failure('invalid-room')
      if (visibility === 'private' && !validPin(pin)) return failure('invalid-pin')
      await start()
      const response = await daemon('/host', { roomName, name, visibility, ...(visibility === 'private' && { pin }) })
      return response.status === 200 ? result(await state()) : failure(response.data?.reason ?? 'host-failed')
    }
    case 'join_room': {
      const { link, name: guestName, pin } = input
      if (!parseLink(link)) return failure('invalid-link')
      if (!validName(guestName)) return failure('invalid-name')
      if (pin !== undefined && !validPin(pin)) return failure('invalid-pin')
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
    case 'rematch': {
      const { room } = await state()
      if (!room || room.gameId !== input.gameId) return failure('stale-game')
      if (room.status !== 'finished' || room.connection !== 'connected') return failure('rematch-unavailable')
      const response = await daemon('/action', { gameId: room.gameId, action: 'rematch' })
      return response.status === 200 ? result({ ok: true, ...await state() }) : failure(response.data?.reason ?? 'rematch-failed')
    }
    case 'game_action': {
      const { room } = await state()
      const { action, offerId, accepted } = input
      if (!room || room.gameId !== input.gameId) return failure('stale-game')
      if (!['undoReq', 'drawReq', 'undoResp', 'drawResp', 'resign'].includes(action)) return failure('invalid-action')
      if (room.status !== 'playing' || room.connection !== 'connected') return failure('action-unavailable')
      const answer = action.endsWith('Resp')
      if (answer && (typeof offerId !== 'string' || typeof accepted !== 'boolean')) return failure('invalid-offer')
      const response = await daemon('/action', { gameId: room.gameId, action, moveEpoch: room.moveEpoch,
        boardVersion: room.boardVersion, ...(answer && { offerId, accepted }) })
      return response.status === 200 ? result({ ok: true, ...await state() }) : failure(response.data?.reason ?? 'action-failed')
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
        capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'clarcade-chat', version: appVersion } }
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

import { expect, mock, test } from 'claude-code/testing'

const invite = 'clarcade://j/K7M2QX'
const alternateInvite = invite + '@192.168.1.20:49000'
const original = {
  roomCode: 'K7M2QX', roomName: 'QA game', gameId: 'game-1', ruleset: 'freestyle',
  host: { playerId: 'host', name: 'An' }, guest: null,
  role: 'host', status: 'waiting', connection: 'waiting', mark: 'X', turn: 'X',
  moves: [], winLine: null, boardVersion: 0, rematchVotes: [], pendingMove: null,
  boardSize: 15,
  finished: null, disconnectedAt: null, holdMs: 1800000,
  link: invite, directLink: invite + '@192.168.0.20:49000',
  directLinks: [
    { address: '192.168.0.20', link: invite + '@192.168.0.20:49000' },
    { address: '192.168.1.20', link: alternateInvite },
  ],
}
const surfaces = ['terminal', 'desktop'] as const
const pane = (surface: 'terminal' | 'desktop' | 'mobile' | 'vscode', columns = 42) => ({
  plugin: 'clarcade', surface, component: 'Pane' as const, requestId: 'clarcade',
  props: {
    title: 'Clarcade', bodyColumns: columns, isFocused: false, placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 23 }, view: {},
  },
})

function fixture(on, { privateRoom = false, publicRoom = false } = {}) {
  const store = mock.store(on)
  const clock = mock.clock(on)
  let room = null
  let revision = 0
  const requests = []
  const opens = []
  const registrations = []
  const toasts = []
  let notifications = []
  const change = (next, alerts = []) => { room = next; notifications = alerts; revision++ }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'thread-a' }))
  on('env.get', (_, e) => ({ value: e.name === 'LANG' ? 'en_US.UTF-8' : undefined }))
  on('command.register', (_, e) => { registrations.push(e.name); return { value: { command: 'clarcade' } } })
  on('ui.open', (_, e) => { opens.push(e.id); return { value: { isPlaced: true } } })
  on('ui.close', () => ({ value: { isClosed: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-surface' } }))
  on('process.run', (_, e) => {
    const stdout = e.argv.includes('-F') ? 'An\n'
      : e.argv.at(-1) === 'command -v node' ? '/usr/bin/node\n' : '{"socketPath":"/tmp/clarcade-test.sock"}'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', (_, e) => {
    const url = new URL(e.url)
    const path = url.pathname
    const body = e.init?.body && JSON.parse(e.init.body)
    requests.push({ path, body })
    let reply = {}
    if (path === '/host') change({
      ...original, roomName: body.roomName, ruleset: body.ruleset,
      visibility: body.visibility, turnMs: body.turnMs,
    })
    if (path === '/join' && privateRoom && body.pin !== '0042') {
      return { value: { status: 409, ok: false, headers: {}, text: JSON.stringify({
        reason: body.pin ? 'wrong-pin' : 'pin-required',
      }) } }
    }
    if (path === '/join') change({ ...original, role: 'guest', status: 'playing', connection: 'connected',
      guest: { playerId: 'guest', name: body.name }, mark: 'O', ruleset: privateRoom ? 'vn' : 'freestyle' })
    if (path === '/move') change({ ...room, boardVersion: 1, turn: 'O', moves: [{ x: body.x, y: body.y, mark: 'X' }] })
    if (path === '/action' && body.action === 'leave') change(null)
    if (path === '/state') {
      if (url.searchParams.get('v') === String(revision)) return { value: { status: 204, ok: true, headers: {}, text: '' } }
      reply = { version: String(revision), room, notifications }
    }
    if (path === '/rooms') {
      const matchedPrivate = privateRoom && url.searchParams.get('name') === 'Caro QA'
      reply = { rooms: matchedPrivate || publicRoom
        ? [{ roomCode: original.roomCode, roomName: matchedPrivate ? 'Caro QA' : original.roomName,
          hostName: 'An', ruleset: matchedPrivate ? 'vn' : 'freestyle', status: 'waiting',
          visibility: matchedPrivate ? 'private' : 'public', address: '192.168.0.20', port: 49000, latencyMs: 1 }] : [] }
    }
    if (path === '/stats') reply = { total: { played: 2, wins: 1, losses: 1, draws: 0 }, opponents: [] }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(reply) } }
  })
  return { clock, opens, requests, change, toasts, store, registrations }
}

for (const surface of surfaces) {
  test(`${surface}: onboarding, host, clipboard fallback, move and pane reopen`, async ($, on) => {
    const f = fixture(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    expect(f.opens).toHaveLength(0)
    await $.command.run({ command: 'clarcade', args: '' })
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.findAll({ type: 'Button', text: 'Save' })).toHaveLength(0)
    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { gap: 'sm' } })
    await ui.input({ key: 'player-name', text: 'An' })
    await ui.press({ key: 'tab-host' })
    expect(await ui.findAll({ type: 'Button', text: 'Create room' })).toHaveLength(0)
    expect(await ui.find({ key: 'turnMs' })).toBeUndefined()
    expect(await ui.find({ type: 'Input', key: 'host-pin' })).toBeUndefined()
    await ui.input({ key: 'room-name', text: 'QA game' })
    expect(f.requests.find(call => call.path === '/host')?.body).toEqual({
      roomName: 'QA game', name: 'An', holdMs: 1800000,
      ruleset: 'freestyle', visibility: 'public', turnMs: 0,
    })
    expect(await ui.find({ type: 'Text', text: /K\s*7\s*M\s*2\s*Q\s*X/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /select this room from Join room/ })).toBeTruthy()
    expect(await ui.findAll({ type: 'Button', text: /Copy link/ })).toHaveLength(1)
    expect(await ui.find({ type: 'Select', key: 'invite-address' })).toBeUndefined()
    await ui.press({ key: 'copy-link' })
    expect(await ui.find({ type: 'Text', text: invite })).toBeTruthy()
    await ui.press({ key: 'firewall-help' })
    await ui.select({ key: 'invite-address', value: '192.168.1.20' })
    expect(await ui.findAll({ type: 'Button', text: /Copy link/ })).toHaveLength(1)
    await ui.press({ key: 'copy-link' })
    expect(await ui.find({ type: 'Text', text: alternateInvite })).toBeTruthy()
    f.change({ ...original, status: 'playing', connection: 'connected', guest: { playerId: 'guest', name: 'Binh' } })
    await f.clock.advance(3000)
    expect(await ui.find({ type: 'Client', key: 'board' })).toBeTruthy()
    await ui.key({ key: 'return', in: 'board' })
    expect(f.requests.find(call => call.path === '/move')?.body).toEqual({ gameId: 'game-1', moveNo: 1, moveEpoch: 0, x: 0, y: 0 })
    await ui.key({ key: 'right', shift: true, in: 'board' })
    await ui.unmount()
    await $.command.run({ command: 'clarcade', args: '' })
    const reopened = await $.ui.mount(pane(surface))
    expect(await reopened.find({ type: 'Text', text: /Move 1/ })).toBeTruthy()
    f.change({ ...original, status: 'playing', connection: 'connected', guest: { playerId: 'guest', name: 'Binh' },
      boardVersion: 2, moves: [{ x: 0, y: 0, mark: 'X' }, { x: 0, y: 1, mark: 'O' }] })
    await f.clock.advance(3000)
    await reopened.key({ key: 'return', in: 'board' })
    expect(f.requests.filter(call => call.path === '/move').at(-1)?.body)
      .toEqual({ gameId: 'game-1', moveNo: 3, moveEpoch: 0, x: 5, y: 0 })
    await reopened.unmount()
  })

  test(`${surface}: join a public room from LAN discovery without entering a code or PIN`, async ($, on) => {
    const f = fixture(on, { publicRoom: true })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({ command: 'clarcade', args: '', origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 42 } })
    const ui = await $.ui.mount(pane(surface))
    await ui.input({ key: 'player-name', text: 'Binh' })
    expect(await ui.find({ key: 'tab-discover' })).toBeUndefined()
    await ui.press({ key: 'tab-join' })
    expect(await ui.findAll({ type: 'Input' })).toHaveLength(1)
    expect(await ui.find({ type: 'Input', key: 'join-target' })).toBeTruthy()
    const key = 'join-K7M2QX-192.168.0.20-49000'
    expect(await ui.find({ type: 'Button', key, text: /QA game · An/ })).toBeTruthy()
    await ui.press({ key })
    expect(f.requests.find(call => call.path === '/join')?.body).toEqual({
      link: original.directLink, name: 'Binh',
    })
    expect(await ui.find({ type: 'Input', key: 'join-pin' })).toBeUndefined()
    expect(await ui.find({ type: 'Client', key: 'board' })).toBeTruthy()
    await ui.unmount()
  })

  test(`${surface}: join by link, finish, rematch and show stats`, async ($, on) => {
    const f = fixture(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({ command: 'clarcade', args: `join ${invite}` })
    const ui = await $.ui.mount(pane(surface))
    await ui.input({ key: 'player-name', text: 'Binh' })
    expect(f.requests.find(call => call.path === '/join')?.body).toEqual({ link: invite, name: 'Binh' })
    f.change({ ...original, role: 'guest', status: 'finished', connection: 'connected',
      guest: { playerId: 'guest', name: 'Binh' }, mark: 'O', turn: null,
      finished: { winner: 'guest', reason: 'resign' },
    }, [{ id: 'finished-1', event: 'finished' }])
    await f.clock.advance(3000)
    expect(await ui.find({ type: 'Text', text: /You won/ })).toBeTruthy()
    await ui.press({ key: 'rematch' })
    expect(f.requests.some(call => call.path === '/action' && call.body.action === 'rematch')).toBe(true)
    await ui.press({ key: 'tab-stats' })
    expect(await ui.find({ type: 'Text', text: /2 played/ })).toBeTruthy()
    await ui.unmount()
  })
}

test('standalone invitations are consumed, while prose continues to the model', async ($, on) => {
  fixture(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const submit = (text) => $.prompt.submit({ text, origin: { kind: 'composer' } })
  expect((await submit(`Join ${invite}`)).text).toBe(`Join ${invite}`)
  expect((await submit(invite)).drop).toBeTruthy()
})

test('mobile and VS Code draw a fallback without a Client', async ($, on) => {
  const f = fixture(on)
  const room = { ...original, status: 'playing', connection: 'connected', guest: { playerId: 'guest', name: 'Binh' } }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  f.change(room)
  await f.clock.advance(3000)
  for (const surface of ['mobile', 'vscode'] as const) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /terminal or Claude Desktop/ })).toBeTruthy()
    expect(await ui.find({ type: 'Client' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Desktop attachment boots an SDK session exactly once without opening a pane', async ($, on) => {
  const f = fixture(on)
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/', isInteractive: false })
  expect(f.registrations).toHaveLength(0)
  for (const clientId of ['desktop-one', 'desktop-two']) {
    await $.session.attach({ surface: 'desktop', clientId })
  }
  expect(f.registrations).toEqual(['clarcade'])
  expect(f.opens).toHaveLength(0)
})

for (const surface of surfaces) {
  test(`${surface}: pending turn stays locked, reconnect restores the board and pointer posts one move`, async ($, on) => {
    const f = fixture(on)
    const room = { ...original, status: 'playing', connection: 'reconnecting',
      guest: { playerId: 'guest', name: 'Opponent' } }
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({ command: 'clarcade', args: '' })
    const ui = await $.ui.mount(pane(surface))
    await ui.input({ key: 'player-name', text: 'An' })
    f.change(room)
    await f.clock.advance(3000)
    expect(await ui.find({ type: 'Text', text: /Reconnecting/ })).toBeTruthy()
    const band = await $.ui.mount({
      plugin: 'clarcade', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 2, bodyColumns: 70,
        scroll: { offset: 0, bodyRows: 2 }, view: {} },
    })
    expect(await band.find({ type: 'Text', text: /Caro · QA game/ })).toBeTruthy()
    await band.press({ key: 'clarcade-open' })
    expect(f.opens).toHaveLength(2)
    await band.unmount()
    await ui.key({ key: 'return', in: 'board' })
    expect(f.requests.filter(call => call.path === '/move')).toHaveLength(0)
    f.change({ ...room, connection: 'connected' }, [{ id: 'boot:3', event: 'turn' }])
    await f.clock.advance(3000)
    expect(f.toasts).toHaveLength(0)
    await ui.pointer({ type: 'down', x: 20, y: surface === 'desktop' ? 7 : 8, button: 'left', in: 'board' })
    expect(f.requests.filter(call => call.path === '/move')).toHaveLength(1)
    await ui.key({ key: 'return', in: 'board' })
    expect(f.requests.filter(call => call.path === '/move')).toHaveLength(1)
    await ui.press({ key: 'tab-settings' })
    await ui.select({ key: 'language', value: 'vi' })
    expect(JSON.stringify(await ui.drawn())).toContain('Ngôn ngữ')
    await ui.unmount()
  })
}

for (const surface of surfaces) {
  test(`${surface}: opt in to blocked ends, PIN and clock then return to the Freestyle default`, async ($, on) => {
    const f = fixture(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({ command: 'clarcade', args: '' })
    const ui = await $.ui.mount(pane(surface))
    await ui.input({ key: 'player-name', text: 'An' })
    await ui.press({ key: 'tab-host' })
    await ui.select({ key: 'ruleset', value: 'vn' })
    expect(await ui.find({ type: 'Text', text: /at least one open end/ })).toBeTruthy()
    await ui.select({ key: 'visibility', value: 'private' })
    await ui.input({ key: 'host-pin', text: '0042' })
    await ui.press({ key: 'toggle-room-options' })
    await ui.select({ key: 'turnMs', value: '30000' })
    expect(await ui.find({ key: 'moveLimit' })).toBeUndefined()
    await ui.input({ key: 'room-name', text: 'Caro QA' })
    expect(f.requests.filter(call => call.path === '/host').at(-1).body).toEqual({
      roomName: 'Caro QA', name: 'An', holdMs: 1800000, ruleset: 'vn', visibility: 'private',
      pin: '0042', turnMs: 30000,
    })
    expect(await ui.find({ type: 'Text', text: 'Private' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Share the PIN/ })).toBeTruthy()
    await ui.press({ key: 'leave-room' })
    await ui.press({ key: 'confirm-action' })
    await ui.press({ key: 'tab-host' })
    expect(await ui.find({ key: 'turnMs' })).toBeUndefined()
    await ui.input({ key: 'room-name', text: 'Default QA' })
    const next = f.requests.filter(call => call.path === '/host').at(-1).body
    expect(next.ruleset).toBe('freestyle')
    expect(next.visibility).toBe('public')
    expect(next.pin).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: exact room name opens a PIN prompt and Caro offer controls`, async ($, on) => {
    const f = fixture(on, { privateRoom: true })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({ command: 'clarcade', args: '' })
    const ui = await $.ui.mount(pane(surface))
    await ui.input({ key: 'player-name', text: 'Binh' })
    await ui.press({ key: 'tab-join' })
    await ui.input({ key: 'join-target', text: 'Caro QA' })
    expect(await ui.find({ type: 'Text', text: 'This room requires a PIN.' })).toBeTruthy()
    expect(await ui.findAll({ type: 'Input' })).toHaveLength(1)
    await ui.press({ key: 'back-to-rooms' })
    await ui.input({ key: 'join-target', text: invite })
    expect(await ui.find({ type: 'Input', key: 'join-pin' })).toBeTruthy()
    await ui.input({ key: 'join-pin', text: '0042' })
    expect(f.requests.filter(call => call.path === '/join').at(-1).body.pin).toBe('0042')
    expect(await ui.find({ type: 'Text', text: /Blocked ends/ })).toBeTruthy()
    f.change({ ...original, ruleset: 'vn', role: 'guest', status: 'playing', connection: 'connected',
      guest: { playerId: 'guest', name: 'Binh' }, mark: 'O', turn: 'X',
      offer: { id: 'offer-qa', kind: 'draw', playerId: 'host' },
    })
    await f.clock.advance(3000)
    await ui.press({ key: 'offer-accept' })
    expect(f.requests.filter(call => call.path === '/action').at(-1).body).toMatchObject({
      action: 'drawResp', offerId: 'offer-qa', accepted: true,
    })
    await ui.unmount()
  })
}

for (const surface of surfaces) {
  for (const [columns, terminalClick, desktopClick] of [
    [36, { x: 17, y: 8 }, { x: 17, y: 7 }],
    [80, { x: 41, y: 9 }, { x: 41, y: 8 }],
  ] as const) {
    test(`${surface}: centered grid edge click at ${columns} columns and live display options`, async ($, on) => {
      const f = fixture(on)
      await $.session.start({ cwd: '/', surface, isInteractive: true })
      await $.command.run({ command: 'clarcade', args: '' })
      const ui = await $.ui.mount(pane(surface, columns))
      await ui.input({ key: 'player-name', text: 'An' })
      expect(await ui.find({ type: 'Button', key: 'tab-join' })).toBeTruthy()
      f.change({ ...original, status: 'playing', connection: 'connected',
        guest: { playerId: 'guest', name: 'Binh' } })
      await f.clock.advance(3000)
      const grid = surface === 'desktop' ? { type: 'Box' as const, key: 'grid-columns', in: 'board' }
        : { type: 'Text' as const, text: /┌──┬/, in: 'board' }
      expect(await ui.find(grid)).toBeTruthy()
      expect(Boolean(await ui.find({ type: 'Text', text: /More cells off-screen/ }))).toBe(surface === 'terminal')
      await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'board' })
      expect(f.requests.filter(call => call.path === '/move')).toHaveLength(0)
      await ui.pointer({ type: 'down', ...(surface === 'desktop' ? desktopClick : terminalClick), button: 'left', in: 'board' })
      expect(f.requests.filter(call => call.path === '/move').map(call => call.body)).toEqual([
        { gameId: 'game-1', moveNo: 1, moveEpoch: 0, x: 0, y: 0 },
      ])
      expect(await ui.find({ type: 'Text', text: surface === 'desktop' ? '✕' : '[X]', in: 'board' })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /Last move|⌖/, in: 'board' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'emote-nice' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'drawReq' })).toBeTruthy()
      expect(await ui.find({ type: 'Button', key: 'board-help' })).toBeUndefined()

      f.change({ ...original, status: 'playing', connection: 'connected',
        guest: { playerId: 'guest', name: 'Binh' }, boardVersion: 2,
        moves: [{ x: 0, y: 0, mark: 'X' }, { x: 1, y: 0, mark: 'O' }] })
      await f.clock.advance(3000)
      await ui.press({ key: 'tab-settings' })
      expect(await ui.findAll({ type: 'Button', text: 'Save' })).toHaveLength(0)
      expect(await ui.find({ type: 'Input', key: 'node-path' })).toBeUndefined()
      expect(await ui.find({ type: 'Select', key: 'pieces' })).toBeUndefined()
      await ui.press({ key: 'toggle-advanced' })
      expect(await ui.find({ type: 'Input', key: 'node-path' })).toBeUndefined()
      await ui.press({ key: 'toggle-network' })
      expect(await ui.find({ type: 'Input', key: 'node-path' })).toBeTruthy()
      await ui.select({ key: 'pieces', value: 'oo' })
      await ui.press({ key: 'tab-game' })
      expect(await ui.find({ type: 'Text', text: surface === 'desktop' ? '○' : '[○]', in: 'board' })).toBeTruthy()
      await ui.press({ key: 'tab-settings' })
      await ui.select({ key: 'pieces', value: 'pixel' })
      await ui.select({ key: 'board', value: 'dots' })
      await ui.press({ key: 'tab-game' })
      expect(await ui.find(grid)).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: '■', in: 'board' })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: '□', in: 'board' })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /More cells off-screen/ })).toBeUndefined()
      await ui.redraw(pane(surface, 24).props)
      expect(await ui.find({ type: 'Text', text: /More cells off-screen/ })).toBeTruthy()
      await ui.unmount()
    })
  }
}

test('Desktop widget restores an existing room after reload without opening a board', async ($, on) => {
  const f = fixture(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, event) =>
    $.ui.resolve(event).Text({ children: 'Idle' }))
  f.change({ ...original, status: 'playing', connection: 'connected',
    guest: { playerId: 'guest', name: 'Binh' } })
  const widget = await $.ui.mount({
    plugin: 'clarcade', surface: 'desktop', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 2, bodyColumns: 70,
      scroll: { offset: 0, bodyRows: 2 }, view: {} },
  })
  await f.clock.advance(3000)
  expect(f.registrations).toEqual(['clarcade'])
  expect(await widget.find({ type: 'Text', text: /Caro · QA game/ })).toBeTruthy()
  expect(f.opens).toHaveLength(0)
  expect(f.toasts).toHaveLength(0)
  await widget.unmount()
})

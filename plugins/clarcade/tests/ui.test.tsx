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

function fixture(on, { privateRoom = false, publicRoom = false, waitForStats = async () => {}, opponents = [] } = {}) {
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
  const envReads = []
  on('env.get', (_, e) => { envReads.push(e.name); return { value: e.name === 'LANG' ? 'en_US.UTF-8' : undefined } })
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
  on('http.fetch', async (_, e) => {
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
    if (path === '/stats') {
      await waitForStats()
      reply = { total: { played: 2, wins: 1, losses: 1, draws: 0 }, opponents }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(reply) } }
  })
  return { clock, opens, requests, change, toasts, store, registrations, envReads }
}

test('desktop host shows the board and subsequent moves while stats are still loading', async ($, on) => {
  let pendingStats: Promise<void> | undefined
  const f = fixture(on, { waitForStats: async () => { await pendingStats } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'clarcade', args: '' })
  const ui = await $.ui.mount(pane('desktop'))
  await ui.input({ key: 'player-name', text: 'An' })
  await ui.press({ key: 'tab-host' })
  await ui.input({ key: 'room-name', text: original.roomName })
  expect(await ui.find({ type: 'Button', text: /Copy link/ })).toBeTruthy()

  let releaseStats = () => {}
  pendingStats = new Promise<void>(resolve => { releaseStats = resolve })
  try {
    const joined = { ...original, status: 'playing', connection: 'connected', guest: { playerId: 'guest', name: 'Binh' } }
    f.change(joined)
    await f.clock.advance(3000)
    expect(await ui.find({ type: 'Client', key: 'board' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Your turn/ })).toBeTruthy()

    f.change({ ...joined, boardVersion: 1, turn: 'O', moves: [{ x: 0, y: 0, mark: 'X' }] })
    await f.clock.advance(3000)
    expect(await ui.find({ type: 'Text', text: /Opponent’s turn/ })).toBeTruthy()
    expect(f.opens).toHaveLength(1)
  } finally {
    releaseStats()
  }
})

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
    expect(await ui.find({ type: 'Text', text: original.directLink })).toBeTruthy()
    await ui.press({ key: 'firewall-help' })
    await ui.select({ key: 'invite-address', value: '' })
    await ui.press({ key: 'copy-link' })
    expect(await ui.find({ type: 'Text', text: invite })).toBeTruthy()
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
    expect(await reopened.find({ type: 'Text', text: /Opponent’s turn/ })).toBeTruthy()
    expect(await reopened.find({ type: 'Text', text: /Click a cell|Move 1/ })).toBeUndefined()
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
  // Desktop's sessions start as SDK sessions, so attaching schedules the update check, once.
  const checks = () => f.envReads.filter(name => name === 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC').length
  expect(checks()).toBe(0)
  await f.clock.advance(16000)
  expect(checks()).toBe(1)
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
    await ui.pointer({ type: 'up', x: 20, y: surface === 'desktop' ? 7 : 8, button: 'left', in: 'board' })
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
      const grid = surface === 'desktop' ? { type: 'Box' as const, key: 'board-grid', in: 'board' }
        : { type: 'Text' as const, text: /┌──┬/, in: 'board' }
      expect(await ui.find(grid)).toBeTruthy()
      if (surface === 'desktop') {
        const tile = await ui.find({ type: 'Box', key: 'grid-tile', in: 'board' })
        expect(Number(tile?.props.width) * 8.8).toBe(16)
        expect(Number(tile?.props.height) * 20).toBe(16)
        expect(Math.round(2 * Number(tile?.props.marginX) * 8.8)).toBe(4)
      }
      expect(Boolean(await ui.find({ type: 'Text', text: /More cells off-screen/ }))).toBe(surface === 'terminal')
      await ui.pointer({ type: 'down', ...(surface === 'desktop' ? desktopClick : terminalClick), button: 'left', in: 'board' })
      await ui.pointer({ type: 'up', ...(surface === 'desktop' ? desktopClick : terminalClick), button: 'left', in: 'board' })
      expect(f.requests.filter(call => call.path === '/move').map(call => call.body)).toEqual([
        { gameId: 'game-1', moveNo: 1, moveEpoch: 0, x: 0, y: 0 },
      ])
      expect(await ui.find({ type: 'Text', text: surface === 'desktop' ? 'X' : 'X ', in: 'board' })).toBeTruthy()
      if (surface === 'desktop') {
        expect((await ui.find({ type: 'Text', text: 'X', in: 'board' }))?.props.size).toBe('heading')
      }
      expect(await ui.find({ type: 'Text', text: /\[X\]|✕/, in: 'board' })).toBeUndefined()
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
      const pieces = await ui.find({ type: 'Select', key: 'pieces' })
      expect(pieces?.props.options).toContainEqual({ value: 'xo', label: 'X / O' })
      await ui.press({ key: 'toggle-network' })
      expect(await ui.find({ type: 'Input', key: 'node-path' })).toBeTruthy()
      await ui.select({ key: 'pieces', value: 'oo' })
      await ui.press({ key: 'tab-game' })
      const circle = await ui.find({ type: 'Text', text: surface === 'desktop' ? '◉' : '○ ', in: 'board' })
      expect(circle).toBeTruthy()
      if (surface === 'desktop') expect(circle?.props.size).toBe('title')
      await ui.press({ key: 'tab-settings' })
      await ui.select({ key: 'pieces', value: 'pixel' })
      await ui.select({ key: 'board', value: 'dots' })
      await ui.press({ key: 'tab-game' })
      expect(await ui.find(grid)).toBeUndefined()
      if (surface === 'desktop') {
        // Desktop draws pixel pieces as Boxes so they stay centred: a solid 12 px
        // square for a played piece, a 10 px frame on the latest O's filled tile.
        expect(await ui.find({ type: 'Text', text: /[■□▣]/, in: 'board' })).toBeUndefined()
        const pieces = await ui.findAll({ type: 'Box', key: 'board-piece', in: 'board' })
        expect(pieces.map(piece => Math.round(Number(piece.props.width) * 8.8)).sort()).toEqual([10, 12])
        expect((await ui.find({ type: 'Box', key: 'board-last-move', in: 'board' }))?.props.backgroundColor)
          .toBe('suggestion')
      } else {
        expect(await ui.find({ type: 'Text', text: '■', in: 'board' })).toBeTruthy()
        expect(await ui.find({ type: 'Text', text: '□', in: 'board' })).toBeTruthy()
      }
      expect(await ui.find({ type: 'Text', text: /More cells off-screen/ })).toBeUndefined()
      await ui.redraw(pane(surface, 24).props)
      expect(await ui.find({ type: 'Text', text: /More cells off-screen/ })).toBeTruthy()
      await ui.unmount()
    })
  }
}

for (const surface of surfaces) {
  test(`${surface}: dragging places one piece at release and dropping outside cancels`, async ($, on) => {
    const f = fixture(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({ command: 'clarcade', args: '' })
    const ui = await $.ui.mount(pane(surface, 80))
    await ui.input({ key: 'player-name', text: 'An' })
    const room = { ...original, status: 'playing', connection: 'connected', guest: { playerId: 'guest', name: 'Binh' },
      boardVersion: 2, moves: [{ x: 0, y: 0, mark: 'X' }, { x: 1, y: 0, mark: 'O' }] }
    f.change(room)
    await f.clock.advance(3000)
    const y = surface === 'desktop' ? 8 : 9
    const dropX = surface === 'desktop' ? 45 : 47
    const pointer = (type: 'down' | 'move' | 'up', x: number, row = y) =>
      ui.pointer({ type, x, y: row, button: 'left', in: 'board' })
    const moves = () => f.requests.filter(call => call.path === '/move').map(call => call.body)
    await pointer('down', 38)
    await pointer('move', dropX)
    await ui.key({ key: 'return', in: 'board' })
    expect(moves()).toHaveLength(0)
    // The Desktop Client reserves a row below its 1px bottom stroke.
    await pointer('up', dropX, surface === 'desktop' ? 16 : 80)
    await pointer('up', dropX)
    expect(moves()).toHaveLength(0)

    await pointer('down', 38)
    f.change({ ...room, moveEpoch: 1 })
    await f.clock.advance(3000)
    await pointer('up', dropX)
    expect(moves()).toHaveLength(0)

    await pointer('down', 38)
    f.change({ ...room, moveEpoch: 1, connection: 'reconnecting' })
    await f.clock.advance(3000)
    f.change({ ...room, moveEpoch: 1 })
    await f.clock.advance(3000)
    await pointer('up', dropX)
    expect(moves()).toHaveLength(0)

    if (surface === 'desktop') {
      await pointer('down', 38)
      await pointer('up', 44)
      expect(moves()).toHaveLength(0)
    }
    await pointer('down', surface === 'desktop' ? 44 : 38)
    await pointer('move', dropX)
    expect(moves()).toHaveLength(0)
    await pointer('up', dropX)
    expect(moves()).toEqual([{ gameId: 'game-1', moveNo: 3, moveEpoch: 1, x: 2, y: 0 }])
    await ui.unmount()
  })
}

test('Desktop marks only the latest move and keeps the same piece color with or without the cursor', async ($, on) => {
  const f = fixture(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'clarcade', args: '' })
  const ui = await $.ui.mount(pane('desktop', 80))
  await ui.input({ key: 'player-name', text: 'An' })
  f.change({ ...original, status: 'playing', connection: 'connected', guest: { playerId: 'guest', name: 'Binh' },
    boardVersion: 2, moves: [{ x: 0, y: 0, mark: 'X' }, { x: 1, y: 0, mark: 'O' }] })
  await f.clock.advance(3000)
  const cursor = { type: 'Box' as const, key: 'board-cursor-top-left', in: 'board' }
  const frame = { type: 'Box' as const, key: 'board-cursor', in: 'board' }
  const latest = { type: 'Box' as const, key: 'board-last-move', in: 'board' }
  const corners = { type: 'Box' as const, key: 'board-cursor-corners', in: 'board' }
  // X's Desktop color: one deeper orange, about 3.5:1 on light and dark tiles.
  const xColor = '#cc5f2d'
  expect((await ui.find(frame))?.props).toMatchObject({ left: 24, top: 8 })
  expect(Math.round(Number((await ui.find(frame))?.props.width) * 8.8)).toBe(180)
  expect((await ui.find(cursor))?.props.backgroundColor).toBe('text')
  // The latest move is a solid 16 px tile in the mover's color, the piece in inverse text.
  expect((await ui.find(latest))?.props.backgroundColor).toBe('suggestion')
  expect(Math.round(Number((await ui.find(latest))?.props.width) * 8.8)).toBe(16)
  expect((await ui.find({ type: 'Text', text: 'O', in: 'board' }))?.props.color).toBe('inverseText')
  expect((await ui.find({ type: 'Text', text: 'X', in: 'board' }))?.props.color).toBe(xColor)
  expect(await ui.find({ type: 'Box', key: 'board-last-move-marker', in: 'board' })).toBeUndefined()
  expect(Math.round(Number((await ui.find(corners))?.props.width) * 8.8)).toBe(14)
  expect(Math.round(Number((await ui.find(corners))?.props.height) * 20)).toBe(14)
  await ui.pointer({ type: 'move', x: 44, y: 8, in: 'board' })
  expect(Math.round(Number((await ui.find(frame))?.props.width) * 8.8)).toBe(200)
  await ui.pointer({ type: 'move', x: 45, y: 8, in: 'board' })
  expect(Math.round(Number((await ui.find(frame))?.props.width) * 8.8)).toBe(200)
  expect(f.requests.filter(call => call.path === '/move')).toHaveLength(0)
  await ui.key({ key: 'left', in: 'board' })
  await ui.key({ key: 'left', in: 'board' })
  expect(Math.round(Number((await ui.find(frame))?.props.width) * 8.8)).toBe(160)
  expect((await ui.find(cursor))?.props.backgroundColor).toBe('text')
  expect((await ui.find({ type: 'Text', text: 'X', in: 'board' }))?.props.color).toBe(xColor)
  f.change({ ...original, status: 'playing', connection: 'connected', guest: { playerId: 'guest', name: 'Binh' },
    turn: 'O', boardVersion: 3, moves: [{ x: 0, y: 0, mark: 'X' }, { x: 1, y: 0, mark: 'O' }, { x: 2, y: 0, mark: 'X' }] })
  await f.clock.advance(3000)
  expect(await ui.find(cursor)).toBeUndefined()
  expect(await ui.findAll(latest)).toHaveLength(1)
  expect((await ui.find(latest))?.props.backgroundColor).toBe(xColor)
  const xs = await ui.findAll({ type: 'Text', text: 'X', in: 'board' })
  expect(xs.map(x => x.props.color).sort()).toEqual(['inverseText', xColor].sort())
  await ui.unmount()
})

test('Desktop renders a dense legacy viewport within the Client budget and can pan to the far edge', async ($, on) => {
  const f = fixture(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'clarcade', args: '' })
  const wide = pane('desktop', 180)
  wide.props.scroll.bodyRows = 42
  const ui = await $.ui.mount(wide)
  await ui.input({ key: 'player-name', text: 'An' })
  const moves = Array.from({ length: 384 }, (_, index) => ({
    x: index % 24 - 12, y: Math.floor(index / 24) - 8, mark: index % 2 ? 'O' : 'X',
  }))
  // Center the dense section; put another piece beyond the initial viewport.
  const last = moves.splice(204, 1)[0]
  moves.push({ x: 100, y: 0, mark: 'O' }, last)
  f.change({ ...original, status: 'playing', connection: 'connected', guest: { playerId: 'guest', name: 'Binh' },
    boardSize: 201, boardVersion: moves.length, moves })
  await f.clock.advance(3000)
  expect(JSON.stringify(await ui.drawn({ in: 'board' })).length).toBeLessThan(100000)
  expect(await ui.find({ type: 'Text', text: /More cells off-screen/ })).toBeTruthy()
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'toggle-advanced' })
  await ui.select({ key: 'board', value: 'dots' })
  await ui.press({ key: 'tab-game' })
  expect(JSON.stringify(await ui.drawn({ in: 'board' })).length).toBeLessThan(100000)
  for (let step = 0; step < 20; step++) await ui.key({ key: 'right', shift: true, in: 'board' })
  expect(await ui.find({ type: 'Text', text: '100', in: 'board' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'O', in: 'board' })).toBeTruthy()
  await ui.unmount()
})

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

// The manifest lists no `options` for these fields (older Claude Code rejects
// the key), so a value typed outside the known choices falls back to the default.
test('unknown userConfig choices fall back to the defaults', {
  options: { pieces: 'banana', board: 'hex', language: 'xx', notifications: 'loud' },
}, async ($, on) => {
  fixture(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clarcade', args: '' })
  const ui = await $.ui.mount(pane('terminal', 80))
  await ui.input({ key: 'player-name', text: 'An' })
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'toggle-advanced' })
  expect((await ui.find({ type: 'Select', key: 'pieces' }))?.props.value).toBe('xo')
  expect((await ui.find({ type: 'Select', key: 'board' }))?.props.value).toBe('grid')
  // Automatic updates default to on, with a button to update at once.
  expect((await ui.find({ type: 'Select', key: 'autoUpdate' }))?.props.value).toBe('true')
  expect(await ui.find({ type: 'Button', key: 'update-now' })).toBeTruthy()
  await ui.unmount()
})

// Rooms on the LAN appear by themselves on Home and Join, with your record
// against each host; Scan LAN looks again at once.
test('Home and Join list LAN rooms automatically, with a scan button and the record against the host', async ($, on) => {
  const f = fixture(on, { publicRoom: true,
    opponents: [{ playerId: 'p-an', name: 'An', played: 5, wins: 3, losses: 2, draws: 0 }] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clarcade', args: '' })
  const ui = await $.ui.mount(pane('terminal', 80))
  await ui.input({ key: 'player-name', text: 'Binh' })
  await f.clock.advance(4000)
  const key = 'join-K7M2QX-192.168.0.20-49000'
  expect(await ui.find({ type: 'Text', text: /1 room\(s\) waiting on your LAN/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key, text: /QA game · An · .* · you 3W 2L/ })).toBeTruthy()

  await ui.press({ key: 'tab-join' })
  expect(await ui.find({ type: 'Text', text: 'Rooms on your LAN' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Updated \d\d:\d\d:\d\d · 1 found/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Private rooms do not appear here/ })).toBeTruthy()
  const scans = () => f.requests.filter(call => call.path === '/rooms').length
  const before = scans()
  await ui.press({ key: 'scan-rooms' })
  expect(scans()).toBe(before + 1)
  expect(await ui.find({ type: 'Button', key, text: /you 3W 2L/ })).toBeTruthy()
  await ui.unmount()
})

test('a host you have never played is marked as a new opponent', async ($, on) => {
  const f = fixture(on, { publicRoom: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clarcade', args: '' })
  const ui = await $.ui.mount(pane('terminal', 80))
  await ui.input({ key: 'player-name', text: 'Binh' })
  await ui.press({ key: 'tab-join' })
  await f.clock.advance(3000)
  expect(await ui.find({ type: 'Button', key: 'join-K7M2QX-192.168.0.20-49000', text: /new opponent/ })).toBeTruthy()
  await ui.unmount()
})

// The first stone may go anywhere: pressing Enter off center plays there.
test('the first move can be played off center', async ($, on) => {
  const f = fixture(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clarcade', args: '' })
  const ui = await $.ui.mount(pane('terminal', 80))
  await ui.input({ key: 'player-name', text: 'An' })
  f.change({ ...original, status: 'playing', connection: 'connected', guest: { playerId: 'guest', name: 'Binh' } })
  await f.clock.advance(3000)
  await ui.key({ key: 'right', in: 'board' })
  await ui.key({ key: 'right', in: 'board' })
  await ui.key({ key: 'up', in: 'board' })
  await ui.key({ key: 'return', in: 'board' })
  expect(f.requests.filter(call => call.path === '/move').map(call => call.body)).toEqual([
    { gameId: 'game-1', moveNo: 1, moveEpoch: 0, x: 2, y: -1 },
  ])
  await ui.unmount()
})

// The board shows this room's score; the all-time record stays on the statistics tab.
test('the player bar shows the score of this room, not the all-time record', async ($, on) => {
  const f = fixture(on, { opponents: [{ playerId: 'guest', name: 'Binh', played: 9, wins: 5, losses: 4, draws: 0 }] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clarcade', args: '' })
  const ui = await $.ui.mount(pane('terminal', 80))
  await ui.input({ key: 'player-name', text: 'An' })
  const joined = { ...original, status: 'playing', connection: 'connected', guest: { playerId: 'guest', name: 'Binh' } }
  f.change({ ...joined, score: { host: 0, guest: 0, draws: 0 } })
  await f.clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: ' 0–0 ' })).toBeTruthy()
  f.change({ ...joined, gameId: 'game-2', score: { host: 1, guest: 2, draws: 1 } })
  await f.clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: ' 1–2 ' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: ' 5–4 ' })).toBeFalsy()
  await ui.unmount()
})

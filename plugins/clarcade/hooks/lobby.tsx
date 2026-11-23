import { boardProps, pieceGlyphs } from '../games/gomoku/board-view.js'
import { roomLinks } from './link.js'
import { resultReason, ruleText } from './i18n.ts'
import { details, summary } from './statistics.ts'
import { piecePalette, statusColor } from './ui/tokens.ts'

export function roomStatus(room, t) {
  if (room.status === 'waiting') return t.waiting
  if (room.connection === 'reconnecting') return t.reconnecting
  if (room.connection === 'syncing') return t.syncing
  if (room.status === 'finished') return t.finished
  if (room.pendingMove) return t.pending
  return room.turn === room.mark ? t.yours : t.theirs
}

export function scoreLine(room, result, t) {
  if (!room.guest) return roomStatus(room, t)
  const isHost = room.role === 'host'
  const own = result?.wins ?? 0
  const other = result?.losses ?? 0
  return `${room.host.name} ${isHost ? own : other}–${isHost ? other : own} ${room.guest.name} · ${roomStatus(room, t)}`
}

export function lobby(elements, event, ui, actions, t) {
  const { Box, Text, Button, Input, Select, Client } = elements
  const button = (key, label, onPress, primary = false) => Button({
    key, label, onPress, ...(primary && { variant: 'primary' }),
  })
  const text = (children, extra = {}) => Text({ children, ...extra })
  const column = (children, gap?: 'xs' | 'sm') =>
    Box({ flexDirection: 'column', gap, children: children.filter(Boolean) })
  const row = (children, spacing = {}) =>
    Box({ flexDirection: 'row', flexWrap: 'wrap', children: children.filter(Boolean), ...spacing })
  const actionRow = children => row(children, { gap: 'sm' })
  const input = (key, label, value, onInput, onSubmit, submitLabel = t.save) =>
    Input({ key, label, value, onInput, onSubmit, submitLabel })
  const edit = key => value => actions.edit(key, value)
  const room = ui.room
  const supported = event.surface === 'terminal' || event.surface === 'desktop'
  const canPlay = supported && Client
  const columns = Math.max(8, event.props.bodyColumns || 36)
  const compact = columns < 48
  const desktop = event.surface === 'desktop'
  const recover = (ui.helperDown || ui.nodeMissing || ui.error === t.unavailable) &&
    button('recover-helper', t.recover, actions.recover, true)
  const alert = ui.error || ui.nodeMissing || ui.helperDown
    ? notice(ui.error || (ui.nodeMissing ? t.nodeMissing : t.unavailable), 'error', recover)
    : ui.notice ? notice(ui.notice) : null
  const feedback = ui.busy ? text(t.loading, { dimColor: true }) : alert
  // During a game nothing above the board may appear or disappear, so the board never moves.
  const playing = Boolean(room && room.status !== 'waiting' && ui.tab !== 'stats' && ui.tab !== 'settings')

  if (!canPlay) return column([
    header(), text(t.fallback),
    room?.guest && playerBar(),
    room && notice(roomStatus(room, t), statusColor(room)),
  ])
  if (!ui.settings.playerName) {
    return column([
      header(), text(t.intro), feedback,
      input('player-name', t.name, ui.nameDraft, edit('nameDraft'), actions.saveName),
    ], 'sm')
  }
  const tabs = [[room ? 'game' : 'home', room ? t.game : t.home], ['stats', t.stats], ['settings', t.settings]]
  return column([
    header(),
    ui.tab !== 'home' && nav(),
    !playing && feedback,
    ...(ui.tab === 'stats' ? statistics() : ui.tab === 'settings' ? settings() :
      room ? game() : ui.tab === 'join' ? join() : ui.tab === 'host' ? host() : home()),
    ui.tab === 'home' && nav(),
  ], ui.tab === 'game' && room?.status !== 'waiting' ? undefined : 'sm')

  function nav() {
    if (ui.tab === 'join' && ui.pinLink) return null
    if (ui.tab !== 'home' && ui.tab !== 'game') {
      return actionRow([button(room ? 'tab-game' : 'tab-home', t.back, () => actions.tab(room ? 'game' : 'home'))])
    }
    return actionRow(tabs.filter(([key]) => key !== ui.tab).map(([key, label]) =>
      button(`tab-${key}`, label, () => actions.tab(key))))
  }

  function header() {
    return row([
      text(` ${t.title} `, { bold: true, color: 'inverseText', backgroundColor: piecePalette(desktop).X }),
      room && text(` · ${room.roomName} `, { bold: true, wrap: 'truncate-end' }),
      room && text(` ${ruleText(room.ruleset, t)} `, { color: 'inverseText', backgroundColor: 'subtle' }),
    ])
  }

  function notice(message, color = 'inactive', action = null, oneLine = false) {
    return Box({
      flexDirection: 'column', borderStyle: 'single', borderColor: color, borderDimColor: color === 'inactive',
      paddingX: 1, children: [text(message, {
        bold: color !== 'inactive', ...(oneLine && { wrap: 'truncate-end', tabular: true }),
      }), action].filter(Boolean),
    })
  }

  function home() {
    return [actionRow([
      button('tab-host', t.create, () => actions.tab('host'), true),
      button('tab-join', t.join, () => actions.tab('join')),
    ])]
  }

  function playerBar() {
    const host = room.role === 'host'
    const glyphs = pieceGlyphs(ui.settings.pieces, desktop)
    const { wins = 0, losses = 0 } = ui.headToHead ?? {}
    const score = text(` ${host ? wins : losses}–${host ? losses : wins} `, { bold: true, tabular: true })
    const player = (mark, person, own) => {
      const active = room.status === 'playing' && room.turn === mark
      const color = piecePalette(desktop)[mark]
      const online = own || room.connection === 'connected'
      return text([
        text(active ? '▸ ' : '  ', { color: active && online ? 'success' : 'inactive' }),
        text(`${glyphs[mark]} `, { color, bold: true }), person.name,
        own ? ` (${t.you})` : text(' ●', { color: online ? 'success' : 'warning' }),
        !online && ` ${t.offline}`,
      ].filter(Boolean), { bold: active, wrap: 'truncate-end' })
    }
    const otherMark = room.mark === 'X' ? 'O' : 'X'
    const hostSide = player(host ? room.mark : otherMark, room.host, host)
    const guestSide = player(host ? otherMark : room.mark, room.guest, !host)
    return compact ? column([row([hostSide, score]), guestSide]) : row([hostSide, score, guestSide])
  }

  function picker<T extends string | number | boolean>(
    key: string, label: string, options: [T, string][], current: T, select = edit(key),
  ) {
    return Select({
      key, label, value: String(current),
      options: options.map(([value, label]) => ({ value: String(value), label })),
      onSelect: (value: string) => {
        const option = options.find(([candidate]) => String(candidate) === value)
        if (option) select(option[0])
      },
    })
  }

  function host() {
    return [
      text(t.chooseHost, { bold: true }),
      column([
        picker('ruleset', t.rules, [['freestyle', t.freestyle], ['vn', t.caro]], ui.ruleset),
        text(ui.ruleset === 'vn' ? t.caroRule : t.freestyleRule, { dimColor: true }),
      ]),
      picker('visibility', t.visibility, [['public', t.public], ['private', t.private]], ui.visibility),
      ui.visibility === 'private' && input('host-pin', t.pin, ui.hostPin, edit('hostPin'), edit('hostPin'), t.setPin),
      button('toggle-room-options', `${ui.hostAdvanced ? '▾' : '▸'} ${t.roomOptions}`,
        () => actions.edit('hostAdvanced', !ui.hostAdvanced)),
      ui.hostAdvanced && column([
        picker('turnMs', t.turnClock, [[0, t.off], [30000, `30 ${t.seconds}`], [60000, `1 ${t.minutes}`],
          [120000, `2 ${t.minutes}`], [300000, `5 ${t.minutes}`]], ui.turnMs),
        picker('holdMs', t.hold, [[300000, `5 ${t.minutes}`], [1800000, `30 ${t.minutes}`],
          [7200000, `2 ${t.hours}`]], ui.holdMs),
      ], 'xs'),
      input('room-name', t.room, ui.roomDraft, edit('roomDraft'), actions.host, t.create),
    ]
  }

  function join() {
    if (ui.pinLink) return [
      button('back-to-rooms', t.backToRooms, () => actions.tab('join')),
      input('join-pin', t.pin, ui.joinPin, edit('joinPin'), actions.submitPin, t.join),
    ]
    const empty = ui.rooms === null ? t.loading : ui.discoveryName ? t.noNamedRooms : t.noPublicRooms
    return [
      input('join-target', t.roomOrLink, ui.joinDraft, edit('joinDraft'), actions.findTarget, t.findOrJoin),
      ui.discoveryName && button('back-to-rooms', t.showPublicRooms, () => actions.tab('join')),
      ui.roomSearchError ? notice(ui.roomSearchError, 'error') :
        ui.rooms?.length ? column(ui.rooms.map(item => {
          const label = [item.roomName, item.hostName, ruleText(item.ruleset, t),
            item.visibility === 'private' && t.private].filter(Boolean).join(' · ')
          return item.status === 'waiting' ? button(`join-${item.roomCode}-${item.address}-${item.port}`, label,
            () => actions.join(roomLinks(item.roomCode, item.address, item.port).directLink)) :
            text(`${label} · ${t.full}`, { dimColor: true })
        }), 'xs') : text(empty, { dimColor: true }),
    ]
  }

  function game() {
    if (room.status === 'waiting') return [
      notice(roomStatus(room, t)),
      column([
        text(room.visibility === 'private' ? t.private : t.public, { bold: true }),
        text(room.visibility === 'private' ? t.privateInvite : t.publicInvite, { dimColor: true }),
      ]),
      ...inviteControls(),
      ...leaveControls(t.cancel),
    ]
    const outcome = room.finished && (room.finished.winner === null ? t.draw :
      room.finished.winner === (room.role === 'host' ? room.host.playerId : room.guest.playerId) ? t.win : t.loss)
    const reason = room.finished && resultReason(room.finished.reason, t)
    const secondsLeft = room.turnEndsAt == null ? null : Math.max(0, Math.ceil((room.turnEndsAt - ui.now) / 1000))
    const canMove = room.status === 'playing' && room.connection === 'connected' &&
      room.mark === room.turn && !room.pendingMove && !ui.busy && secondsLeft !== 0
    const rows = Math.max(7, Math.min(32, (event.props.scroll?.bodyRows || 23) - 5))
    const contents = boardProps(room, ui.view, canMove, columns, rows, ui.settings, desktop)
    const myId = room.role === 'host' ? room.host.playerId : room.guest?.playerId
    const voted = room.rematchVotes.includes(myId)
    const canClaim = room.role === 'host' && room.disconnectedAt && ui.now >= room.disconnectedAt + room.holdMs &&
      room.status === 'playing'
    return [
      playerBar(),
      notice(outcome ? [outcome, reason].filter(Boolean).join(' · ') : [
        roomStatus(room, t),
        room.disconnectedAt && room.status === 'playing' &&
          `${Math.max(0, Math.floor((ui.now - room.disconnectedAt) / 1000))} ${t.seconds}`,
        room.turnMs > 0 && secondsLeft !== null && room.connection === 'connected' && `${secondsLeft} ${t.seconds}`,
        room.moveLimit > 0 && `${room.boardVersion}/${room.moveLimit}`,
      ].filter(Boolean).join(' · '), outcome ? outcome === t.win ? 'success' : outcome === t.loss ? 'error' : 'warning' : statusColor(room),
      null, true),
      Client({
        key: 'board', module: '../games/gomoku/board.client.tsx', width: '100%', height: contents.lines,
        props: contents,
      }),
      alert,
      contents.cropped && text(t.boardCropped, { dimColor: true }),
      column([
        ...(room.status === 'playing' && room.connection === 'connected' ? gameActions(room, myId) : []),
        room.status === 'finished' && (voted ? text(`${t.waitingVote} · ${room.role === 'host' ? room.guest.name : room.host.name}`) :
          room.connection === 'connected' && button('rematch', t.rematch, () => actions.action('rematch'), true)),
        canClaim && notice(t.holdExpired, 'warning', actionRow([
          button('extend-hold', t.wait, () => actions.action('extend')),
          button('claim-win', t.claim, () => actions.action('claim'), true),
        ])),
        ...leaveControls(t.leave),
      ], 'xs'),
    ]
  }

  function gameActions(room, myId) {
    if (!room.offer) return [
      actionRow([
        room.moves.at(-1)?.mark === room.mark && button('undoReq', t.requestUndo, () => actions.action('undoReq')),
        button('drawReq', t.requestDraw, () => actions.action('drawReq')),
      ]),
    ]
    const { id, kind, playerId } = room.offer
    if (playerId === myId) return [text(kind === 'undo' ? t.pendingUndo : t.pendingDraw)]
    return [
      text(kind === 'undo' ? t.offeredUndo : t.offeredDraw),
      actionRow([
        button('offer-accept', t.accept, () => actions.action(`${kind}Resp`, { offerId: id, accepted: true }), true),
        button('offer-decline', t.decline, () => actions.action(`${kind}Resp`, { offerId: id, accepted: false })),
      ]),
    ]
  }

  function inviteControls() {
    const directLinks: { address: string; link: string }[] = room.directLinks ??
      (room.address && room.directLink ? [{ address: room.address, link: room.directLink }] : [])
    const link = directLinks.find(item => item.address === ui.inviteAddress)?.link ?? room.link
    return [
      actionRow([
        button('copy-link', t.copy, e => actions.copy(link, e.surface), true),
        button('firewall-help', `${ui.firewallHelp ? '▾' : '▸'} ${t.connectionHelp}`,
          () => actions.edit('firewallHelp', !ui.firewallHelp)),
      ]),
      ui.firewallHelp && column([
        directLinks.length > 0 && Select({
          key: 'invite-address', label: t.inviteAddress, value: ui.inviteAddress,
          options: [{ value: '', label: t.lanDiscovery }, ...directLinks.map(({ address }) => ({ value: address, label: address }))],
          onSelect: edit('inviteAddress'),
        }),
        directLinks.length > 0 && text(t.directInvite, { dimColor: true }),
        text(t.firewall, { dimColor: true }),
      ], 'xs'),
      ui.copyFallback && notice(ui.copyFallback),
    ]
  }

  function leaveControls(label) {
    if (ui.confirm) return [
      actionRow([
        button('confirm-action', `${t.confirm} · ${ui.confirm === 'resign' ? t.resign : label}`, () => actions.action(ui.confirm), true),
        button('cancel-action', t.back, () => actions.edit('confirm', null)),
      ]),
    ]
    return [actionRow([
      button('leave-room', label, () => actions.edit('confirm', 'leave')),
      room.status === 'playing' && button('resign', t.resign, () => actions.edit('confirm', 'resign')),
    ])]
  }

  function statistics() {
    const total = ui.stats?.total
    const opponents = ui.stats?.opponents ?? []
    const selected = opponents.find(item => item.playerId === ui.selectedOpponent)
    if (selected) return [
      button('back-stats', t.back, () => edit('selectedOpponent')(null)),
      text(selected.name ?? selected.playerId.slice(0, 8), { bold: true }),
      ...details(selected, t).map(line => text(line)),
    ]
    return [
      section(t.personal, total?.played ? details(total, t).map(line => text(line, { tabular: true })) : [text(t.noStats)]),
      section(t.opponents, opponents.map(item => button(`stats-${item.playerId}`,
        `${item.name ?? item.playerId.slice(0, 8)} · ${summary(item, t)}`,
        () => edit('selectedOpponent')(item.playerId)))),
      button('refresh-stats', t.refresh, actions.stats),
    ]
  }

  function section(title, children) {
    return column([text(title, { bold: true, size: 'heading' }), ...children])
  }

  function settings() {
    const current = ui.settings
    const set = (key: string) => (value: string | number | boolean) => actions.setting(key, value)
    const switchOptions: [boolean, string][] = [[true, t.on], [false, t.off]]
    return [
      input('player-name', t.name, ui.nameDraft, edit('nameDraft'), actions.saveName),
      picker('language', t.language, [['auto', t.system], ['en', 'English'], ['vi', 'Tiếng Việt']],
        current.preference, set('language')),
      picker('sounds', t.sounds, switchOptions, current.sounds, set('sounds')),
      button('toggle-advanced', `${ui.advanced ? '▾' : '▸'} ${t.advanced}`, () => actions.edit('advanced', !ui.advanced)),
      ...(ui.advanced ? [
        picker('notifications', t.notifications, ['toast', 'sound', 'band', 'off'].map(value => [value, t[value]]),
          current.notifications, set('notifications')),
        picker('board', t.board, [['grid', t.grid], ['dots', t.dots]], current.board, set('board')),
        picker('pieces', t.pieces, ['xo', 'oo', 'pixel'].map(style => {
          const { X, O } = pieceGlyphs(style, desktop)
          return [style, `${X} / ${O}`]
        }), current.pieces, set('pieces')),
        event.surface === 'terminal' && current.pieces !== 'xo' && text(t.glyphHint, { dimColor: true }),
        button('toggle-network', `${ui.network ? '▾' : '▸'} ${t.network}`, () => actions.edit('network', !ui.network)),
        ...(ui.network ? [
          input('udp-port', t.udpPort, ui.portDraft, edit('portDraft'), set('udpPort')),
          input('node-path', t.nodePath, ui.nodeDraft, edit('nodeDraft'), set('nodePath')),
          picker('allowTailscale', t.tailscale, switchOptions, current.allowTailscale, set('allowTailscale')),
          picker('allowIpv6Ula', t.ula, switchOptions, current.allowIpv6Ula, set('allowIpv6Ula')),
        ] : []),
      ] : []),
    ]
  }
}

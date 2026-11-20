import { boardProps, pieceGlyphs } from '../games/gomoku/board-view.js'
import { roomLinks } from './link.js'
import { resultReason, ruleText } from './i18n.ts'
import { details, summary } from './statistics.ts'
import { pieceColor, statusColor } from './ui/tokens.ts'

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
  const column = children => Box({ flexDirection: 'column', children: children.filter(Boolean) })
  const row = (children, spacing = {}) =>
    Box({ flexDirection: 'row', flexWrap: 'wrap', children: children.filter(Boolean), ...spacing })
  const actionRow = children => row(children, { columnGap: 'sm', rowGap: 'xs', marginTop: 'xs' })
  const input = (key, label, value, onInput, onSubmit, submitLabel = t.save) =>
    Input({ key, label, value, onInput, onSubmit, submitLabel })
  const edit = key => value => actions.edit(key, value)
  const room = ui.room
  const supported = event.surface === 'terminal' || event.surface === 'desktop'
  const canPlay = supported && Client
  const columns = Math.max(8, event.props.bodyColumns || 36)
  const compact = columns < 48
  const recover = (ui.helperDown || ui.nodeMissing || ui.error === t.unavailable) &&
    button('recover-helper', t.recover, actions.recover, true)
  const feedback = ui.busy ? text(t.loading, { dimColor: true }) :
    ui.error || ui.nodeMissing || ui.helperDown
      ? notice(ui.error || (ui.nodeMissing ? t.nodeMissing : t.unavailable), 'error', recover)
      : ui.notice ? notice(ui.notice) : null

  if (!canPlay) return column([
    header(), text(t.fallback),
    room?.guest && playerBar(),
    room && notice(roomStatus(room, t), statusColor(room)),
  ])
  if (!ui.settings.playerName) {
    return column([
      header(), text(t.intro), feedback,
      input('player-name', t.name, ui.nameDraft, edit('nameDraft'), actions.saveName),
      button('save-player-name', t.save, () => actions.saveName(ui.nameDraft), true),
    ])
  }
  const tabs = [[room ? 'game' : 'home', room ? t.game : t.home], ['stats', t.stats], ['settings', t.settings]]
  return column([
    header(),
    ui.tab !== 'home' && nav(),
    feedback,
    ...(ui.tab === 'stats' ? statistics() : ui.tab === 'settings' ? settings() :
      room ? game() : ui.tab === 'join' ? join() : ui.tab === 'host' ? host() : home()),
    ui.tab === 'home' && nav(),
  ])

  function nav() {
    return actionRow(tabs.filter(([key]) => key !== ui.tab).map(([key, label]) =>
      button(`tab-${key}`, label, () => actions.tab(key))))
  }

  function header() {
    return row([
      text(` ${t.title} `, { bold: true, color: 'inverseText', backgroundColor: pieceColor.X }),
      room && text(` · ${room.roomName} `, { bold: true, wrap: 'truncate-end' }),
      room && text(` ${ruleText(room.ruleset, t)} `, { color: 'inverseText', backgroundColor: 'subtle' }),
    ])
  }

  function notice(message, color = 'inactive', action = null) {
    return Box({
      flexDirection: 'column', borderStyle: 'single', borderColor: color, borderDimColor: color === 'inactive',
      paddingX: 1, children: [text(message, { bold: color !== 'inactive' }), action].filter(Boolean),
    })
  }

  function home() {
    const cards = [
      ['host', t.create, t.hostHint], ['join', t.joinByLink, t.joinHint], ['discover', t.findLan, t.findHint],
    ]
    return [Box({ flexDirection: 'column', gap: 'sm', children: cards.map(([key, title, hint]) => Box({
      flexDirection: 'column', borderStyle: 'single', borderColor: 'inactive', paddingX: 1,
      children: [button(`tab-${key}`, title, () => actions.tab(key), key === 'host'), text(hint, { dimColor: true })],
    })) })]
  }

  function playerBar() {
    const host = room.role === 'host'
    const glyphs = pieceGlyphs(ui.settings.pieces, event.surface === 'desktop')
    const { wins = 0, losses = 0 } = ui.headToHead ?? {}
    const score = text(` ${host ? wins : losses}–${host ? losses : wins} `, { bold: true, tabular: true })
    const player = (mark, person, own) => {
      const active = room.status === 'playing' && room.turn === mark
      const color = pieceColor[mark]
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

  function choices(key, label, options, current, select = edit(key)) {
    return [text(label, { dimColor: true }), actionRow(options.map(([value, title]) =>
      button(`${key}-${value}`, title, () => select(value), current === value)))]
  }

  function host() {
    return [
      text(t.chooseHost, { bold: true }),
      input('room-name', t.room, ui.roomDraft, edit('roomDraft'), actions.host, t.create),
      Select ? Select({ key: 'ruleset', label: t.rules, value: ui.ruleset,
        options: [{ value: 'freestyle', label: t.freestyle }, { value: 'vn', label: t.caro }],
        onSelect: edit('ruleset') }) : column(choices('ruleset', t.rules,
        [['freestyle', t.freestyle], ['vn', t.caro]], ui.ruleset)),
      text(ui.ruleset === 'vn' ? t.caroRule : t.freestyleRule, { dimColor: true }),
      ...choices('visibility', t.visibility, [['public', t.public], ['private', t.private]], ui.visibility),
      ui.visibility === 'private' && input('host-pin', t.pin, ui.hostPin, edit('hostPin'),
        value => actions.edit('hostPin', value)),
      ...choices('turnMs', t.turnClock, [[0, t.off], [30000, `30 ${t.seconds}`], [60000, `1 ${t.minutes}`],
        [120000, `2 ${t.minutes}`], [300000, `5 ${t.minutes}`]], ui.turnMs),
      ...choices('moveLimit', t.moveLimit, [[0, t.off], [200, '200'], [400, '400']], ui.moveLimit),
      ...choices('holdMs', t.hold, [[300000, `5 ${t.minutes}`], [1800000, `30 ${t.minutes}`],
        [7200000, `2 ${t.hours}`]], ui.holdMs),
      button('create-room', t.create, () => actions.host(ui.roomDraft), true),
    ]
  }

  function join() {
    const rooms = ui.rooms.filter(item => item.roomName.toLowerCase().includes(ui.filter.trim().toLowerCase()))
    const hint = ui.busy ? t.loading : ui.search ? t.noRooms : t.readyRooms
    return [
      (!ui.search || ui.pinLink) && input('join-link', t.link, ui.linkDraft, edit('linkDraft'), actions.join, t.join),
      actionRow([
        !ui.search && button('join-link-submit', t.join, () => actions.join(ui.linkDraft), true),
        button('discover', ui.search ? t.refresh : t.discover, actions.discover),
      ]),
      ui.pinLink && input('join-pin', t.pin, ui.joinPin, edit('joinPin'), actions.submitPin, t.join),
      ui.search && !ui.discoveryName && input('filter', t.filter, ui.filter, edit('filter'), edit('filter')),
      input('find-name', t.roomSearch, ui.nameQuery, edit('nameQuery'), actions.findByName, t.findName),
      ui.discoveryName && text(`${t.roomSearch} · ${ui.discoveryName}`, { dimColor: true }),
      ...(ui.search && rooms.length ? rooms.map(item => {
        const state = item.status === 'waiting' ? t.waiting : t.full
        const label = `${item.roomName} · ${item.hostName} · ${ruleText(item.ruleset, t)} · ${item.visibility === 'private' ? t.private : t.public} · ${state} · ${item.latencyMs} ms`
        return item.status === 'waiting' ? button(`join-${item.roomCode}-${item.address}-${item.port}`, label,
          () => actions.join(roomLinks(item.roomCode, item.address, item.port).directLink)) : text(label, { dimColor: true })
      }) : [text(hint, { dimColor: true })]),
    ]
  }

  function game() {
    if (room.status === 'waiting') return [
      notice(roomStatus(room, t)),
      text(event.surface === 'desktop' ? room.roomCode : [...room.roomCode].join(' '), { bold: true, size: 'title' }),
      text(room.visibility === 'private' ? t.private : t.public, { dimColor: true }), ...inviteButtons(),
      button('firewall-help', t.firewallTitle, () => actions.edit('firewallHelp', !ui.firewallHelp)),
      ui.firewallHelp && text(t.firewall, { dimColor: true }), ...leaveControls(t.cancel),
    ]
    const outcome = room.finished && (room.finished.winner === null ? t.draw :
      room.finished.winner === (room.role === 'host' ? room.host.playerId : room.guest.playerId) ? t.win : t.loss)
    const reason = room.finished && resultReason(room.finished.reason, t)
    const secondsLeft = room.turnEndsAt == null ? null : Math.max(0, Math.ceil((room.turnEndsAt - ui.now) / 1000))
    const canMove = room.status === 'playing' && room.connection === 'connected' &&
      room.mark === room.turn && !room.pendingMove && !ui.busy && secondsLeft !== 0
    const rows = Math.max(7, Math.min(29, (event.props.scroll?.bodyRows || 23) - 5))
    const contents = boardProps(room, ui.view, canMove, columns, rows, ui.settings, event.surface === 'desktop')
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
      ].filter(Boolean).join(' · '), outcome ? outcome === t.win ? 'success' : outcome === t.loss ? 'error' : 'warning' : statusColor(room)),
      room.moveLimit > 0 && text(`${t.moveLimit} · ${room.moveLimit}`, { dimColor: true }),
      text(`${t.move} ${room.boardVersion}`, { dimColor: true, tabular: true }),
      contents.cropped ? text(t.boardCropped, { color: 'warning', bold: true }) :
        canMove && text(t.boardPlace, { dimColor: true }),
      Client({
        key: 'board', module: '../games/gomoku/board.client.tsx', width: '100%', height: contents.lines,
        props: contents,
      }),
      ...(room.status === 'playing' && room.connection === 'connected' ? gameActions(room, myId) : []),
      room.status === 'finished' && (voted ? text(`${t.waitingVote} · ${room.role === 'host' ? room.guest.name : room.host.name}`) :
        room.connection === 'connected' && button('rematch', t.rematch, () => actions.action('rematch'), true)),
      canClaim && notice(t.holdExpired, 'warning', actionRow([
        button('extend-hold', t.wait, () => actions.action('extend')),
        button('claim-win', t.claim, () => actions.action('claim'), true),
      ])),
      ...leaveControls(t.leave),
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

  function inviteButtons() {
    return [
      actionRow([
        button('copy-link', t.copy, e => actions.copy(room.link, e.surface), true),
        room.directLink && button('copy-direct', t.copyDirect, e => actions.copy(room.directLink, e.surface)),
        ...(room.directLinks ?? []).filter(item => item.link !== room.directLink).map(item =>
          button(`copy-${item.address}`, `${t.copy} · ${item.address}`, e => actions.copy(item.link, e.surface))),
      ]),
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
    return [
      input('player-name', t.name, ui.nameDraft, edit('nameDraft'), actions.saveName),
      button('save-player-name', t.save, () => actions.saveName(ui.nameDraft)),
      text(t.language, { bold: true }),
      actionRow([['auto', t.system], ['en', 'English'], ['vi', 'Tiếng Việt']]
        .map(([value, label]) => button(`language-${value}`, label, () => actions.setting('language', value),
          current.preference === value))),
      text(t.sounds, { bold: true }),
      actionRow([true, false].map(value => button(`sounds-${value}`, value ? t.on : t.off,
        () => actions.setting('sounds', value), current.sounds === value))),
      Select ? Select({ key: 'notifications', label: t.notifications, value: current.notifications,
        options: ['toast', 'sound', 'band', 'off'].map(value => ({ value, label: t[value] })),
        onSelect: value => actions.setting('notifications', value) }) : column(choices('notification', t.notifications,
        ['toast', 'sound', 'band', 'off'].map(value => [value, t[value]]), current.notifications,
        value => actions.setting('notifications', value))),
      section(t.display, [
        ...choices('board', t.board, [['grid', t.grid], ['dots', t.dots]], current.board,
          value => actions.setting('board', value)),
        ...choices('pieces', t.pieces, [['xo', event.surface === 'desktop' ? '✕ / ○' : 'X / O'], ['oo', '● / ○'], ['pixel', '■ / □']], current.pieces,
          value => actions.setting('pieces', value)),
        event.surface === 'terminal' && text(t.glyphHint, { dimColor: true }),
      ]),
      button('toggle-advanced', `${ui.advanced ? '▾' : '▸'} ${t.advanced}`, () => actions.edit('advanced', !ui.advanced)),
      ...(ui.advanced ? [
        input('udp-port', t.udpPort, ui.portDraft, edit('portDraft'), value => actions.setting('udpPort', value)),
        input('node-path', t.nodePath, ui.nodeDraft, edit('nodeDraft'), value => actions.setting('nodePath', value)),
        ...choices('allowTailscale', t.tailscale, [[false, t.off], [true, t.on]], current.allowTailscale,
          value => actions.setting('allowTailscale', value)),
        ...choices('allowIpv6Ula', t.ula, [[false, t.off], [true, t.on]], current.allowIpv6Ula,
          value => actions.setting('allowIpv6Ula', value)),
        text(t.restartToApply, { dimColor: true }),
      ] : []),
    ]
  }
}

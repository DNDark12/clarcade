import { createDaemonClient } from './daemon-client.js'
import { LEGACY_BOARD_SIZE, validCoordinate } from '../games/gomoku/rules.js'
import { defaultName } from './identity.ts'
import { errorText, languageOf, resultReason, words } from './i18n.ts'
import { parseLink, roomLinks } from './link.js'
import { lobby, roomStatus, scoreLine } from './lobby.tsx'
import { statusColor } from './ui/tokens.ts'
import { readSettings, saveSettings, validName } from './settings.ts'
import { autoUpdate, updatePlugin } from './update.js'

const PANE = 'clarcade'
// The first automatic check waits until the session has settled, with some
// spread so threads opened together do not all run the CLI at once.
const AUTO_UPDATE_DELAY_MS = 5000
const AUTO_UPDATE_SPREAD_MS = 10000

function updateText(result, t) {
  switch (result?.status) {
    case 'not-installed': return t.updateNotInstalled
    case 'no-cli': return t.updateNoCli.replace('{detail}', result.detail || '-')
    case 'failed': return t.updateFailed.replace('{step}', result.step).replace('{code}', String(result.code))
      .replace('{detail}', result.detail || '-')
    case 'current': return t.updateCurrent.replace('{version}', result.version)
    case 'updated': return t.updateDone.replace('{from}', result.from).replace('{to}', result.to)
    default: return t.retry
  }
}
const ART = { joined: 'turn', turn: 'turn', finished: 'win', rematch: 'turn' }
const HOST_DEFAULTS = {
  holdMs: 1800000, ruleset: 'freestyle', visibility: 'public', turnMs: 0, hostPin: '', hostAdvanced: false,
}

function createController(options) {
  const ui = {
    tab: 'home', settings: { language: 'en', playerName: '' },
    nameDraft: '', roomDraft: '', joinDraft: '', portDraft: '', nodeDraft: '',
    room: null, rooms: null, roomsAt: null, scanning: false, scanRequested: false, roomSearchError: '', busy: false, notice: '', error: '',
    ...HOST_DEFAULTS, joinPin: '', pinLink: null, discoveryName: '', selectedOpponent: null,
    copyFallback: '', inviteAddress: null as string | null, confirm: null, view: null, advanced: false, network: false, firewallHelp: false,
    stats: null, now: 0, surface: null, visible: false, helperDown: false, nodeMissing: false,
  }
  let setup
  let client
  let lastAlert
  let version
  let pendingJoin
  let refreshJob
  let statsJob: Promise<void> | undefined
  let statsPending = false
  let scanJob: { roomName: string; promise?: Promise<void> } | undefined
  let elapsed = 0
  let discoveryElapsed = 0
  const t = () => words(ui.settings.language)
  const draw = api => api.ui.invalidate('ui.render')

  function load(api) {
    setup ??= (async () => {
      ui.settings = await readSettings(api, options)
      ui.nameDraft = ui.settings.playerName || await defaultName(api)
      ui.portDraft = String(ui.settings.udpPort)
      ui.nodeDraft = ui.settings.nodePath
      client = createDaemonClient(api, ui.settings)
    })().catch(error => {
      setup = undefined
      throw error
    })
    return setup
  }

  async function fetch(api, path, body) {
    await load(api)
    const response = await client.request(path, body)
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error(response.body?.reason ?? 'daemon-unavailable'),
        { reason: response.body?.reason ?? 'daemon-unavailable' })
    }
    return response.body
  }

  async function focus(api) {
    if (!api.process?.run) return
    try { await fetch(api, '/focus', {}) } catch { /* Idle helper starts only on discovery, host, or join. */ }
  }

  function status(api) {
    api.ui.status(ui.surface !== 'desktop' && ui.room && ui.settings.notifications !== 'off' ?
      `${t().title} · ${scoreLine(ui.room, t())}` : undefined)
  }

  function refresh(api, afterWrite = false) {
    if (!api.process?.run) return Promise.resolve()
    if (refreshJob) return afterWrite ? refreshJob.then(() => refresh(api)) : refreshJob
    refreshJob = (async () => {
      const now = await api.clock.now()
      const wasExpired = ui.room?.disconnectedAt && ui.now - ui.room.disconnectedAt >= ui.room.holdMs
      ui.now = now
      if ((!wasExpired && ui.room?.disconnectedAt && now - ui.room.disconnectedAt >= ui.room.holdMs) ||
          (ui.visible && (ui.room?.turnEndsAt ||
            (ui.room?.status === 'playing' && ui.room.disconnectedAt)))) draw(api)
      try {
        const snapshot = await fetch(api, `/state${version ? `?v=${encodeURIComponent(version)}` : ''}`)
        if (ui.nodeMissing) {
          ui.nodeMissing = false
          draw(api)
        }
        if (!snapshot) return
        const previous = ui.room
        const latest = snapshot.room && { boardSize: LEGACY_BOARD_SIZE, ...snapshot.room }
        version = snapshot.version
        ui.helperDown = false
        ui.room = latest
        if (previous?.roomCode !== latest?.roomCode) {
          ui.tab = latest ? 'game' : 'home'
          ui.confirm = null
          ui.copyFallback = ''
          ui.inviteAddress = null
          ui.firewallHelp = false
          if (!latest) Object.assign(ui, HOST_DEFAULTS)
        }
        if (previous?.gameId !== latest?.gameId) ui.view = null
        const previousOpponent = previous?.role === 'host' ? previous.guest : previous?.host
        const opponent = latest?.role === 'host' ? latest.guest : latest?.host
        const opponentChanged = previousOpponent?.playerId !== opponent?.playerId
        status(api)
        draw(api)
        // The board must follow the room snapshot even while the stats request is pending.
        if (opponentChanged || previous?.status !== latest?.status || latest?.status === 'finished' || ui.tab === 'stats') {
          void updateStats(api).catch(() => {})
        }
        for (const event of snapshot.notifications ?? []) {
          if (event.id === lastAlert || (!ART[event.event] && event.event !== 'action-rejected')) continue
          const sequence = event.id.split(':')
          const last = lastAlert?.split(':')
          if (last?.[0] === sequence[0] && Number(last[1]) >= Number(sequence[1])) continue
          lastAlert = event.id
          if (event.event === 'action-rejected') invalid(api, t().invalidAction)
          else announce(api, event.event)
        }
      } catch (error) {
        version = undefined
        if (error.reason === 'node-missing' && !ui.nodeMissing) {
          ui.nodeMissing = true
          draw(api)
        }
        if (ui.room && !ui.helperDown) {
          ui.helperDown = true
          ui.room = { ...ui.room, connection: 'reconnecting' }
          status(api)
          draw(api)
        }
      }
    })().finally(() => { refreshJob = undefined })
    return refreshJob
  }

  function announce(api, event) {
    const mode = ui.settings.notifications
    if (mode === 'off' || mode === 'band') return
    const dictionary = t()
    const room = ui.room
    const finished = room?.finished
    const player = room?.role === 'host' ? room.host : room?.guest
    const opponent = room?.role === 'host' ? room.guest : room?.host
    const outcome = finished && (finished.winner === null ? dictionary.draw :
      finished.winner === player?.playerId ? dictionary.win : dictionary.loss)
    const reason = finished && resultReason(finished.reason, dictionary)
    const message = {
      joined: opponent ? `${opponent.name} · ${dictionary.joined}` : dictionary.joined,
      turn: dictionary.yours,
      finished: outcome ? [outcome, reason].filter(Boolean).join(' · ') : dictionary.finished,
    }
    if (!ui.visible && message[event]) api.ui.toast(`${dictionary.title} · ${message[event]}`)
    if (ui.settings.sounds && (mode === 'sound' || event === 'finished')) play(api, ART[event])
  }

  function play(api, clip) {
    if (ui.settings.sounds) void api.audio.play({ asset: `sounds/${clip}.wav` }).catch(() => {})
  }

  function updateStats(api) {
    statsPending = true
    statsJob ??= (async () => {
      try {
        do {
          statsPending = false
          try { ui.stats = await fetch(api, '/stats') } catch { ui.stats = null }
          status(api)
          draw(api)
        } while (statsPending)
      } finally {
        statsJob = undefined
      }
    })()
    return statsJob
  }

  function discover(api, joinIfUnique = false) {
    const roomName = ui.discoveryName
    if (!joinIfUnique && scanJob?.roomName === roomName && scanJob.promise) return scanJob.promise
    const scan: NonNullable<typeof scanJob> = { roomName }
    scanJob = scan
    const active = () => scanJob === scan && ['join', 'home'].includes(ui.tab) && !ui.pinLink && !ui.room
    ui.scanning = true
    // The automatic scan every few seconds stays quiet; only the first one and
    // a scan the person asked for show that a scan is running.
    if (ui.scanRequested || !ui.roomsAt) draw(api)
    scan.promise = (async () => {
      try {
        const query = roomName ? `?name=${encodeURIComponent(roomName)}` : ''
        const { rooms } = await fetch(api, `/rooms${query}`)
        if (!active()) return
        ui.rooms = rooms
        ui.roomsAt = await api.clock.now()
        ui.roomSearchError = ''
        // Your record against each host comes from your statistics.
        if (rooms.length && !ui.stats) await updateStats(api)
        if (joinIfUnique && rooms.length === 1 && rooms[0].status === 'waiting') {
          const item = rooms[0]
          await join(api, roomLinks(item.roomCode, item.address, item.port).directLink)
        }
      } catch (error) {
        if (!active()) return
        ui.roomSearchError = errorText(error.reason ?? 'daemon-unavailable', t())
      }
      draw(api)
    })().finally(() => {
      if (scanJob === scan) {
        scanJob = undefined
        ui.scanning = false
        ui.scanRequested = false
        draw(api)
      }
    })
    return scan.promise
  }

  function findTarget(api, value: string) {
    const target = value.trim()
    ui.tab = 'join'
    ui.joinDraft = target
    scanJob = undefined
    if (parseLink(target)) return join(api, target)
    if (/^clarcade:/i.test(target)) return invalid(api, t().invalidLink)
    if (target && !validName(target)) return invalid(api, t().badName)
    ui.error = ''
    ui.notice = ''
    ui.discoveryName = target
    ui.rooms = null
    ui.roomSearchError = ''
    draw(api)
    return discover(api, Boolean(target))
  }

  async function tick(api) {
    elapsed++
    const panes = await api.ui.panes().catch(() => [])
    const pane = panes?.find(item => item.id === PANE)
    const shown = pane ? pane.isShown : ui.visible
    if (shown || elapsed % 3 === 0) await refresh(api)
    // Rooms are found automatically every few seconds while Home or Join is on screen.
    if (shown && ['join', 'home'].includes(ui.tab) && ui.settings.playerName && !ui.pinLink && !ui.room && !ui.busy &&
        ++discoveryElapsed % 2 === 0) {
      await discover(api)
    }
  }

  async function run(api, operation) {
    if (ui.busy) return
    ui.busy = true
    ui.error = ''
    ui.notice = ''
    draw(api)
    try {
      await operation()
    } catch (error) {
      ui.error = errorText(error.reason ?? 'daemon-unavailable', t())
    } finally {
      ui.busy = false
      draw(api)
    }
  }

  function invalid(api, message) {
    ui.error = message
    draw(api)
  }

  function join(api, link, pin) {
    if (!parseLink(link)) return invalid(api, t().invalidLink)
    const target = link.trim()
    ui.tab = 'join'
    if (ui.pinLink !== target) {
      ui.pinLink = null
      ui.joinPin = ''
    }
    if (pin !== undefined && !/^[0-9]{4,6}$/.test(pin)) return invalid(api, t().pin)
    if (!ui.settings.playerName) {
      pendingJoin = target
      ui.tab = 'join'
      draw(api)
      return
    }
    return run(api, async () => {
      try {
        await fetch(api, '/join', { link: target, name: ui.settings.playerName, ...(pin !== undefined && { pin }) })
      } catch (error) {
        if (['pin-required', 'wrong-pin', 'pin-rate-limit'].includes(error.reason)) ui.pinLink = target
        else ui.pinLink = null
        throw error
      } finally {
        ui.joinPin = ''
      }
      ui.pinLink = null
      await refresh(api, true)
    })
  }

  async function open(api) {
    await load(api)
    const result = await api.ui.open({ id: PANE, title: 'Clarcade', focus: true })
    ui.visible = result.isPlaced
    await focus(api)
    await refresh(api)
    return result
  }

  function actions(api) {
    return {
      edit(key, value) { ui[key] = value; draw(api) },
      async tab(key) {
        ui.tab = key
        ui.confirm = null
        if (key === 'join') {
          ui.pinLink = null
          ui.joinPin = ''
          return findTarget(api, '')
        }
        ui.error = ''
        ui.notice = ''
        draw(api)
        await focus(api)
        if (key === 'stats') await this.stats()
      },
      async saveName(value) {
        if (!validName(value)) return invalid(api, t().badName)
        const playerName = value.trim()
        await saveSettings(api, { playerName }, options)
        ui.settings.playerName = playerName
        ui.nameDraft = playerName
        ui.error = ''
        draw(api)
        if (pendingJoin) {
          const link = pendingJoin
          pendingJoin = undefined
          await join(api, link)
        }
      },
      host(value) {
        if (!validName(value)) return invalid(api, t().badName)
        const roomName = value.trim()
        if (ui.visibility === 'private' && !/^[0-9]{4,6}$/.test(ui.hostPin)) return invalid(api, t().pin)
        return run(api, async () => {
          await fetch(api, '/host', {
            roomName, name: ui.settings.playerName, holdMs: ui.holdMs,
            ruleset: ui.ruleset, visibility: ui.visibility, turnMs: ui.turnMs,
            ...(ui.visibility === 'private' && { pin: ui.hostPin }),
          })
          ui.hostPin = ''
          await refresh(api, true)
        })
      },
      join(link) { return join(api, link) },
      submitPin(pin) { if (ui.pinLink) return join(api, ui.pinLink, pin) },
      findTarget(value) { return findTarget(api, value) },
      recover() {
        return run(api, async () => {
          await client.start({ retryNode: true })
          ui.nodeMissing = false
          await focus(api)
          await refresh(api, true)
        })
      },
      async copy(link, surface) {
        if (!link) return
        await focus(api)
        let copied = false
        try { copied = (await api.ui.copy({ text: link, surface })).isCopied } catch { /* Show the link. */ }
        ui.copyFallback = copied ? '' : link
        ui.notice = copied ? t().copied : ''
        draw(api)
      },
      action(action, details = {}) {
        if (!ui.room) return
        return run(api, async () => {
          const { gameId, moveEpoch, boardVersion } = ui.room
          await fetch(api, '/action', { action, gameId, moveEpoch, boardVersion, ...details })
          ui.confirm = null
          await refresh(api, true)
        })
      },
      stats() { return updateStats(api) },
      // A scan the person asked for starts afresh instead of joining one already running.
      scan() {
        scanJob = undefined
        ui.scanRequested = true
        return discover(api)
      },
      update() {
        return run(api, async () => {
          ui.notice = updateText(await updatePlugin(api), t())
        })
      },
      async setting(key, value) {
        const patch = {}
        if (key === 'language') {
          patch.language = value
        } else if (key === 'udpPort') {
          const port = Number(value)
          if (!Number.isInteger(port) || port < 1 || port > 65535) return invalid(api, t().invalidPort)
          patch.udpPort = port
          ui.portDraft = String(port)
        } else if (key === 'nodePath') {
          const path = value.trim()
          if (path && !path.startsWith('/')) return invalid(api, t().invalidPath)
          patch.nodePath = path
          ui.nodeDraft = path
        } else patch[key] = value
        await saveSettings(api, patch, options)
        if (key === 'language') {
          ui.settings.preference = value
          ui.settings.language = languageOf(value, ui.settings.locale)
        } else ui.settings[key] = patch[key]
        if (['nodePath', 'udpPort', 'allowTailscale', 'allowIpv6Ula'].includes(key)) {
          client = createDaemonClient(api, ui.settings)
          if (key === 'nodePath') ui.nodeMissing = false
          // The new client relocates the daemon, which restarts it with these settings when no room is open.
          await refresh(api, true)
          ui.notice = t().restartToApply
        }
        ui.error = ''
        status(api)
        draw(api)
      },
    }
  }

  // A daily check that installs a newer version by itself, unless the person
  // turned it off or a game is being played.
  async function automaticUpdate(api) {
    if (ui.settings.autoUpdate === false) return
    const result = await autoUpdate(api, { busy: () => ui.room?.status === 'playing' })
    if (result?.status === 'updated') api.ui.toast(`Caro · ${updateText(result, t())}`)
  }

  return { ui, t, draw, load, focus, refresh, tick, open, findTarget, invalid, actions, run, fetch, play, automaticUpdate }
}

function capabilities($) {
  return {
    plugin: { root: $.plugin.root },
    session: { id: () => $.session.id() },
    registerCommand: () => $.command.register({
      name: 'clarcade', description: 'Open Clarcade, join with a Clarcade invitation, or update Clarcade',
      argumentHint: 'join <link|room name> | update', immediate: true,
    }),
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
    process: { run: (argv, init) => $.process.run(argv, init) },
    http: { fetch: (url, init) => $.http.fetch(url, init) },
    // Reads for the updater: the installed plugins list and the CLI's path.
    fs: { read: path => $.fs.read(path), stat: (path, init) => $.fs.stat(path, init) },
    env: {
      get(key) {
        if (key === 'CLAUDE_CONFIG_DIR') return $.env.get('CLAUDE_CONFIG_DIR')
        if (key === 'LC_ALL') return $.env.get('LC_ALL')
        if (key === 'LC_MESSAGES') return $.env.get('LC_MESSAGES')
        if (key === 'HOME') return $.env.get('HOME')
        if (key === 'CLAUDE_CODE_EXECPATH') return $.env.get('CLAUDE_CODE_EXECPATH')
        if (key === 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC') return $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
        return $.env.get('LANG')
      },
    },
    clock: {
      now: () => $.clock.now(),
      after: (ms, callback) => $.clock.after(ms, callback),
      every: (ms, callback) => $.clock.every(ms, callback),
    },
    audio: { play: clip => $.audio.play(clip) },
    ui: {
      invalidate: () => $.ui.invalidate('ui.render'),
      status: text => $.ui.status(text),
      toast: text => $.ui.toast(text),
      panes: () => $.ui.panes(),
      open: request => $.ui.open(request),
      copy: request => $.ui.copy(request),
    },
  }
}

export function register(on, options = {}) {
  const controller = createController(options)
  const { ui, t, draw, load, focus, refresh, tick, open, findTarget, invalid, actions, run, fetch, play,
    automaticUpdate } = controller
  let timer
  let booted
  let updateScheduled = false
  let attached
  let resumeQueued = false

  function boot(api) {
    booted ??= (async () => {
      await api.registerCommand()
      await load(api)
      void refresh(api)
    })().catch(error => {
      booted = undefined
      throw error
    })
    return booted
  }

  function watch(api) {
    timer ??= api.clock.every(1000, () => { void tick(api).catch(() => {}) })
  }

  function resume(api) {
    if (booted || resumeQueued) return
    resumeQueued = true
    // The widget can be the first thing rendered when an already-open thread reloads the mod.
    api.clock.after(1, () => {
      void boot(api).then(() => {
        draw(api)
        watch(api)
      }).catch(() => {}).finally(() => { resumeQueued = false })
    })
  }

  // Once per session, a little after it starts or Desktop attaches to it.
  function scheduleUpdate(api) {
    if (updateScheduled) return
    updateScheduled = true
    api.clock.after(AUTO_UPDATE_DELAY_MS + Math.floor(Math.random() * AUTO_UPDATE_SPREAD_MS),
      () => { void automaticUpdate(api).catch(() => {}) })
  }

  on('session.start', async ($, event, next) => {
    const started = await next(event)
    ui.surface = event.surface ?? ui.surface
    if (event.isInteractive !== false || event.surface === 'desktop') {
      await boot(capabilities($))
      watch(capabilities($))
      scheduleUpdate(capabilities($))
    }
    return started
  })

  on('session.attach', async ($, event, next) => {
    const result = await next(event)
    attached = event.surface
    ui.surface = event.surface
    if (event.surface === 'desktop') {
      await $.ui.status(undefined)
      await boot(capabilities($))
      watch(capabilities($))
      // Desktop starts its sessions as SDK sessions, so the update check is
      // scheduled here rather than at session.start.
      scheduleUpdate(capabilities($))
    }
    if (event.surface === 'desktop' || event.surface === 'terminal') void focus(capabilities($))
    return result
  })

  on('command.run', { command: 'clarcade' }, async ($, event) => {
    const args = event.args.trim()
    if (/^update$/i.test(args)) {
      const api = capabilities($)
      await load(api)
      return { text: updateText(await updatePlugin(api), t()), isTextDisplayOnly: true }
    }
    const match = /^join\s+(.+)$/i.exec(args)
    if (args && !match) return { text: t().useJoin, isTextDisplayOnly: true }
    const opened = await open(capabilities($))
    watch(capabilities($))
    if (match && attached !== 'vscode' && attached !== 'mobile') {
      const api = capabilities($)
      await findTarget(api, match[1])
    }
    if (!opened.isPlaced) return { text: t().fallback, isTextDisplayOnly: true }
    return {}
  }).catch(() => ({ text: t().unavailable, isTextDisplayOnly: true }))

  on('prompt.submit', async ($, event, next) => {
    const desktopInput = attached === 'desktop' && ['sdk', 'unclassified'].includes(event.origin?.kind)
    if (event.command || event.isMeta || event.attachments?.length || !parseLink(event.text) ||
        (!desktopInput && event.origin?.kind !== 'composer') || attached === 'vscode' || attached === 'mobile') return next(event)
    try {
      await open(capabilities($))
      watch(capabilities($))
      await findTarget(capabilities($), event.text)
    } catch { invalid(capabilities($), t().unavailable) }
    return { drop: t().connecting }
  })

  on('ui.close', { id: 'clarcade' }, async ($, event, next) => {
    const result = await next(event)
    ui.visible = false
    return result
  }).catch(() => undefined)

  on('ui.render', { component: 'Pane', requestId: 'clarcade' }, ($, event) => {
    ui.surface ??= event.surface
    if (event.surface === 'terminal' || event.surface === 'desktop') {
      ui.visible = true
      resume(capabilities($))
    }
    return lobby($.ui.resolve(event), event, ui, actions(capabilities($)), t())
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, event, next) => {
    ui.surface ??= event.surface
    if (event.surface === 'terminal' || event.surface === 'desktop') resume(capabilities($))
    if (!ui.room || ui.settings.notifications === 'off' || event.props.hasSurvey) return next(event)
    const { Box, Text, Button } = $.ui.resolve(event)
    const dictionary = t()
    const title = Text({ children: [
      `${dictionary.title} · ${ui.room.roomName} · `,
      Text({ children: '●', color: statusColor(ui.room) }),
      ` ${roomStatus(ui.room, dictionary)}`,
    ] })
    if (!Button) return title
    return Box({ flexDirection: 'row', children: [
      title, Button({ key: 'clarcade-open', label: t().open, onPress: () => open(capabilities($)) }),
    ] })
  })

  on('ui.message', { component: 'Pane', requestId: 'clarcade', element: 'board' }, async ($, event, next) => {
    const data = event.data
    const room = ui.room
    if (!data || !room || data.gameId !== room.gameId || !['view', 'move'].includes(data.kind) ||
        ![data.x, data.y, data.left, data.top].every(Number.isInteger)) return next(event)
    ui.view = { gameId: data.gameId, x: data.x, y: data.y, left: data.left, top: data.top,
      boardVersion: data.boardVersion, moveEpoch: data.moveEpoch }
    if (data.kind === 'view') {
      void focus(capabilities($))
      return {}
    }
    if (room.status === 'playing' && room.connection === 'connected' && room.turn === room.mark &&
        !room.pendingMove && validCoordinate(data.x, room.boardSize) && validCoordinate(data.y, room.boardSize)) {
      await run(capabilities($), async () => {
        const { gameId, boardVersion, moveEpoch = 0 } = room
        if (data.boardVersion !== boardVersion || data.moveEpoch !== moveEpoch) return
        await fetch(capabilities($), '/move', { gameId, moveNo: boardVersion + 1, moveEpoch, x: data.x, y: data.y })
        play(capabilities($), 'move')
        await refresh(capabilities($), true)
      })
    }
    return {}
  })
}

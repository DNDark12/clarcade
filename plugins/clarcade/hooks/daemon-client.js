const START_ROUTES = new Set(['/host', '/join', '/rooms'])
const NODE_RETRY_MS = 60000
const ROUTES = new Set(['/health', '/me', '/state', '/rooms', '/stats',
  '/focus', '/host', '/join', '/move', '/action'])

export function createDaemonClient($, { nodePath, udpPort, allowTailscale, allowIpv6Ula } = {}) {
  let node
  let socketPath
  let starting
  let missingUntil = 0

  async function executable() {
    if (nodePath) {
      if (!nodePath.startsWith('/')) throw new Error('Clarcade nodePath must be absolute')
      return nodePath
    }
    const now = () => $.clock?.now() ?? Date.now()
    if (missingUntil && await now() < missingUntil) throw missingNode()
    node ??= $.process.run(['/bin/sh', '-c', 'command -v node'], { timeoutMs: 3000 })
      .then(async result => {
        if (result.exitCode === 0 && result.stdout.trim().startsWith('/')) return result
        return $.process.run(['/bin/zsh', '-lc', 'command -v node'], { timeoutMs: 3000 })
      }).then(result => {
        const path = result.stdout.trim()
        if (result.exitCode !== 0 || !path.startsWith('/')) throw missingNode()
        return path
      }).catch(async () => {
        missingUntil = (await now()) + NODE_RETRY_MS
        node = undefined
        throw missingNode()
      })
    return node
  }

  async function locate(start) {
    const profile = await $.env.get('CLAUDE_CONFIG_DIR')
    const args = [await executable(), `${$.plugin.root}/helper/launch.mjs`]
    if (udpPort !== undefined) args.push('--udp-port', String(udpPort))
    if (allowTailscale) args.push('--allow-tailscale')
    if (allowIpv6Ula) args.push('--allow-ipv6-ula')
    if (!start) args.push('--locate')
    const result = await $.process.run(args, {
      timeoutMs: 7000, ...(profile && { env: { CLAUDE_CONFIG_DIR: profile } }),
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Clarcade helper failed')
    const endpoint = JSON.parse(result.stdout)
    if (typeof endpoint.socketPath !== 'string' || !endpoint.socketPath.startsWith('/')) {
      throw new Error('Clarcade helper returned an invalid socket path')
    }
    socketPath = endpoint.socketPath
    return endpoint
  }

  function start({ retryNode = false } = {}) {
    if (retryNode) missingUntil = 0
    starting ??= locate(true).finally(() => { starting = undefined })
    return starting
  }

  return {
    start,
    async request(path, body) {
      const route = path.split('?')[0]
      if (!ROUTES.has(route)) throw new Error('Unknown Clarcade daemon route')
      if (START_ROUTES.has(route)) await start()
      else if (!socketPath) await locate(false)
      const response = await $.http.fetch(`http://clarcade${path}`, {
        socketPath, method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-clarcade-thread': await $.session.id(), 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
      let payload = null
      if (response.text) {
        try { payload = JSON.parse(response.text) } catch {
          return { status: response.status, body: { ok: false, reason: 'daemon-unavailable' } }
        }
      }
      return { status: response.status, body: payload }
    },
  }
}

function missingNode() {
  return Object.assign(new Error('Clarcade could not find Node'), { reason: 'node-missing' })
}

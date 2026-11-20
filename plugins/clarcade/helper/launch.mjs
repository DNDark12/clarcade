import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { VERSION, health, networkKey, olderVersion, runtime } from './runtime.mjs'

const LOCK_WRAPPER = String.raw`
use strict;
use warnings;
use Errno qw(EWOULDBLOCK EAGAIN);
use Fcntl qw(:flock F_SETFD);
umask 0077;
open my $lock, ">>", shift @ARGV or die "daemon lock: $!";
if (!flock($lock, LOCK_EX | LOCK_NB)) {
  exit 75 if $! == EWOULDBLOCK || $! == EAGAIN;
  die "daemon flock: $!";
}
fcntl($lock, F_SETFD, 0) or die "daemon lock descriptor: $!";
push @ARGV, "--lock-fd", fileno($lock);
exec {$ARGV[0]} @ARGV or die "daemon exec: $!";
`

async function launch(args, start = true) {
  const options = runtime(args, start)
  const current = await health(options.socketPath)
  if (current) {
    if (!outdated(current, options)) return { ...current, socketPath: options.socketPath }
    await stop(current.pid)
  } else if (!start) {
    return { socketPath: options.socketPath }
  }

  const script = fileURLToPath(new URL('./daemon.mjs', import.meta.url))
  const log = openSync(join(options.directory, 'daemon.log'), 'a', 0o600)
  let child
  try {
    child = spawn('/usr/bin/perl', ['-e', LOCK_WRAPPER, options.lockPath, process.execPath, script, ...args], {
      detached: true, stdio: ['ignore', 'ignore', log],
    })
  } finally {
    closeSync(log)
  }
  child.unref()
  let failure
  child.on('error', error => { failure = error })
  child.on('exit', (code, signal) => {
    if (code !== 75) failure = new Error(`Daemon exited (${code ?? signal}). Check daemon.log.`)
  })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const ready = await health(options.socketPath)
    if (ready) return { ...ready, socketPath: options.socketPath }
    if (failure) throw failure
    await delay(100)
  }
  throw new Error('Daemon did not become ready within 5 seconds. Check daemon.log.')
}

// Replace a daemon from an older plugin version at once. Network settings only take effect
// when no room is open, so a settings change never drops a game in progress.
function outdated(current, options) {
  return olderVersion(current.version, VERSION) ||
    (current.network !== networkKey(options) && current.room === false)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function stop(pid) {
  for (const [signal, wait] of [['SIGTERM', 3000], ['SIGKILL', 1000]]) {
    if (!alive(pid)) return
    process.kill(pid, signal)
    const deadline = Date.now() + wait
    while (alive(pid) && Date.now() < deadline) await delay(25)
  }
  if (alive(pid)) throw new Error(`Daemon ${pid} did not stop. Check daemon.log.`)
}

try {
  const args = process.argv.slice(2)
  const locate = args.at(-1) === '--locate'
  const result = await launch(locate ? args.slice(0, -1) : args, !locate)
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(`[clarcade] ${error.message}`)
  process.exitCode = 1
}

import { validName } from './settings.ts'

export async function defaultName($) {
  try {
    const result = await $.process.run(['/usr/bin/id', '-F'], { timeoutMs: 1500 })
    const name = result.stdout.trim().slice(0, 32)
    if (result.exitCode === 0 && validName(name)) return name
  } catch { /* id -F is specific to macOS */ }
  const id = (await $.session.id()).replace(/[^a-z0-9]/gi, '')
  return `Player-${id.slice(-4).toUpperCase().padStart(4, '0')}`
}

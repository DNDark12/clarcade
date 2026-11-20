import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const WINDOW_MS = 60000
export const validPin = value => typeof value === 'string' && /^[0-9]{4,6}$/.test(value)

export function createPin(pin) {
  const salt = randomBytes(16).toString('hex')
  return { salt, digest: digest(pin, salt).toString('hex') }
}

export function checkPin(secret, pin, previous, now) {
  const count = previous?.count ?? 0
  if (count >= 10) return { reason: 'pin-blocked' }
  if (pin === undefined || pin === '') return { reason: 'pin-required' }

  const recent = (previous?.recent ?? []).filter(time => now - time < WINDOW_MS)
  if (recent.length >= 5) return { reason: 'pin-rate-limit' }
  if (validPin(pin) && timingSafeEqual(digest(pin, secret.salt), Buffer.from(secret.digest, 'hex'))) {
    return {}
  }

  return {
    reason: count + 1 === 10 ? 'pin-blocked' : 'wrong-pin',
    attempt: { count: count + 1, recent: [...recent, now] },
  }
}

function digest(pin, salt) {
  return scryptSync(pin, Buffer.from(salt, 'hex'), 32)
}

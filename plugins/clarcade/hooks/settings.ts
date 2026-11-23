import { languageOf } from './i18n.ts'

export const validName = value => typeof value === 'string' &&
  value.trim().length >= 1 && value.trim().length <= 32 && !/[\u0000-\u001f\u007f]/u.test(value.trim())

const optionKey = key => key === 'playerName' ? 'nickname' : key

export async function readSettings($, options) {
  const saved = await $.store.get('settings') ?? {}
  const value = (key, fallback) => {
    const configured = options[optionKey(key)] ?? null
    const baseline = Object.hasOwn(saved.configured ?? {}, key) ? saved.configured[key] : configured
    return baseline === configured && saved[key] !== undefined ? saved[key] : configured ?? fallback
  }
  const locale = await $.env.get('LC_ALL') || await $.env.get('LC_MESSAGES') || await $.env.get('LANG')
    || Intl.DateTimeFormat().resolvedOptions().locale
  // The manifest lists no `options` (older Claude Code rejects the key), so a
  // typed value outside the known choices falls back to the default here.
  const choice = (key, fallback, allowed) => allowed.includes(value(key, fallback)) ? value(key, fallback) : fallback
  const language = choice('language', 'auto', ['auto', 'en', 'vi'])
  const nickname = value('playerName', '')
  return {
    preference: language,
    language: languageOf(language, locale),
    locale,
    sounds: value('sounds', true),
    notifications: choice('notifications', 'band', ['band', 'toast', 'sound', 'off']),
    playerName: validName(nickname) ? nickname.trim() : '',
    udpPort: value('udpPort', 47979),
    nodePath: value('nodePath', ''),
    board: choice('board', 'grid', ['grid', 'dots']),
    pieces: choice('pieces', 'xo', ['xo', 'oo', 'pixel']),
    allowTailscale: value('allowTailscale', false),
    allowIpv6Ula: value('allowIpv6Ula', false),
  }
}

export async function saveSettings($, patch, options) {
  const saved = await $.store.get('settings') ?? {}
  const configured = { ...saved.configured }
  for (const key of Object.keys(patch)) configured[key] = options[optionKey(key)] ?? null
  await $.store.set('settings', { ...saved, ...patch, configured })
}

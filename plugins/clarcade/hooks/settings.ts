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
  const language = value('language', 'auto')
  const nickname = value('playerName', '')
  return {
    preference: language,
    language: languageOf(language, locale),
    locale,
    sounds: value('sounds', true),
    notifications: value('notifications', 'band'),
    playerName: validName(nickname) ? nickname.trim() : '',
    udpPort: value('udpPort', 47979),
    nodePath: value('nodePath', ''),
    board: value('board', 'grid') === 'dots' ? 'dots' : 'grid',
    pieces: ['oo', 'pixel'].includes(value('pieces', 'xo')) ? value('pieces', 'xo') : 'xo',
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

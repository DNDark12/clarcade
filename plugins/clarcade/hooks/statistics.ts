import { resultReason, ruleText } from './i18n.ts'

export function summary(result, t) {
  return `${result.played} ${t.played} · ${result.wins} ${t.wins} · ${result.losses} ${t.losses} · ${result.draws} ${t.draws}`
}

const percent = value => `${Math.round((value ?? 0) * 100)}%`

function duration(ms) {
  const seconds = Math.round((ms ?? 0) / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function details(result, t) {
  const headToHead = Boolean(result.recent)
  const countBreakdown = (label, group) => group?.played ? `${label} · ${summary(group, t)} · ${percent(group.winRate)}` : ''
  const lines = [
    summary(result, t),
    `${t.rate} ${percent(result.winRate)} · ${t.streak} ${result.streak ?? 0} · ${t.bestStreak} ${result.bestStreak ?? 0}`,
    countBreakdown(t.freestyle, result.byRuleset?.freestyle),
    countBreakdown(t.caro, result.byRuleset?.vn),
    countBreakdown('X', result.byMark?.X),
    countBreakdown('O', result.byMark?.O),
    headToHead
      ? `${t.averageMoves} ${(result.averageMoves ?? 0).toFixed(1)} · ${t.averageTime} ${duration(result.averageDurationMs)}`
      : `${t.totalMoves} ${result.moves ?? 0} · ${t.playedTime} ${duration(result.durationMs)}`,
    `${t.fastest} ${result.fastestWinMoves ?? '—'} · ${t.longest} ${result.longestGameMoves ?? '—'}`,
  ]
  if (headToHead && result.recent.length) {
    lines.push(t.recent, ...result.recent.map(game => {
      const date = game.endedAt ? new Date(game.endedAt).toISOString().slice(0, 10) : t.unknown
      const outcome = { wins: t.outcomeWins, losses: t.outcomeLosses, draws: t.outcomeDraws }[game.outcome]
      return `${date} · ${ruleText(game.ruleset, t)} · ${outcome} · ${game.moves} ${t.totalMoves.toLowerCase()} · ${resultReason(game.reason, t) ?? t.unknown}`
    }))
  }
  if (!headToHead) {
    const top = result.mostPlayedOpponent
    lines.push(`${t.opponentsMet} ${result.opponentCount ?? 0}`)
    if (top) lines.push(`${t.mostPlayed} ${top.name ?? top.playerId.slice(0, 8)} · ${top.played} ${t.played}`)
    for (const [reason, amount] of Object.entries(result.byReason ?? {})) {
      lines.push(`${resultReason(reason, t)} · ${amount.wins} ${t.wins} · ${amount.losses} ${t.losses}`)
    }
  }
  return lines.filter(Boolean)
}

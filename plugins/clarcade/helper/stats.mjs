import { record } from './protocol.mjs'
import { readJson, writeJson } from './runtime.mjs'
import { DEFAULT_RULESET } from '../games/gomoku/rules.js'

const DECISIONS = ['resign', 'timeout', 'disconnected']

export function openStats(path) {
  let results = readJson(path, [], value => Array.isArray(value) && value.every(record))
  const ids = new Set(results.map(result => result.gameId))
  let cached
  return {
    record(result) {
      if (ids.has(result.gameId)) return
      const next = [...results, result]
      writeJson(path, next)
      results = next
      ids.add(result.gameId)
      cached = undefined
    },
    summary() {
      cached ??= summarize(results)
      return cached
    },
  }
}

function summarize(results) {
  const total = counters()
  const opponents = new Map()
  for (const result of [...results].sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))) {
    if (!opponents.has(result.opponentId)) {
      opponents.set(result.opponentId, { playerId: result.opponentId, ...counters(), recent: [] })
    }
    const opponent = opponents.get(result.opponentId)
    const outcome = result.winner === null ? 'draws' : result.winner === result.playerId ? 'wins' : 'losses'
    const mark = result.firstPlayerId ? result.firstPlayerId === result.playerId ? 'X' : 'O' : null
    const ruleset = result.ruleset === 'vn' ? 'vn' : DEFAULT_RULESET
    if (result.opponentName) opponent.name = result.opponentName
    update(total, result, outcome, ruleset, mark)
    update(opponent, result, outcome, ruleset, mark)
    opponent.recent.unshift({
      gameId: result.gameId, endedAt: result.endedAt ?? null, ruleset, winner: result.winner,
      outcome, moves: result.moves, durationMs: result.durationMs, reason: result.reason, mark,
    })
    if (opponent.recent.length > 10) opponent.recent.pop()
  }
  const list = [...opponents.values()].sort((a, b) =>
    b.played - a.played || a.playerId.localeCompare(b.playerId))
  const mostPlayed = list[0]
  return {
    total: { ...total, opponentCount: list.length, mostPlayedOpponent: mostPlayed ? {
      playerId: mostPlayed.playerId, name: mostPlayed.name, played: mostPlayed.played,
    } : null },
    opponents: list,
  }
}

function count() {
  return { played: 0, wins: 0, losses: 0, draws: 0, winRate: 0 }
}

function counters() {
  return {
    ...count(), streak: 0, bestStreak: 0, moves: 0, durationMs: 0,
    averageMoves: 0, averageDurationMs: 0, fastestWinMoves: null, longestGameMoves: null,
    byRuleset: { freestyle: count(), vn: count() },
    byMark: { X: count(), O: count() },
    byReason: Object.fromEntries(DECISIONS.map(reason => [reason, { wins: 0, losses: 0 }])),
  }
}

function countResult(counter, outcome) {
  counter.played++
  counter[outcome]++
  counter.winRate = counter.wins / counter.played
}

function update(stats, result, outcome, ruleset, mark) {
  countResult(stats, outcome)
  countResult(stats.byRuleset[ruleset], outcome)
  if (mark) countResult(stats.byMark[mark], outcome)
  stats.streak = outcome === 'wins' ? stats.streak + 1 : 0
  stats.bestStreak = Math.max(stats.bestStreak, stats.streak)
  stats.moves += result.moves
  stats.durationMs += result.durationMs
  stats.averageMoves = stats.moves / stats.played
  stats.averageDurationMs = stats.durationMs / stats.played
  if (outcome === 'wins') stats.fastestWinMoves = Math.min(stats.fastestWinMoves ?? Infinity, result.moves)
  stats.longestGameMoves = Math.max(stats.longestGameMoves ?? 0, result.moves)
  if (DECISIONS.includes(result.reason) && outcome !== 'draws') stats.byReason[result.reason][outcome]++
}

/**
 * The focus timer behind ado-companion's /focus routes: focus blocks, breaks, and a
 * bank of break time you skipped. Pure functions over a plain state object, so the
 * companion persists it and tests drive it with a fake clock. Times are ms.
 *
 * Phases: ready → focus → due (the block ended; take or skip the break) → break →
 * ready. A skipped break's minutes go into the bank, and so do the minutes left
 * when a break ends early; taking a break can add banked minutes to it. The bank
 * has no limit and never empties.
 *
 * A running phase keeps `runningSince`; `elapsed` is the time it ran before that,
 * so a pause just folds the run into `elapsed`.
 */
export const DEFAULTS = { focusMin: 25, breakMin: 5, longBreakMin: 15, longEvery: 4, idlePauseMin: 5 }
// The review clock reports the PR it's timing every check (15 s); older than this, it's gone.
export const REVIEW_FRESH_MS = 60 * 1000
const MIN = 60 * 1000
const SNOOZE_MIN = 5

export const initial = (now) => ({
  v: 1,
  settings: { ...DEFAULTS },
  phase: 'ready',
  phaseId: now,
  phaseStart: now,
  total: 0,
  elapsed: 0,
  runningSince: null,
  pausedBy: null,
  block: 1,
  bank: 0,
  breakPlanned: 0,
  breakFromBank: 0,
  blockPrs: [],
  review: null,
})

const elapsedAt = (s, now) => s.elapsed + (s.runningSince != null ? Math.max(0, now - s.runningSince) : 0)
export const remainingAt = (s, now) => Math.max(0, s.total - elapsedAt(s, now))
const endsAt = (s) => s.runningSince + s.total - s.elapsed
export const breakMinutes = (s) => (s.block % s.settings.longEvery === 0 ? s.settings.longBreakMin : s.settings.breakMin)

const begin = (s, phase, total, now) => {
  Object.assign(s, { phase, phaseId: now, phaseStart: now, total, elapsed: 0, runningSince: total ? now : null, pausedBy: null })
  if (phase === 'focus') s.blockPrs = s.review ? [prOf(s.review)] : []
}
const pause = (s, at, by) => {
  s.elapsed = elapsedAt(s, at)
  s.runningSince = null
  s.pausedBy = by
}
const nextBlock = (s) => {
  s.block = s.block % s.settings.longEvery === 0 ? 1 : s.block + 1
}

const prOf = (r) => ({ repo: r.repo, pr: r.pr, title: r.title })
const focusEvent = (s, end) => ({
  type: 'focus', start: s.phaseStart, end, seconds: Math.round(elapsedAt(s, end) / 1000), block: s.block, prs: s.blockPrs,
})
const breakEvent = (s, end) => ({
  type: 'break', start: s.phaseStart, end, seconds: Math.round(elapsedAt(s, end) / 1000),
  plannedMin: s.breakPlanned, fromBankMin: s.breakFromBank,
})
const bankEvent = (at, seconds, reason) => ({ type: 'bank', at, seconds, reason })

// Finishes a running phase whose time is up. Returns the events to log.
export const advance = (s, now) => {
  if (s.runningSince == null || now < endsAt(s)) return []
  const end = endsAt(s)
  if (s.phase === 'focus') {
    const event = focusEvent(s, end)
    begin(s, 'due', 0, end)
    return [event]
  }
  if (s.phase === 'break') {
    const event = breakEvent(s, end)
    nextBlock(s)
    begin(s, 'ready', 0, end)
    return [event]
  }
  return []
}

// Pauses a focus block once you've been away `idlePauseMin` (counting from when you
// left), and picks it back up when you're back. Returns true when it changed `s`.
export const applyIdle = (s, now, idleSec) => {
  if (s.phase !== 'focus' || idleSec == null) return false
  if (s.runningSince != null && idleSec >= s.settings.idlePauseMin * 60) {
    pause(s, Math.max(s.runningSince, now - idleSec * 1000), 'idle')
    return true
  }
  if (s.pausedBy === 'idle' && idleSec < 30) {
    s.runningSince = now
    s.pausedBy = null
    return true
  }
  return false
}

const minutes = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null)

// One request from the menu bar or the review clock. Returns { events } to log, plus
// { error } when the action doesn't apply now: then only the time that passed (a
// phase that ended on its own) has changed `s`, and its events still need logging.
export const act = (s, body, now) => {
  const events = advance(s, now)
  const action = body?.action
  const fail = (error) => ({ error, events })
  const wrong = fail(`can't ${action} while ${s.phase}${s.runningSince == null && s.total ? ' (paused)' : ''}`)
  switch (action) {
    case 'start':
      if (s.phase !== 'ready') return wrong
      begin(s, 'focus', s.settings.focusMin * MIN, now)
      break
    case 'pause':
      if ((s.phase !== 'focus' && s.phase !== 'break') || s.runningSince == null) return wrong
      pause(s, now, 'user')
      break
    case 'resume':
      if ((s.phase !== 'focus' && s.phase !== 'break') || s.runningSince != null) return wrong
      s.runningSince = now
      s.pausedBy = null
      break
    case 'breakNow':
      if (s.phase !== 'focus') return wrong
      events.push(focusEvent(s, now))
      begin(s, 'due', 0, now)
      break
    case 'take': {
      if (s.phase !== 'due') return wrong
      const add = body.add == null ? 0 : minutes(body.add, 0, 24 * 60)
      if (add == null || add * MIN > s.bank) return fail('add must be whole minutes, no more than the bank')
      const planned = breakMinutes(s)
      s.bank -= add * MIN
      if (add) events.push(bankEvent(now, -add * 60, 'spent'))
      begin(s, 'break', (planned + add) * MIN, now)
      s.breakPlanned = planned
      s.breakFromBank = add
      break
    }
    case 'skip': {
      if (s.phase !== 'due') return wrong
      const banked = breakMinutes(s)
      s.bank += banked * MIN
      events.push(bankEvent(now, banked * 60, 'skipped'))
      nextBlock(s)
      begin(s, 'focus', s.settings.focusMin * MIN, now)
      break
    }
    case 'snooze':
      if (s.phase !== 'due') return wrong
      begin(s, 'focus', SNOOZE_MIN * MIN, now)
      break
    case 'endBreak': {
      if (s.phase !== 'break') return wrong
      // Whole minutes only, so the bank reads in minutes.
      const unused = Math.floor(remainingAt(s, now) / MIN)
      events.push(breakEvent(s, now))
      if (unused) {
        s.bank += unused * MIN
        events.push(bankEvent(now, unused * 60, 'unused'))
      }
      nextBlock(s)
      begin(s, 'ready', 0, now)
      break
    }
    case 'stop':
      if (s.phase === 'focus') events.push(focusEvent(s, now))
      if (s.phase === 'break') events.push(breakEvent(s, now))
      begin(s, 'ready', 0, now)
      break
    case 'settings': {
      const next = {
        focusMin: body.focusMin == null ? s.settings.focusMin : minutes(body.focusMin, 5, 120),
        breakMin: body.breakMin == null ? s.settings.breakMin : minutes(body.breakMin, 1, 60),
        longBreakMin: body.longBreakMin == null ? s.settings.longBreakMin : minutes(body.longBreakMin, 1, 120),
      }
      if (Object.values(next).includes(null)) return fail('focusMin 5-120, breakMin 1-60, longBreakMin 1-120')
      Object.assign(s.settings, next)
      break
    }
    case 'review': {
      // The review clock says which PR it's timing (or none). A focus block remembers
      // every PR reviewed during it.
      if (body.pr == null) {
        s.review = null
        break
      }
      const pr = minutes(body.pr, 1, 1e9)
      const repo = typeof body.repo === 'string' && /^[A-Za-z0-9._ -]{1,100}$/.test(body.repo) ? body.repo : null
      if (!pr || !repo) return fail('review needs pr and repo')
      s.review = { pr, repo, title: typeof body.title === 'string' ? body.title.slice(0, 200) : '',
        seconds: minutes(body.seconds, 0, 86400) ?? 0, running: body.running !== false, at: now }
      if (s.phase === 'focus' && s.review.running && !s.blockPrs.some((p) => p.repo === repo && p.pr === pr)) s.blockPrs.push(prOf(s.review))
      break
    }
    default:
      return fail('unknown action')
  }
  return { events }
}

// What GET /focus answers.
export const view = (s, now) => ({
  phase: s.phase,
  phaseId: s.phaseId,
  running: s.runningSince != null,
  pausedBy: s.pausedBy,
  remaining: remainingAt(s, now),
  total: s.total,
  block: s.block,
  longEvery: s.settings.longEvery,
  breakMin: s.phase === 'break' ? s.breakPlanned + s.breakFromBank : breakMinutes(s),
  fromBankMin: s.phase === 'break' ? s.breakFromBank : 0,
  bank: s.bank,
  review: s.review && now - s.review.at < REVIEW_FRESH_MS ? s.review : null,
  blockPrs: s.phase === 'focus' ? s.blockPrs : [],
  settings: s.settings,
  now,
})

// Today's totals from the event log (one parsed event per entry), local time.
export const today = (events, now) => {
  const day = new Date(now).toDateString()
  const on = (ms) => new Date(ms).toDateString() === day
  const t = { focusSeconds: 0, blocks: 0, breakSeconds: 0, skipped: 0, bankedSeconds: 0, spentSeconds: 0 }
  for (const e of events) {
    if (e.type === 'focus' && on(e.start)) {
      t.focusSeconds += e.seconds
      t.blocks += 1
    } else if (e.type === 'break' && on(e.start)) t.breakSeconds += e.seconds
    else if (e.type === 'bank' && on(e.at)) {
      if (e.seconds > 0) t.bankedSeconds += e.seconds
      else t.spentSeconds -= e.seconds
      if (e.reason === 'skipped') t.skipped += 1
    }
  }
  return t
}

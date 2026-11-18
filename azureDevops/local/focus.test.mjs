// node --test azureDevops/local/focus.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { act, advance, applyIdle, initial, remainingAt, today, view } from './focus.mjs'

const MIN = 60 * 1000
const T0 = Date.UTC(2026, 10, 18, 15, 0)

// Runs actions in order at given minute offsets; returns the state and every logged event.
const run = (steps) => {
  const s = initial(T0)
  const log = []
  for (const [min, body] of steps) {
    const now = T0 + min * MIN
    const out = body ? act(s, body, now) : { events: advance(s, now) }
    assert.equal(out.error, undefined, `${body?.action} at +${min}m: ${out.error}`)
    log.push(...out.events)
  }
  return { s, log }
}

test('a focus block ends on its own and asks for a break', () => {
  const { s, log } = run([[0, { action: 'start' }], [25]])
  assert.equal(s.phase, 'due')
  assert.equal(log.length, 1)
  assert.deepEqual([log[0].type, log[0].seconds, log[0].block], ['focus', 1500, 1])
  assert.equal(view(s, T0 + 25 * MIN).breakMin, 5)
})

test('skipping a break banks it and starts the next block', () => {
  const { s, log } = run([[0, { action: 'start' }], [25], [26, { action: 'skip' }]])
  assert.equal(s.phase, 'focus')
  assert.equal(s.block, 2)
  assert.equal(s.bank, 5 * MIN)
  assert.deepEqual(log.at(-1), { type: 'bank', at: T0 + 26 * MIN, seconds: 300, reason: 'skipped' })
})

test('a break can add banked minutes, and ending it early returns whole unused minutes', () => {
  const { s, log } = run([
    [0, { action: 'start' }], [25], [25, { action: 'skip' }], [50], [50, { action: 'take', add: 5 }],
    [53.5, { action: 'endBreak' }],
  ])
  // 10 min break (5 + 5 banked), ended after 3.5: 6.5 left → 6 back.
  assert.equal(s.phase, 'ready')
  assert.equal(s.bank, 6 * MIN)
  assert.deepEqual(log.filter((e) => e.type === 'bank').map((e) => [e.reason, e.seconds]), [['skipped', 300], ['spent', -300], ['unused', 360]])
  const brk = log.find((e) => e.type === 'break')
  assert.deepEqual([brk.seconds, brk.plannedMin, brk.fromBankMin], [210, 5, 5])
})

test('the bank has no limit', () => {
  const steps = [[0, { action: 'start' }]]
  for (let i = 1; i <= 30; i++) steps.push([i * 25], [i * 25, { action: 'skip' }])
  const { s } = run(steps)
  // 30 skips: blocks 4, 8, … are long breaks (15), the rest 5.
  assert.equal(s.bank, (7 * 15 + 23 * 5) * MIN)
})

test("can't spend more than the bank", () => {
  const s = initial(T0)
  act(s, { action: 'start' }, T0)
  advance(s, T0 + 25 * MIN)
  const out = act(s, { action: 'take', add: 5 }, T0 + 25 * MIN)
  assert.match(out.error, /bank/)
  assert.equal(s.phase, 'due')
})

test('every 4th block gets the long break', () => {
  const steps = [[0, { action: 'start' }]]
  for (let i = 1; i <= 3; i++) steps.push([i * 25], [i * 25, { action: 'skip' }])
  steps.push([100])
  const { s } = run(steps)
  assert.equal(s.block, 4)
  assert.equal(view(s, T0 + 100 * MIN).breakMin, 15)
})

test('pausing stops the clock; resuming continues it', () => {
  const { s } = run([[0, { action: 'start' }], [10, { action: 'pause' }], [40, { action: 'resume' }]])
  assert.equal(remainingAt(s, T0 + 40 * MIN), 15 * MIN)
  advance(s, T0 + 54 * MIN)
  assert.equal(s.phase, 'focus')
  advance(s, T0 + 55 * MIN)
  assert.equal(s.phase, 'due')
})

test('idle pauses focus from when you left, and coming back resumes it', () => {
  const s = initial(T0)
  act(s, { action: 'start' }, T0)
  // 10 min in, idle for 6 min already.
  assert.equal(applyIdle(s, T0 + 10 * MIN, 6 * 60), true)
  assert.equal(s.pausedBy, 'idle')
  assert.equal(remainingAt(s, T0 + 30 * MIN), 21 * MIN)
  assert.equal(applyIdle(s, T0 + 30 * MIN, 5), true)
  assert.equal(s.runningSince, T0 + 30 * MIN)
  // A manual pause isn't undone by activity.
  act(s, { action: 'pause' }, T0 + 31 * MIN)
  assert.equal(applyIdle(s, T0 + 32 * MIN, 1), false)
})

test('a focus block remembers the PRs reviewed in it', () => {
  const { s, log } = run([
    [0, { action: 'review', pr: 12349, repo: 'CoreAPI', title: 'Notes', seconds: 60 }],
    [1, { action: 'start' }],
    [5, { action: 'review', pr: 12414, repo: 'CoreAPI', title: 'Contract notes', seconds: 10 }],
    [5.5, { action: 'review', pr: 12414, repo: 'CoreAPI', title: 'Contract notes', seconds: 40 }],
    [26],
  ])
  assert.deepEqual(log[0].prs.map((p) => p.pr), [12349, 12414])
  assert.equal(s.phase, 'due')
})

test('a review report goes stale', () => {
  const s = initial(T0)
  act(s, { action: 'review', pr: 1, repo: 'r', seconds: 0 }, T0)
  assert.equal(view(s, T0 + 30 * 1000).review.pr, 1)
  assert.equal(view(s, T0 + 2 * MIN).review, null)
})

test('a refused action still reports a phase that ended meanwhile', () => {
  const s = initial(T0)
  act(s, { action: 'start' }, T0)
  const out = act(s, { action: 'endBreak' }, T0 + 30 * MIN)
  assert.match(out.error, /while due/)
  assert.deepEqual(out.events.map((e) => e.type), ['focus'])
})

test('wrong-phase actions are refused without changing anything', () => {
  const s = initial(T0)
  const before = JSON.stringify(s)
  assert.match(act(s, { action: 'skip' }, T0).error, /can't skip while ready/)
  assert.match(act(s, { action: 'nope' }, T0).error, /unknown/)
  assert.match(act(s, { action: 'settings', focusMin: 1 }, T0).error, /focusMin/)
  assert.equal(JSON.stringify(s), before)
})

test("today's totals", () => {
  const { log } = run([
    [0, { action: 'start' }], [25], [25, { action: 'skip' }], [50], [50, { action: 'take', add: 5 }], [60],
  ])
  assert.deepEqual(today(log, T0 + 60 * MIN), { focusSeconds: 3000, blocks: 2, breakSeconds: 600, skipped: 1, bankedSeconds: 300, spentSeconds: 300 })
  assert.equal(today(log, T0 + 24 * 60 * MIN).blocks, 0)
})

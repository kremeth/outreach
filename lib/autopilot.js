// Launch: runs voicenotes, picked comments (with likes), relaunches and 2nd relaunches in the background.
//
// Spacing: each kind of action is spread evenly over what is left of today's window (8:00 to 21:00),
// never faster than its floor below, with ±30% randomness so it never looks scheduled. The Instagram
// safety gate (ig-guard, in the app) still has the final say on every action, across both computers.
// Whatever does not fit today carries on the next morning. Any Instagram warning stops everything.
const fs = require('fs')
const path = require('path')

const WINDOW_START_HOUR = 8
const WINDOW_END_HOUR = 21
const FLOOR_MS = { voice: 4 * 60 * 1000, dm: 6 * 60 * 1000, comment: 5 * 60 * 1000 }
const CEILING_MS = 45 * 60 * 1000
const PRIORITY = ['voice', 'dm', 'comment']
const LABEL = { voice: 'voicenote', dm: 'relaunch', comment: 'comment' }
const MAX_TRIES = 2

let deps = null
// Launch remembers that it is on, so it resumes by itself after Outreach, its server or the Mac
// restarts. Only Stop (or an automatic stop, e.g. an Instagram warning) turns it off.
const STATE_FILE = path.join(__dirname, '..', 'data', 'autopilot.json')

function remember(running) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ running, tasks: state.tasks, at: new Date().toISOString() }, null, 2))
  } catch (error) {
    console.error(error)
  }
}
let state = fresh()
let wake = null

function fresh() {
  return {
    running: false,
    tasks: { voice: true, comment: true, relaunch1: true, relaunch2: true },
    startedAt: 0,
    sent: { voice: 0, comment: 0, dm: 0 },
    planned: {},
    current: '',
    waitingFor: '',
    nextAt: 0,
    nextKind: '',
    stopReason: '',
    events: [],
    exhausted: {},
  }
}

const tries = new Map()

function init(options) {
  deps = options
}

// Never show raw HTML or a wall of text in the event list.
function readable(message) {
  const text = String(message || 'unknown error')
  if (/<html|<!doctype/i.test(text)) return 'a server returned an error page.'
  return text.replace(/\s+/g, ' ').slice(0, 200)
}

function event(text, tone = '') {
  state.events.unshift({ at: Date.now(), text, tone })
  state.events = state.events.slice(0, 40)
}

function sleepUntil(time, reason) {
  state.nextAt = time
  state.waitingFor = reason
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, time - Date.now()))
    wake = () => {
      clearTimeout(timer)
      resolve()
    }
  }).finally(() => {
    wake = null
  })
}

function windowFor(now) {
  const start = new Date(now)
  start.setHours(WINDOW_START_HOUR, 0, 0, 0)
  const end = new Date(now)
  end.setHours(WINDOW_END_HOUR, 0, 0, 0)
  if (now >= end.getTime()) {
    start.setDate(start.getDate() + 1)
    end.setDate(end.getDate() + 1)
  }
  return { start: start.getTime(), end: end.getTime() }
}

// What is waiting, per kind, and how much of today's limits is left for it.
// Relaunch items within today's per-step caps (20 first, 10 second), queue order kept.
function withinRelaunchCaps(items, guard) {
  const left = {
    1: Math.max(0, (guard.relaunch?.[1]?.limit ?? 20) - (guard.relaunch?.[1]?.today ?? 0)),
    2: Math.max(0, (guard.relaunch?.[2]?.limit ?? 10) - (guard.relaunch?.[2]?.today ?? 0)),
  }
  const first = items.filter((item) => item.stage === 1).slice(0, left[1])
  const second = items.filter((item) => item.stage === 2).slice(0, left[2])
  // Next up is the step furthest behind its daily target, so both run through the whole day.
  const progress = (stage) => (guard.relaunch?.[stage]?.today ?? 0) / (guard.relaunch?.[stage]?.limit || 1)
  const secondFirst = second.length && (!first.length || progress(2) < progress(1))
  return secondFirst ? [...second, ...first] : [...first, ...second]
}

async function workLeft(guard) {
  const relaunchItems = withinRelaunchCaps(await deps.relaunchQueue(state.tasks), guard)
  const waiting = {
    voice: state.tasks.voice && !state.exhausted.voice ? deps.voiceCount() : 0,
    comment: state.tasks.comment ? deps.hustle.picks().length : 0,
    dm: relaunchItems.length,
  }
  const totalLeft = Math.max(0, guard.totalLimit - guard.total)
  const today = {}
  for (const kind of PRIORITY) {
    const limits = guard.kinds[kind]
    today[kind] = Math.min(waiting[kind], Math.max(0, limits.limit - limits.today), totalLeft)
  }
  if (today.voice) today.voice = Math.min(today.voice, deps.voiceRemainingToday())
  return { waiting, today, relaunchItems }
}

// Spreads what is left of today evenly so the last one lands ~15 minutes before the window closes
// (so ±20% randomness can never push it past 21:00 into tomorrow).
const FINISH_EARLY_MS = 15 * 60 * 1000
const LOGIN_GRACE_MS = 5 * 60 * 1000
function plan(kind, count, window, now) {
  const span = Math.max(0, window.end - FINISH_EARLY_MS - Math.max(now, window.start))
  const even = count ? span / (count + 0.5) : CEILING_MS
  const interval = Math.min(CEILING_MS, Math.max(FLOOR_MS[kind], even))
  return interval * (0.8 + Math.random() * 0.4)
}

// A new day starts at a random time in the first 20 minutes of the window, never exactly on the hour.
function newDay() {
  state.exhausted = {}
  const now = Date.now()
  for (const kind of PRIORITY) state.planned[kind] = now + Math.random() * 20 * 60 * 1000
}

function stop(reason, tone = '') {
  if (!state.running) return status()
  state.running = false
  remember(false)
  state.stopReason = reason
  state.nextAt = 0
  state.waitingFor = ''
  event(reason, tone)
  if (wake) wake()
  return status()
}

function start(tasks = {}, { resumed = false } = {}) {
  if (state.running) return status()
  const keep = state.events
  state = fresh()
  state.events = keep
  state.tasks = { ...state.tasks, ...tasks }
  state.running = true
  state.startedAt = Date.now()
  remember(true)
  event(resumed ? 'Resumed after a restart.' : 'Launched.')
  loop().catch((error) => {
    console.error(error)
    stop(`Stopped: ${error.message}`, 'bad')
  })
  return status()
}

async function loop() {
  while (state.running) {
    const now = Date.now()
    const window = windowFor(now)
    if (now < window.start) {
      await sleepUntil(window.start, 'Resumes')
      newDay()
      continue
    }
    let guard
    try {
      guard = await deps.guard()
    } catch (error) {
      await sleepUntil(Date.now() + 30000, 'Waiting for the Outreach app')
      continue
    }
    if (!guard.app) {
      await sleepUntil(Date.now() + 30000, 'Waiting for the Outreach app')
      continue
    }
    if (guard.blocked) return stop(`Stopped: Instagram warning (${guard.blocked.reason}). Nothing more will run for 48 hours.`, 'bad')
    // Right after a restart the panel can take a moment to show the account: give it a few minutes
    // (nothing runs meanwhile) before stopping.
    if (!guard.loggedIn) {
      state.loggedOutSince = state.loggedOutSince || Date.now()
      if (Date.now() - state.loggedOutSince > LOGIN_GRACE_MS) return stop('Stopped: Instagram is not logged in in the panel.', 'bad')
      await sleepUntil(Date.now() + 30000, 'Waiting for Instagram in the panel')
      continue
    }
    state.loggedOutSince = 0
    // Without the sheet (no internet at start, Google down) everything would look done. Wait for it.
    if (!deps.sheetReady()) {
      await deps.refreshSheet()
      if (!deps.sheetReady()) {
        await sleepUntil(Date.now() + 60000, 'Waiting for the Google Sheet')
        continue
      }
    }

    const work = await workLeft(guard)
    const kinds = PRIORITY.filter((kind) => work.today[kind] > 0)
    if (!kinds.length) {
      const anyWaiting = PRIORITY.some((kind) => work.waiting[kind] > 0)
      if (!anyWaiting) return stop('All done. Everything that was waiting has been sent.', 'good')
      const tomorrow = windowFor(window.end + 1000).start
      event("Today's limits are used up. The rest continues tomorrow.")
      await sleepUntil(tomorrow, 'Continues')
      newDay()
      continue
    }

    // When each kind is next due: its planned time (the first of each kind is staggered by 20s), but
    // never before the safety gate allows it.
    for (const kind of kinds) {
      if (!state.planned[kind]) state.planned[kind] = now + PRIORITY.indexOf(kind) * 20000
    }
    const due = (kind) => Math.max(state.planned[kind], guard.kinds[kind].nextAt + 2000 + Math.random() * 8000)
    const kind = kinds.reduce((best, item) => (due(item) < due(best) ? item : best))
    const at = due(kind)
    state.nextKind = kind
    if (at > Date.now() + 1000) {
      await sleepUntil(at, `Next ${LABEL[kind]}`)
      continue
    }

    state.nextAt = 0
    state.waitingFor = ''
    const outcome = await runOne(kind, work)
    if (!state.running) break
    if (outcome === 'stop') return
    const after = Date.now()
    // A skip sent nothing, so the next one can follow shortly instead of waiting a full gap. A 'wait'
    // from the safety gate already set its own short retry time, so it is not pushed back a full gap.
    if (outcome === 'quick') state.planned[kind] = after + 20000 + Math.random() * 20000
    else if (outcome !== 'wait') state.planned[kind] = after + plan(kind, Math.max(1, work.today[kind] - 1), windowFor(after), after)
  }
}

async function runOne(kind, work) {
  try {
    if (kind === 'voice') return await runVoice()
    if (kind === 'comment') return await runComment(deps.nextPick())
    return await runRelaunch(work.relaunchItems[0])
  } catch (error) {
    if (error.kind === 'blocked') {
      stop(`Stopped: Instagram warning. ${error.message} Nothing more will run for 48 hours.`, 'bad')
      return 'stop'
    }
    if (error.kind === 'login') {
      stop('Stopped: Instagram is not logged in in the panel.', 'bad')
      return 'stop'
    }
    if (error.kind === 'wait' || error.kind === 'busy') {
      state.planned[kind] = Date.now() + Math.max(30000, error.waitMs || 0)
      return 'wait'
    }
    if (error.kind === 'limit') {
      state.exhausted[kind] = true
      return 'wait'
    }
    if (error.kind === 'app') {
      await sleepUntil(Date.now() + 30000, 'Waiting for the Outreach app')
      return 'wait'
    }
    // macOS paused the panel: nothing was sent, not a failure. Try the same step again shortly.
    if (error.kind === 'hidden' || /paused the Instagram panel/.test(error.message || '')) {
      if (!/paused/.test(state.events[0]?.text || '')) event('macOS paused the Instagram panel for a moment; retrying shortly.')
      state.planned[kind] = Date.now() + 2 * 60 * 1000
      return 'wait'
    }
    // Google Sheets hiccup (already retried for ~30s): nothing was sent, try this step again shortly.
    if (/temporarily unavailable|did not answer in time|socket hang up|ECONNRESET|ETIMEDOUT/i.test(error.message || '')) {
      event(`Google Sheets was briefly unavailable, so the ${LABEL[kind]} will be retried in a few minutes.`)
      state.planned[kind] = Date.now() + 3 * 60 * 1000
      return 'wait'
    }
    event(`${LABEL[kind]} failed: ${readable(error.message)}`, 'bad')
    return 'failed'
  } finally {
    state.current = ''
  }
}

async function runVoice() {
  state.current = 'Sending a voicenote'
  const result = await deps.instagram.voiceNext()
  for (const username of result.leftOut || []) event(`Left out @${username}: their chat would not open after 2 tries.`, 'bad')
  if (result.done) {
    state.exhausted.voice = true
    return 'done'
  }
  if (result.skipped) {
    event(`Skipped @${result.item.username}: ${result.reason}`)
    return 'quick'
  }
  await deps.refreshSheet()
  if (result.sent) {
    state.sent.voice++
    if (result.flatWaveform) event(`Voicenote sent to @${result.item.username}, but its waveform looks flat in the chat. Check it.`, 'bad')
    else event(`Voicenote sent to @${result.item.username} (${result.item.device}, ${result.item.voice}).`, 'good')
  } else if (result.unreachable) {
    event(`Can't message @${result.item.username}${result.reason ? `: ${result.reason}` : ''}. Marked NA.`)
    return 'quick'
  }
  return 'ok'
}

// Gives up on an item after MAX_TRIES failures that happened before anything was sent.
function tooManyTries(key) {
  const count = (tries.get(key) || 0) + 1
  tries.set(key, count)
  return count >= MAX_TRIES
}

async function runComment(pick) {
  if (!pick) return 'done'
  state.current = `Commenting on @${pick.username}`
  try {
    const result = await deps.postComment({ username: pick.username, pk: pick.pk, code: pick.code, message: pick.text, permalink: `https://www.instagram.com/p/${pick.code}/` })
    if (result.ok === false) {
      event(`@${pick.username}: ${result.error}`)
      return 'skipped'
    }
    state.sent.comment++
    event(`Liked and commented on @${pick.username}.`, 'good')
    return 'ok'
  } catch (error) {
    if (error.kind === 'notsent' && tooManyTries(`comment:${pick.pk}`)) {
      await deps.hustle.unpick(pick.username, pick.pk)
      event(`Gave up on @${pick.username} after ${MAX_TRIES} tries: ${error.message}`, 'bad')
      return 'skipped'
    }
    throw error
  }
}

async function runRelaunch(item) {
  if (!item) return 'done'
  const label = item.stage === 2 ? '2nd relaunch' : 'Relaunch'
  state.current = `${label} to @${item.username}`
  try {
    const result = await deps.sendRelaunch(item.stage, item.sheetRow, deps.relaunch.messageFor(item, item.stage))
    if (result.ok) {
      state.sent.dm++
      event(`${label} sent to @${item.username}.${result.warning ? ` ${result.warning}` : ''}`, 'good')
    } else {
      event(result.error.startsWith(`@${item.username}`) ? result.error : `@${item.username}: ${result.error}`)
      // Nothing was sent, so move on to the next creator soon instead of waiting a full interval.
      return 'quick'
    }
    return 'ok'
  } catch (error) {
    if (error.kind === 'notsent' && tooManyTries(`dm:${item.stage}:${item.sheetRow}`)) {
      await deps.relaunch.leaveOut(item.stage, item.sheetRow)
      event(`Left @${item.username} out after ${MAX_TRIES} tries: ${error.message}`, 'bad')
      return 'skipped'
    }
    throw error
  }
}

function status() {
  return {
    running: state.running,
    tasks: state.tasks,
    startedAt: state.startedAt,
    sent: state.sent,
    current: state.current,
    nextAt: state.nextAt,
    nextKind: state.nextKind,
    waitingFor: state.waitingFor,
    stopReason: state.stopReason,
    events: state.events.slice(0, 12),
    window: { startHour: WINDOW_START_HOUR, endHour: WINDOW_END_HOUR },
    now: Date.now(),
  }
}

// What Launch would do right now, for the To do page.
async function preview(guard) {
  const relaunchItems = await deps.relaunchQueue({ relaunch1: true, relaunch2: true })
  const counts = {
    voice: deps.voiceCount(),
    comment: deps.hustle.picks().length,
    relaunch1: relaunchItems.filter((item) => item.stage === 1).length,
    relaunch2: relaunchItems.filter((item) => item.stage === 2).length,
  }
  const now = Date.now()
  const window = windowFor(now)
  const left = guard?.app ? {
    voice: Math.max(0, guard.kinds.voice.limit - guard.kinds.voice.today),
    comment: Math.max(0, guard.kinds.comment.limit - guard.kinds.comment.today),
    dm: Math.max(0, guard.kinds.dm.limit - guard.kinds.dm.today),
    relaunch1: Math.max(0, guard.relaunch[1].limit - guard.relaunch[1].today),
    relaunch2: Math.max(0, guard.relaunch[2].limit - guard.relaunch[2].today),
  } : null
  return { counts, left, windowStart: window.start, windowEnd: window.end, now }
}

function resume() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (saved.running) start(saved.tasks || {}, { resumed: true })
  } catch {}
}

module.exports = { init, start, stop: (reason) => stop(reason || 'Stopped.'), status, preview, resume }

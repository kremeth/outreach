// Launch: runs voicenotes, picked comments (with likes), relaunches, 2nd relaunches and unfollows
// (no reply after the 2nd relaunch, or a no) in the background.
//
// Spacing: each kind of action is spread evenly over what is left of today's window (8:00 to 21:00),
// never faster than its floor below, with ±30% randomness so it never looks scheduled. The Instagram
// safety gate (ig-guard, in the app) still has the final say on every action, across both computers.
// Whatever does not fit today carries on the next morning. Any Instagram warning stops everything.
const fs = require('fs')
const path = require('path')

const WINDOW_START_HOUR = 8
const WINDOW_END_HOUR = 21
const FLOOR_MS = { voice: 4 * 60 * 1000, dm: 6 * 60 * 1000, comment: 5 * 60 * 1000, unfollow: 5 * 60 * 1000, reply: 4 * 60 * 1000 }
const CEILING_MS = 45 * 60 * 1000
// reply: an ongoing conversation that went quiet (lib/reply-relaunch.js): its chat is read and, when
// due, a reply relaunch is sent (a DM, within the DM limits) or the creator is closed out.
const PRIORITY = ['voice', 'dm', 'reply', 'comment', 'unfollow']
const LABEL = { voice: 'voicenote', dm: 'relaunch', reply: 'conversation check', comment: 'comment', unfollow: 'unfollow' }
const MAX_TRIES = 2

let deps = null
// Launch remembers that it is on, so it resumes by itself after Outreach, its server or the Mac
// restarts. Only Stop (or an automatic stop, e.g. an Instagram warning) turns it off.
const STATE_FILE = path.join(__dirname, '..', 'data', 'autopilot.json')

// Saved with why it stopped and whether a person paused it (Launch is always on otherwise: the server
// starts it again on its own, see keepRunning).
function remember(running, extra = {}) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ running, tasks: state.tasks, at: new Date().toISOString(), ...extra }, null, 2))
  } catch (error) {
    console.error(error)
  }
}
let state = fresh()
let wake = null

function fresh() {
  return {
    running: false,
    tasks: { voice: true, comment: true, relaunch1: true, relaunch2: true, unfollow: true, reply: true },
    startedAt: 0,
    sent: { voice: 0, comment: 0, dm: 0, unfollow: 0 },
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
// Relaunch items within today's per-step caps (30 first, 30 second), queue order kept.
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
  const closeItems = state.tasks.unfollow && guard.kinds.unfollow ? await deps.closeQueue() : []
  const replyItems = state.tasks.reply && deps.replyQueue ? await deps.replyQueue() : []
  const waiting = {
    voice: state.tasks.voice && !state.exhausted.voice ? deps.voiceCount() : 0,
    comment: state.tasks.comment ? deps.hustle.picks().length : 0,
    dm: relaunchItems.length,
    unfollow: closeItems.length,
    reply: replyItems.length,
  }
  const totalLeft = Math.max(0, guard.totalLimit - guard.total)
  const today = {}
  for (const kind of PRIORITY) {
    // Reading a chat is not an Instagram action: its own pace (FLOOR_MS) and daily number of looks
    // (lib/reply-relaunch.js); what it sends is checked against the DM limits when it is sent.
    if (kind === 'reply') {
      today.reply = waiting.reply
      continue
    }
    const limits = guard.kinds[kind]
    // An older Outreach app that has no limit for this kind yet: nothing of it runs.
    if (!limits) {
      today[kind] = 0
      continue
    }
    today[kind] = Math.min(waiting[kind], Math.max(0, limits.limit - limits.today), totalLeft)
    // Auto-commenting keeps only a few picks waiting, so the pace is planned for the whole day's target
    // (what is left of the daily limit), not for the few picks waiting right now.
    if (kind === 'comment' && state.tasks.comment && deps.autoCommenting?.()) today[kind] = Math.min(Math.max(0, limits.limit - limits.today), totalLeft)
  }
  if (today.voice) today.voice = Math.min(today.voice, deps.voiceRemainingToday())
  return { waiting, today, relaunchItems, closeItems, replyItems }
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

function stop(reason, tone = '', { byPerson = false } = {}) {
  if (!state.running) return status()
  state.running = false
  remember(false, { reason, byPerson })
  console.log(`Launch stopped: ${reason}`)
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
      // Nothing waiting right now: Launch stays on and looks again in 30 minutes (new work comes in all
      // day: replies, picks, relaunches falling due).
      if (!anyWaiting) {
        await sleepUntil(Date.now() + 30 * 60 * 1000, 'Nothing to send right now; checking again')
        continue
      }
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
    const due = (kind) => Math.max(state.planned[kind], (guard.kinds[kind]?.nextAt || 0) + 2000 + Math.random() * 8000)
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
    if (kind === 'unfollow') return await runUnfollow(work.closeItems[0])
    if (kind === 'reply') return await runReply(work.replyItems[0])
    return await runRelaunch(work.relaunchItems[0])
  } catch (error) {
    if (error.kind === 'blocked') {
      // A short pause (a single "Couldn't post comment": 2 hours, see ig-guard trip): Launch waits it
      // out and carries on. A real stop (48 hours): Launch stops.
      const soft = /couldn.?t post comment/i.test(error.message || '') ? 2 * 60 * 60 * 1000 + 60 * 1000 : 0
      const pauseMs = error.waitMs || soft
      if (pauseMs && pauseMs <= 3 * 60 * 60 * 1000) {
        event(`Paused after an Instagram warning (${error.message}); carrying on at ${new Date(Date.now() + pauseMs).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}.`, 'bad')
        await sleepUntil(Date.now() + pauseMs, 'Paused after an Instagram warning')
        return 'wait'
      }
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
    // Instagram would not take a comment on this post: never tried again (a second refusal would stop
    // everything for 48 hours).
    if (error.kind === 'blocked' && /couldn.?t post comment/i.test(error.message || '')) {
      await deps.hustle.unpick(pick.username, pick.pk).catch(() => {})
      if (deps.hustle.skip) await deps.hustle.skip(pick.username, pick.pk).catch(() => {})
    }
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

async function runReply(item) {
  if (!item) return 'done'
  state.current = `Checking the chat with @${item.username}`
  try {
    const result = await deps.replyStep(item)
    if (result.sent) {
      state.sent.dm++
      event(`Reply relaunch ${result.sent} sent to @${result.username} (${result.sent === 1 ? 'the Travolta GIF' : '"giving this one last try 🫠"'}).`, 'good')
      return 'ok'
    }
    if (result.closed && result.ok) {
      state.sent.unfollow++
      event(`Unfollowed @${result.username} (no answer 3 days after both reply relaunches). Keep hustling set to No.${result.warning ? ` ${result.warning}` : ''}`, 'good')
      return 'ok'
    }
    if (!result.ok && result.error) event(result.error.startsWith('@') ? result.error : `@${item.username}: ${result.error}`)
    return 'ok'
  } catch (error) {
    if (error.kind === 'notsent' && tooManyTries(`reply:${item.sheetRow}`)) {
      event(`Left the chat with @${item.username} for later after ${MAX_TRIES} tries: ${error.message}`, 'bad')
      return 'skipped'
    }
    throw error
  }
}

async function runUnfollow(item) {
  if (!item) return 'done'
  state.current = `Unfollowing @${item.username}`
  try {
    const result = await deps.closeOut(item.sheetRow, item.mode)
    if (result.ok) {
      state.sent.unfollow++
      if (item.mode === 'cleanup') {
        event(`Unfollowed @${item.username} (not on Hustling, clean-up).`, 'good')
        return 'ok'
      }
      const why = item.mode === 'declined' ? 'they said no' : item.mode === 'unreachable' ? "they can't receive our messages" : 'no reply 3 days after the 2nd relaunch'
      const marked = item.mode === 'declined' ? 'Marked No' : item.mode === 'unreachable' ? 'Kept NA' : 'Marked unfollowed'
      event(`Unfollowed @${item.username} (${why}). ${marked}, Keep hustling No.${result.warning ? ` ${result.warning}` : ''}`, 'good')
      return 'ok'
    }
    event(result.error.startsWith(`@${item.username}`) ? result.error : `@${item.username}: ${result.error}`)
    return 'quick'
  } catch (error) {
    if (error.kind === 'notsent' && tooManyTries(`unfollow:${item.sheetRow}`)) {
      if (item.mode === 'cleanup') deps.cleanupGaveUp?.(item.username, error.message)
      else await deps.relaunch.closeWithoutUnfollow(item.sheetRow, `gave up: ${error.message}`)
      event(`Left @${item.username} out of unfollows after ${MAX_TRIES} tries: ${error.message}`, 'bad')
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
    // Why it is not running (also after a restart): e.g. "Paused by you".
    stopReason: state.stopReason || (!state.running ? saved().reason || '' : ''),
    pausedByPerson: !state.running && Boolean(saved().byPerson),
    events: state.events.slice(0, 12),
    window: { startHour: WINDOW_START_HOUR, endHour: WINDOW_END_HOUR },
    now: Date.now(),
  }
}

// What Launch would do right now, for the To do page.
async function preview(guard) {
  const relaunchItems = await deps.relaunchQueue({ relaunch1: true, relaunch2: true })
  const closeItems = await deps.closeQueue()
  const replyItems = deps.replyQueue ? await deps.replyQueue() : []
  const counts = {
    unfollow: closeItems.length,
    unfollowDeclined: closeItems.filter((item) => item.mode === 'declined').length,
    voice: deps.voiceCount(),
    comment: deps.hustle.picks().length,
    relaunch1: relaunchItems.filter((item) => item.stage === 1).length,
    relaunch2: relaunchItems.filter((item) => item.stage === 2).length,
    reply: replyItems.length,
  }
  const now = Date.now()
  const window = windowFor(now)
  const left = guard?.app ? {
    voice: Math.max(0, guard.kinds.voice.limit - guard.kinds.voice.today),
    comment: Math.max(0, guard.kinds.comment.limit - guard.kinds.comment.today),
    dm: Math.max(0, guard.kinds.dm.limit - guard.kinds.dm.today),
    unfollow: guard.kinds.unfollow ? Math.max(0, guard.kinds.unfollow.limit - guard.kinds.unfollow.today) : 0,
    relaunch1: Math.max(0, guard.relaunch[1].limit - guard.relaunch[1].today),
    relaunch2: Math.max(0, guard.relaunch[2].limit - guard.relaunch[2].today),
  } : null
  const replies = deps.replySummary ? { ...deps.replySummary(), sentToday: guard?.relaunch?.reply?.today ?? 0, limit: guard?.relaunch?.reply?.limit ?? 10 } : null
  return { counts, left, replies, windowStart: window.start, windowEnd: window.end, now }
}

function resume() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (saved.running) start(saved.tasks || {}, { resumed: true })
  } catch {}
}

// The saved state: running, why it stopped, and whether a person paused it.
function saved() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

module.exports = { init, start, stop: (reason, options) => stop(reason || 'Stopped.', '', options), status, preview, resume, saved }

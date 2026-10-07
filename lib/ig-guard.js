// Instagram safety. Every comment, DM and voicenote goes through here first. Limits are per Instagram
// account and count actions from every computer (through the shared log), and any warning from
// Instagram stops all actions on that account, everywhere, for BLOCK_HOURS.
const log = require('./shared-log')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const BLOCK_HOURS = 48

// gap: random wait in seconds before the next action of the same kind.
// Daily targets per Instagram account, counted per calendar day (reset at midnight), both computers
// together. Relaunch DMs split into 20 first relaunches and 10 second relaunches (see RELAUNCH_DAILY).
const LIMITS = {
  comment: { label: 'comments', gap: [90, 180], hour: 12, day: 60 },
  dm: { label: 'relaunch DMs', gap: [120, 240], hour: 10, day: 30 },
  voice: { label: 'voicenotes', gap: [75, 180], hour: 15, day: 30 },
}
const RELAUNCH_DAILY = { 1: 20, 2: 10 }
const ANY_GAP_MS = 45 * 1000
const DAY_TOTAL = 125

function startOfToday() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return today.getTime()
}

// What Instagram shows when it is unhappy. Any of these trips the 48 hour stop.
// Popup phrases are only matched inside dialogs and toasts, so a caption saying "try again later" never trips it.
const POPUP_WARNING = /action blocked|try again later|we limit how often|we restrict certain activity|temporarily (locked|blocked|restricted)|couldn't (post|send|follow)|suspicious|unusual activity|confirm (it's|its|it’s) you|help us confirm/i
const PAGE_WARNING = /your account has been (suspended|disabled|locked|restricted)|we suspended your account|confirm (it's|its|it’s) you|help us confirm (it's|its|it’s|that it's) you|suspicious login attempt|we detected unusual activity/i
const WARNING_PATH = /^\/(challenge|checkpoint|accounts\/suspended|accounts\/disabled|accounts\/locked)/i

// Attempts that stopped before anything was sent ("notsent") do not count towards the limits.
function actionsOf(account) {
  return log.list((entry) => LIMITS[entry.action] && !/ notsent$/.test(entry.detail) && (!account || entry.account === account))
}

function activeBlock(account) {
  const now = Date.now()
  return log.list((entry) => entry.action === 'block' && entry.until > now && (!account || !entry.account || entry.account === account)).pop() || null
}

function status(account) {
  const now = Date.now()
  const dayStart = startOfToday()
  const actions = actionsOf(account)
  const block = activeBlock(account)
  const kinds = {}
  for (const [kind, limit] of Object.entries(LIMITS)) {
    const mine = actions.filter((entry) => entry.action === kind)
    const day = mine.filter((entry) => entry.time >= dayStart)
    const hour = mine.filter((entry) => entry.time > now - HOUR)
    let nextAt = Math.max(0, ...mine.map((entry) => entry.until))
    const lastAny = Math.max(0, ...actions.map((entry) => entry.time))
    nextAt = Math.max(nextAt, lastAny + ANY_GAP_MS)
    let reason = ''
    if (day.length >= limit.day) {
      nextAt = Math.max(nextAt, dayStart + DAY)
      reason = `Daily limit of ${limit.day} ${limit.label} reached.`
    } else if (hour.length >= limit.hour) {
      nextAt = Math.max(nextAt, Math.min(...hour.map((entry) => entry.time)) + HOUR)
      reason = `Hourly limit of ${limit.hour} ${limit.label} reached.`
    }
    kinds[kind] = { today: day.length, limit: limit.day, hourLimit: limit.hour, nextAt, reason }
  }
  const total = actions.filter((entry) => entry.time >= dayStart).length
  // Relaunches sent today per step, from the action's detail (relaunch1:<row> / relaunch2:<row>).
  const relaunchToday = { 1: 0, 2: 0 }
  for (const entry of actions) {
    const match = entry.action === 'dm' && entry.time >= dayStart && entry.detail.match(/^relaunch([12]):/)
    if (match) relaunchToday[match[1]]++
  }
  return {
    relaunch: { 1: { today: relaunchToday[1], limit: RELAUNCH_DAILY[1] }, 2: { today: relaunchToday[2], limit: RELAUNCH_DAILY[2] } },
    account,
    blocked: block ? { until: block.until, reason: block.detail, at: block.time, machine: block.machine } : null,
    total,
    totalLimit: DAY_TOTAL,
    kinds,
  }
}

// Throws unless an action of this kind may start right now.
async function check(kind, account) {
  await log.refresh(0)
  const state = status(account)
  if (state.blocked) {
    throw Object.assign(new Error(`Instagram actions are stopped until ${new Date(state.blocked.until).toLocaleString('en-AU')} after a warning: ${state.blocked.reason}`), { kind: 'blocked' })
  }
  if (state.total >= DAY_TOTAL) throw Object.assign(new Error(`Daily safety limit of ${DAY_TOTAL} Instagram actions reached.`), { kind: 'limit' })
  const info = state.kinds[kind]
  const waitMs = info.nextAt - Date.now()
  if (waitMs > 0) {
    throw Object.assign(new Error(info.reason || `Next ${LIMITS[kind].label.replace(/s$/, '')} allowed in ${Math.ceil(waitMs / 1000)}s.`), { kind: 'wait', waitMs })
  }
  return state
}

// Only one computer acts on an Instagram account at a time.
async function lock(account, ttlMs = 2 * 60 * 1000) {
  const result = await log.claim(`ig:${account || 'unknown'}`, ttlMs)
  if (!result.ok) throw Object.assign(new Error(`${result.by} is using Instagram right now. Try again in a minute.`), { kind: 'wait', waitMs: 60000 })
}

function randomGapMs(kind) {
  const [min, max] = LIMITS[kind].gap
  return (min + Math.random() * (max - min)) * 1000
}

// Every attempt that reached Instagram counts, successful or not.
function record(kind, account, target, detail) {
  return log.append({ account, action: kind, target, detail, until: Date.now() + randomGapMs(kind) })
}

function trip(account, reason) {
  return log.append({ account, action: 'block', target: 'instagram', detail: String(reason || 'Instagram warning').slice(0, 300), until: Date.now() + BLOCK_HOURS * HOUR })
}

function isWarningUrl(url) {
  try {
    return WARNING_PATH.test(new URL(url).pathname)
  } catch {
    return false
  }
}

module.exports = { LIMITS, RELAUNCH_DAILY, BLOCK_HOURS, status, check, lock, record, trip, isWarningUrl, POPUP_WARNING, PAGE_WARNING, WARNING_PATH }

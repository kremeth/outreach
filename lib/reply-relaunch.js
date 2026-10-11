// Reply relaunches: creators we are in an ongoing conversation with (Accepted? = Replied) whose chat has
// gone quiet on our side. Separate from the voicenote relaunches (each creator can get both kinds).
//   - the chat ends with our message, no answer for 2 days       -> reply relaunch 1: the Travolta GIF
//   - then (or after any later message of ours) 3 days, no answer -> reply relaunch 2: a short text
//   - both used, our latest message unanswered for 3 days         -> unfollow, Keep hustling = No
// Each one is sent at most once per creator, ever (shared App Log: dm entries "reply1:<row>",
// "reply2:<row>"). When they wrote last it is our turn, so nothing happens.
// Time is the timestamp Instagram shows above our last message; when none is in view, the first time we
// saw that message (data/hustle/reply-relaunch.json, per sheet row).
const fs = require('fs')
const path = require('path')
const log = require('./shared-log')

const STATE_PATH = path.join(__dirname, '..', 'data', 'hustle', 'reply-relaunch.json')
const DAY = 24 * 60 * 60 * 1000
const WAIT = { 1: 2 * DAY, 2: 3 * DAY, close: 3 * DAY }
const TEXT_2 = 'giving this one last try 🫠'
const CHECKS_PER_DAY = 40
const RECHECK_THEIR_TURN = DAY
const RECHECK_MIN = 12 * 60 * 60 * 1000

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { rows: {} }
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  const tmp = `${STATE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
  fs.renameSync(tmp, STATE_PATH)
}

// Which reply relaunches a row has had (sent, or tapped and maybe sent: never twice).
function used(sheetRow) {
  const sent = { 1: 0, 2: 0 }
  for (const entry of log.list((item) => item.action === 'dm' && /^reply[12]:/.test(item.detail) && !/ notsent$/.test(item.detail))) {
    const [step, row] = entry.detail.replace(/ failed$/, '').slice(5).split(':')
    if (Number(row) === Number(sheetRow)) sent[step] = sent[step] || entry.time
  }
  return sent
}

// What to do for one chat, given its messages (oldest first, each { ours, text, at }).
function decide(sheetRow, messages, now = Date.now()) {
  const state = load()
  const previous = state.rows[sheetRow] || {}
  const last = messages[messages.length - 1]
  if (!last) return { action: 'none', reason: 'could not read the chat' }
  if (!last.ours) return { action: 'none', reason: 'they wrote last, our turn', last }
  // Since when our last message has been waiting: Instagram's timestamp, else when we first saw it.
  const sameAsBefore = previous.lastText === last.text.slice(0, 80)
  const since = last.at || (sameAsBefore && previous.firstSeen) || now
  const sent = used(sheetRow)
  const age = now - since
  let action = 'none'
  let dueAt = 0
  if (!sent[1]) {
    dueAt = since + WAIT[1]
    if (age >= WAIT[1]) action = 'reply1'
  } else if (!sent[2]) {
    dueAt = since + WAIT[2]
    if (age >= WAIT[2]) action = 'reply2'
  } else {
    dueAt = since + WAIT.close
    if (age >= WAIT.close) action = 'close'
  }
  return { action, since, dueAt, sent, last, firstSeen: sameAsBefore && previous.firstSeen ? previous.firstSeen : now }
}

function remember(sheetRow, username, decision, now = Date.now()) {
  const state = load()
  const last = decision.last
  state.rows[sheetRow] = {
    username,
    checkedAt: now,
    lastOurs: Boolean(last?.ours),
    lastText: last ? last.text.slice(0, 80) : '',
    lastAt: last?.at || null,
    firstSeen: last?.ours ? decision.firstSeen : null,
    action: decision.action,
    dueAt: decision.dueAt || 0,
    reason: decision.reason || '',
    // Held back by the conversation check: not looked at again until the chat changes (a new message).
    held: decision.held || '',
  }
  save(state)
}

// When a row should be looked at again: right away if never checked or something is due; when its
// next step falls due if our message is waiting (at least 12 hours after the last look); a day after
// the last look when it is our turn.
function nextCheck(sheetRow, now = Date.now()) {
  const row = load().rows[sheetRow]
  if (!row) return 0
  if (row.action && row.action !== 'none') return 0
  if (!row.lastOurs) return row.checkedAt + RECHECK_THEIR_TURN
  // Held (loop closed, or unclear): a quick look every few days in case they wrote.
  if (row.held) return row.checkedAt + 3 * DAY
  return Math.max(row.dueAt || 0, row.checkedAt + RECHECK_MIN)
}

// The step a row was found due for at its last look (reply1, reply2, close), if any.
function pending(sheetRow) {
  const row = load().rows[sheetRow]
  return row && row.action !== 'none' ? row.action : ''
}

function checksToday(now = Date.now()) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return Object.values(load().rows).filter((row) => row.checkedAt >= start.getTime()).length
}

// The Replied conversations due for a look, oldest due first, within today's checks.
// Every relaunch or close-out due by the clock first passes the conversation check (reply-check.js
// conversationOpen), since 11 Oct: a GIF had gone to a creator whose conversation had moved to email.
const PAUSED = false

function queue(yesRows, data, now = Date.now()) {
  if (PAUSED) return []
  const left = Math.max(0, CHECKS_PER_DAY - checksToday(now))
  return yesRows
    .filter((row) => String(row.accepted || '').trim().toLowerCase() === 'replied' && data.usernameFrom(row.link))
    .filter((row) => !log.claimedByOther(`reply:${row.sheetRow}`))
    .map((row) => ({ sheetRow: row.sheetRow, username: data.usernameFrom(row.link), name: row.name, link: row.link, at: nextCheck(row.sheetRow, now) }))
    .filter((item) => item.at <= now)
    .sort((a, b) => a.at - b.at)
    .slice(0, left)
}

function summary(yesRows, data) {
  const state = load().rows
  const replied = yesRows.filter((row) => String(row.accepted || '').trim().toLowerCase() === 'replied')
  const counts = { conversations: replied.length, checked: 0, ourTurn: 0, waitingOnThem: 0 }
  for (const row of replied) {
    const seen = state[row.sheetRow]
    if (!seen) continue
    counts.checked++
    if (seen.lastOurs) counts.waitingOnThem++
    else counts.ourTurn++
  }
  return { ...counts, due: queue(yesRows, data).length }
}

module.exports = { decide, remember, queue, used, summary, nextCheck, pending, TEXT_2, WAIT, CHECKS_PER_DAY }

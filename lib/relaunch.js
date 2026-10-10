// Relaunches: a creator on Accepted? = Pending gets a reminder DM 48 hours after the first message,
// then a second one 3 days after that (Accepted? = Relaunched). The sheet records the dates in
// OUTREACH MSG #2 DATE (the blank-headed column after #1) and OUTREACH MSG #3 DATE.
const fs = require('fs')
const path = require('path')
const writer = require('./sheet-writer')
const data = require('./data')
const sheet = require('./sheet')
const sharedLog = require('./shared-log')

const DIR = path.join(__dirname, '..', 'data', 'relaunch')
const TEMPLATE_PATH = path.join(DIR, 'templates.json')
const LOG_PATH = path.join(DIR, 'sent-log.jsonl')
const DAY_MS = 24 * 60 * 60 * 1000

const STAGES = {
  1: { from: 'pending', to: 'Relaunched', waitDays: 2, dateKey: 'relaunchDate', column: 'relaunch', label: 'Relaunch' },
  2: { from: 'relaunched', to: '2nd Relanched', waitDays: 3, dateKey: 'secondDate', column: 'second', label: '2nd relaunch' },
}

// Relaunches never include a name: a wrongly guessed first name is worse than none.
const DEFAULT_TEMPLATES = {
  1: 'Hey 👋 just bumping this in case it got buried. Would love to hear what you think!',
  2: 'Hey, last nudge from me 🙏 Happy to share more if you’re keen, and no worries at all if not!',
}

function parseDay(text) {
  const match = String(text || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!match) return null
  const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]))
  return Number.isNaN(date.getTime()) ? null : date
}

function startOfToday() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

// The date the step before this one happened: the first message for stage 1, the relaunch for stage 2.
function previousDate(row, stage) {
  if (stage === 1) return parseDay(row.voiceDate) || parseDay(row.firstDate)
  return parseDay(row.relaunchDate)
}

function readLog() {
  if (!fs.existsSync(LOG_PATH)) return []
  return fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

// Rows already handled for a stage, on this computer (local log) or the other one (shared log), so a
// sheet write that failed after sending can never cause a second DM.
let handledCache = { at: 0, sets: {} }
function handled(stage) {
  if (Date.now() - handledCache.at > 2000) {
    const sets = { 1: new Set(), 2: new Set() }
    for (const entry of readLog()) sets[entry.stage]?.add(entry.sheetRow)
    for (const entry of sharedLog.list((item) => item.action === 'dm')) {
      const match = entry.detail.match(/^relaunch([12]):(\d+)( failed)?$/)
      if (match) sets[match[1]].add(Number(match[2]))
    }
    // Creators left out on the Relaunch screen are never relaunched automatically.
    for (const entry of sharedLog.list((item) => item.action === 'skip')) {
      const match = entry.target.match(/^relaunch([12]):(\d+)$/)
      if (match) sets[match[1]].add(Number(match[2]))
    }
    handledCache = { at: Date.now(), sets }
  }
  return handledCache.sets[stage]
}

function inStage(row, stage) {
  return String(row.accepted || '').trim().toLowerCase() === STAGES[stage].from
    && Boolean(data.usernameFrom(row.link))
    && !handled(stage).has(row.sheetRow)
}

function dueOn(row, stage) {
  const before = previousDate(row, stage)
  return before ? new Date(before.getTime() + STAGES[stage].waitDays * DAY_MS) : null
}

function isDue(row, stage) {
  const due = dueOn(row, stage)
  return !due || due <= startOfToday()
}

function present(row, stage) {
  const before = previousDate(row, stage)
  return {
    sheetRow: row.sheetRow,
    name: row.name || 'Untitled',
    first: firstName(row.name),
    username: data.usernameFrom(row.link),
    link: row.link,
    followers: row.followers,
    location: row.location,
    device: row.device,
    voice: row.voice,
    notes: row.notes,
    message: row.message,
    accepted: row.accepted,
    previousDate: before ? before.toISOString() : '',
    firstDate: row.voiceDate || row.firstDate || '',
    relaunchDate: row.relaunchDate || '',
  }
}

// Freshest leads first (most recently messaged), then rows with no date on record.
function due(yesRows, stage) {
  return yesRows
    .filter((row) => inStage(row, stage) && isDue(row, stage))
    .sort((a, b) => {
      const da = previousDate(a, stage)
      const db = previousDate(b, stage)
      if (da && db) return db - da
      if (da) return -1
      if (db) return 1
      return a.sheetRow - b.sheetRow
    })
    .map((row) => present(row, stage))
}

function summary(yesRows, stage) {
  const waiting = yesRows.filter((row) => inStage(row, stage) && !isDue(row, stage))
  const next = waiting.map((row) => dueOn(row, stage)).sort((a, b) => a - b)[0]
  return {
    due: yesRows.filter((row) => inStage(row, stage) && isDue(row, stage)).length,
    waiting: waiting.length,
    nextDue: next ? next.toISOString() : '',
    sentToday: sentToday(stage),
  }
}

function firstName(name) {
  const word = String(name || '').split(/[|•·,\-–—(]/)[0].trim().split(/\s+/)[0] || ''
  const letters = word.replace(/[^\p{L}'’]/gu, '')
  if (letters.length < 2) return ''
  return letters[0].toUpperCase() + letters.slice(1).toLowerCase()
}

function templates() {
  try {
    return { ...DEFAULT_TEMPLATES, ...JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8')) }
  } catch {
    return { ...DEFAULT_TEMPLATES }
  }
}

function saveTemplate(stage, text) {
  const next = { ...templates(), [stage]: withoutName(text).trim() }
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(TEMPLATE_PATH, JSON.stringify(next, null, 2))
  return next
}

function log(entry) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.appendFileSync(LOG_PATH, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`)
  handledCache.at = 0
}

// Counted from the shared log, so both computers' sends are included.
function sentToday(stage) {
  const today = new Date().toDateString()
  return sharedLog.list((entry) => entry.action === 'dm' && new RegExp(`^relaunch${stage}:\\d+$`).test(entry.detail) && new Date(entry.time).toDateString() === today).length
}

// The DM is already sent here, so the row is updated in memory and logged before the sheet write:
// if the write fails the creator must still not show up as due again.
async function markSent(row, stage, columns, message) {
  const step = STAGES[stage]
  const today = sheet.todayLabel()
  row.accepted = step.to
  row[step.dateKey] = today
  log({ stage, sheetRow: row.sheetRow, name: row.name, username: data.usernameFrom(row.link), message, result: 'sent' })
  writer.ensureAcceptedOption(step.to)
  await writer.setAccepted(row.sheetRow, step.to)
  const column = columns[step.column]
  if (column) await writer.setCells([{ cell: `${column}${row.sheetRow}`, value: today }])
}

async function markUnreachable(row, stage, reason) {
  await writer.setAccepted(row.sheetRow, 'NA')
  row.accepted = 'NA'
  log({ stage, sheetRow: row.sheetRow, name: row.name, username: data.usernameFrom(row.link), result: 'cannot message', reason: reason || '' })
}

// They answered in the chat: Accepted? becomes Replied (added to the dropdown if missing), so no
// relaunch step picks them up again and the sheet shows the conversation is live.
async function markReplied(row, stage, reason) {
  writer.ensureAcceptedOption('Replied')
  await writer.setAccepted(row.sheetRow, 'Replied')
  row.accepted = 'Replied'
  log({ stage, sheetRow: row.sheetRow, name: row.name, username: data.usernameFrom(row.link), result: 'replied', reason: reason || '' })
}

// Sent exactly as written. A {first} left in an older saved template is dropped, never filled in.
function messageFor(item, stage) {
  return withoutName(templates()[stage])
}

function withoutName(text) {
  return String(text || '').replace(/\s*\{first\}/g, '').replace(/^\s+/, '')
}

function leaveOut(stage, sheetRow) {
  handledCache.at = 0
  return sharedLog.append({ action: 'skip', target: `relaunch${stage}:${sheetRow}` })
}

// ---------- Closing out: unfollow ----------
// No reply 3 days after the 2nd relaunch: unfollow, Accepted? = unfollowed. Said no (judged from the
// chat, see reply-check.js): Accepted? = No, then unfollow. Both computers see the same state through
// the shared log: 'unfollow' actions (detail close:<row>) and skips (close:<row> done without an
// unfollow, unfollow:<row> a no waiting to be unfollowed).
const CLOSE_WAIT_DAYS = 3

function closeState() {
  const closed = new Set()
  const declined = new Map()
  for (const entry of sharedLog.list((item) => item.action === 'unfollow' || item.action === 'skip')) {
    if (entry.action === 'unfollow') {
      const match = String(entry.detail || '').match(/^close:(\d+)( failed)?$/)
      if (match) closed.add(Number(match[1]))
      continue
    }
    const match = String(entry.target || '').match(/^(close|unfollow):(\d+)$/)
    if (!match) continue
    if (match[1] === 'close') closed.add(Number(match[2]))
    else declined.set(Number(match[2]), entry.detail || '')
  }
  return { closed, declined }
}

function closeDueOn(row) {
  const second = parseDay(row.secondDate)
  return second ? new Date(second.getTime() + CLOSE_WAIT_DAYS * DAY_MS) : null
}

// Creators to close out now: those who said no first, then no reply after the 2nd relaunch (oldest
// 2nd relaunch first, undated ones last).
function closeDue(yesRows) {
  const { closed, declined } = closeState()
  const today = startOfToday()
  const items = []
  for (const row of yesRows) {
    if (closed.has(row.sheetRow) || !data.usernameFrom(row.link)) continue
    const accepted = String(row.accepted || '').trim().toLowerCase()
    if (declined.has(row.sheetRow)) {
      items.push({ ...present(row, 2), mode: 'declined', reason: declined.get(row.sheetRow) })
      continue
    }
    if (accepted !== STAGES[2].to.toLowerCase()) continue
    const due = closeDueOn(row)
    if (due && due > today) continue
    items.push({ ...present(row, 2), mode: 'no-reply', secondDate: row.secondDate || '', dueAt: due ? due.getTime() : 0 })
  }
  const rank = (item) => (item.mode === 'declined' ? 0 : item.dueAt ? 1 : 2)
  return items.sort((a, b) => rank(a) - rank(b) || a.dueAt - b.dueAt || a.sheetRow - b.sheetRow)
}

async function markClosed(row, value, reason) {
  writer.ensureAcceptedOption(value)
  await writer.setAccepted(row.sheetRow, value)
  row.accepted = value
  log({ stage: 3, sheetRow: row.sheetRow, name: row.name, username: data.usernameFrom(row.link), result: value, reason: reason || '' })
}

// Done with this creator without unfollowing (they replied and it is still going, we weren't
// following them, the chat could not be read...).
function closeWithoutUnfollow(sheetRow, reason) {
  return sharedLog.append({ action: 'skip', target: `close:${sheetRow}`, detail: String(reason || '').slice(0, 200) })
}

// They said no: unfollow them on a later Launch step.
function queueUnfollow(sheetRow, reason) {
  return sharedLog.append({ action: 'skip', target: `unfollow:${sheetRow}`, detail: String(reason || '').slice(0, 200) })
}

module.exports = {
  STAGES, due, summary, templates, saveTemplate, markSent, markUnreachable, markReplied, inStage, isDue, messageFor, leaveOut,
  closeDue, markClosed, closeWithoutUnfollow, queueUnfollow,
}

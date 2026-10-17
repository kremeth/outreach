const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const data = require('./lib/data')
const sheet = require('./lib/sheet')
const writer = require('./lib/sheet-writer')
const preview = require('./lib/ig-preview')
const drafts = require('./lib/comment-draft')
const instagram = require('./lib/ig-app')
const posts = require('./lib/ig-posts')
const hustle = require('./lib/hustle')
const relaunch = require('./lib/relaunch')
const sendQueue = require('./lib/send-queue')
const log = require('./lib/shared-log')
const autopilot = require('./lib/autopilot')
const training = require('./lib/training-log')
const migrations = require('./lib/row-migrations')
const replyCheck = require('./lib/reply-check')
const replyRelaunch = require('./lib/reply-relaunch')
const dmInbox = require('./lib/dm-inbox')
const partners = require('./lib/partners')
const dmReply = require('./lib/dm-reply')
const dmChats = require('./lib/dm-chats')
const runners = require('./lib/runners')
const unfollowCleanup = require('./lib/unfollow-cleanup')
const igGraph = require('./lib/ig-graph')
const dmMissed = require('./lib/dm-missed')
const voiceText = require('./lib/voice-transcribe')
const followingScraper = require('./lib/following-scraper')
const tempEnrich = require('./lib/temp-enrich')
const pickModel = require('./lib/pick-model')
const apiUsage = require('./lib/api-usage')
const modelProspect = require('./lib/model-prospect')

const ROOT = __dirname
const WEB = path.join(ROOT, 'web')
const PORT = Number(process.env.PORT) || 8787
const MEDIA_PORT = PORT + 1
const QUEUE_SIZE = 12
const PROSPECT_CLAIM_MS = 30 * 60 * 1000
const CREATOR_CLAIM_MS = 15 * 60 * 1000
const SHEET_REFRESH_MS = 15000

let rows = []
let yesRows = []
let outreachColumns = { relaunch: '', second: '' }
let sheetRefreshedAt = 0
let sheetRefreshing = null
let refreshError = ''
let byRow = new Map()
let decisions = {}
// Rows the other computer (or someone in the sheet) decided since this server loaded them.
const elsewhere = new Map()
let loadError = ''
let devices = ['Garmin', 'WHOOP', 'Apple Watch', 'Oura', 'Polar']
const signInNote = 'The sheet is not shared with the service account yet, so Yes and No cannot save.'

function choiceFor(row) {
  if (!row) return null
  return sheet.savedDecision(decisions, row)?.choice || elsewhere.get(row.sheetRow) || null
}

function sameLink(a, b) {
  const clean = (value) => String(value || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
  return clean(a) === clean(b)
}

// Live Keep hustling? and link for these rows, straight from the sheet.
async function liveRows(list) {
  if (!list.length) return new Map()
  const first = Math.min(...list.map((row) => row.sheetRow))
  const last = Math.max(...list.map((row) => row.sheetRow))
  const sample = list[0]
  const [links, keeps] = await writer.getValues([
    `${sample.linkColumn}${first}:${sample.linkColumn}${last}`,
    `${sample.keepColumn}${first}:${sample.keepColumn}${last}`,
  ])
  const live = new Map()
  for (const row of list) {
    const offset = row.sheetRow - first
    live.set(row.sheetRow, {
      link: String(links[offset]?.[0] || '').trim(),
      keep: String(keeps[offset]?.[0] || '').trim(),
    })
  }
  return live
}

function present(row, itemIndex) {
  return {
    index: itemIndex,
    name: row.NAME || 'Untitled',
    username: data.usernameFrom(row['DIRECT LINK']),
    followers: row.FOLLOWERS || '',
    email: row.EMAIL || '',
    location: row.LOCATION || '',
    notes: row.NOTES || '',
    ranking: row.ranking || '',
    engagement: row['Engagement Rate'] || '',
    link: row['DIRECT LINK'] || '',
    sheetRow: row.sheetRow,
    choice: choiceFor(row),
  }
}

function voiceStatus(row) {
  const accepted = String(row.accepted || '').trim().toLowerCase()
  if (accepted === 'na') return 'closed'
  if (accepted === 'pending') return 'sent'
  if (!String(row.device || '').trim()) return 'past'
  if (!accepted || accepted === 'not messaged') return 'to-send'
  return 'other'
}

// Yeses waiting for their first voicenote, minus those skipped because their chat was not empty.
function voiceQueue() {
  const skipped = new Set(log.list((entry) => entry.action === 'skip' && entry.target.startsWith('voice:')).map((entry) => Number(entry.target.slice(6))))
  return yesRows.filter((row) => voiceStatus(row) === 'to-send' && !skipped.has(row.sheetRow))
}

function presentYes(row) {
  return {
    sheetRow: row.sheetRow,
    name: row.name || 'Untitled',
    username: data.usernameFrom(row.link),
    followers: row.followers || '',
    location: row.location || '',
    link: row.link || '',
    device: row.device || '',
    accepted: row.accepted || '',
    voice: row.voice || '',
    voiceDate: row.voiceDate || '',
    status: voiceStatus(row),
    choice: 'yes',
  }
}

// Every Yes / No is also written to the shared log, so the other computer sees it within seconds
// (the sheet download it otherwise relies on is only refreshed now and then).
function logDecision(row, choice) {
  log.append({ action: 'decide', target: `row:${row.sheetRow}`, detail: choice }).catch((error) => console.error(error))
}

// Today's decisions from both computers, oldest first, as row -> choice.
function decisionsToday() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const latest = new Map()
  for (const entry of log.list((item) => item.action === 'decide' && item.time >= start.getTime())) {
    latest.set(Number(entry.target.slice(4)), { choice: entry.detail, machine: entry.machine })
  }
  return latest
}

function counts() {
  const live = decisionsToday()
  // The other computer's decisions count as decided here straight away.
  for (const [sheetRow, decision] of live) {
    if (decision.machine !== log.MACHINE && byRow.has(sheetRow) && !sheet.savedDecision(decisions, byRow.get(sheetRow))) {
      elsewhere.set(sheetRow, decision.choice)
    }
  }
  let remaining = 0
  for (const row of rows) {
    if (!choiceFor(row)) remaining++
  }
  const toSend = yesRows.filter((row) => voiceStatus(row) === 'to-send').length
  // Yes today, both computers: Yeses dated today in the sheet, updated by today's live decisions.
  const today = sheet.todayLabel()
  const yesSet = new Set(yesRows.filter((row) => row.date === today).map((row) => row.sheetRow))
  for (const [sheetRow, decision] of live) {
    if (decision.choice === 'yes') yesSet.add(sheetRow)
    else yesSet.delete(sheetRow)
  }
  return { total: rows.length, yesCount: yesRows.length, toSend, remaining, yesToday: yesSet.size, yesTarget: sendQueue.DAILY_LIMIT }
}

// The next profiles to review: not decided by anyone (checked live in the sheet), not claimed by the
// other computer, and then claimed for this one, so two people never review the same profile.
async function nextBatch(fromIndex, count) {
  await log.refresh(0)
  const picked = []
  let index = fromIndex + 1
  while (picked.length < count && index < rows.length) {
    const window = []
    for (; index < rows.length && window.length < count * 2; index++) {
      const row = rows[index]
      if (choiceFor(row) || log.claimedByOther(`row:${row.sheetRow}`)) continue
      // The model's Nos are not shown: the auto-No loop writes them to the sheet.
      if (modelProspect.saysNo(data.usernameFrom(row['DIRECT LINK'])) || modelProspect.saysYes(data.usernameFrom(row['DIRECT LINK']))) continue
      window.push(index)
    }
    if (!window.length) break
    const live = await liveRows(window.map((itemIndex) => rows[itemIndex]))
    const free = []
    for (const itemIndex of window) {
      const row = rows[itemIndex]
      const now = live.get(row.sheetRow)
      if (!now || !sameLink(now.link, row['DIRECT LINK'])) continue
      if (/^(yes|no)$/i.test(now.keep)) {
        elsewhere.set(row.sheetRow, now.keep.toLowerCase())
        continue
      }
      free.push(itemIndex)
    }
    const wanted = free.slice(0, count - picked.length)
    const held = new Set(await log.claimMany(wanted.map((itemIndex) => `row:${rows[itemIndex].sheetRow}`), PROSPECT_CLAIM_MS))
    for (const itemIndex of wanted) {
      if (held.has(`row:${rows[itemIndex].sheetRow}`)) picked.push(itemIndex)
    }
  }
  return picked.map((itemIndex) => present(rows[itemIndex], itemIndex))
}

function writeNote() {
  return writer.accessState === 'edit' ? '' : (writer.accessNote || signInNote)
}

async function initialState() {
  let queue = []
  let queueError = ''
  try {
    queue = await nextBatch(-1, QUEUE_SIZE)
  } catch (error) {
    console.error(error)
    queueError = 'Could not reach the Google Sheet to pick profiles.'
  }
  return {
    ...counts(),
    loadError: loadError || queueError,
    writeNote: writeNote(),
    sheetUrl: sheet.SHEET_URL,
    yesPath: data.prettyPath(data.YES_PATH),
    devices,
    mediaBase: `http://127.0.0.1:${MEDIA_PORT}`,
    queue,
    people: yesRows.map(presentYes),
  }
}

function rememberYes(row, device) {
  yesRows = yesRows.filter((item) => item.sheetRow !== row.sheetRow)
  yesRows.push({
    sheetRow: row.sheetRow,
    name: row.NAME || '',
    link: row['DIRECT LINK'] || '',
    followers: row.FOLLOWERS || '',
    location: row.LOCATION || '',
    device: device || '',
    accepted: 'Not messaged',
    voice: '',
    voiceDate: '',
    date: sheet.todayLabel(),
  })
}

// A row this server did not load at boot (decided before it started, or added to the sheet since):
// rebuilt from the live sheet, but only if it still holds the creator the screen showed.
async function adoptRow(sheetRow, link) {
  const template = rows[0]
  if (!template || !sheetRow || !link) return null
  const [[liveLink = '']] = (await writer.getValues([`${template.linkColumn}${sheetRow}`])).map((values) => values[0] || [])
  if (!sameLink(liveLink, link)) return null
  const row = {
    sheetRow,
    keepColumn: template.keepColumn,
    linkColumn: template.linkColumn,
    dateColumn: template.dateColumn,
    deviceColumn: template.deviceColumn,
    acceptedColumn: template.acceptedColumn,
    NAME: '',
    'DIRECT LINK': String(liveLink).trim(),
  }
  byRow.set(sheetRow, row)
  return row
}

// The undecided profiles split by where the wearable model is with them: for the person to judge,
// decided by the model (written to the sheet within a minute or two), or still being checked.
// A row without an Instagram link is always for the person.
function modelProgress() {
  let forYou = 0
  let auto = 0
  let judging = 0
  for (const row of rows) {
    if (choiceFor(row)) continue
    const username = data.usernameFrom(row['DIRECT LINK'])
    const state = username ? modelProspect.stateOf(username) : 'review'
    if (state === 'review') forYou++
    else if (state === 'auto') auto++
    else judging++
  }
  const written = modelProspect.autoTotals()
  const today = modelProspect.todayStats()
  return { forYou, auto, judging, modelYes: written.yes, modelNo: written.no, modelToday: today }
}

// The next undecided profiles in queue order, for the wearable model to judge ahead of the person
// (data/wearable/live-list.json, read by python -m wearable.live and wearable/acquire.js --watch).
function writeUpcoming(count = Infinity) {
  const upcoming = rows.filter((row) => !choiceFor(row)).slice(0, count).map((row) => ({ sheetRow: row.sheetRow, username: data.usernameFrom(row['DIRECT LINK']) })).filter((item) => item.username)
  fs.mkdirSync(path.dirname(modelProspect.LIST), { recursive: true })
  const tmp = `${modelProspect.LIST}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(upcoming))
  fs.renameSync(tmp, modelProspect.LIST)
  return upcoming
}

// The wearable model's Nos go straight into the sheet: rows nobody decided and nobody is looking at
// (not claimed by either computer), checked live in the sheet first and written only into an empty or
// "pending" Keep cell of the same creator, never over an answer. One read and one write per pass (both computers
// share the sheet's per-minute quota), at most 20 rows, once a minute.
let autoNoBusy = false
// Rows whose Keep cell turned out to hold something already (any value): never candidates again.
const autoNoSettled = new Set()
async function autoNo() {
  if (autoNoBusy || !rows.length || loadError) return
  autoNoBusy = true
  let wrote = []
  const before = decisions
  try {
    await log.refresh() // the other computer's claims, at most a few seconds old
    const candidates = []
    for (const row of rows) {
      if (candidates.length >= 20) break
      if (choiceFor(row) || autoNoSettled.has(row.sheetRow)) continue
      const username = data.usernameFrom(row['DIRECT LINK'])
      if (!username || !modelProspect.saysNo(username)) continue
      const target = `row:${row.sheetRow}`
      if (log.claimedByOther(target) || log.heldByMe(target)) continue
      candidates.push(row)
    }
    if (!candidates.length) return
    const live = await liveRows(candidates)
    const updates = []
    const skipped = { link: 0, decided: 0 }
    for (const row of candidates) {
      const now = live.get(row.sheetRow)
      if (!now || !sameLink(now.link, row['DIRECT LINK'])) {
        skipped.link++
        autoNoSettled.add(row.sheetRow)
        continue
      }
      // "pending" is what an undecided row holds; anything else is someone's answer and stays.
      if (now.keep && !/^pending$/i.test(now.keep)) {
        skipped.decided++
        autoNoSettled.add(row.sheetRow)
        skipped.values = [...new Set([...(skipped.values || []), now.keep])].slice(0, 5)
        if (/^(yes|no)$/i.test(now.keep)) elsewhere.set(row.sheetRow, now.keep.toLowerCase())
        continue
      }
      if (row.dateColumn) updates.push({ cell: `${row.dateColumn}${row.sheetRow}`, value: sheet.todayLabel() })
      updates.push({ cell: `${row.keepColumn}${row.sheetRow}`, value: 'No' })
      decisions = sheet.record(decisions, row, 'no')
      wrote.push(row)
    }
    if (!updates.length) {
      console.log(`auto no: nothing to write (${JSON.stringify(skipped)})`)
      return
    }
    await writer.setCells(updates)
    sheet.persist(rows, decisions)
    for (const row of wrote) modelProspect.logAuto({ sheetRow: row.sheetRow, username: data.usernameFrom(row['DIRECT LINK']) })
    console.log(`model wrote No for ${wrote.length} rows`)
  } catch (error) {
    if (wrote.length) decisions = before
    console.error('auto no', error.message)
  } finally {
    autoNoBusy = false
  }
}

// Saving is idempotent and never overwrites: an answer the sheet already holds counts as saved, someone
// else's answer is never replaced, and a temporary failure is retried (retry: true becomes a 503).
// by = 'model': the wearable model's own decision (auto No or auto Yes), from autoYes or the Prospecting screen.
// Auto-commenting (trial, 11 Oct): for each creator with a new post, the 5 comments are drafted as
// usual and the pick model's top one is picked, exactly like a person's pick; Launch then posts it with
// a like within the usual limits. On for a set time (data/hustle/auto-comment.json). It keeps at most
// AUTO_AHEAD picks waiting for Launch (the posts stay fresh and nothing is drafted for nothing) and at
// most DAILY_PICKS a day. Logged in the training tab as 'auto picked' (never used to train the model).
const AUTO_COMMENT_PATH = path.join(__dirname, 'data', 'hustle', 'auto-comment.json')
const AUTO_AHEAD = 6
const DAILY_PICKS = 50
let autoCommentBusy = false
// Posts auto-commenting gave up on (unreadable, taken...): kept on disk so a restart never loads them again.
const PASSED_PATH = path.join(__dirname, 'data', 'auto-comment-passed.json')
const autoCommentPassed = (() => {
  let list = []
  try { list = JSON.parse(fs.readFileSync(PASSED_PATH, 'utf8')) } catch {}
  const set = new Set(list.slice(-2000))
  const add = set.add.bind(set)
  set.add = (key) => {
    add(key)
    try { fs.writeFileSync(PASSED_PATH, JSON.stringify([...set].slice(-2000))) } catch {}
    return set
  }
  return set
})()

function autoCommentState() {
  try {
    return JSON.parse(fs.readFileSync(AUTO_COMMENT_PATH, 'utf8'))
  } catch {
    return { until: 0 }
  }
}

function setAutoComment(state) {
  fs.mkdirSync(path.dirname(AUTO_COMMENT_PATH), { recursive: true })
  fs.writeFileSync(AUTO_COMMENT_PATH, JSON.stringify(state, null, 1))
  return autoCommentStatus()
}

function autoCommentStatus() {
  const state = autoCommentState()
  const today = new Date().toDateString()
  const picks = (state.picks || []).filter((pick) => new Date(pick.at).toDateString() === today)
  // Armed: the trial's hours start counting at its first automatic pick (the person's own picks waiting
  // for Launch go first).
  // always: on until Stop is pressed (since 14 Oct), no end time.
  const on = Boolean(state.armed) && (state.always || !state.until || Date.now() < state.until)
  return { on, always: Boolean(state.always), armed: Boolean(state.armed), until: state.always ? 0 : state.until || 0, hours: state.hours || 0, pickedToday: picks.length, waiting: hustle.picks().length, last: (state.picks || []).slice(-5).reverse(), note: state.note || '' }
}

async function autoComment() {
  const state = autoCommentState()
  if (autoCommentBusy || !autoCommentStatus().on) return
  autoCommentBusy = true
  try {
    await log.refresh(5000) // the shared log first: the picks waiting for Launch come from it
    if (!log.list(() => true).length) return // not loaded yet (just restarted)
    if (autoCommentStatus().pickedToday >= DAILY_PICKS || hustle.picks().length >= AUTO_AHEAD) return
    const next = hustle.queue().find((item) => !autoCommentPassed.has(`${item.username}:${item.latest.pk}`))
    if (!next) return
    const key = `${next.username}:${next.latest.pk}`
    let drafted
    try {
      drafted = await commentDrafts(next.username, [], '', { background: true })
    } catch (error) {
      autoCommentPassed.add(key) // taken by the other computer, already handled, unreadable: next one
      console.error('auto comment', next.username, error.message)
      return
    }
    const scores = drafted.scores
    if (!Array.isArray(scores) || scores.length !== drafted.comments.length) {
      autoCommentPassed.add(key)
      setAutoComment({ ...state, note: 'The pick model did not score the comments, so nothing was picked.' })
      return
    }
    const index = scores.indexOf(Math.max(...scores))
    const text = drafted.comments[index]
    if (hustle.alreadyHandled(next.username, drafted.pk)) return
    await hustle.pick(next.username, { pk: String(drafted.pk), code: String(drafted.code), text })
    training.record({
      username: next.username, name: drafted.name, followers: drafted.followers, bio: drafted.bio, pk: drafted.pk, code: drafted.code,
      caption: drafted.caption, description: drafted.description, transcript: drafted.transcript, format: drafted.format,
      predicted: scores, comments: drafted.comments, outcome: 'auto picked', pickedIndex: index + 1, pickedText: text, seconds: 0,
    })
    const fresh = autoCommentState()
    setAutoComment({ ...fresh, note: '', until: fresh.always ? 0 : fresh.until || Date.now() + (fresh.hours || 24) * 3600 * 1000, picks: [...(fresh.picks || []), { at: new Date().toISOString(), username: next.username, text, score: scores[index], code: drafted.code }].slice(-500) })
    console.log(`auto comment @${next.username}: "${text}" (${scores[index]}%)`)
  } catch (error) {
    console.error('auto comment', error.message)
  } finally {
    autoCommentBusy = false
  }
}

// The wearable model's automatic Yes (all three gauges pass: wearable 85+, profile 65+, device 80+):
// written through decide like a person's Yes (live check, never over an answer, device for the
// voicenote), a few per minute, only for rows nobody is looking at.
let autoYesBusy = false
async function autoYes() {
  if (autoYesBusy || !rows.length || loadError) return
  autoYesBusy = true
  try {
    let written = 0
    for (const row of rows) {
      if (written >= 5) break
      if (choiceFor(row) || autoNoSettled.has(row.sheetRow)) continue
      const username = data.usernameFrom(row['DIRECT LINK'])
      const device = username && modelProspect.saysYes(username)
      if (!device || !devices.includes(device)) continue
      const target = `row:${row.sheetRow}`
      if (log.claimedByOther(target) || log.heldByMe(target)) continue
      const result = await decide(row.sheetRow, 'yes', device, row['DIRECT LINK'], 'model')
      if (result.ok) {
        written++
        console.log(`model wrote Yes (${device}) for row ${row.sheetRow} @${username}`)
      } else {
        autoNoSettled.add(row.sheetRow)
        if (result.retry) break
      }
    }
  } catch (error) {
    console.error('auto yes', error.message)
  } finally {
    autoYesBusy = false
  }
}

async function decide(sheetRow, choice, device, link, by = '') {
  if (choice !== 'yes' && choice !== 'no') return { ok: false, taken: true, error: 'Unknown choice. Nothing was saved.', ...counts() }
  if (choice === 'yes' && !devices.includes(device)) return { ok: false, taken: true, error: 'No device was picked. Nothing was saved.', ...counts() }
  let row = byRow.get(Number(sheetRow))
  try {
    if (!row) row = await adoptRow(Number(sheetRow), link)
  } catch (error) {
    console.error(error)
    return { ok: false, retry: true, error: 'Could not reach the sheet. It will retry.', ...counts() }
  }
  if (!row) return { ok: false, taken: true, error: `Row ${sheetRow} no longer holds this creator in the sheet. Nothing was saved.`, ...counts() }
  // The answer must be about the creator the screen showed, not whatever this row number holds now.
  if (link && !sameLink(link, row['DIRECT LINK'])) {
    return { ok: false, taken: true, error: `Row ${sheetRow} holds a different creator than the one on screen. Nothing was saved.`, ...counts() }
  }
  const key = String(row.sheetRow)
  const previous = decisions[key]
  let liveChoice = ''
  try {
    const now = (await liveRows([row])).get(row.sheetRow)
    if (!now || !sameLink(now.link, row['DIRECT LINK'])) {
      return { ok: false, taken: true, error: `Row ${row.sheetRow} no longer holds ${row.NAME || 'this creator'} in the sheet. Nothing was saved.`, ...counts() }
    }
    liveChoice = now.keep.toLowerCase()
    const mine = sheet.savedDecision(decisions, row)?.choice || ''
    if ((liveChoice === 'yes' || liveChoice === 'no') && liveChoice !== mine && liveChoice !== choice) {
      elsewhere.set(row.sheetRow, liveChoice)
      return { ok: false, taken: true, error: `${row.NAME || 'This profile'} was already marked ${now.keep} by someone else. Nothing was overwritten.`, ...counts() }
    }
  } catch (error) {
    console.error(error)
    return { ok: false, retry: true, error: 'Could not check the sheet before saving. It will retry.', ...counts(), writeNote: writeNote() }
  }
  decisions = sheet.record(decisions, row, choice)
  // The wearable model's answer for this profile, kept next to the person's (local log only).
  try {
    if (by === 'model') modelProspect.logAuto({ sheetRow: row.sheetRow, username: data.usernameFrom(row['DIRECT LINK']), choice, device: choice === 'yes' ? device : '', from: 'screen' })
    else modelProspect.record({ sheetRow: row.sheetRow, username: data.usernameFrom(row['DIRECT LINK']), choice, device: choice === 'yes' ? device : '' })
  } catch (error) {
    console.error('model compare', error.message)
  }
  // Already in the sheet (a save that landed before a restart, re-sent from the outbox): done.
  if (liveChoice === choice) {
    if (choice === 'yes' && !yesRows.some((item) => item.sheetRow === row.sheetRow)) rememberYes(row, device)
    if (choice === 'no') yesRows = yesRows.filter((item) => item.sheetRow !== row.sheetRow)
    sheet.persist(rows, decisions)
    logDecision(row, choice)
    return { ok: true, already: true, ...counts(), writeNote: writeNote() }
  }
  const updates = []
  if (row.dateColumn) {
    updates.push({ cell: `${row.dateColumn}${row.sheetRow}`, value: sheet.todayLabel() })
  }
  updates.push({ cell: `${row.keepColumn}${row.sheetRow}`, value: choice === 'yes' ? 'Yes' : 'No' })
  if (row.deviceColumn) {
    updates.push({ cell: `${row.deviceColumn}${row.sheetRow}`, value: choice === 'yes' ? device : '' })
  }
  try {
    if (row.acceptedColumn) await writer.setAccepted(row.sheetRow, choice === 'yes' ? 'Not messaged' : '')
    await writer.setCells(updates)
    if (choice === 'yes') rememberYes(row, device)
    else yesRows = yesRows.filter((item) => item.sheetRow !== row.sheetRow)
    sheet.persist(rows, decisions)
    logDecision(row, choice)
    return { ok: true, ...counts(), writeNote: writeNote() }
  } catch (error) {
    if (decisions[key] && decisions[key].choice === choice) {
      const restored = { ...decisions }
      if (previous) restored[key] = previous
      else delete restored[key]
      decisions = restored
    }
    console.error(error)
    return { ok: false, retry: true, error: error.message || 'Could not update Keep hustling. It will retry.', ...counts(), writeNote: writeNote() }
  }
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  return 'application/octet-stream'
}

function serveStatic(res, urlPath) {
  const requested = urlPath === '/' ? '/index.html' : urlPath
  const filePath = path.normalize(path.join(WEB, requested))
  if (!filePath.startsWith(WEB)) {
    send(res, 403, 'Forbidden', 'text/plain; charset=utf-8')
    return
  }
  fs.readFile(filePath, (error, file) => {
    if (error) {
      send(res, 404, 'Not found', 'text/plain; charset=utf-8')
      return
    }
    send(res, 200, file, contentType(filePath))
  })
}

// A creator's profile: Meta's official API first (no logged-out page, so no walls), the logged-out
// preview for personal accounts or when the API is not set up or out of calls for the hour.
async function profileOf(username, urgent) {
  if (igGraph.available()) {
    try {
      return await igGraph.profile(username)
    } catch (error) {
      if (error.kind === 'token') console.error('graph', error.message)
    }
  }
  return preview.profile(username, urgent)
}

// The newest post by date, not the first grid tile, which is often a pinned post.
// urgent: false for background work (auto-commenting), inside the shared hourly allowance.
async function latestPost(username, urgent = true) {
  let profile = await profileOf(username, urgent)
  let post = posts.latestPost(profile)
  if (!post?.image) {
    preview.forget(username)
    profile = await preview.profile(username, urgent)
    post = posts.latestPost(profile)
  }
  if (!post) throw Object.assign(new Error('Could not find the latest post.'), { kind: 'read' })
  if (!post.image) throw Object.assign(new Error('Found the latest post but could not read its photo.'), { kind: 'read' })
  if (hustle.person(username)) hustle.refreshFrom(username, profile)
  return { profile, post, permalink: posts.permalink(post) }
}

function taken(message) {
  return Object.assign(new Error(message), { kind: 'taken' })
}

// Everything Gemini should see of a post: the full video (with sound) for a reel, every slide for a
// carousel, the photo otherwise. Read logged out, never through the Instagram account. If the post
// page can't be read, the cover photo alone is used and the reply says so.
const INLINE_BYTES = 12 * 1024 * 1024
const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const MAX_SLIDES = 20

async function readPost(post, photo, urgent = true) {
  const cover = async (note) => ({
    format: 'photo',
    media: [await preview.downloadImage(photo.full || photo.src)],
    caption: photo.alt || '',
    slides: 0,
    note,
  })
  let full
  try {
    full = await preview.post(post.code, urgent)
  } catch (error) {
    console.error('post page', post.code, error.message)
    return cover(error.kind === 'missing' ? '' : 'Read from the cover photo only: the full post did not load.')
  }
  const caption = full.caption.length > (photo.alt || '').length ? full.caption : (photo.alt || '')
  try {
    if (full.mediaType === 2 && full.video) {
      const video = await preview.downloadImage(full.video, MAX_VIDEO_BYTES)
      const media = video.bytes > INLINE_BYTES ? await drafts.upload(video) : video
      return { format: 'video', media: [media], caption, slides: 0, note: '' }
    }
    if (full.mediaType === 8 && full.slides.length) {
      const slides = full.slides.slice(0, MAX_SLIDES)
      let budget = INLINE_BYTES
      const media = []
      // Photos first so they always fit; a video slide is sent whole if there is room, else its cover.
      const images = await Promise.all(slides.map((slide) => (slide.image ? preview.downloadImage(slide.image).catch(() => null) : null)))
      for (const image of images) if (image) budget -= image.bytes
      for (let index = 0; index < slides.length; index++) {
        let item = images[index]
        if (slides[index].video && budget > 0) {
          const video = await preview.downloadImage(slides[index].video, budget).catch(() => null)
          if (video) {
            budget -= video.bytes - (item?.bytes || 0)
            item = video
          }
        }
        if (item) media.push(item)
      }
      if (!media.length) throw new Error('No slide could be downloaded.')
      return { format: 'carousel', media, caption, slides: slides.length, note: full.slides.length > MAX_SLIDES ? `Read the first ${MAX_SLIDES} of ${full.slides.length} slides.` : '' }
    }
    if (full.image) return { format: 'photo', media: [await preview.downloadImage(full.image)], caption, slides: 0, note: '' }
  } catch (error) {
    console.error('post media', post.code, error.message)
    return cover(error.kind === 'too-big' ? 'Read from the cover photo only: the video is too long to watch.' : 'Read from the cover photo only: the full post could not be downloaded.')
  }
  return cover('')
}

// Pick predictions start as soon as comments are drafted or rewritten, so they are usually ready by
// the time the creator is on screen; the page's own request picks up the same work.
const scoreJobs = new Map()
function scoreFor({ comments, description = '', caption = '', transcript = '' }) {
  const clip = (value, max) => String(value || '').slice(0, max)
  const list = (Array.isArray(comments) ? comments : []).map((text) => clip(text, 300))
  const key = JSON.stringify(list)
  const existing = scoreJobs.get(key)
  if (existing && Date.now() - existing.at < 60 * 60 * 1000) return existing.promise
  const promise = pickModel.score({ comments: list, description: clip(description, 1500), caption: clip(caption, 1500), transcript: clip(transcript, 3000), machine: log.MACHINE })
  promise.catch(() => scoreJobs.delete(key))
  scoreJobs.set(key, { at: Date.now(), promise })
  while (scoreJobs.size > 300) scoreJobs.delete(scoreJobs.keys().next().value)
  return promise
}

// The page's code version: when it changes, an open window reloads itself (see web/tasks.js).
const WEB_FILES = ['index.html', 'app.js', 'tasks.js', 'styles.css']
function webVersion() {
  const hash = crypto.createHash('sha1')
  for (const name of WEB_FILES) {
    try { hash.update(fs.readFileSync(path.join(__dirname, 'web', name))) } catch {}
  }
  return hash.digest('hex').slice(0, 12)
}

async function commentDrafts(username, avoid = [], guidance = '', { background = false } = {}) {
  const claimed = await log.claim(`hustle:${String(username).toLowerCase()}`, CREATOR_CLAIM_MS)
  if (!claimed.ok) throw taken(`${claimed.by} is working on @${username} right now.`)
  // Auto-commenting (background): few loads (about 2 per comment, at Launch's pace), so it goes with the
  // screen's preloads instead of waiting behind the hourly background allowance.
  const { profile, post, permalink } = await latestPost(username, background ? 'screen' : true)
  if (hustle.alreadyHandled(username, post.pk)) throw taken(`@${username}'s newest post was already commented on or skipped.`)
  const photo = post.image
  const read = await readPost(post, photo, background ? 'screen' : true)
  const drafted = await drafts.generate({
    name: profile.name,
    username: profile.username || username,
    bio: profile.bio,
    caption: read.caption,
    format: read.format,
    media: read.media,
    // Photos and carousel slides at Gemini's low resolution: ~77% fewer tokens, comments just as
    // specific in a side-by-side test (slide text still read). Reels keep the default, for on-screen text.
    mediaResolution: read.format === 'video' ? '' : 'MEDIA_RESOLUTION_LOW',
    avoid: avoid.map((text) => String(text).slice(0, 300)).slice(0, 15),
    guidance: String(guidance || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  })
  const result = {
    permalink,
    pk: post.pk,
    code: post.code,
    kind: post.kind,
    postedAt: post.at,
    caption: read.caption,
    format: read.format,
    slides: read.slides,
    readNote: read.note,
    bio: profile.bio || '',
    name: profile.name || '',
    followers: profile.followers || '',
    image: photo.src,
    full: photo.full || photo.src,
    description: drafted.description,
    transcript: drafted.transcript,
    comments: drafted.comments,
  }
  // The pick predictor's chances come back with the comments, so they show on load (it takes about
  // 3 seconds; if it is ever slower, the page gets the comments now and the chances right after).
  const scored = await withTimeout(scoreFor({ comments: result.comments, description: result.description, caption: result.caption, transcript: result.transcript }), 10000).catch(() => null)
  result.scores = scored?.percent || null
  result.judge = scored?.judge || null
  return result
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))])
}

async function postComment({ permalink, message, username, pk, code, kind }) {
  const text = String(message || '').trim()
  if (!/^https:\/\/www\.instagram\.com\/(p|reel)\/[A-Za-z0-9_-]+\/?$/.test(String(permalink || ''))) {
    throw new Error('That post link is not usable.')
  }
  if (!text || text.length > 300) throw new Error('Pick one of the comments.')
  if (!username || !/^\d+$/.test(String(pk || ''))) throw new Error('Open the creator again, the post details are missing.')
  const link = /^[A-Za-z0-9_-]+$/.test(String(code || '')) ? posts.permalink({ code }) : permalink
  // Never comment twice: not if this or the other computer already handled the post, nor while they have it open.
  await log.refresh(0)
  if (hustle.alreadyHandled(username, pk)) return { ok: false, duplicate: true, error: 'This post was already commented on or skipped (maybe from the other computer). Nothing was posted.' }
  const claimed = await log.claim(`hustle:${String(username).toLowerCase()}`, CREATOR_CLAIM_MS)
  if (!claimed.ok) return { ok: false, taken: true, error: `${claimed.by} is working on @${username}. Nothing was posted.` }
  // An earlier attempt that stopped before Post may already have liked the post; that like is ours.
  const handle = String(username).toLowerCase()
  const allowLiked = log.list((entry) => entry.action === 'comment' && entry.target === handle && entry.detail === `${pk} notsent`).length > 0
  let result
  try {
    result = await instagram.engage({ permalink: link, message: text, username: handle, pk: String(pk), allowLiked })
  } catch (error) {
    if (error.kind === 'duplicate') {
      await hustle.skip(username, pk).catch((skipError) => console.error(skipError))
      return { ok: false, duplicate: true, error: error.message }
    }
    throw error
  }
  hustle.recordComment(username, { pk: String(pk), code: code || '', kind: kind || 'p' }, text)
  return result
}

function refreshSheet(force) {
  if (sheetRefreshing) return sheetRefreshing
  if (!force && Date.now() - sheetRefreshedAt < SHEET_REFRESH_MS) return Promise.resolve()
  sheetRefreshing = sheet.loadPending()
    .then((loaded) => {
      yesRows = loaded.yesRows || []
      outreachColumns = loaded.outreachColumns || outreachColumns
      const pending = new Set((loaded.rows || []).map((row) => row.sheetRow))
      for (const row of rows) {
        if (!pending.has(row.sheetRow) && !sheet.savedDecision(decisions, row)) elsewhere.set(row.sheetRow, 'done')
      }
      sheetRefreshedAt = Date.now()
      refreshError = ''
    })
    .finally(() => {
      sheetRefreshing = null
    })
  return sheetRefreshing
}

async function guardStatus() {
  try {
    return { app: true, ...(await instagram.guard()) }
  } catch (error) {
    return { app: false, error: error.message }
  }
}

async function todo() {
  const guard = await guardStatus()
  const voice = voiceQueue()
  await log.refresh(10000).catch(() => {})
  return {
    guard,
    dms: dmsForPage(),
    scraper: { ...followingScraper.summary(), enrich: tempEnrich.summary() },
    partners: await partnersForPage(),
    prospecting: { remaining: counts().remaining, ...modelProgress(), total: rows.length, yesToday: counts().yesToday, yesTarget: sendQueue.DAILY_LIMIT, health: runners.health.message },
    voice: { toSend: voice.length, sentToday: Math.max(sendQueue.sentToday(), guard.app ? guard.kinds.voice.today : 0), limit: sendQueue.DAILY_LIMIT },
    hustle: { ...hustle.status(), auto: autoCommentStatus() },
    relaunch: { 1: relaunch.summary(yesRows, 1), 2: relaunch.summary(yesRows, 2) },
    warnings: [loadError, refreshError, writeNote(), igGraph.warning()].filter(Boolean),
    sheetRefreshedAt: sheetRefreshedAt ? new Date(sheetRefreshedAt).toISOString() : '',
  }
}

async function sendRelaunch(stage, sheetRow, message) {
  const step = relaunch.STAGES[stage]
  if (!step) throw new Error('Unknown relaunch step.')
  const row = yesRows.find((item) => item.sheetRow === Number(sheetRow))
  if (!row || !relaunch.inStage(row, stage)) throw new Error(`${row?.name || 'This creator'} is no longer waiting for a ${step.label.toLowerCase()}.`)
  const text = String(message || '').trim()
  if (!text || text.length > 1000) throw new Error('Write the message first.')
  const username = data.usernameFrom(row.link)
  // Never message twice: hold the creator, then confirm in the live sheet that nobody moved them on.
  const claimed = await log.claim(`relaunch:${row.sheetRow}`, CREATOR_CLAIM_MS)
  if (!claimed.ok) return { ok: false, taken: true, error: `${claimed.by} is working on @${username}. Nothing was sent.` }
  const [liveLink, liveAccepted] = (await writer.getValues([`${outreachColumns.link}${row.sheetRow}`, `${outreachColumns.accepted}${row.sheetRow}`]))
    .map((values) => String(values?.[0]?.[0] || '').trim())
  if (!sameLink(liveLink, row.link)) return { ok: false, taken: true, error: `Row ${row.sheetRow} no longer holds @${username} in the sheet. Nothing was sent.` }
  if (liveAccepted.toLowerCase() !== step.from) {
    row.accepted = liveAccepted
    return { ok: false, taken: true, error: `@${username} is now "${liveAccepted || 'blank'}" in the sheet, so no ${step.label.toLowerCase()} was sent.` }
  }
  try {
    // The app reads the chat first and refuses if they have replied (see threadAllows in app/instagram.js).
    const viaVoice = Boolean(String(row.voice || '').trim() || String(row.voiceDate || '').trim())
    await instagram.sendDm({ username, message: text, detail: `relaunch${stage}:${row.sheetRow}`, expect: { stage, viaVoice } })
  } catch (error) {
    if (error.kind === 'replied' || error.kind === 'mismatch') {
      await relaunch.leaveOut(stage, row.sheetRow).catch((logError) => console.error(logError))
      // They wrote back: read what they said. A clear no is marked No and unfollowed on a later
      // Launch step; anything else (or no verdict) is marked Replied as before.
      if (error.kind === 'replied') {
        const verdict = await replyCheck.classify(error.thread).catch((checkError) => {
          console.error('reply check', checkError.message)
          return null
        })
        if (verdict?.verdict === 'no') {
          await relaunch.queueUnfollow(row.sheetRow, verdict.reason).catch((logError) => console.error(logError))
          try {
            await relaunch.markClosed(row, 'No', verdict.reason)
            return { ok: false, replied: true, error: `@${username} said no (${verdict.reason}). Marked No in the sheet; Launch will unfollow them.` }
          } catch (writeError) {
            console.error(writeError)
            return { ok: false, replied: true, error: `@${username} said no, so no relaunch was sent and Launch will unfollow them, but the sheet could not be updated: ${writeError.message}` }
          }
        }
      }
      // Only a chat with a message from them is marked Replied; any other mismatch just leaves them out.
      if (error.kind === 'replied') {
        try {
          await relaunch.markReplied(row, stage, error.message)
          return { ok: false, replied: true, error: `@${username} replied. Marked Replied in the sheet, no relaunch sent.` }
        } catch (writeError) {
          console.error(writeError)
          return { ok: false, replied: true, error: `@${username} replied, so no relaunch was sent, but the sheet could not be updated: ${writeError.message}` }
        }
      }
      return { ok: false, replied: true, error: `@${username}: ${error.message} Left out of relaunches.` }
    }
    if (error.kind === 'unreachable') {
      await relaunch.markUnreachable(row, stage, error.message).catch((writeError) => console.error(writeError))
      return { ok: false, unreachable: true, error: `Can't message @${username}. Marked NA in the sheet.` }
    }
    // Deleted or renamed account: nothing to relaunch. Leave them out first so Launch never retries,
    // even if the sheet write fails.
    if (error.kind === 'missing') {
      await relaunch.leaveOut(stage, row.sheetRow).catch((logError) => console.error(logError))
      await relaunch.markUnreachable(row, stage, error.message).catch((writeError) => console.error(writeError))
      return { ok: false, unreachable: true, error: `@${username}'s Instagram account no longer exists. Marked NA in the sheet, no relaunch sent.` }
    }
    throw error
  }
  try {
    await relaunch.markSent(row, stage, outreachColumns, text)
    return { ok: true }
  } catch (error) {
    console.error(error)
    return { ok: true, warning: `Sent, but the sheet did not update: ${error.message || 'unknown error'}` }
  }
}

// Closing a creator out: unfollow after no reply to the 2nd relaunch (checking the chat first), or
// after they said no. Held with a claim and re-checked against the live sheet, like relaunches.
async function closeOut(sheetRow, mode) {
  if (mode === 'cleanup') return cleanupUnfollow(String(sheetRow).replace(/^cleanup:/, ''))
  const row = yesRows.find((item) => item.sheetRow === Number(sheetRow))
  if (!row) throw new Error('This creator is no longer in the sheet.')
  const username = data.usernameFrom(row.link)
  const claimed = await log.claim(`close:${row.sheetRow}`, CREATOR_CLAIM_MS)
  if (!claimed.ok) return { ok: false, taken: true, error: `${claimed.by} is working on @${username}. Nothing was done.` }
  const [liveLink, liveAccepted] = (await writer.getValues([`${outreachColumns.link}${row.sheetRow}`, `${outreachColumns.accepted}${row.sheetRow}`]))
    .map((values) => String(values?.[0]?.[0] || '').trim())
  if (!sameLink(liveLink, row.link)) return { ok: false, taken: true, error: `Row ${row.sheetRow} no longer holds @${username} in the sheet. Nothing was done.` }
  // A quiet conversation after both reply relaunches: only while it is still "Replied".
  if (mode === 'reply-stale' && liveAccepted.toLowerCase() !== 'replied') {
    row.accepted = liveAccepted
    return { ok: false, taken: true, error: `@${username} is now "${liveAccepted || 'blank'}" in the sheet, so they were not unfollowed.` }
  }
  if (mode === 'no-reply' && liveAccepted.toLowerCase() !== relaunch.STAGES[2].to.toLowerCase()) {
    row.accepted = liveAccepted
    return { ok: false, taken: true, error: `@${username} is now "${liveAccepted || 'blank'}" in the sheet, so they were not unfollowed.` }
  }
  // A no that someone has since changed by hand (they came back, it was a misread...) is left alone.
  if (mode === 'declined' && liveAccepted.toLowerCase() !== 'no') {
    await relaunch.closeWithoutUnfollow(row.sheetRow, `sheet says ${liveAccepted || 'blank'}, not No`)
    return { ok: false, error: `@${username} is "${liveAccepted || 'blank'}" in the sheet, not No, so they were not unfollowed.` }
  }
  // Unfollowed (or not followed in the first place): Keep hustling? becomes No, so they are done for good.
  // Only after the unfollow: a creator who said no stays Yes until Launch has unfollowed them.
  const keepNo = async () => {
    if (!outreachColumns.keep) return ''
    try {
      await writer.setCells([{ cell: `${outreachColumns.keep}${row.sheetRow}`, value: 'No' }])
      yesRows = yesRows.filter((item) => item.sheetRow !== row.sheetRow)
      return ''
    } catch (writeError) {
      console.error(writeError)
      return ` Keep hustling could not be set to No: ${writeError.message}`
    }
  }
  // They can't receive our messages (NA): only while the sheet still says NA.
  if (mode === 'unreachable' && liveAccepted.toLowerCase() !== 'na') {
    await relaunch.closeWithoutUnfollow(row.sheetRow, `sheet says ${liveAccepted || 'blank'}, not NA`)
    return { ok: false, error: `@${username} is "${liveAccepted || 'blank'}" in the sheet, not NA, so they were not unfollowed.` }
  }
  let result
  try {
    result = await instagram.unfollow({ username, sheetRow: row.sheetRow, checkChat: mode === 'no-reply' })
  } catch (error) {
    if (error.kind === 'missing' && mode === 'unreachable') {
      await relaunch.closeWithoutUnfollow(row.sheetRow, 'account no longer exists').catch((logError) => console.error(logError))
      const note = await keepNo()
      return { ok: false, error: `@${username}'s Instagram account no longer exists. Keep hustling set to No.${note}` }
    }
    if (error.kind === 'missing') {
      await relaunch.closeWithoutUnfollow(row.sheetRow, 'account no longer exists').catch((logError) => console.error(logError))
      await relaunch.markUnreachable(row, 3, error.message).catch((writeError) => console.error(writeError))
      return { ok: false, error: `@${username}'s Instagram account no longer exists. Marked NA in the sheet.` }
    }
    if (error.kind === 'mismatch') {
      await relaunch.closeWithoutUnfollow(row.sheetRow, error.message).catch((logError) => console.error(logError))
      return { ok: false, error: `@${username}: ${error.message} Left out of unfollows.` }
    }
    throw error
  }
  const sheetWrite = async (value, reason) => {
    try {
      await relaunch.markClosed(row, value, reason)
      return ''
    } catch (writeError) {
      console.error(writeError)
      return ` The sheet could not be updated: ${writeError.message}`
    }
  }
  if (result.replied) {
    // Without a verdict nothing changes; Launch tries again later (and gives up after 2 tries).
    const verdict = await replyCheck.classify(result.thread).catch((error) => {
      throw Object.assign(new Error(`Could not judge @${username}'s reply: ${error.message}`), { kind: 'notsent' })
    })
    if (verdict.verdict === 'no') {
      await relaunch.queueUnfollow(row.sheetRow, verdict.reason)
      const note = await sheetWrite('No', verdict.reason)
      return { ok: false, declined: true, error: `@${username} said no (${verdict.reason}). Marked No; unfollowing them next.${note}` }
    }
    await relaunch.closeWithoutUnfollow(row.sheetRow, `replied: ${verdict.reason}`)
    try {
      await relaunch.markReplied(row, 3, verdict.reason)
    } catch (writeError) {
      console.error(writeError)
    }
    return { ok: false, replied: true, error: `@${username} replied and it's still going (${verdict.reason}). Marked Replied, not unfollowed.` }
  }
  const value = mode === 'declined' ? 'No' : mode === 'unreachable' ? 'NA' : 'unfollowed'
  const reason = mode === 'declined' ? 'said no' : mode === 'unreachable' ? 'cannot receive our messages' : mode === 'reply-stale' ? 'no answer 3 days after both reply relaunches' : 'no reply 3 days after the 2nd relaunch'
  if (result.notFollowing) {
    await relaunch.closeWithoutUnfollow(row.sheetRow, 'was not following them')
    const note = (String(liveAccepted).toLowerCase() === value.toLowerCase() ? '' : await sheetWrite(value, `${reason} (was not following)`)) + await keepNo()
    return { ok: false, error: `@${username}: we were not following them, nothing to unfollow. Marked ${value}, Keep hustling No.${note}` }
  }
  const note = (String(liveAccepted).toLowerCase() === value.toLowerCase() ? '' : await sheetWrite(value, reason)) + await keepNo()
  return { ok: true, warning: note.trim() }
}

// Background reads in the Instagram panel (no action, nothing sent), only when Launch is not about to use
// it, inside its daily window: the DM inbox every 20 minutes (DMs to reply), our own stories every 4 hours
// (Story ticks for ongoing partnerships). Partners' posts are read once a day with the logged-out preview.
const OUR_ACCOUNT = process.env.OUR_INSTAGRAM || 'nutricode.io'
const panelReads = { inbox: 0, stories: 0, posts: 0, busy: false, errors: {} }

function panelFree() {
  const pilot = autopilot.status()
  if (pilot.current) return false
  if (pilot.running && pilot.nextAt && pilot.nextAt - Date.now() < 100 * 1000) return false
  const hour = new Date().getHours()
  return hour >= 8 && hour < 21
}

// A conversation showing "can't receive your message": NA in the sheet (Launch then unfollows them and
// sets Keep hustling to No). Only for creators we contacted (Keep hustling Yes).
// The inbox shows display names: matched to the sheet's NAME (case and spacing aside), only when exactly
// one creator we contacted has that name.
async function markUnreachableByUsername(name, inboxRow) {
  const norm = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const matches = yesRows.filter((item) => norm(item.name) === norm(name))
  if (matches.length !== 1) return false
  const row = matches[0]
  if (String(row.accepted || '').trim().toLowerCase() === 'na') return true
  await relaunch.markUnreachable(row, 3, `can't receive our messages (seen in the inbox: ${inboxRow.name})`)
  return true
}

// A partner mentioning nutricode.io in their story shows in the DM inbox ("Mentioned you in their story"):
// their story is ticked and dated (the reel countdown starts). The inbox shows display names, matched to
// the partner through the contact list's NAME (or the username itself). A story already dated keeps its
// date (the month started with the first one).
async function partnerStoryMentions() {
  const inbox = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'dm-inbox.json'), 'utf8')) } catch { return { rows: [] } } })()
  const mentions = (inbox.rows || []).filter((row) => /mentioned you in (their|a|his|her) story/i.test(row.preview || ''))
  if (!mentions.length) return
  const list = await partners.list()
  const norm = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  for (const mention of mentions) {
    const named = [...rows, ...yesRows].filter((row) => norm(row.name || row['NAME']) === norm(mention.name)).map((row) => data.usernameFrom(row.link || row['DIRECT LINK'])).filter(Boolean)
    const partner = list.find((item) => named.includes(item.username) || norm(item.username) === norm(mention.name))
    if (!partner || (partner.story && partner.storyDated)) continue
    // When: the row's age ("3h", "2d", "1w") back from the inbox read.
    const age = String(mention.age || '').match(/^(\d+)\s*([mhdw])/i)
    const ms = age ? Number(age[1]) * { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[age[2].toLowerCase()] : 0
    const when = new Date((inbox.scannedAt || Date.now()) - ms)
    await partners.mark(partner.username, 'story', true, `${when.toLocaleDateString('en-AU')} · mentioned us in their story`, when, { keepDate: true })
    console.log(`partner @${partner.username}: story mention, ${when.toLocaleDateString('en-AU')}`)
  }
}

async function checkPartnerPosts() {
  for (const partner of await partners.list()) {
    if (partner.post) continue
    try {
      const profile = await preview.profile(partner.username, false)
      const hit = (profile.images || []).find((image) => /nutricode/i.test(image.alt || ''))
      if (hit) await partners.mark(partner.username, 'post', true, `${new Date().toLocaleDateString('en-AU')} · ${hit.code ? `instagram.com/p/${hit.code}` : 'caption names nutricode'}`)
    } catch (error) {
      panelReads.errors.posts = `${partner.username}: ${error.message}`
    }
  }
}

// DMs to reply: each conversation matched to the creator we contacted (by name, only when exactly one
// matches), for their username and who sent the first voicenote (Romain or Mathieu); and the state of a
// reply sent from the list.
let sentLogCache = { mtime: 0, map: new Map() }
function voiceSenderOf(username) {
  const key = String(username || '').toLowerCase()
  if (!key) return ''
  const valid = (value) => (/^(romain|mathieu)$/i.test(String(value || '').trim()) ? String(value).trim()[0].toUpperCase() + String(value).trim().slice(1).toLowerCase() : '')
  const yes = yesRows.find((row) => data.usernameFrom(row.link) === key)
  if (valid(yes?.voice)) return valid(yes.voice)
  const any = rows.find((row) => data.usernameFrom(row['DIRECT LINK'] || row.link || '') === key)
  if (any && valid(any['Voice'] || any.voice)) return valid(any['Voice'] || any.voice)
  // Picked by hand once (for creators contacted before Outreach tracked voicenotes).
  try {
    const picked = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'voice', 'picked-senders.json'), 'utf8'))
    if (valid(picked[key])) return valid(picked[key])
  } catch {}
  try {
    const file = path.join(__dirname, 'data', 'voice', 'sent-log.jsonl')
    const mtime = fs.statSync(file).mtimeMs
    if (mtime !== sentLogCache.mtime) {
      const map = new Map()
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        try {
          const entry = JSON.parse(line)
          if (entry.username && entry.voice && entry.result === 'sent') map.set(String(entry.username).toLowerCase(), entry.voice)
        } catch {}
      }
      sentLogCache = { mtime, map }
    }
    return valid(sentLogCache.map.get(key))
  } catch {
    return ''
  }
}

// A conversation's username from its display name: the saved chat, then the sheet (one exact match).
function usernameForName(name) {
  const chat = dmChats.chatOf(name, '')
  if (chat?.username) return chat.username
  const norm = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const matches = yesRows.filter((row) => norm(row.name) === norm(name))
  return matches.length === 1 ? data.usernameFrom(matches[0].link) : ''
}

// The "No reply needed" saved by name only (before they were kept by username): moved over once the
// sheet is loaded.
let dismissMigrated = false
function migrateDismissed() {
  if (dismissMigrated || !yesRows.length) return
  dismissMigrated = true
  let moved = 0
  for (const [name, preview] of Object.entries(dmInbox.dismissedNames())) {
    const username = usernameForName(name)
    if (username && !dmMissed.isHandled(username, preview, -1)) {
      dmMissed.dismiss(username, preview)
      moved++
    }
  }
  if (moved) console.log(`dm dismissed: ${moved} kept by username now`)
}

// How many followers someone has, as a number (0 unknown): the sheet first, then the profile the
// wearable model downloaded.
function followersOf(username) {
  const key = String(username || '').replace(/^@/, '').toLowerCase()
  if (!key) return 0
  const parse = (text) => {
    const match = String(text || '').replace(/,/g, '').match(/([\d.]+)\s*([kKmM]?)/)
    return match ? Math.round(parseFloat(match[1]) * ({ k: 1e3, m: 1e6 }[match[2].toLowerCase()] || 1)) : 0
  }
  const yes = yesRows.find((row) => data.usernameFrom(row.link) === key)
  if (parse(yes?.followers)) return parse(yes.followers)
  const any = rows.find((row) => data.usernameFrom(row['DIRECT LINK'] || '') === key)
  if (parse(any?.FOLLOWERS)) return parse(any.FOLLOWERS)
  try {
    const saved = parse(JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'wearable', 'profiles', `${key}.json`), 'utf8')).followers)
    if (saved) return saved
  } catch {}
  // Nowhere on this Mac: looked up once through Meta's API in the background (kept in
  // data/followers-cache.json; a failed lookup is tried again after a day).
  const cached = followersCache()[key]
  if (cached?.followers) return cached.followers
  if (!cached || Date.now() - cached.at > 86400000) lookupFollowers(key)
  return 0
}

const FOLLOWERS_CACHE = path.join(__dirname, 'data', 'followers-cache.json')
function followersCache() {
  try { return JSON.parse(fs.readFileSync(FOLLOWERS_CACHE, 'utf8')) } catch { return {} }
}
const followerLookups = new Set()
function lookupFollowers(username) {
  if (followerLookups.has(username) || !igGraph.available()) return
  followerLookups.add(username)
  // Meta busy (paused, hour used up): nothing is kept, so it is tried again on a later refresh.
  // A personal account (Meta's API only sees creator and business ones): its public profile page instead.
  const fromPage = () => preview.profile(username, false).then((profile) => {
    const match = String(profile.followers || '').replace(/,/g, '').match(/([\d.]+)\s*([kKmM]?)/)
    return match ? Math.round(parseFloat(match[1]) * ({ k: 1e3, m: 1e6 }[match[2].toLowerCase()] || 1)) : 0
  }).catch(() => null)
  igGraph.lookup(username).then((found) => found.followers || 0).catch((error) => (error.kind === 'rate' ? null : error.kind === 'not-business' ? fromPage() : 0)).then((followers) => {
    if (followers === null) return
    const cache = followersCache()
    cache[username] = { followers, at: Date.now() }
    fs.writeFileSync(FOLLOWERS_CACHE, JSON.stringify(cache, null, 1))
  }).finally(() => followerLookups.delete(username))
}

async function partnersForPage() {
  return (await partners.list().catch(() => [])).map((partner) => ({ ...partner, followers: followersOf(partner.username) }))
}

function dmsForPage({ all = false } = {}) {
  migrateDismissed()
  const summary = dmInbox.summary()
  const norm = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const sent = dmReply.byName()
  summary.toReply = summary.toReply.map((item) => {
    const matches = yesRows.filter((row) => norm(row.name) === norm(item.name))
    const row = matches.length === 1 ? matches[0] : null
    return { ...item, username: row ? data.usernameFrom(row.link) : '', voice: row && /^(romain|mathieu)$/i.test(row.voice || '') ? row.voice : '', reply: sent[item.name] || null }
  }).map((item) => ({
    ...item,
    // A reply sent before this inbox read: they wrote again since, so it is a new conversation turn.
    reply: item.reply && item.reply.status === 'sent' && item.reply.sentAt < summary.scannedAt ? null : item.reply,
    draftReady: Boolean(dmChats.draftFor(item, dmReply.MODEL)),
  }))
  // Missed replies found in chats read for other reasons (however old): added as unread, unless the
  // inbox already lists them, or the inbox shows our message last (answered since).
  const inboxRows = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'dm-inbox.json'), 'utf8')).rows || [] } catch { return [] } })()
  const listed = new Set(summary.toReply.map((item) => item.username).filter(Boolean))
  for (const missed of dmMissed.list()) {
    if (listed.has(missed.username)) continue
    const row = yesRows.find((entry) => data.usernameFrom(entry.link) === missed.username)
    const name = missed.name || row?.name || `@${missed.username}`
    const inbox = inboxRows.find((entry) => norm(entry.name) === norm(name))
    // Answered since (the inbox shows ours last, or a reply went out from here after their message).
    const sentAt = dmReply.lastSentTo(missed.username)
    // (Only with their message's own time: a remembered line from an older check has none to compare.)
    if ((inbox && inbox.ours) || (sentAt && !missed.partial && missed.at && sentAt > missed.at + 60 * 1000)) {
      dmMissed.answered(missed.username)
      continue
    }
    if (summary.toReply.some((item) => norm(item.name) === norm(name))) continue
    const at = missed.at || missed.notedAt
    const days = Math.floor((Date.now() - at) / 86400000)
    summary.toReply.push({
      name, username: missed.username, unread: true, missed: true,
      age: days >= 7 ? `${Math.floor(days / 7)}w` : days >= 1 ? `${days}d` : `${Math.max(1, Math.round((Date.now() - at) / 3600000))}h`,
      voice: row && /^(romain|mathieu)$/i.test(row.voice || '') ? row.voice : '',
      tag: dmInbox.tagOf(missed.text), preview: missed.text, rawPreview: missed.text,
      reply: sent[name] || null,
    })
  }
  summary.toReply = summary.toReply.map((item) => (item.missed ? { ...item, draftReady: Boolean(dmChats.draftFor(item, dmReply.MODEL)) } : item))
  // Their messages since our last one, from the chat saved on this Mac (when it is up to date: it ends
  // with theirs), so all of them show at once, voicenotes with their transcript.
  summary.toReply = summary.toReply.map((item) => {
    const chat = dmChats.chatOf(item.name, item.username)
    const messages = (chat?.messages || []).filter((message) => message.ours || !dmMissed.SYSTEM.test(String(message.text || '').trim()))
    if (!messages.length || messages[messages.length - 1].ours) return item
    const lastOurs = messages.map((message) => message.ours).lastIndexOf(true)
    return { ...item, recent: messages.slice(lastOurs + 1).slice(-10), username: item.username || chat.username || '' }
  })
  // A like, reaction or attachment last in the inbox: the saved chat (read after it showed) says who wrote
  // the last real message. Theirs: listed with that message. Ours: nothing to answer, left out.
  summary.toReply = summary.toReply.flatMap((item) => {
    if (!item.check) return [item]
    const saved = dmChats.chatOf(item.name, item.username)
    if (!saved || (saved.readAt || 0) < (item.firstSeen || 0)) return [item]
    const last = dmMissed.theirLast(saved.messages)
    if (!last || last.unreachable) return []
    return [{ ...item, check: false, preview: last.text, rawPreview: last.text, username: item.username || saved.username || '' }]
  })
  // Only conversations that are ready are shown: read in full (voicenotes transcribed) and a reply
  // drafted. The others are being prepared in the background (counted, not shown). One that could not be
  // read after three tries is shown anyway, with what is known.
  const ready = (item) => {
    if (item.reply && item.reply.status !== 'failed') return true
    if ((readTries.get(`${item.name}#count`) || 0) >= 3) return true
    if (needsReading(item)) return false
    if (dmChats.draftFor(item, dmReply.MODEL)) return true
    const saved = dmChats.chatOf(item.name, item.username)
    return Boolean(saved && Date.now() - saved.readAt > 5 * 60 * 1000) // a draft that would not come
  }
  const reactions = dmReply.reactions()
  summary.toReply = summary.toReply.map((item) => (reactions[item.name] ? { ...item, reactions: reactions[item.name] } : item))
  // Who sent them the first voicenote (Message 2 comes from the same person): by username, from the
  // sheet (the creators we contacted, then the whole contact list), then this Mac's send log.
  summary.toReply = summary.toReply.map((item) => (item.voice || !item.username ? item : { ...item, voice: voiceSenderOf(item.username) }))
  // Dealt with before (answered or "No reply needed"), by username: that same message never comes back.
  summary.toReply = summary.toReply.filter((item) => {
    const username = item.username || dmChats.chatOf(item.name, '')?.username || ''
    // The inbox shows their message last: listed unless "No reply needed" was pressed on that message.
    return !username || !dmMissed.isHandled(username, item.rawPreview || item.preview, item.missed ? 0 : -1, !item.missed)
  })
  // (Likes not checked yet are not counted: most turn out to be a like of our message.)
  summary.preparing = summary.toReply.filter((item) => !ready(item) && !item.check).length
  if (!all) summary.toReply = summary.toReply.filter(ready)
  // Answered from here: off the list straight away (queued or sending), and once sent until the inbox
  // is read again (then it is gone for good, unless they wrote again). A failed send stays, with why.
  const answered = (item) => item.reply && (['queued', 'sending'].includes(item.reply.status) || (item.reply.status === 'sent' && item.reply.sentAt >= summary.scannedAt))
  summary.outgoing = dmReply.outgoing().filter((entry) => entry.kind !== 'read')
  summary.sendingNow = Date.now() < replyNowUntil
  summary.toReply = summary.toReply.filter((item) => !answered(item)).map((item) => ({ ...item, followers: followersOf(item.username) }))
  return summary
}

// Sends the queued replies, one at a time, when Launch is not using Instagram. Busy, paused or waiting
// on a limit: stays queued and is tried again. Anything else: marked failed with the reason.
let replySending = false
let replyNowUntil = 0 // "Send now": the queued replies go out even outside Launch's hours, for 3 hours
async function sendQueuedReplies() {
  if (replySending) return
  const pilot = autopilot.status()
  if (pilot.current) return
  // In a gap between Launch's actions (its next one at least a minute away).
  if (pilot.running && pilot.nextAt && pilot.nextAt - Date.now() < 60 * 1000) return
  // Same hours as Launch, unless "Send now" was pressed.
  const hour = new Date().getHours()
  if ((hour < 8 || hour >= 21) && Date.now() > replyNowUntil) return
  const item = dmReply.next()
  if (!item) return
  replySending = true
  try {
    let username = item.username
    if (!username) {
      const chat = await instagram.openInboxRow({ name: item.name, transcribe: false })
      username = chat.username
      if (!username) throw Object.assign(new Error('Could not find their username.'), { kind: 'notsent' })
    }
    dmReply.update(item.id, { status: 'sending', username, startedAt: Date.now() })
    let threadId = dmChats.chatOf(item.name, username)?.threadId || ''
    // No inbox address yet and the profile link says "no longer exists" (someone we don't follow,
    // restrictions): the conversation is found in the inbox list first, then used.
    if (!threadId && item.name) {
      try {
        const probe = await instagram.chatState({ username, transcribe: false })
        threadId = probe.threadId || ''
      } catch (error) {
        if (error.kind !== 'missing' && error.kind !== 'mismatch' && error.kind !== 'unreachable') throw error
        const chat = await instagram.openInboxRow({ name: item.name, transcribe: false })
        threadId = chat.threadId || ''
        if (threadId) dmChats.remember({ name: item.name, username: chat.username || username, messages: chat.messages || [], threadId })
      }
    }
    if (item.kind === 'voice') {
      // Message 2 is two voicenotes, part 1 then part 2 (each under Instagram's 1 minute), from whoever
      // sent the first one, sent back to back in one go (nothing in between). A part already sent is
      // never sent again.
      const parts = [1, 2].filter((part) => part > (item.sentParts || 0))
      try {
        await instagram.voiceReply({ username, threadId, clipNames: parts.map((part) => `${item.voice} Message 2 part ${part}.m4a`) })
        dmReply.update(item.id, { sentParts: 2 })
      } catch (error) {
        if (error.sentParts) dmReply.update(item.id, { sentParts: (item.sentParts || 0) + error.sentParts })
        throw error
      }
    } else if (item.kind === 'read') {
      // Only opens the chat (Instagram marks it read); nothing is sent.
      await instagram.chatState({ username, threadId })
    } else if (item.kind === 'react') {
      await instagram.react({ username, threadId, text: item.text, emoji: item.emoji })
    } else if (item.kind === 'like') {
      const result = await instagram.likeLast({ username, threadId })
      if (result?.already) console.log(`dm like @${username}: already liked`)
    } else await instagram.sendDm({ username, threadId, message: item.text, detail: 'reply' })
    dmReply.update(item.id, { status: 'sent', sentAt: Date.now() })
    if (item.kind !== 'react') dmMissed.answered(username)
    if (item.kind !== 'read' && item.kind !== 'react') dmChats.addOurs(item.name, item.kind === 'voice' ? { voice: true, text: `(${item.voice}'s Message 2 voicenotes, part 1 and part 2)` } : item.kind === 'like' ? { text: '(liked their last message ❤️)' } : { text: item.text })
    panelReads.inbox = 0 // the list refreshes on the next pass: this one is answered now
  } catch (error) {
    if (['wait', 'limit'].includes(error.kind)) {
      // Waiting on a safety limit: this one steps aside (the others keep going) until it has room.
      const daily = error.kind === 'limit' || /daily/i.test(error.message)
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(8, 0, 0, 0)
      dmReply.update(item.id, { status: 'queued', waitUntil: daily ? tomorrow.getTime() : Date.now() + Math.max(30000, error.waitMs || 60000), waitReason: error.message })
    } else if (['busy', 'hidden', 'app', 'timeout'].includes(error.kind)) dmReply.update(item.id, { status: 'queued' })
    else dmReply.update(item.id, { status: 'failed', error: error.message })
  } finally {
    replySending = false
  }
}

// A conversation read in full, for drafts and View chat: their voicenotes transcribed by Gemini (from
// the files the panel already loaded, nothing played), their profile picture kept, and the chat saved.
async function readFullChat({ name, username }) {
  const saved = dmChats.chatOf(name, username)
  let chat = null
  // By the conversation's own address when known, else the profile link; when that fails (someone we
  // don't follow, restrictions: "no longer exists"), found by its name in the inbox list.
  if (username || saved?.threadId) {
    try {
      chat = { ...(await instagram.chatState({ username, threadId: saved?.threadId || '', transcribe: true })), username }
    } catch (error) {
      if (!['missing', 'mismatch', 'unreachable', 'error'].includes(error.kind) || !name) throw error
    }
  }
  if (!chat) chat = await instagram.openInboxRow({ name, transcribe: true })
  const threadId = chat.threadId || saved?.threadId || ''
  let messages = chat.messages || []
  if (chat.username) messages = await voiceText.fill(instagram, chat.username, messages, threadId).catch((error) => { console.error('voicenotes', error.message); return messages })
  if (chat.username && chat.avatar) saveAvatar(chat.username, chat.avatar).catch(() => {})
  dmChats.remember({ name, username: chat.username || username, messages, threadId })
  return { ...chat, messages, threadId }
}

// Profile pictures for DMs to reply: the wearable model's copy when it has one, else the chat header's.
const AVATAR_DIR = path.join(__dirname, 'data', 'dm-avatars')
async function saveAvatar(username, url) {
  const file = path.join(AVATAR_DIR, `${String(username).replace(/[^\w.]/g, '')}.jpg`)
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 14 * 86400000) return
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) return
  fs.mkdirSync(AVATAR_DIR, { recursive: true })
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
}
function avatarFile(username) {
  const clean = String(username || '').replace(/[^\w.]/g, '')
  if (!clean) return ''
  for (const file of [path.join(AVATAR_DIR, `${clean}.jpg`), path.join(__dirname, 'data', 'wearable', 'images', clean, 'avatar.jpg')]) if (fs.existsSync(file)) return file
  return ''
}

// Replies drafted ahead for every conversation waiting on us (from the saved chat, or our first voicenote
// and their message from the inbox list), so "Write it for me" is instant. About $0.002 each, once per
// new message from them.
let predrafting = false
async function predraftReplies() {
  if (predrafting) return
  predrafting = true
  try {
    for (const item of dmsForPage({ all: true }).toReply) {
      if (dmChats.draftFor(item, dmReply.MODEL) || (item.reply && item.reply.status !== 'failed')) continue
      const history = dmChats.history(item)
      if (!history) continue
      try {
        const reply = await dmReply.draft({ name: item.name, messages: history.messages.slice(-20) })
        dmChats.rememberDraft(item, reply, history.complete ? 'chat' : 'list', dmReply.MODEL)
      } catch (error) {
        console.error('dm predraft', item.name, error.message)
        break
      }
    }
  } finally {
    predrafting = false
  }
}

// Every conversation waiting on us is read ahead (unread ones too: the person wants them ready), so
// when they open it the messages are there, voicenotes transcribed, and a reply drafted. In any gap of a
// minute or more between Launch's actions; a few at a time; one that failed is tried again 10 minutes
// later. Read again when they wrote something new since.
const readTries = new Map()
let readingAhead = false
function chatGap() {
  const pilot = autopilot.status()
  if (pilot.current || replySending) return false
  return !(pilot.running && pilot.nextAt && pilot.nextAt - Date.now() < 75 * 1000)
}
function needsReading(item) {
  const saved = dmChats.chatOf(item.name, item.username)
  if (!saved || !saved.messages?.length) return true
  // A like/attachment row: read once after it showed, to see who wrote last.
  if (item.check) return (saved.readAt || 0) < (item.firstSeen || 0)
  const scannedAt = dmInbox.summary().scannedAt || 0
  // A voicenote of theirs without words yet.
  const theirs = saved.messages.filter((message) => !message.ours)
  if (theirs.some((message) => message.voice && !String(message.text || '').replace(/\d+:\d{2}/, '').replace(/(view|hide) transcription|unable to transcribe,?\s*(try again)?/gi, '').trim())) return true
  if (saved.readAt > scannedAt) return false
  const latest = String(item.rawPreview || item.preview || '').trim()
  if (dmChats.HIDDEN_PREVIEW.test(latest) || !latest || /^·?$/.test(latest)) return saved.messages[saved.messages.length - 1]?.ours === true
  return !theirs.some((message) => String(message.text || '').trim() === latest)
}
async function readChatsAhead(limit = 6) {
  if (readingAhead) return
  readingAhead = true
  let read = 0
  try {
    for (const item of dmsForPage({ all: true }).toReply) {
      if (read >= limit || !chatGap()) break
      if (item.reply && item.reply.status !== 'failed') continue
      if (!needsReading(item)) continue
      if (Date.now() - (readTries.get(item.name) || 0) < 10 * 60 * 1000) continue
      readTries.set(item.name, Date.now())
      try {
        await readFullChat({ name: item.name, username: item.username })
        read++
      } catch (error) {
        panelReads.errors.chats = `${item.name}: ${error.message}`
        if (!['busy', 'wait', 'hidden'].includes(error.kind)) readTries.set(`${item.name}#count`, (readTries.get(`${item.name}#count`) || 0) + 1)
        if (['busy', 'wait', 'hidden', 'login', 'blocked'].includes(error.kind)) break
      }
    }
  } finally {
    readingAhead = false
  }
  predraftReplies().catch(() => {})
}

// A missed reply that is really a "no" (the same reply check Launch uses on relaunches): marked No in
// the sheet and unfollowed on a later Launch step, not listed. Partners are never closed out. Anything
// else stays on DMs to reply.
let checkingMissed = false
async function checkMissed() {
  if (checkingMissed) return
  checkingMissed = true
  try {
    const partnerNames = new Set((await partners.list().catch(() => [])).map((partner) => partner.username))
    for (const item of dmMissed.unchecked()) {
      // Only a chat read in full can close someone out; a single remembered line (chats checked before
      // 15 Oct) stays on the list for the person to judge.
      if (item.partial || !item.thread || !item.thread.some((message) => !message.ours)) {
        dmMissed.setVerdict(item.username, item.text, 'ongoing')
        continue
      }
      const verdict = await replyCheck.classify(item.thread).catch((error) => {
        console.error('dm missed check', item.username, error.message)
        return null
      })
      if (!verdict) break
      const row = yesRows.find((entry) => data.usernameFrom(entry.link) === item.username)
      if (verdict.verdict === 'no' && row && !partnerNames.has(item.username)) {
        await relaunch.queueUnfollow(row.sheetRow, verdict.reason).catch((error) => console.error(error))
        await relaunch.markClosed(row, 'No', verdict.reason).catch((error) => console.error(error))
        dmMissed.setVerdict(item.username, item.text, 'no', verdict.reason)
        console.log(`dm missed @${item.username}: said no (${verdict.reason}); marked No, Launch unfollows them`)
      } else dmMissed.setVerdict(item.username, item.text, 'ongoing', verdict.reason)
    }
  } finally {
    checkingMissed = false
  }
}

async function backgroundReads() {
  predraftReplies().catch(() => {})
  if (panelReads.busy) return
  panelReads.busy = true
  try {
    const now = Date.now()
    // Partners' reels are ticked by hand only (Mathieu, 15 Oct): a caption naming nutricode is not a
    // reel posted for the deal, so checkPartnerPosts no longer runs on its own.
    if (!panelFree()) return
    if (now - panelReads.inbox > 10 * 60 * 1000) {
      panelReads.inbox = now
      try {
        await dmInbox.scan(instagram, markUnreachableByUsername)
        await partnerStoryMentions().catch((error) => { panelReads.errors.mentions = error.message })
        await refreshSheet(true).catch(() => {})
      } catch (error) {
        panelReads.errors.inbox = error.message
      }
    }
    await readChatsAhead()
    if (!panelFree()) return
    if (now - panelReads.stories > 4 * 60 * 60 * 1000) {
      panelReads.stories = now
      try {
        const { frames } = await instagram.ourStories({ account: OUR_ACCOUNT })
        const list = await partners.list()
        for (const partner of list) {
          if (partner.story && partner.storyDated) continue
          const frame = frames.find((item) => item.names.includes(partner.username))
          if (frame) await partners.mark(partner.username, 'story', true, `${new Date().toLocaleDateString('en-AU')} · reposted on our story`, new Date(), { keepDate: true })
        }
      } catch (error) {
        panelReads.errors.stories = error.message
      }
    }
  } finally {
    panelReads.busy = false
  }
}

// Reply relaunches (lib/reply-relaunch.js): the Replied conversations due for a look.
async function replyQueue() {
  await refreshSheet(false).catch((error) => console.error(error))
  await log.refresh(0).catch((error) => console.error(error))
  // With today's reply relaunches used up, chats that only wait for one are left until tomorrow.
  const guard = await guardStatus().catch(() => null)
  const allowance = guard?.relaunch?.reply
  const sendsLeft = !allowance || allowance.today < allowance.limit
  return replyRelaunch.queue(yesRows, data).filter((item) => sendsLeft || !['reply1', 'reply2'].includes(replyRelaunch.pending(item.sheetRow)))
}

// One Replied conversation: read the chat (no action), decide, and when due send reply relaunch 1 (the
// Travolta GIF) or 2 (text), or close out (unfollow, Keep hustling No). Re-checked against the live
// sheet first, held with a claim so the other computer never does the same one.
async function replyStep(item) {
  const row = yesRows.find((entry) => entry.sheetRow === Number(item.sheetRow))
  if (!row) return { ok: false, error: 'This creator is no longer in the sheet.' }
  const username = data.usernameFrom(row.link)
  const claimed = await log.claim(`reply:${row.sheetRow}`, CREATOR_CLAIM_MS)
  if (!claimed.ok) return { ok: false, error: `${claimed.by} is working on @${username}.` }
  const [liveLink, liveAccepted] = (await writer.getValues([`${outreachColumns.link}${row.sheetRow}`, `${outreachColumns.accepted}${row.sheetRow}`]))
    .map((values) => String(values?.[0]?.[0] || '').trim())
  if (!sameLink(liveLink, row.link) || liveAccepted.toLowerCase() !== 'replied') {
    row.accepted = liveAccepted
    return { ok: false, error: `@${username} is no longer "Replied" in the sheet.` }
  }
  let chat
  try {
    chat = await instagram.chatState({ username })
    dmChats.remember({ username, messages: chat.messages })
  } catch (error) {
    // Instagram busy, paused, logged out, warning...: try again later as usual. Anything else about
    // this chat (gone, unreadable): looked at again tomorrow, not every few minutes.
    if (['busy', 'wait', 'hidden', 'login', 'blocked', 'app', 'timeout', 'limit'].includes(error.kind)) throw error
    replyRelaunch.remember(row.sheetRow, username, { action: 'none', reason: error.message })
    return { ok: false, error: `@${username}: ${error.message}` }
  }
  let decision = replyRelaunch.decide(row.sheetRow, chat.messages)
  // Due by the clock: first make sure the conversation is really waiting on them, in this chat. A
  // closed loop (moved to email or management, a thank-you, their reaction to our message, the next
  // step ours) or any doubt: no nudge and no unfollow; looked at again once someone writes.
  if (decision.action !== 'none') {
    const open = await replyCheck.conversationOpen(chat.messages)
    if (open.state !== 'waiting') decision = { ...decision, action: 'none', reason: `${open.state === 'closed' ? 'Loop closed' : 'Not clearly waiting on them'}: ${open.reason}`, held: open.state }
  }
  replyRelaunch.remember(row.sheetRow, username, decision)
  if (decision.action === 'none') return { ok: true, checked: true, username, reason: decision.reason || `waiting on them since ${new Date(decision.since).toLocaleDateString('en-AU')}`, dueAt: decision.dueAt }
  if (decision.action === 'close') {
    const result = await closeOut(row.sheetRow, 'reply-stale')
    if (result.ok || result.warning) replyRelaunch.remember(row.sheetRow, username, { ...decision, action: 'none', reason: 'closed out' })
    return { ...result, closed: true, username }
  }
  // A reply relaunch: within today's allowance of reply relaunches (10).
  const guard = await guardStatus()
  const allowance = guard.relaunch?.reply
  if (allowance && allowance.today >= allowance.limit) return { ok: false, limit: true, username, error: `Today's ${allowance.limit} reply relaunches are used up.` }
  const step = decision.action === 'reply2' ? 2 : 1
  try {
    await instagram.replyRelaunch({ username, sheetRow: row.sheetRow, step, text: step === 2 ? replyRelaunch.TEXT_2 : '', expectLast: { text: decision.last.text } })
  } catch (error) {
    if (error.kind === 'replied' || error.kind === 'mismatch') {
      replyRelaunch.remember(row.sheetRow, username, { action: 'none', reason: error.message, last: error.thread?.[error.thread.length - 1] })
      return { ok: false, username, error: error.message }
    }
    throw error
  }
  replyRelaunch.remember(row.sheetRow, username, { action: 'none', last: { ours: true, text: step === 2 ? replyRelaunch.TEXT_2 : '', at: Date.now() }, firstSeen: Date.now(), dueAt: Date.now() + (step === 2 ? replyRelaunch.WAIT.close : replyRelaunch.WAIT[2]) })
  return { ok: true, sent: step, username }
}

async function closeQueue() {
  await refreshSheet(false).catch((error) => console.error(error))
  await log.refresh(0).catch((error) => console.error(error))
  const due = relaunch.closeDue(yesRows).filter((item) => !log.claimedByOther(`close:${item.sheetRow}`))
  // Then the one-off clean-up of accounts followed that are not on Hustling (lib/unfollow-cleanup.js).
  const cleanup = unfollowCleanup.pending().filter((username) => !log.claimedByOther(`cleanup:${username}`))
    .map((username) => ({ username, sheetRow: `cleanup:${username}`, mode: 'cleanup', name: username }))
  return [...due, ...cleanup]
}

// One account of the clean-up: checked again (still not on Hustling, not a partner, not in a
// conversation waiting on us), then unfollowed. Nothing is written to the sheet.
async function cleanupUnfollow(username) {
  const claimed = await log.claim(`cleanup:${username}`, CREATOR_CLAIM_MS)
  if (!claimed.ok) return { ok: false, taken: true, error: `${claimed.by} is working on @${username}.` }
  const partnerNames = (await partners.list().catch(() => [])).map((partner) => partner.username)
  const talking = dmsForPage({ all: true }).toReply.some((item) => item.username === username)
  if (hustle.person(username) || partnerNames.includes(username) || talking) {
    unfollowCleanup.mark(username, 'kept')
    return { ok: false, error: `@${username} is on Hustling, a partner or in a conversation, so kept.` }
  }
  try {
    const result = await instagram.unfollow({ username, sheetRow: 0, checkChat: false })
    unfollowCleanup.mark(username, result.notFollowing ? 'not following' : 'unfollowed')
    return result.notFollowing ? { ok: false, error: `@${username}: not followed any more.` } : { ok: true }
  } catch (error) {
    if (error.kind === 'missing' || error.kind === 'mismatch') {
      unfollowCleanup.mark(username, error.kind)
      return { ok: false, error: `@${username}: ${error.message}` }
    }
    throw error
  }
}

// Relaunch and 2nd relaunch work for Launch: freshest leads first across both steps, undated ones last,
// skipping creators the other computer is working on.
async function relaunchQueue(tasks) {
  await refreshSheet(false).catch((error) => console.error(error))
  await log.refresh(0).catch((error) => console.error(error))
  const items = []
  for (const stage of [1, 2]) {
    if (!tasks[`relaunch${stage}`]) continue
    for (const item of relaunch.due(yesRows, stage)) items.push({ ...item, stage })
  }
  return items
    .filter((item) => !log.claimedByOther(`relaunch:${item.sheetRow}`))
    .sort((a, b) => {
      if (a.previousDate && b.previousDate) return Date.parse(b.previousDate) - Date.parse(a.previousDate)
      if (a.previousDate) return -1
      if (b.previousDate) return 1
      return a.stage - b.stage || a.sheetRow - b.sheetRow
    })
}

autopilot.init({
  guard: guardStatus,
  instagram,
  hustle,
  relaunch,
  postComment,
  sendRelaunch,
  relaunchQueue,
  closeOut,
  closeQueue,
  cleanupGaveUp: (username, reason) => unfollowCleanup.mark(username, `gave up: ${reason}`),
  replyQueue,
  replyStep,
  replySummary: () => replyRelaunch.summary(yesRows, data),
  autoCommenting: () => autoCommentStatus().on,
  refreshSheet: () => refreshSheet(true).catch((error) => console.error(error)),
  sheetReady: () => Boolean(sheetRefreshedAt),
  voiceCount: () => voiceQueue().length,
  voiceRemainingToday: () => sendQueue.remainingToday(),
  nextPick: () => hustle.picks().find((item) => !log.claimedByOther(`hustle:${item.username}`)),
})

async function serveMedia(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${MEDIA_PORT}`)
  if (req.method !== 'GET' || url.pathname !== '/media') {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8')
    return
  }
  try {
    await preview.streamImage(url.searchParams.get('src'), res)
  } catch {
    if (res.headersSent) res.destroy()
    else send(res, 502, 'Image unavailable', 'text/plain; charset=utf-8')
  }
}

const OWN_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  // Writes (decisions, comments, DMs, voicenotes) only from this app's own pages, never from another website.
  if (req.method === 'POST' && req.headers.origin && !OWN_ORIGINS.has(req.headers.origin)) {
    sendJson(res, 403, { error: 'Forbidden' })
    return
  }
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, await initialState())
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/yes') {
      const loaded = await sheet.loadPending()
      yesRows = loaded.yesRows || []
      sendJson(res, 200, { people: yesRows.map(presentYes), ...counts() })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/queue') {
      const from = Number(url.searchParams.get('from'))
      try {
        sendJson(res, 200, { queue: await nextBatch(Number.isFinite(from) ? from : -1, QUEUE_SIZE), ...counts() })
      } catch (error) {
        console.error(error)
        sendJson(res, 503, { error: 'Could not reach the Google Sheet to pick profiles.', kind: 'server' })
      }
      return
    }
    // The wearable model prospecting alongside: the next undecided profiles in queue order, its answer
    // for one profile, and how often it has agreed so far.
    if (req.method === 'GET' && url.pathname === '/api/model-prospect/upcoming') {
      const count = Math.max(1, Number(url.searchParams.get('count')) || Infinity)
      const upcoming = writeUpcoming(count)
      sendJson(res, 200, { count: upcoming.length, upcoming })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/model-prediction') {
      sendJson(res, 200, modelProspect.prediction(url.searchParams.get('username')))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/model-image') {
      const file = modelProspect.imagePath(url.searchParams.get('username'), url.searchParams.get('n'))
      if (!file) {
        send(res, 404, 'Not found', 'text/plain; charset=utf-8')
        return
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' })
      fs.createReadStream(file).pipe(res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/model-agreement') {
      sendJson(res, 200, modelProspect.agreement())
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const body = await readBody(req)
      const result = await decide(body.sheetRow, body.choice, body.device, body.link, body.by === 'model' ? 'model' : '')
      sendJson(res, result.retry ? 503 : 200, result)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/comment-drafts') {
      const body = await readBody(req)
      try {
        sendJson(res, 200, await commentDrafts(body.username, Array.isArray(body.avoid) ? body.avoid : [], body.guidance))
      } catch (error) {
        sendJson(res, 502, { error: error.message || 'Could not draft comments.', kind: error.kind || 'error' })
      }
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/comment-rewrite') {
      const body = await readBody(req)
      const clip = (value, max) => String(value || '').slice(0, max)
      try {
        const result = await drafts.rewrite({
          name: clip(body.name, 120),
          username: clip(body.username, 60),
          bio: clip(body.bio, 600),
          caption: clip(body.caption, 1500),
          description: clip(body.description, 1500),
          transcript: clip(body.transcript, 6000),
          avoid: (Array.isArray(body.avoid) ? body.avoid : []).map((text) => clip(text, 300)).slice(-20),
          guidance: clip(body.guidance, 200).replace(/\s+/g, ' ').trim(),
        })
        const scored = await withTimeout(scoreFor({ comments: result.comments, description: body.description, caption: body.caption, transcript: body.transcript }), 10000).catch(() => null)
        sendJson(res, 200, { ...result, scores: scored?.percent || null, judge: scored?.judge || null })
      } catch (error) {
        sendJson(res, 502, { error: error.message || 'Could not rewrite the comments.' })
      }
      return
    }
    // How likely this computer's person is to pick each of the 5 (whole percent, adding to 100).
    if (req.method === 'POST' && url.pathname === '/api/comment-scores') {
      const body = await readBody(req)
      try {
        const scored = await scoreFor(body)
        sendJson(res, 200, { percent: scored?.percent || null, judge: scored?.judge || null, model: { ...pickModel.summary(), machine: log.MACHINE } })
      } catch (error) {
        sendJson(res, 502, { error: error.message || 'Could not score the comments.' })
      }
      return
    }
    // Gemini tokens by purpose since midnight (from data/gemini-usage.jsonl).
    if (req.method === 'GET' && url.pathname === '/api/gemini-usage') {
      const since = new Date()
      since.setHours(0, 0, 0, 0)
      const totals = {}
      const lines = fs.existsSync(drafts.USAGE_PATH) ? fs.readFileSync(drafts.USAGE_PATH, 'utf8').split('\n').filter(Boolean) : []
      for (const line of lines) {
        let entry
        try { entry = JSON.parse(line) } catch { continue }
        if (Date.parse(entry.at) < since.getTime()) continue
        const row = (totals[entry.purpose] ||= { calls: 0, input: 0, cached: 0, output: 0, cacheWrite: 0 })
        row.calls++
        for (const key of ['input', 'cached', 'output', 'cacheWrite']) row[key] += entry[key] || 0
      }
      sendJson(res, 200, { since: since.toISOString(), totals })
      return
    }
    // Gemini API spend in USD (today, this week, this month), both computers.
    if (req.method === 'GET' && url.pathname === '/api/usage-cost') {
      try {
        sendJson(res, 200, await apiUsage.totals())
      } catch (error) {
        sendJson(res, 502, { error: error.message || 'Could not read API usage.' })
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/version') {
      sendJson(res, 200, { version: webVersion() })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/pick-model') {
      sendJson(res, 200, { ...pickModel.summary(), machine: log.MACHINE })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/pick-model/retrain') {
      try {
        sendJson(res, 200, await pickModel.retrain('manual'))
      } catch (error) {
        sendJson(res, 502, { error: error.message || 'Could not retrain.' })
      }
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/comment') {
      const body = await readBody(req)
      try {
        sendJson(res, 200, await postComment(body))
      } catch (error) {
        sendJson(res, 502, { error: error.message || 'Could not comment.', kind: error.kind || 'error' })
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/todo') {
      if (url.searchParams.get('refresh') === '1') {
        try {
          await refreshSheet(false)
        } catch (error) {
          console.error(error)
          refreshError = 'Could not refresh the Google Sheet. Counts may be out of date.'
        }
      }
      sendJson(res, 200, await todo())
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/hustle/sync') {
      const body = await readBody(req)
      sendJson(res, 200, hustle.start({ force: Boolean(body.force) }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/hustle/status') {
      sendJson(res, 200, hustle.status())
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/hustle/queue') {
      await log.refresh(0).catch((error) => console.error(error))
      sendJson(res, 200, { queue: hustle.queue(), status: hustle.status() })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/hustle/skip') {
      const body = await readBody(req)
      if (!body.username || !/^\d+$/.test(String(body.pk || ''))) {
        sendJson(res, 400, { error: 'Nothing to skip.' })
        return
      }
      hustle.skip(String(body.username), String(body.pk))
      sendJson(res, 200, { ok: true, status: hustle.status() })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/relaunch') {
      const stage = Number(url.searchParams.get('stage'))
      if (!relaunch.STAGES[stage]) {
        sendJson(res, 400, { error: 'Unknown relaunch step.' })
        return
      }
      await refreshSheet(false).catch((error) => console.error(error))
      await log.refresh(0).catch((error) => console.error(error))
      sendJson(res, 200, {
        stage,
        label: relaunch.STAGES[stage].label,
        queue: relaunch.due(yesRows, stage).filter((item) => !log.claimedByOther(`relaunch:${item.sheetRow}`)).map((item) => ({ ...item, relaunchText: relaunch.messageFor(item, stage) })),
        summary: relaunch.summary(yesRows, stage),
        template: relaunch.templates()[stage],
        writeNote: writeNote(),
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/relaunch/claim') {
      const body = await readBody(req)
      sendJson(res, 200, await log.claim(`relaunch:${Number(body.sheetRow)}`, CREATOR_CLAIM_MS))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/guard') {
      sendJson(res, 200, await guardStatus())
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/relaunch/template') {
      const body = await readBody(req)
      const stage = Number(body.stage)
      if (!relaunch.STAGES[stage] || !String(body.text || '').trim()) {
        sendJson(res, 400, { error: 'Write the template first.' })
        return
      }
      sendJson(res, 200, { template: relaunch.saveTemplate(stage, body.text)[stage] })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/relaunch/send') {
      const body = await readBody(req)
      try {
        sendJson(res, 200, await sendRelaunch(Number(body.stage), body.sheetRow, body.message))
      } catch (error) {
        sendJson(res, 502, { error: error.message || 'Could not send the message.', kind: error.kind || 'error' })
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/voice') {
      await refreshSheet(false).catch((error) => console.error(error))
      sendJson(res, 200, {
        people: voiceQueue().map(presentYes),
        sentToday: sendQueue.sentToday(),
        limit: sendQueue.DAILY_LIMIT,
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/voice/status') {
      try {
        sendJson(res, 200, { app: true, ...(await instagram.voiceStatus()) })
      } catch (error) {
        sendJson(res, 200, { app: false, error: error.message })
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/autopilot') {
      const guard = await guardStatus()
      sendJson(res, 200, { ...autopilot.status(), preview: await autopilot.preview(guard), guard })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/partners/mark') {
      const body = await readBody(req)
      const ok = await partners.mark(String(body.username || ''), body.kind === 'post' ? 'post' : 'story', Boolean(body.value), body.value ? `${new Date().toLocaleDateString('en-AU')} · ticked by hand` : '')
      sendJson(res, ok ? 200 : 404, { ok, partners: await partnersForPage() })
      return
    }
    // A story or reel date set by hand (the countdown follows).
    if (req.method === 'POST' && url.pathname === '/api/partners/date') {
      const body = await readBody(req)
      const ok = await partners.setDate(String(body.username || ''), body.kind === 'post' ? 'post' : 'story', String(body.date || ''))
      sendJson(res, ok ? 200 : 400, { ok, partners: await partnersForPage() })
      return
    }
    // A proposed reply: the one drafted ahead when there is one (instant), otherwise drafted now from the
    // chat saved on this computer (a few seconds, Instagram untouched). Only a conversation never read
    // whose latest is hidden ("2 new messages", a voicenote) is opened in the panel first.
    // fresh: another version, drafted now.
    if (req.method === 'POST' && url.pathname === '/api/dms/draft') {
      const body = await readBody(req)
      const listed = dmsForPage().toReply.find((entry) => entry.name === body.name)
      const item = listed || { name: String(body.name || ''), username: String(body.username || ''), preview: '', voice: '' }
      try {
        const note = String(body.note || '').trim().slice(0, 500)
        const turns = Array.isArray(body.turns) ? body.turns.slice(-8) : []
        const ready = !body.fresh && !note && !turns.length && dmChats.draftFor(item, dmReply.MODEL)
        if (ready) {
          sendJson(res, 200, { reply: ready.reply, username: item.username, instant: true })
          return
        }
        let history = dmChats.history(item)
        if (!history) {
          if (autopilot.status().current || replySending) {
            sendJson(res, 409, { error: 'Instagram is busy with Launch right now. Try again in a minute.' })
            return
          }
          const chat = await readFullChat({ name: item.name, username: item.username })
          if (chat.username && !item.username) item.username = chat.username
          history = dmChats.history(item) || { messages: chat.messages || [], complete: true }
        }
        const reply = await dmReply.draft({ name: item.name, messages: history.messages.slice(-20), note, turns })
        if (listed && !turns.length) dmChats.rememberDraft(item, reply, history.complete ? 'chat' : 'list', dmReply.MODEL)
        sendJson(res, 200, { reply, username: item.username || '' })
      } catch (error) {
        sendJson(res, error.kind === 'busy' ? 409 : 502, { error: error.message || 'Could not draft a reply.' })
      }
      return
    }
    // Their newest messages in one conversation (for "2 new messages" and voicenotes): opens the chat,
    // so Instagram marks it as read; only when asked.
    if (req.method === 'POST' && url.pathname === '/api/dms/messages') {
      const body = await readBody(req)
      if (autopilot.status().current || replySending) {
        sendJson(res, 409, { error: 'Instagram is busy with Launch right now. Try again in a minute.' })
        return
      }
      try {
        const chat = await readFullChat({ name: String(body.name || ''), username: String(body.username || '') })
        const messages = chat.messages || []
        const lastOurs = messages.map((message) => message.ours).lastIndexOf(true)
        const theirs = messages.slice(lastOurs + 1).filter((message) => !message.ours).map((message) => ({
          voice: message.voice,
          text: message.voice ? String(message.text || '').replace(/\d+:\d{2}/, '').replace(/(view|hide) transcription/gi, '').trim() || '(voicenote, no transcription)' : message.text || '(photo, GIF or attachment)',
        }))
        sendJson(res, 200, { username: chat.username || '', messages: theirs })
      } catch (error) {
        sendJson(res, error.kind === 'busy' ? 409 : 502, { error: error.message || 'Could not read the chat.' })
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/dms') {
      sendJson(res, 200, dmsForPage())
      return
    }
    // View chat: the whole conversation (saved on this Mac; read again from Instagram when asked or
    // when nothing is saved yet).
    if (req.method === 'POST' && url.pathname === '/api/dms/chat') {
      const body = await readBody(req)
      const saved = dmChats.chatOf(String(body.name || ''), String(body.username || ''))
      if (saved && !body.fresh) {
        sendJson(res, 200, { messages: saved.messages, readAt: saved.readAt, username: saved.username || body.username || '' })
        return
      }
      if (autopilot.status().current || replySending) {
        sendJson(res, 409, { error: 'Instagram is busy with Launch right now. Try again in a minute.', messages: saved?.messages || [] })
        return
      }
      try {
        const chat = await readFullChat({ name: String(body.name || ''), username: String(body.username || '') })
        sendJson(res, 200, { messages: chat.messages || [], readAt: Date.now(), username: chat.username || '' })
      } catch (error) {
        sendJson(res, error.kind === 'busy' ? 409 : 502, { error: error.message || 'Could not read the chat.' })
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/dms/avatar') {
      let file = avatarFile(url.searchParams.get('u'))
      // Not saved yet: the inbox list's own picture for that conversation (by its name).
      const name = url.searchParams.get('n')
      if (!file && name && url.searchParams.get('u')) {
        const inbox = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'dm-inbox.json'), 'utf8')).rows || [] } catch { return [] } })()
        const row = inbox.find((entry) => entry.name === name && entry.avatar)
        if (row) {
          await saveAvatar(url.searchParams.get('u'), row.avatar).catch(() => {})
          file = avatarFile(url.searchParams.get('u'))
        }
      }
      if (!file) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' })
      fs.createReadStream(file).pipe(res)
      return
    }
    // "No reply needed": off the list until they write something new.
    if (req.method === 'POST' && url.pathname === '/api/dms/dismiss') {
      const body = await readBody(req)
      dmInbox.dismiss(String(body.name || ''), String(body.preview || ''))
      // Kept by username (names change and are spelled differently): from the list, the saved chat, or the sheet.
      const dismissedUser = String(body.username || '') || usernameForName(String(body.name || ''))
      if (dismissedUser) dmMissed.dismiss(dismissedUser, String(body.preview || ''))
      else console.error(`dm dismiss: no username for ${body.name}; kept by name only`)
      // Still unread on Instagram: opened once (read) when Instagram is free, so it is done there too.
      if (body.unread) {
        dmReply.add({ name: String(body.name || ''), username: String(body.username || ''), kind: 'read' })
        sendQueuedReplies().catch(() => {})
      }
      sendJson(res, 200, { ok: true, dms: dmsForPage() })
      return
    }
    // The Message 2 voicenotes, to listen to before sending.
    if (req.method === 'GET' && url.pathname === '/api/dms/clip') {
      const voice = /^(romain|mathieu)$/i.test(url.searchParams.get('voice') || '') ? url.searchParams.get('voice')[0].toUpperCase() + url.searchParams.get('voice').slice(1).toLowerCase() : ''
      const part = url.searchParams.get('part') === '2' ? 2 : 1
      const file = path.join(__dirname, 'data', 'voice', 'clips', `${voice} Message 2 part ${part}.m4a`)
      if (!voice || !fs.existsSync(file)) {
        sendJson(res, 404, { error: 'No such clip.' })
        return
      }
      res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-cache' })
      fs.createReadStream(file).pipe(res)
      return
    }
    // "Send now": the queued replies go out straight away, outside Launch's hours too (still one at a
    // time, through the safety limits).
    if (req.method === 'POST' && url.pathname === '/api/dms/send-now') {
      replyNowUntil = Date.now() + 3 * 60 * 60 * 1000
      sendQueuedReplies().catch(() => {})
      sendJson(res, 200, { ok: true, dms: dmsForPage() })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/dms/send') {
      const body = await readBody(req)
      const kind = body.kind === 'voice' ? 'voice' : body.kind === 'like' ? 'like' : body.kind === 'react' ? 'react' : 'text'
      const text = String(body.text || '').trim()
      const voice = /^(romain|mathieu)$/i.test(body.voice || '') ? body.voice[0].toUpperCase() + body.voice.slice(1).toLowerCase() : ''
      const emoji = kind === 'react' ? (['❤️', '😂', '😮', '😢', '😡', '👍'].find((item) => item.replace(/\uFE0F/g, '') === String(body.emoji || '').replace(/\uFE0F/g, '')) || '') : ''
      if (kind === 'react' && !emoji) {
        sendJson(res, 400, { error: 'Pick one of the quick reactions.' })
        return
      }
      if (!body.name || (kind === 'text' && !text) || (kind === 'voice' && !voice)) {
        sendJson(res, 400, { error: kind === 'voice' ? 'Who sent the first voicenote is unknown.' : 'The reply is empty.' })
        return
      }
      // Not straight away: it goes out a few minutes later, in a gap between Launch's actions, so the
      // Instagram panel does not switch the moment Send is pressed.
      // Who sent the first voicenote, picked by hand: remembered for that person.
      if (kind === 'voice' && body.username && !voiceSenderOf(String(body.username))) {
        const file = path.join(__dirname, 'data', 'voice', 'picked-senders.json')
        let picked = {}
        try { picked = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
        picked[String(body.username).toLowerCase()] = voice
        fs.writeFileSync(file, JSON.stringify(picked, null, 1))
      }
      const item = dmReply.add({ name: String(body.name), username: String(body.username || ''), kind, text: kind === 'react' ? String(body.text || '').slice(0, 200) : text, voice, emoji, sendAfter: Date.now() + (120 + Math.random() * 120) * 1000 })
      sendQueuedReplies().catch(() => {})
      sendJson(res, 200, { ok: true, item })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/scraper') {
      const summary = { ...followingScraper.summary(), enrich: tempEnrich.summary() }
      // While a following list is being read: how many accounts are loaded so far (each scraper account).
      for (const account of summary.accounts) {
        if (!account.current || account.status !== 'running') continue
        const progress = await instagram.scraperProgress(account.account).catch(() => null)
        if (progress && progress.reading && progress.username === account.current.username) account.reading = { loaded: progress.loaded, since: progress.at }
      }
      sendJson(res, 200, summary)
      return
    }
    // A scraper account's window (body.account: 1, 2...), to log in or verify it.
    if (req.method === 'POST' && url.pathname === '/api/scraper/login') {
      const body = await readBody(req).catch(() => ({}))
      await instagram.scraperOpen(Number(body.account) || 1).catch(() => {})
      sendJson(res, 200, { ok: true })
      return
    }
    // After the person verified the scraper account (or logged it in) in its window.
    if (req.method === 'POST' && url.pathname === '/api/scraper/resume') {
      const body = await readBody(req).catch(() => ({}))
      followingScraper.resume(instagram, (text) => console.log(text), Number(body.account) || 1).catch((error) => console.error('scraper', error.message))
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/scraper/start') {
      const body = await readBody(req).catch(() => ({}))
      followingScraper.run(instagram, (text) => console.log(text), Number(body.account) || 0).catch((error) => console.error('scraper', error.message))
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/dms/scan') {
      panelReads.inbox = 0
      backgroundReads().catch((error) => console.error('background reads', error.message))
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/hustle/auto') {
      sendJson(res, 200, autoCommentStatus())
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/hustle/auto') {
      const body = await readBody(req)
      if (body.always) {
        sendJson(res, 200, setAutoComment({ ...autoCommentState(), armed: true, always: true, hours: 0, until: 0, note: '' }))
        return
      }
      const hours = Math.max(0, Math.min(72, Number(body.hours) || 0))
      sendJson(res, 200, setAutoComment({ ...autoCommentState(), armed: hours > 0, always: false, hours, until: 0, note: '' }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/hustle/training') {
      const body = await readBody(req)
      sendJson(res, 200, { ok: training.record(body) })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/counts') {
      await log.refresh(4000).catch((error) => console.error(error))
      // With the model's numbers, so the Prospecting card follows the day (today's counts reset at midnight).
      sendJson(res, 200, { ...counts(), model: { ...modelProgress(), health: runners.health.message } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/autopilot/running') {
      sendJson(res, 200, { running: autopilot.status().running })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/autopilot/start') {
      const body = await readBody(req)
      sendJson(res, 200, autopilot.start(body.tasks || {}))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/autopilot/stop') {
      sendJson(res, 200, autopilot.stop('Stopped by you.'))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/hustle/pick') {
      const body = await readBody(req)
      const username = String(body.username || '').toLowerCase()
      const text = String(body.text || '').replace(/\s+/g, ' ').trim()
      if (!hustle.person(username) || !/^\d+$/.test(String(body.pk || '')) || !/^[A-Za-z0-9_-]+$/.test(String(body.code || '')) || !text || text.length > 300) {
        sendJson(res, 400, { error: 'That pick is incomplete. Open the creator again.' })
        return
      }
      // One Sheets call per pick: the shared log is at most a few seconds old here, and the creator is
      // already held by this computer since their comments were drafted.
      await log.refresh(5000)
      if (hustle.alreadyHandled(username, body.pk)) {
        sendJson(res, 409, { error: 'That post was already commented on or skipped.', kind: 'taken' })
        return
      }
      await hustle.pick(username, { pk: String(body.pk), code: String(body.code), text })
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/hustle/unpick') {
      const body = await readBody(req)
      await hustle.unpick(String(body.username || ''), String(body.pk || ''))
      await log.refresh(0)
      sendJson(res, 200, { ok: true, picked: hustle.picks().length })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/hustle/picks') {
      await log.refresh(0)
      sendJson(res, 200, { picks: hustle.picks() })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/relaunch/skip') {
      const body = await readBody(req)
      const stage = Number(body.stage)
      if (!relaunch.STAGES[stage] || !Number(body.sheetRow)) {
        sendJson(res, 400, { error: 'Nothing to leave out.' })
        return
      }
      await relaunch.leaveOut(stage, Number(body.sheetRow))
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/preview') {
      try {
        // The Prospecting screen: the profile on screen now, or one it preloads next ('screen'): never held
        // back by the background allowance.
        const profile = await profileOf(url.searchParams.get('u'), url.searchParams.get('now') === '1' ? true : 'screen')
        sendJson(res, 200, profile)
      } catch (error) {
        sendJson(res, 502, { error: error.message || 'Could not load this profile.', kind: error.kind || 'error' })
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/media') {
      await serveMedia(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/voicenote-yes.csv') {
      const file = fs.readFileSync(data.YES_PATH)
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="voicenote-yes.csv"',
        'Cache-Control': 'no-store',
      })
      res.end(file)
      return
    }
    if (req.method === 'GET') {
      serveStatic(res, url.pathname)
      return
    }
    send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8')
  } catch (error) {
    console.error(error)
    if (res.headersSent) res.destroy()
    else sendJson(res, 500, { error: 'Something went wrong.' })
  }
})

const mediaServer = http.createServer(serveMedia)
mediaServer.keepAliveTimeout = 30000

async function boot() {
  // Row numbers shift when rows are deleted from the sheet: update local files first (once per change).
  try {
    const done = migrations.apply()
    if (done.length) console.log(`applied row migrations: ${done.join(', ')}`)
  } catch (error) {
    console.error('row migration failed', error)
  }
  try {
    const loaded = await sheet.loadPending()
    rows = loaded.rows
    yesRows = loaded.yesRows || []
    outreachColumns = loaded.outreachColumns || outreachColumns
    sheetRefreshedAt = Date.now()
    byRow = new Map(rows.map((row) => [row.sheetRow, row]))
    decisions = sheet.loadDecisions()
    console.log(`pending ${rows.length}`)
    try {
      const column = rows.find((row) => row.deviceColumn)?.deviceColumn
      const listed = await writer.listDevices(column)
      if (listed.length) devices = listed
      const acceptedColumn = rows.find((row) => row.acceptedColumn)?.acceptedColumn
      await writer.loadAcceptedRule(acceptedColumn)
      console.log(writer.acceptedRule ? 'accepted dropdown ready' : 'accepted dropdown missing')
    } catch (error) {
      console.error(error)
    }
    console.log(`devices ${devices.join(', ')}`)
  } catch (error) {
    loadError = 'Could not load the Google Sheet.'
    console.error(error)
  }
  writer.start()
  autopilot.resume()
  pickModel.startAutoRetrain()
  setInterval(async () => {
    await autoNo()
    await autoYes()
  }, 60 * 1000).unref()
  setInterval(autoComment, 90 * 1000).unref()
  setInterval(() => backgroundReads().catch((error) => console.error('background reads', error.message)), 5 * 60 * 1000).unref()
  setInterval(() => sendQueuedReplies().catch((error) => console.error('dm replies', error.message)), 20 * 1000).unref()
  // The following scraper (scraper account, lib/following-scraper.js): runs on its own between 8:00 and 21:00.
  setInterval(() => followingScraper.run(instagram, (text) => console.log(text)).catch((error) => console.error('scraper', error.message)), 10 * 60 * 1000).unref()
  // Keeps the model's list ahead of the person (it moves on as profiles get decided).
  setInterval(() => { if (rows.length) writeUpcoming() }, 5 * 60 * 1000).unref()
  apiUsage.startSync()
  // Missed replies: every chat read for any reason that ends with their message goes on DMs to reply;
  // the chats the reply checks read before this are added once.
  instagram.onThread((username, messages, name, avatar) => {
    if (avatar) saveAvatar(username, avatar).catch(() => {})
    dmMissed.note(username, messages, name)
    checkMissed().catch((error) => console.error('dm missed check', error.message))
  })
  setInterval(() => checkMissed().catch((error) => console.error('dm missed check', error.message)), 5 * 60 * 1000).unref()
  setTimeout(() => checkMissed().catch((error) => console.error('dm missed check', error.message)), 30 * 1000).unref()
  const backfilled = dmMissed.backfill()
  if (backfilled) console.log(`dm missed: ${backfilled} earlier chats where they wrote last`)
  // DMs read ahead (messages, voicenote transcripts, a drafted reply) between Launch's actions.
  setInterval(() => readChatsAhead().catch((error) => console.error('read ahead', error.message)), 2 * 60 * 1000).unref()
  // Meta's token kept alive (renewed daily when the app secret is saved).
  const renewMeta = () => igGraph.renew().then((result) => { if (result.renewed) console.log(`meta token renewed, valid until ${new Date(result.expiresAt).toLocaleDateString('en-AU')}`) }).catch((error) => console.error('meta renew', error.message))
  setTimeout(renewMeta, 20 * 1000).unref()
  setInterval(renewMeta, 6 * 3600 * 1000).unref()
  setTimeout(() => igGraph.checkAccess().catch(() => {}), 40 * 1000).unref()
  setInterval(() => igGraph.checkAccess().catch(() => {}), 12 * 3600 * 1000).unref()
  // The wearable model's photo downloader and model, kept running on this Mac.
  runners.start((text) => console.log(text))
  // The HUSTLING list straight from the sheet (no Instagram), so Hustling is never empty after a restart.
  hustle.loadList().catch((error) => console.error('hustle list:', error.message))
  mediaServer.listen(MEDIA_PORT, '127.0.0.1')
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Open http://127.0.0.1:${PORT}`)
  })
  // The scraper picks up where it was straight away (not 10 minutes later).
  setTimeout(() => followingScraper.run(instagram, (text) => console.log(text)).catch((error) => console.error('scraper', error.message)), 60 * 1000).unref()
  // TEMP Scrape's usernames get their link, followers and bio (slowly, logged out, this Mac only).
  const enrich = () => tempEnrich.run((text) => console.log(text)).catch((error) => console.error('temp enrich', error.message))
  setTimeout(enrich, 90 * 1000).unref()
  setInterval(enrich, 10 * 60 * 1000).unref()
  // The first profiles of the Prospecting list, loaded ahead for the screen: at most once every 30
  // minutes (a restart is not a reason to load them again; they count against the hourly allowance).
  const BOOT_PATH = path.join(__dirname, 'data', 'boot-preload.json')
  let lastPreload = 0
  try { lastPreload = JSON.parse(fs.readFileSync(BOOT_PATH, 'utf8')).at || 0 } catch {}
  if (Date.now() - lastPreload > 30 * 60 * 1000) {
    try { fs.writeFileSync(BOOT_PATH, JSON.stringify({ at: Date.now() })) } catch {}
    const first = rows.filter((row) => !choiceFor(row)).slice(0, 4).map((row) => data.usernameFrom(row['DIRECT LINK'])).filter(Boolean)
    first.forEach((username, position) => {
      preview.profile(username, position === 0 ? true : 'screen').catch(() => {})
    })
  }
}

boot()

// Write any queued training rows before the app closes.
process.on('SIGTERM', () => {
  Promise.allSettled([training.flush(), followingScraper.flushPending()]).finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 8000)
})

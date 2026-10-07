const http = require('http')
const fs = require('fs')
const path = require('path')
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

// Saving is idempotent and never overwrites: an answer the sheet already holds counts as saved, someone
// else's answer is never replaced, and a temporary failure is retried (retry: true becomes a 503).
async function decide(sheetRow, choice, device, link) {
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

// The newest post by date, not the first grid tile, which is often a pinned post.
async function latestPost(username) {
  let profile = await preview.profile(username, true)
  let post = posts.latestPost(profile)
  if (!post?.image) {
    preview.forget(username)
    profile = await preview.profile(username, true)
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

async function commentDrafts(username, avoid = [], guidance = '') {
  const claimed = await log.claim(`hustle:${String(username).toLowerCase()}`, CREATOR_CLAIM_MS)
  if (!claimed.ok) throw taken(`${claimed.by} is working on @${username} right now.`)
  const { profile, post, permalink } = await latestPost(username)
  if (hustle.alreadyHandled(username, post.pk)) throw taken(`@${username}'s newest post was already commented on or skipped.`)
  const photo = post.image
  const image = await preview.downloadImage(photo.full || photo.src)
  const drafted = await drafts.generate({
    name: profile.name,
    username: profile.username || username,
    bio: profile.bio,
    caption: photo.alt || '',
    image,
    avoid: avoid.map((text) => String(text).slice(0, 300)).slice(0, 15),
    guidance: String(guidance || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  })
  return {
    permalink,
    pk: post.pk,
    code: post.code,
    kind: post.kind,
    postedAt: post.at,
    caption: photo.alt || '',
    bio: profile.bio || '',
    name: profile.name || '',
    followers: profile.followers || '',
    image: photo.src,
    full: photo.full || photo.src,
    description: drafted.description,
    comments: drafted.comments,
  }
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
    prospecting: { remaining: counts().remaining, total: rows.length, yesToday: counts().yesToday, yesTarget: sendQueue.DAILY_LIMIT },
    voice: { toSend: voice.length, sentToday: Math.max(sendQueue.sentToday(), guard.app ? guard.kinds.voice.today : 0), limit: sendQueue.DAILY_LIMIT },
    hustle: hustle.status(),
    relaunch: { 1: relaunch.summary(yesRows, 1), 2: relaunch.summary(yesRows, 2) },
    warnings: [loadError, refreshError, writeNote()].filter(Boolean),
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
  refreshSheet: () => refreshSheet(true).catch((error) => console.error(error)),
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
    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const body = await readBody(req)
      const result = await decide(body.sheetRow, body.choice, body.device, body.link)
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
        sendJson(res, 200, await drafts.rewrite({
          name: clip(body.name, 120),
          username: clip(body.username, 60),
          bio: clip(body.bio, 600),
          caption: clip(body.caption, 1500),
          description: clip(body.description, 800),
          avoid: (Array.isArray(body.avoid) ? body.avoid : []).map((text) => clip(text, 300)).slice(-20),
          guidance: clip(body.guidance, 200).replace(/\s+/g, ' ').trim(),
        }))
      } catch (error) {
        sendJson(res, 502, { error: error.message || 'Could not rewrite the comments.' })
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
        queue: relaunch.due(yesRows, stage).filter((item) => !log.claimedByOther(`relaunch:${item.sheetRow}`)),
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
    if (req.method === 'POST' && url.pathname === '/api/hustle/training') {
      const body = await readBody(req)
      sendJson(res, 200, { ok: training.record(body) })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/counts') {
      await log.refresh(4000).catch((error) => console.error(error))
      sendJson(res, 200, counts())
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
        const profile = await preview.profile(url.searchParams.get('u'), url.searchParams.get('now') === '1')
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
  mediaServer.listen(MEDIA_PORT, '127.0.0.1')
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Open http://127.0.0.1:${PORT}`)
  })
  const first = rows.filter((row) => !choiceFor(row)).slice(0, 4).map((row) => data.usernameFrom(row['DIRECT LINK'])).filter(Boolean)
  first.forEach((username, position) => {
    preview.profile(username, position === 0).catch(() => {})
  })
}

boot()

// Write any queued training rows before the app closes.
process.on('SIGTERM', () => {
  training.flush().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 8000)
})

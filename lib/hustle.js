// Hustling: creators listed on the HUSTLING tab of the Google Sheet. A creator needs a comment when
// their newest post is newer than the last post we commented on (or chose to skip).
// Sync loads every profile through the preview browser and records the newest post.
const fs = require('fs')
const path = require('path')
const writer = require('./sheet-writer')
const data = require('./data')
const preview = require('./ig-preview')
const posts = require('./ig-posts')
const log = require('./shared-log')

const DIR = path.join(__dirname, '..', 'data', 'hustle')
const STATE_PATH = path.join(DIR, 'state.json')
const LOG_PATH = path.join(DIR, 'comments.jsonl')
const FRESH_MS = 60 * 60 * 1000
const WORKERS = 2

let list = []
let state = loadState()
let sync = { running: false, total: 0, done: 0, errors: 0, startedAt: '', finishedAt: '', message: '' }

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    return raw && raw.profiles ? raw : { profiles: {} }
  } catch {
    return { profiles: {} }
  }
}

function saveState() {
  fs.mkdirSync(DIR, { recursive: true })
  const tmp = `${STATE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
  fs.renameSync(tmp, STATE_PATH)
}

function entry(username) {
  const key = username.toLowerCase()
  if (!state.profiles[key]) state.profiles[key] = {}
  return state.profiles[key]
}

async function loadList() {
  if (!writer.sheetTitle) await writer.prepare()
  const meta = await writer.api('GET', '?fields=sheets.properties(title)')
  const tab = (meta.sheets || []).map((item) => item.properties.title).find((title) => /hustl/i.test(title))
  if (!tab) throw new Error('The Google Sheet has no HUSTLING tab.')
  const result = await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(tab)}!A2:J`)}`)
  const seen = new Set()
  const next = []
  for (const row of result.values || []) {
    const link = row.find((cell) => /instagram\.com\//i.test(cell || '')) || ''
    const username = data.usernameFrom(link).toLowerCase()
    if (!username || seen.has(username)) continue
    seen.add(username)
    const first = String(row[0] || '').trim()
    const second = String(row[1] || '').trim()
    const name = first && first.toLowerCase() !== username ? first : (second && second.toLowerCase() !== username ? second : username)
    next.push({
      username,
      name,
      link: link.trim(),
      followers: String(row[4] || '').trim(),
      notes: String(row[7] || '').trim(),
    })
  }
  list = next
  return list
}

// Comments and skips recorded by any computer in the shared log are copied into this computer's state,
// so a post handled by the other person is never commented twice, even after the log rolls over.
function mergeShared() {
  let changed = false
  // A comment that failed after Post was pressed may have gone through, so it counts as handled too.
  for (const entry of log.list((item) => (item.action === 'comment' || item.action === 'skip') && /^\d+( failed)?$/.test(item.detail))) {
    const item = state.profiles[entry.target]
    if (!item) continue
    const key = entry.action === 'comment' ? 'commented' : 'skipped'
    const pk = entry.detail.split(' ')[0]
    if (!item[key] || posts.newer(pk, item[key].pk)) {
      item[key] = { pk, at: new Date(entry.time).toISOString(), by: entry.machine }
      changed = true
    }
  }
  if (changed) saveState()
}

function handledPk(username) {
  const item = state.profiles[username.toLowerCase()]
  return [item?.commented?.pk, item?.skipped?.pk].reduce((a, b) => (posts.newer(b, a) ? b : a), '0')
}

function needsComment(username) {
  const item = state.profiles[username.toLowerCase()]
  if (!item || !item.latest) return false
  return posts.newer(item.latest.pk, handledPk(username))
}

// Picked comments waiting for Launch to post them: 'pick' rows (Detail = postId|code|text) in the
// shared log, cancelled by 'unpick'. A pick disappears once its post is commented on or skipped.
function picks() {
  mergeShared()
  const open = new Map()
  for (const entry of log.list((item) => item.action === 'pick' || item.action === 'unpick')) {
    if (entry.action === 'pick') {
      const [pk, code, ...text] = entry.detail.split('|')
      open.set(entry.target, { username: entry.target, pk, code, text: text.join('|'), at: entry.time, by: entry.machine })
    } else if (open.get(entry.target)?.pk === entry.detail) {
      open.delete(entry.target)
    }
  }
  return [...open.values()]
    .filter((pick) => posts.newer(pick.pk, handledPk(pick.username)))
    .sort((a, b) => a.at - b.at)
    .map((pick) => ({ ...pick, name: person(pick.username)?.name || pick.username }))
}

function pick(username, { pk, code, text }) {
  return log.append({ action: 'pick', target: username.toLowerCase(), detail: `${pk}|${code}|${text}` })
}

function unpick(username, pk) {
  return log.append({ action: 'unpick', target: username.toLowerCase(), detail: String(pk) })
}

function alreadyHandled(username, pk) {
  mergeShared()
  return !posts.newer(pk, handledPk(username))
}

function queue() {
  const picked = new Set(picks().map((item) => item.username))
  return list
    .filter((person) => needsComment(person.username) && !picked.has(person.username) && !log.claimedByOther(`hustle:${person.username}`))
    .map((person) => {
      const item = state.profiles[person.username]
      return { ...person, latest: { pk: item.latest.pk, code: item.latest.code, at: item.latest.at }, commented: item.commented || null }
    })
    .sort((a, b) => (posts.newer(a.latest.pk, b.latest.pk) ? -1 : 1))
}

function status() {
  const pickedNow = new Set(picks().map((item) => item.username))
  let checked = 0
  let unreadable = 0
  for (const person of list) {
    const item = state.profiles[person.username]
    if (item?.checkedAt) checked++
    if (item?.error) unreadable++
  }
  return {
    ...sync,
    listed: list.length,
    checked,
    unreadable,
    toDo: list.filter((person) => needsComment(person.username) && !pickedNow.has(person.username)).length,
    picked: pickedNow.size,
  }
}

function remember(username, profile) {
  const item = entry(username)
  const latest = posts.latestPost(profile)
  item.checkedAt = new Date().toISOString()
  item.private = Boolean(profile.private)
  item.error = ''
  item.latest = latest ? { pk: latest.pk, code: latest.code, kind: latest.kind, at: latest.at } : null
  return item
}

async function checkOne(username) {
  preview.forget(username)
  try {
    const profile = await preview.profile(username, false)
    remember(username, profile)
  } catch (error) {
    const item = entry(username)
    item.checkedAt = new Date().toISOString()
    item.error = error.message || 'Could not read this profile.'
    if (error.kind === 'login') throw error
  }
}

function start({ force = false } = {}) {
  if (sync.running) return status()
  sync = { running: true, total: 0, done: 0, errors: 0, startedAt: new Date().toISOString(), finishedAt: '', message: 'Reading the HUSTLING tab…' }
  run(force).catch((error) => {
    console.error(error)
    sync.message = error.message || 'Sync failed.'
  }).finally(() => {
    sync.running = false
    sync.finishedAt = new Date().toISOString()
    saveState()
  })
  return status()
}

function checkedTime(username) {
  return Date.parse(state.profiles[username]?.checkedAt || '') || 0
}

async function run(force) {
  await loadList()
  const now = Date.now()
  const stale = list
    .filter((person) => force || now - checkedTime(person.username) > FRESH_MS)
    .sort((a, b) => checkedTime(a.username) - checkedTime(b.username))
  sync.total = stale.length
  sync.message = ''
  let stop = null
  const work = [...stale]
  async function worker() {
    while (work.length && !stop) {
      const person = work.shift()
      try {
        await checkOne(person.username)
        if (state.profiles[person.username]?.error) sync.errors++
      } catch (error) {
        stop = error
      }
      sync.done++
      if (sync.done % 10 === 0) saveState()
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker))
  if (stop) {
    sync.message = 'Instagram asked for a login in the preview browser, so the sync stopped.'
    throw stop
  }
}

// Called after the profile was loaded fresh for drafting, so the stored newest post stays current.
function refreshFrom(username, profile) {
  remember(username, profile)
  saveState()
}

function recordComment(username, post, text) {
  const item = entry(username)
  item.commented = { pk: post.pk, code: post.code, text, at: new Date().toISOString() }
  if (!item.latest || posts.newer(post.pk, item.latest.pk)) item.latest = { pk: post.pk, code: post.code, kind: post.kind, at: posts.postedAt(post.pk) }
  saveState()
  fs.mkdirSync(DIR, { recursive: true })
  fs.appendFileSync(LOG_PATH, `${JSON.stringify({ username, pk: post.pk, code: post.code, text, at: item.commented.at })}\n`)
}

function skip(username, pk) {
  const item = entry(username)
  item.skipped = { pk: String(pk), at: new Date().toISOString() }
  saveState()
  return log.append({ action: 'skip', target: username.toLowerCase(), detail: String(pk) })
}

function person(username) {
  return list.find((item) => item.username === String(username || '').toLowerCase()) || null
}

module.exports = { start, status, queue, recordComment, skip, refreshFrom, person, loadList, alreadyHandled, picks, pick, unpick }

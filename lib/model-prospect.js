// The wearable model "prospecting" alongside a person: its answers for upcoming profiles (written by
// the local runner, python -m wearable.live, to data/wearable/results/live.jsonl), shown after the
// person decides, and every decision logged next to the model's answer in data/wearable/live-eval.jsonl.
const fs = require('fs')
const path = require('path')

const DIR = path.join(__dirname, '..', 'data', 'wearable')
const RESULTS = path.join(DIR, 'results', 'live.jsonl')
const EVAL = path.join(DIR, 'live-eval.jsonl')
const LIST = path.join(DIR, 'live-list.json')

let cache = { mtime: 0, byUser: new Map() }

function predictions() {
  let mtime = 0
  try { mtime = fs.statSync(RESULTS).mtimeMs } catch { return cache.byUser }
  if (mtime !== cache.mtime) {
    const byUser = new Map()
    for (const line of fs.readFileSync(RESULTS, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        byUser.set(String(record.username).toLowerCase(), record)
      } catch {}
    }
    cache = { mtime, byUser }
  }
  return cache.byUser
}

function inList(username) {
  try {
    return JSON.parse(fs.readFileSync(LIST, 'utf8')).some((item) => item.username === username)
  } catch {
    return false
  }
}

// What the model said about a profile, in a compact form for the screen.
function prediction(username) {
  const key = String(username || '').toLowerCase()
  const record = predictions().get(key)
  if (!record) return { status: inList(key) ? 'pending' : 'none' }
  // Judged on photos that have since been fetched again: its photo numbers may not match any more.
  if (record.acquired_at && record.acquired_at !== acquiredAt(key)) return { status: 'pending' }
  const devices = (record.devices || []).map((device) => ({ brand: device.brand, certainty: device.certainty, tiles: device.tiles, best_tile: device.best_tile, wearer: device.wearer, verified: Boolean(device.verified), evidence: device.evidence }))
  // The evidence photo: only one the closer look checked at full size and found the device in (photo n is
  // the profile's n-th photo, the same order as on the Prospecting screen). No checked photo, no photo.
  const rank = { confirmed: 0, probable: 1, possible: 2 }
  const lead = [...devices]
    .filter((device) => device.verified && Number.isInteger(device.best_tile) && fs.existsSync(path.join(DIR, 'images', key, `${device.best_tile}.jpg`)))
    .sort((a, b) => (a.wearer === 'owner' ? 0 : 1) - (b.wearer === 'owner' ? 0 : 1) || (rank[a.certainty] ?? 3) - (rank[b.certainty] ?? 3))[0]
  const evidence = lead
    ? {
        photo: lead.best_tile,
        image: `/api/model-image?username=${encodeURIComponent(key)}&n=${lead.best_tile}`,
        where: lead.evidence || '',
        brand: lead.brand,
        certainty: lead.certainty,
        wearer: lead.wearer || '',
        verified: true,
        others: devices.filter((device) => device.verified && device !== lead).map((device) => device.best_tile),
      }
    : null
  return {
    status: 'ready',
    decision: record.decision,
    verdict: record.verdict,
    brands: record.brands || [],
    possibleBrands: record.possible_brands || [],
    devices: devices.slice(0, 4),
    evidence,
    textMentions: Object.keys(record.text_mentions || {}),
    // What it saw on wrists, arms and hands (per-photo runs), so a No or Unsure explains itself.
    notes: String(record.stage1?.notes || '').trim().slice(0, 600),
    // The photos worth looking at (a wrist, hand or arm, or a device), by photo number, and each
    // photo's post code, so the screen only filters when its photos are exactly the model's photos.
    focus: Array.isArray(record.focus_photos) ? record.focus_photos : null,
    order: Array.isArray(record.photo_order) ? record.photo_order : null,
    confidence: confidenceOf(record, devices),
    autoNo: saysNo(key),
    // Profile match: an active person whose content is their own life (0-100, low / medium / high),
    // from how active they are and how much of the content is their own life.
    match: record.match?.version === 'active-v1'
      ? { score: record.match.score, level: record.match.level, active: record.match.active, lifestyle: record.match.lifestyle, evidence: record.match.evidence || '', niche: record.match.niche || '' }
      : null,
    photoCodes: photoCodes(key),
    profileStatus: record.status,
  }
}

// How sure it is about the wearable (0-100): the closer look's own score; for answers from before it
// gave one, from its certainty (confirmed 85, probable 65, possible 40; named in the bio only 60).
function confidenceOf(record, devices) {
  if (Number.isFinite(record.confidence) && (record.confidence > 0 || record.decision !== 'Yes')) return record.confidence
  if (record.decision !== 'Yes') return null
  const score = { confirmed: 85, probable: 65, possible: 40 }
  const best = Math.max(0, ...devices.map((device) => (device.verified === false ? 0.6 : 1) * (score[device.certainty] || 0)))
  return Math.round(best || (Object.keys(record.text_mentions || {}).length ? 60 : 30))
}

function acquiredAt(key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, 'profiles', `${key}.json`), 'utf8')).acquiredAt || ''
  } catch {
    return ''
  }
}

// The post code of each photo the model saw, in order (null where a download failed).
function photoCodes(key) {
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(DIR, 'profiles', `${key}.json`), 'utf8'))
    return (profile.posts || []).map((post) => (post.file ? post.code || '' : null))
  } catch {
    return null
  }
}

// The model's No (or nothing to judge on: the owner's wrists and hands never visible) goes to the sheet
// without a person. Not when its answer could not be read, the profile was not readable, a brand is
// named in the bio or captions, or its photos have since been fetched again.
function saysNo(username) {
  const key = String(username || '').toLowerCase()
  const record = predictions().get(key)
  if (!record || record.status !== 'ok') return false
  if (record.acquired_at && record.acquired_at !== acquiredAt(key)) return false
  if (Object.keys(record.text_mentions || {}).length) return false
  if ('_unparsed' in (record.stage1 || {})) return false
  return record.decision === 'No' || (record.decision === 'Unknown' && record.verdict === 'insufficient')
}

// Every No the model wrote to the sheet, with what it saw, so any of them can be checked later.
const AUTO = path.join(DIR, 'auto-no.jsonl')
function logAuto(entry) {
  const record = predictions().get(String(entry.username || '').toLowerCase()) || {}
  fs.mkdirSync(DIR, { recursive: true })
  fs.appendFileSync(AUTO, `${JSON.stringify({ at: new Date().toISOString(), ...entry, prompt: record.prompt, notes: record.stage1?.notes || '' })}\n`)
}

function record(entry) {
  const model = prediction(entry.username)
  fs.mkdirSync(DIR, { recursive: true })
  // Since 11 Oct the model's answer is on screen before the person decides (shownBefore).
  fs.appendFileSync(EVAL, `${JSON.stringify({ at: new Date().toISOString(), ...entry, shownBefore: true, model })}\n`)
  return model
}

// Latest decision per row, compared with the model.
function agreement() {
  const latest = new Map()
  if (fs.existsSync(EVAL)) {
    for (const line of fs.readFileSync(EVAL, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        latest.set(entry.sheetRow, entry)
      } catch {}
    }
  }
  const rows = [...latest.values()].filter((entry) => entry.model?.status === 'ready')
  const humanYes = rows.filter((entry) => entry.choice === 'yes')
  const modelKept = (entry) => entry.model.decision === 'Yes' || entry.model.decision === 'Unknown'
  return {
    compared: rows.length,
    agree: rows.filter((entry) => (entry.choice === 'yes') === modelKept(entry)).length,
    yes: humanYes.length,
    yesCaught: humanYes.filter(modelKept).length,
    deviceRight: humanYes.filter((entry) => entry.model.brands.includes(entry.device)).length,
    no: rows.length - humanYes.length,
    noKept: rows.filter((entry) => entry.choice === 'no' && modelKept(entry)).length,
  }
}

// A locally saved post photo of a profile in the model's list (for the evidence on screen).
function imagePath(username, n) {
  const key = String(username || '').toLowerCase()
  if (!/^[a-z0-9._]{1,40}$/.test(key) || !/^\d{1,3}$/.test(String(n))) return null
  const file = path.join(DIR, 'images', key, `${Number(n)}.jpg`)
  return fs.existsSync(file) ? file : null
}

module.exports = { prediction, record, agreement, imagePath, saysNo, logAuto, LIST }

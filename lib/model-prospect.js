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
    // Where a brand is named, with the words around it, and whether it is a paid partnership (#ad...).
    mentions: mentionsOf(key, record),
    // What it saw on wrists, arms and hands (per-photo runs), so a No or Unsure explains itself.
    notes: shortNotes(record.stage1?.notes),
    // The photos worth looking at (a wrist, hand or arm, or a device), by photo number, and each
    // photo's post code, so the screen only filters when its photos are exactly the model's photos.
    focus: Array.isArray(record.focus_photos) ? record.focus_photos : null,
    order: Array.isArray(record.photo_order) ? record.photo_order : null,
    confidence: confidenceOf(record, devices),
    device: deviceConfidence(record, devices),
    autoNo: saysNo(key),
    autoYes: saysYes(key),
    // What the model would decide on its own (shown as "Auto would say" while auto-Yes is off).
    auto: autoDecision(key, record),
    autoYesOn: AUTO_YES,
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

// How sure it is about the exact device (Apple Watch, Garmin...), 0-100: the closer look's own score; for
// answers from before it gave one, from its certainty (confirmed 85, probable 60, possible 35; an
// Unknown type 10).
function deviceConfidence(record, devices) {
  if (record.decision !== 'Yes') return null
  const lead = [...devices].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0]
  // No device in the photos, a brand named in the bio or captions: that brand, 60 (not seen worn).
  if (!lead) {
    const named = Object.keys(record.text_mentions || {})[0]
    return named ? { brand: named, score: 60, fromText: true } : null
  }
  const unknown = /^Unknown|^Other/.test(lead.brand || '')
  if (Number.isFinite(lead.brand_confidence)) return { brand: lead.brand, score: lead.brand_confidence }
  const score = { confirmed: 85, probable: 60, possible: 35 }
  return { brand: lead.brand, score: unknown ? 10 : score[lead.certainty] || 35 }
}

function mentionsOf(key, record) {
  const found = record.text_mentions || {}
  if (!Object.keys(found).length) return []
  let profile = {}
  try {
    profile = JSON.parse(fs.readFileSync(path.join(DIR, 'profiles', `${key}.json`), 'utf8'))
  } catch {}
  const textOf = (where) => (where === 'bio' ? profile.bio : where === 'name' ? profile.name : (profile.posts || []).find((post) => `caption ${post.index}` === where)?.caption) || ''
  return Object.entries(found).map(([brand, places]) => {
    const text = String(textOf(places[0]))
    const at = text.toLowerCase().indexOf(brand.toLowerCase().split(' ')[0])
    // About a sentence around the name, cut at whole words.
    let start = Math.max(0, at - 60)
    let end = Math.min(text.length, at + 80)
    if (start > 0) start = text.indexOf(' ', start) + 1
    if (end < text.length) end = Math.max(at + brand.length, text.lastIndexOf(' ', end))
    const quote = `${start > 0 ? '… ' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? ' …' : ''}`
    const paid = places.some((where) => /#(ad|sponsored|gifted)\b|partner|paid partnership|ambassador|#collab/i.test(textOf(where)))
    return { brand, where: places[0].replace('caption ', 'post '), count: places.length, quote, paid }
  })
}

// The model's notes, cut at a sentence: they list every wrist it looked at and can run long.
function shortNotes(notes) {
  const text = String(notes || '').trim()
  if (text.length <= 320) return text
  const cut = text.slice(0, 320)
  const end = cut.lastIndexOf('. ')
  return `${end > 80 ? cut.slice(0, end + 1) : cut.trim()} …`
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

// What the model decides on its own, in order of importance (11 Oct):
//   Wearable (a fitness wearable on the owner): 85+ passes, 50-84 review, under 50 No
//   Profile (active, own-life content):        65+ passes, 50-64 review, under 50 No
//   Device (the exact brand):                   80+ and one of our devices passes, else review (never No)
// The model's No and every Unsure (closer look found nothing, content filter, private, deleted, no
// posts) are a No. All three passing is a Yes with that device: for now only shown ("Auto would say"),
// AUTO_YES is on (11 Oct): all three passing is written as Yes with that device, the rest goes to the person.
// Not decided (null) while the answer is pending, unreadable, an error, on photos since fetched again,
// or a "no posts" profile whose photos simply failed to download.
const AUTO_YES = true // on since 11 Oct (asked to skip the shadow phase)
const CURRENT_PROMPTS = new Set(['photos-v3', 'photos-v4'])
const DEVICES = ['Garmin', 'WHOOP', 'Apple Watch', 'Oura', 'Polar']
const GATES = { wearable: { pass: 85, floor: 50 }, profile: { pass: 65, floor: 50 }, device: { pass: 80 } }

function autoDecision(key, record) {
  if (!record) return null
  // Only answers from the current model (every photo on its own, closer look, profile picture); older
  // ones are judged again first.
  if (!CURRENT_PROMPTS.has(record.prompt)) return null
  if (record.acquired_at && record.acquired_at !== acquiredAt(key)) return null
  if (record.status === 'error' || record.status === 'login-wall' || record.status === 'not acquired') return null
  if ('_unparsed' in (record.stage1 || {}) || record.verdict === 'unreadable') return null
  if (record.status !== 'ok') {
    if (record.status === 'no-posts' && downloadsFailed(key)) return null
    return { verdict: 'no', reasons: [`profile ${record.status}`] }
  }
  const match = record.match?.version === 'active-v1' ? record.match : null
  if (match && match.score < GATES.profile.floor) return { verdict: 'no', reasons: [`profile ${match.score} (under ${GATES.profile.floor})`] }
  if (record.decision === 'No') return { verdict: 'no', reasons: ['no wearable on the owner'] }
  if (record.decision !== 'Yes') return { verdict: 'no', reasons: [`unsure (${record.verdict || 'no answer'})`] }
  const devices = (record.devices || [])
  const wearable = confidenceOf(record, devices)
  if (wearable != null && wearable < GATES.wearable.floor) return { verdict: 'no', reasons: [`wearable ${wearable} (under ${GATES.wearable.floor})`] }
  const device = deviceConfidence(record, devices)
  const reasons = []
  if (!(wearable >= GATES.wearable.pass)) reasons.push(`wearable ${wearable} (under ${GATES.wearable.pass})`)
  if (!match) reasons.push('profile not scored yet')
  else if (match.score < GATES.profile.pass) reasons.push(`profile ${match.score} (under ${GATES.profile.pass})`)
  if (!device || !DEVICES.includes(device.brand)) reasons.push(`device ${device?.brand || 'unknown'} is not one of ours`)
  else if (device.score < GATES.device.pass) reasons.push(`device ${device.score} (under ${GATES.device.pass})`)
  return reasons.length ? { verdict: 'review', reasons } : { verdict: 'yes', device: device.brand, reasons: [] }
}

function downloadsFailed(key) {
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(DIR, 'profiles', `${key}.json`), 'utf8'))
    return (profile.posts || []).some((post) => post.error)
  } catch {
    return true
  }
}

// The model's No goes to the sheet without a person (see autoDecision).
function saysNo(username) {
  const key = String(username || '').toLowerCase()
  return autoDecision(key, predictions().get(key))?.verdict === 'no'
}

// How many Yes and No the model has written so far (data/wearable/auto-no.jsonl, every automatic decision).
let autoCache = { mtime: 0, yes: 0, no: 0 }
function autoTotals() {
  let mtime = 0
  try { mtime = fs.statSync(AUTO).mtimeMs } catch { return { yes: 0, no: 0 } }
  if (mtime !== autoCache.mtime) {
    const rows = new Map()
    for (const line of fs.readFileSync(AUTO, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        rows.set(entry.sheetRow, entry.choice === 'yes' ? 'yes' : 'no')
      } catch {}
    }
    const values = [...rows.values()]
    autoCache = { mtime, yes: values.filter((v) => v === 'yes').length, no: values.filter((v) => v === 'no').length }
  }
  return { yes: autoCache.yes, no: autoCache.no }
}

// Where an undecided profile stands: 'review' (for the person), 'auto' (the model decided; the sheet
// write follows within a minute or two) or 'judging' (no answer from the current model yet).
function stateOf(username) {
  const key = String(username || '').toLowerCase()
  const auto = autoDecision(key, predictions().get(key))
  if (!auto) return 'judging'
  if (auto.verdict === 'review' || (auto.verdict === 'yes' && !AUTO_YES)) return 'review'
  return 'auto'
}

// An automatic Yes (with its device), once AUTO_YES is on.
function saysYes(username) {
  if (!AUTO_YES) return null
  const key = String(username || '').toLowerCase()
  const auto = autoDecision(key, predictions().get(key))
  return auto?.verdict === 'yes' ? auto.device : null
}

// Every No the model wrote to the sheet, with what it saw, so any of them can be checked later.
const AUTO = path.join(DIR, 'auto-no.jsonl')
function logAuto(entry) {
  const record = predictions().get(String(entry.username || '').toLowerCase()) || {}
  fs.mkdirSync(DIR, { recursive: true })
  fs.appendFileSync(AUTO, `${JSON.stringify({ at: new Date().toISOString(), choice: 'no', ...entry, prompt: record.prompt, notes: record.stage1?.notes || '', gauges: { wearable: record.confidence, device: record.brand_confidence, profile: record.match?.score } })}\n`)
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

module.exports = { prediction, record, agreement, imagePath, saysNo, saysYes, stateOf, autoTotals, logAuto, LIST }

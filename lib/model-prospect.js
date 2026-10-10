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
  const devices = (record.devices || []).map((device) => ({ brand: device.brand, certainty: device.certainty, tiles: device.tiles, evidence: device.evidence }))
  return {
    status: 'ready',
    decision: record.decision,
    verdict: record.verdict,
    brands: record.brands || [],
    possibleBrands: record.possible_brands || [],
    devices: devices.slice(0, 4),
    textMentions: Object.keys(record.text_mentions || {}),
    profileStatus: record.status,
  }
}

function record(entry) {
  const model = prediction(entry.username)
  fs.mkdirSync(DIR, { recursive: true })
  fs.appendFileSync(EVAL, `${JSON.stringify({ at: new Date().toISOString(), ...entry, model })}\n`)
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

module.exports = { prediction, record, agreement, LIST }

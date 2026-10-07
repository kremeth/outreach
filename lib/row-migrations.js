// When rows are deleted from the main sheet, row numbers shift. Each file in migrations/ lists the
// deleted rows ([deleted row, kept row] in the old numbering); on start, every computer applies new
// ones once to its local files that store row numbers, so they keep pointing at the same creators.
// (The shared App Log is updated once, centrally, when the rows are deleted.)
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DIR = path.join(ROOT, 'migrations')
const APPLIED = path.join(ROOT, 'data', 'applied-migrations.json')

function mapperFor(deleted) {
  const gone = deleted.map(([row]) => row).sort((a, b) => a - b)
  const keepOf = new Map(deleted)
  const below = (row) => {
    let lo = 0
    let hi = gone.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (gone[mid] < row) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const map = (row) => (keepOf.has(row) ? map(keepOf.get(row)) : row - below(row))
  return map
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeAtomic(file, text) {
  fs.writeFileSync(`${file}.tmp`, text)
  fs.renameSync(`${file}.tmp`, file)
}

// Prospecting decisions, keyed by row. A deleted row's decision only moves if the kept row has none.
function remapDecisions(map) {
  const file = path.join(ROOT, 'sheet-review-state.json')
  const state = readJson(file, null)
  if (!state?.decisions) return
  const next = {}
  const entries = Object.entries(state.decisions).sort((a, b) => Number(a[0]) - Number(b[0]))
  for (const [row, decision] of entries) {
    const key = String(map(Number(row)))
    if (!next[key]) next[key] = decision
  }
  writeAtomic(file, JSON.stringify({ ...state, decisions: next }, null, 2))
}

function remapJsonLines(file, map) {
  if (!fs.existsSync(file)) return
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try {
      const entry = JSON.parse(line)
      if (Number.isFinite(Number(entry.sheetRow))) entry.sheetRow = map(Number(entry.sheetRow))
      return JSON.stringify(entry)
    } catch {
      return line
    }
  })
  writeAtomic(file, `${lines.join('\n')}\n`)
}

function apply() {
  if (!fs.existsSync(DIR)) return []
  const applied = new Set(readJson(APPLIED, []))
  const done = []
  for (const name of fs.readdirSync(DIR).filter((file) => file.endsWith('.json')).sort()) {
    const migration = readJson(path.join(DIR, name), null)
    if (!migration?.id || applied.has(migration.id)) continue
    const map = mapperFor(migration.deleted)
    remapDecisions(map)
    remapJsonLines(path.join(ROOT, 'data', 'relaunch', 'sent-log.jsonl'), map)
    remapJsonLines(path.join(ROOT, 'data', 'voice', 'sent-log.jsonl'), map)
    applied.add(migration.id)
    done.push(migration.id)
  }
  if (done.length) {
    fs.mkdirSync(path.dirname(APPLIED), { recursive: true })
    writeAtomic(APPLIED, JSON.stringify([...applied], null, 2))
  }
  return done
}

module.exports = { apply, mapperFor }

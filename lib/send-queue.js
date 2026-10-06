const fs = require('fs')
const path = require('path')
const writer = require('./sheet-writer')
const data = require('./data')
const sheet = require('./sheet')

const HEADER_ROW = 3
const CLIPS_DIR = path.join(__dirname, '..', 'data', 'voice', 'clips')
const LOG_PATH = path.join(__dirname, '..', 'data', 'voice', 'sent-log.jsonl')
const VOICES = ['Romain', 'Mathieu']
const QUEUE_STATES = new Set(['', 'not messaged'])
const DAILY_LIMIT = 30

let columns = null

function letter(index) {
  let number = index + 1
  let out = ''
  while (number > 0) {
    const remainder = (number - 1) % 26
    out = String.fromCharCode(65 + remainder) + out
    number = Math.floor((number - 1) / 26)
  }
  return out
}

function clipFor(voice, device) {
  const wanted = `${voice} ${device}.m4a`.toLowerCase()
  const file = fs.readdirSync(CLIPS_DIR).find((name) => name.toLowerCase() === wanted)
  return file ? path.join(CLIPS_DIR, file) : ''
}

function pickVoice(device) {
  const options = VOICES.filter((voice) => clipFor(voice, device))
  if (!options.length) return null
  const voice = options[Math.floor(Math.random() * options.length)]
  return { voice, clip: clipFor(voice, device) }
}

async function readGrid() {
  if (!writer.sheetTitle) await writer.prepare()
  const range = `${writer.quoteTitle(writer.sheetTitle)}!A${HEADER_ROW}:AZ`
  const result = await writer.api('GET', `/values/${encodeURIComponent(range)}`)
  return result.values || []
}

async function ensureColumns(header) {
  const find = (name) => header.findIndex((cell) => String(cell || '').trim().toLowerCase() === name.toLowerCase())
  columns = {
    name: find('NAME'),
    link: find('DIRECT LINK'),
    keep: find('KEEP HUSTLING?'),
    device: find('Device'),
    accepted: find('ACCEPTED?'),
    voice: find('Voice'),
    voiceDate: find('Voice date'),
  }
  for (const key of ['name', 'link', 'keep', 'device', 'accepted']) {
    if (columns[key] === -1) throw new Error(`The sheet has no ${key} column.`)
  }
  const created = []
  if (columns.voice === -1) {
    columns.voice = columns.accepted + 1
    created.push({ cell: `${letter(columns.voice)}${HEADER_ROW}`, value: 'Voice' })
  }
  if (columns.voiceDate === -1) {
    columns.voiceDate = Math.max(columns.voice, columns.accepted) + 1
    created.push({ cell: `${letter(columns.voiceDate)}${HEADER_ROW}`, value: 'Voice date' })
  }
  if (created.length) await writer.setCells(created)
  await writer.loadAcceptedRule(letter(columns.accepted))
}

async function loadQueue() {
  const grid = await readGrid()
  await ensureColumns(grid[0] || [])
  const queue = []
  grid.slice(1).forEach((row, offset) => {
    const cell = (index) => String(row[index] || '').trim()
    if (cell(columns.keep).toLowerCase() !== 'yes') return
    const device = cell(columns.device)
    if (!device) return
    if (!QUEUE_STATES.has(cell(columns.accepted).toLowerCase())) return
    const username = data.usernameFrom(cell(columns.link))
    if (!username) return
    queue.push({
      sheetRow: HEADER_ROW + 1 + offset,
      name: cell(columns.name),
      username,
      device,
      link: cell(columns.link),
    })
  })
  return queue
}

function sameLink(a, b) {
  const clean = (value) => String(value || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
  return clean(a) === clean(b)
}

// Re-reads the row from the live sheet right before sending: still the same creator, still Yes with a
// device, still not messaged. Protects against the other computer (or a manual edit) getting there first.
async function stillQueued(item) {
  if (!columns) await loadQueue()
  const cell = (key) => `${letter(columns[key])}${item.sheetRow}`
  const [link, keep, device, accepted] = (await writer.getValues([cell('link'), cell('keep'), cell('device'), cell('accepted')]))
    .map((values) => String(values?.[0]?.[0] || '').trim())
  return sameLink(link, item.link) && keep.toLowerCase() === 'yes' && Boolean(device) && QUEUE_STATES.has(accepted.toLowerCase())
}

async function markSent(item, voice) {
  const today = sheet.todayLabel()
  await writer.setAccepted(item.sheetRow, 'Pending')
  await writer.setCells([
    { cell: `${letter(columns.voice)}${item.sheetRow}`, value: voice },
    { cell: `${letter(columns.voiceDate)}${item.sheetRow}`, value: today },
  ])
  log({ ...item, voice, voiceDate: today, result: 'sent' })
}

async function markUnreachable(item, reason) {
  await writer.setAccepted(item.sheetRow, 'NA')
  log({ ...item, result: 'cannot message', reason: reason || '' })
}

function log(entry) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
  fs.appendFileSync(LOG_PATH, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`)
}

function sentToday() {
  if (!fs.existsSync(LOG_PATH)) return 0
  const today = new Date().toDateString()
  return fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.result === 'sent' && !entry.test && new Date(entry.at).toDateString() === today).length
}

function remainingToday() {
  return Math.max(0, DAILY_LIMIT - sentToday())
}

module.exports = {
  loadQueue,
  stillQueued,
  pickVoice,
  markSent,
  markUnreachable,
  sentToday,
  remainingToday,
  log,
  DAILY_LIMIT,
  CLIPS_DIR,
}

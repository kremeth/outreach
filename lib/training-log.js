// Training data for a future model that picks, rewrites or skips comments on its own.
// One row per round of 5 suggested comments shown in Hustling, with what was done with it, in the
// "HUSTLING Training Data" tab of the Google Sheet. Rows are only ever appended.
const writer = require('./sheet-writer')
const log = require('./shared-log')

const TAB = 'HUSTLING Training Data'
const HEADERS = [
  'Time', 'Machine', 'Username', 'Name', 'Followers', 'Post URL', 'Post ID',
  'Bio', 'Caption', 'Image description',
  'Round', 'Rewrite direction',
  'Comment 1', 'Comment 2', 'Comment 3', 'Comment 4', 'Comment 5',
  'Outcome', 'Picked #', 'Picked comment', 'Seconds to decide',
  'Post type', 'Transcript', 'Predicted %',
]
// picked: one of the 5 · own comment: typed their own · reloaded: asked for 5 new ones (the next
// row is the new round, with its rewrite direction) · skipped: skipped the post · later: moved on
// without deciding · undo pick: took back the previous pick
const OUTCOMES = new Set(['picked', 'own comment', 'reloaded', 'skipped', 'later', 'undo pick'])
const FLUSH_MS = 3000

let ready = null
let pending = []
let timer = null

function ensureTab() {
  if (!ready) {
    ready = (async () => {
      const meta = await writer.api('GET', '?fields=sheets.properties(title,sheetId,gridProperties.columnCount)')
      const existing = (meta.sheets || []).find((item) => item.properties.title === TAB)
      if (existing) return addNewColumns(existing.properties)
      try {
        await writer.api('POST', ':batchUpdate', {
          requests: [{ addSheet: { properties: { title: TAB, gridProperties: { rowCount: 1000, columnCount: HEADERS.length, frozenRowCount: 1 } } } }],
        })
        await writer.api('PUT', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!A1`)}?valueInputOption=RAW`, { values: [HEADERS] })
      } catch (error) {
        // The other computer may have created it at the same moment.
        if (!/already exists/i.test(error.message || '')) throw error
      }
    })()
    ready.catch(() => { ready = null })
  }
  return ready
}

// Columns added after the tab was first made: widen it and fill in their headers. Only the missing
// header cells are written, so both computers doing it at once is harmless.
async function addNewColumns(properties) {
  const columns = properties.gridProperties?.columnCount || 0
  if (columns < HEADERS.length) {
    await writer.api('POST', ':batchUpdate', {
      requests: [{ appendDimension: { sheetId: properties.sheetId, dimension: 'COLUMNS', length: HEADERS.length - columns } }],
    })
  }
  const range = `${writer.quoteTitle(TAB)}!A1:${columnLetter(HEADERS.length)}1`
  const current = ((await writer.api('GET', `/values/${encodeURIComponent(range)}`)).values || [[]])[0]
  if (HEADERS.every((header, index) => current[index] === header)) return
  await writer.api('PUT', `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { values: [HEADERS.map((header, index) => current[index] || header)] })
}

function columnLetter(count) {
  let out = ''
  for (let n = count; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out
  return out
}

const clip = (value, max) => String(value ?? '').slice(0, max)

function rowFrom(event) {
  const comments = Array.isArray(event.comments) ? event.comments : []
  return [
    new Date().toISOString(),
    log.MACHINE,
    clip(event.username, 60),
    clip(event.name, 120),
    clip(event.followers, 30),
    event.code ? `https://www.instagram.com/p/${clip(event.code, 40)}/` : '',
    clip(event.pk, 40),
    clip(event.bio, 1000),
    clip(event.caption, 2000),
    clip(event.description, 1500),
    Number(event.round) || 1,
    clip(event.guidance, 200),
    ...[0, 1, 2, 3, 4].map((index) => clip(comments[index], 300)),
    event.outcome,
    event.pickedIndex ? Number(event.pickedIndex) : '',
    clip(event.pickedText, 300),
    Number.isFinite(Number(event.seconds)) ? Math.round(Number(event.seconds)) : '',
    ({ video: 'reel', carousel: 'carousel', photo: 'photo' })[event.format] || '',
    clip(event.transcript, 5000),
    // The model's chance for comments 1-5 when they were shown, e.g. "12/46/20/12/10".
    Array.isArray(event.predicted) && event.predicted.length === 5 ? event.predicted.map((value) => Math.round(Number(value) || 0)).join('/') : '',
  ]
}

async function flush() {
  timer = null
  if (!pending.length) return
  const rows = pending
  pending = []
  try {
    await ensureTab()
    await writer.api('POST', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows })
  } catch (error) {
    console.error('training data not saved yet, will retry', error.message)
    pending = [...rows, ...pending]
    timer = setTimeout(flush, 30000)
  }
}

// Queues one round; rows are written in small batches every few seconds.
function record(event) {
  if (!OUTCOMES.has(event.outcome) || !event.username) return false
  pending.push(rowFrom(event))
  if (!timer) timer = setTimeout(flush, FLUSH_MS)
  return true
}

module.exports = { record, flush, TAB }

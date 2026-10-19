// The "Replies" tab of the Google Sheet: every conversation waiting on us (unread or not), with all of
// their messages since our last one (voicenotes as their transcript), and what was decided:
//   Waiting          -> on DMs to reply
//   No reply needed  -> never shown again for that same message (both Macs read this tab)
//   Answered         -> a reply went out from Outreach
// A message is recognised by its letters and digits (emojis, a cut-short inbox preview or "Liked a
// message" on top do not make it look new); only a new message from them brings a conversation back.
// Columns: Username | Name | Their messages | Last message | Status | Updated
const writer = require('./sheet-writer')

const TAB = 'Replies'
const HEADERS = ['Username', 'Name', 'Their messages', 'Last message', 'Status', 'Updated']
const CACHE_MS = 60 * 1000

let cache = { at: 0, rows: [] }
let tabReady = false

const norm = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
// The same message? (one may be cut short: the inbox preview of a long message)
function sameMessage(a, b) {
  const x = norm(a).slice(0, 60)
  const y = norm(b).slice(0, 60)
  if (!x || !y) return false
  return x === y || (Math.min(x.length, y.length) >= 12 && (x.startsWith(y) || y.startsWith(x)))
}

const range = (a1) => `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!${a1}`)}`

async function ensureTab() {
  if (tabReady) return
  await writer.prepare()
  const meta = await writer.api('GET', '?fields=sheets.properties(title)')
  if (!(meta.sheets || []).some((sheet) => sheet.properties.title === TAB)) {
    try {
      await writer.api('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } } }] })
    } catch (error) {
      if (!/already exists/i.test(error.message || '')) throw error
    }
    await writer.api('PUT', `${range('A1')}?valueInputOption=RAW`, { values: [HEADERS] })
  }
  tabReady = true
}

async function rows(force = false) {
  if (!force && Date.now() - cache.at < CACHE_MS) return cache.rows
  await ensureTab()
  const values = (await writer.api('GET', range('A2:F'))).values || []
  cache = {
    at: Date.now(),
    rows: values.map((row, index) => ({ row: index + 2, username: String(row[0] || '').replace(/^@/, '').trim().toLowerCase(), name: String(row[1] || '').trim(), messages: row[2] || '', last: row[3] || '', status: String(row[4] || '').trim(), updated: row[5] || '' })),
  }
  return cache.rows
}

// The row of a conversation: by username, else by name.
function find(list, item) {
  const username = String(item.username || '').replace(/^@/, '').toLowerCase()
  return (username && list.find((row) => row.username === username)) || list.find((row) => !row.username && row.name && row.name === item.name) || null
}

// Their last message in a list item (the chat's messages since ours when read, else the preview).
function lastOf(item) {
  const recent = (item.recent || []).filter((message) => !message.ours)
  const last = recent[recent.length - 1]
  return String(last ? last.text || (last.voice ? 'Voicenote' : '') : item.rawPreview || item.preview || '').trim()
}

// "No reply needed" was pressed on this same message (the cached tab; read again every minute).
function isDismissed(item) {
  const row = find(cache.rows, item)
  if (!row || row.status !== 'No reply needed') return false
  const last = lastOf(item)
  // Their last message, or (a preview such as "2 new messages") any of their messages saved with it.
  return sameMessage(row.last, last) || String(row.messages).split('\n').some((line) => sameMessage(line.replace(/^\[voicenote\]\s*/i, ''), last))
}

const stamp = () => new Date().toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const messagesText = (item) => {
  const recent = (item.recent || []).filter((message) => !message.ours)
  const lines = recent.length ? recent.map((message) => (message.voice ? `[voicenote] ${message.text || '(no words yet)'}` : String(message.text || ''))) : [String(item.rawPreview || item.preview || '')]
  return lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 45000)
}

// Brings the tab up to date with the conversations waiting (every 2 minutes): new ones added, changed
// ones updated (a new message after "No reply needed" or "Answered" makes it Waiting again).
async function sync(items) {
  const list = await rows(true)
  const updates = []
  const appends = []
  for (const item of items) {
    const last = lastOf(item)
    if (!last) continue
    const row = find(list, item)
    const messages = messagesText(item)
    const username = String(item.username || '').replace(/^@/, '').toLowerCase()
    if (!row) {
      appends.push([username, item.name || '', messages, last, 'Waiting', stamp()])
      continue
    }
    const same = sameMessage(row.last, last)
    // Same message: only fuller details (transcripts, all messages); the decision stays.
    if (same && row.messages === messages && (row.username || !username)) continue
    const status = same ? row.status || 'Waiting' : 'Waiting'
    updates.push({ range: `${writer.quoteTitle(TAB)}!A${row.row}:F${row.row}`, values: [[row.username || username, row.name || item.name || '', messages, last, status, same ? row.updated : stamp()]] })
  }
  if (updates.length) await writer.api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: updates })
  if (appends.length) await writer.api('POST', `${range('A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: appends })
  if (updates.length || appends.length) await rows(true)
  return { updated: updates.length, added: appends.length }
}

// A decision on a conversation's current message: 'No reply needed' or 'Answered'.
async function mark(item, status) {
  const list = await rows(true)
  const row = find(list, item)
  const last = lastOf(item) || String(item.preview || '')
  const username = String(item.username || '').replace(/^@/, '').toLowerCase()
  const values = [[(row && row.username) || username, (row && row.name) || item.name || '', row && sameMessage(row.last, last) && row.messages ? row.messages : messagesText(item), last, status, stamp()]]
  if (row) await writer.api('PUT', `${range(`A${row.row}:F${row.row}`)}?valueInputOption=RAW`, { values })
  else await writer.api('POST', `${range('A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values })
  await rows(true)
}

module.exports = { sync, mark, isDismissed, rows, sameMessage, TAB }

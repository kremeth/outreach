// DMs to reply to: the Instagram inbox (Primary and General) read in the Outreach panel every 20
// minutes, read only. A conversation is "to reply" when their message is the last one (the preview does
// not start with "You"); it drops off by itself once we answer. For each one the chat is opened once (per
// new message) for their username and newest messages, with their voicenotes transcribed by Instagram.
// A conversation showing "This account can't receive your message" is handed to the sheet: NA, then
// Launch unfollows them and sets Keep hustling to No.
const fs = require('fs')
const path = require('path')

const STATE_PATH = path.join(__dirname, '..', 'data', 'dm-inbox.json')
const OPENS_PER_SCAN = 8

const OURS = /^(you:|you sent|you replied|you reacted|you liked|you shared|you unsent|you mentioned)/i
const UNREACHABLE = /can.t receive your message|don.t allow new message requests/i
const SKIP_NAME = /^(partnership messages|primary|general|requests|messages|hidden requests)$/i

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { scannedAt: 0, rows: {} }
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  const tmp = `${STATE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
  fs.renameSync(tmp, STATE_PATH)
}

// One inbox row: ['Name', 'preview', '·', '1m'] (the dot and the age are optional).
function parseRow(lines, folder) {
  // "Active" / "Active now" (their online status) can come first: not part of the row.
  while (lines.length && /^active( now| \d+\w? ago)?$/i.test(lines[0])) lines = lines.slice(1)
  const [name, preview = '', ...rest] = lines
  if (!name || SKIP_NAME.test(name)) return null
  const age = rest.filter((line) => line !== '·').pop() || ''
  return {
    key: name, // Primary and General can list the same conversation: once, by name
    name,
    folder,
    preview,
    age,
    ours: OURS.test(preview),
    typing: /^typing/i.test(preview),
    unreachable: UNREACHABLE.test(preview),
    voice: /voice message|voicenote|audio/i.test(preview),
  }
}

// One scan: both folders, then opens the new "to reply" ones and the unreachable ones.
// ig: lib/ig-app; onUnreachable(username, row): marks the sheet (NA) so Launch closes them out.
async function scan(ig, onUnreachable) {
  const state = load()
  const seen = {}
  for (const folder of ['inbox', 'general']) {
    const page = await ig.inboxState({ folder })
    for (const raw of page.rows || []) {
      const row = parseRow(raw.lines || [], folder)
      if (row && !row.typing && !seen[row.key]) seen[row.key] = row
    }
  }
  let opens = 0
  for (const row of Object.values(seen)) {
    const before = state.rows[row.key]
    const changed = !before || before.preview !== row.preview
    row.username = before?.username || ''
    row.threadId = before?.threadId || ''
    row.messages = changed ? [] : before.messages || []
    row.handled = before?.handled || false
    const needsOpen = (!row.ours || row.unreachable) && (changed || !row.username) && !row.handled
    if (needsOpen && opens < OPENS_PER_SCAN) {
      opens++
      try {
        const chat = await ig.openInboxRow({ name: row.name, folder: row.folder, transcribe: !row.unreachable })
        row.username = chat.username || row.username
        row.threadId = chat.threadId || row.threadId
        row.messages = (chat.messages || []).map((message) => ({ ours: message.ours, voice: message.voice, text: message.text, at: message.at }))
      } catch (error) {
        if (['busy', 'login', 'blocked', 'app', 'hidden'].includes(error.kind)) throw error
        row.error = error.message
      }
    }
    if (row.unreachable && row.username && !row.handled && onUnreachable) {
      row.handled = Boolean(await onUnreachable(row.username, row).catch(() => false))
    }
  }
  state.rows = seen
  state.scannedAt = Date.now()
  save(state)
  return summary(state)
}

// Their last messages since ours, voicenotes as their transcription when Instagram gave one.
function lastWords(row) {
  const messages = row.messages || []
  const lastOurs = messages.map((message) => message.ours).lastIndexOf(true)
  return messages.slice(lastOurs + 1).filter((message) => !message.ours).map((message) => {
    if (!message.voice) return { text: message.text }
    const words = String(message.text || '').replace(/\d+:\d{2}/, '').replace(/(view|hide) transcription/ig, '').trim()
    return { voice: true, text: words || '(voicenote, no transcription)' }
  })
}

function summary(state = load()) {
  const toReply = Object.values(state.rows || {})
    .filter((row) => !row.ours && !row.unreachable)
    .map((row) => ({ name: row.name, username: row.username, folder: row.folder, age: row.age, preview: row.preview, threadId: row.threadId, words: lastWords(row) }))
  const unreachable = Object.values(state.rows || {}).filter((row) => row.unreachable).map((row) => ({ name: row.name, username: row.username, handled: row.handled }))
  return { scannedAt: state.scannedAt || 0, toReply, unreachable }
}

module.exports = { scan, summary, parseRow }

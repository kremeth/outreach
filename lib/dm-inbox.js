// DMs to reply to: the Instagram inbox list (Primary), read in the Outreach panel every 20 minutes,
// read only: no conversation is ever opened (so nothing is marked as seen). It scrolls through the
// last 100 conversations and notes, from each row's preview, the ones where they wrote last (not
// "You: ..."); "Unread" ones are flagged. A conversation drops off by itself once we answer.
// A row showing "This account can't receive your message" is handed to the sheet (NA), and Launch
// then unfollows them and sets Keep hustling to No.
const fs = require('fs')
const path = require('path')

const STATE_PATH = path.join(__dirname, '..', 'data', 'dm-inbox.json')
const LIMIT = 100

const OURS = /^(you:|you sent|you replied|you reacted|you liked|you shared|you unsent|you mentioned|you started|you created|you named|you changed)/i
const UNREACHABLE = /can.t receive your message|don.t allow new message requests/i
const SKIP_NAME = /^(partnership messages|primary|general|requests|messages|hidden requests|notes?)$/i

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { scannedAt: 0, rows: [] }
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  const tmp = `${STATE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
  fs.renameSync(tmp, STATE_PATH)
}

// One inbox row: ['Name', 'preview', '·', '1m'] or ['Name', 'preview', 'Unread']; "Active" (their
// online status) can come first.
function parseRow(lines) {
  lines = [...lines]
  while (lines.length && /^active( now| \d+\w? ago)?$/i.test(lines[0])) lines = lines.slice(1)
  const [name, preview = '', ...rest] = lines
  if (!name || SKIP_NAME.test(name)) return null
  const unread = rest.some((line) => /^unread$/i.test(line)) || /^\d+ new messages?$/i.test(preview)
  const age = rest.filter((line) => line !== '·' && !/^unread$/i.test(line)).pop() || ''
  return {
    name,
    preview,
    age,
    unread,
    ours: OURS.test(preview),
    typing: /^typing/i.test(preview),
    unreachable: UNREACHABLE.test(preview),
    voice: /voice message|voicenote|audio/i.test(preview),
  }
}

// ig: lib/ig-app; onUnreachable(name, row): marks the sheet (NA) so Launch closes them out.
async function scan(ig, onUnreachable) {
  const previous = load()
  const page = await ig.inboxState({ folder: 'inbox', limit: LIMIT })
  const rows = []
  const names = new Set()
  for (const raw of page.rows || []) {
    const row = parseRow(raw.lines || [])
    if (!row || row.typing || names.has(row.name)) continue
    names.add(row.name)
    row.handled = Boolean((previous.rows || []).find((item) => item.name === row.name && item.unreachable && item.handled))
    if (row.unreachable && !row.handled && onUnreachable) row.handled = Boolean(await onUnreachable(row.name, row).catch(() => false))
    rows.push(row)
  }
  const state = { scannedAt: Date.now(), looked: rows.length, rows }
  save(state)
  return summary(state)
}

function summary(state = load()) {
  const rows = state.rows || []
  const toReply = rows
    // A like or reaction you have already seen needs no answer.
    .filter((row) => !row.ours && !row.unreachable && (row.unread || !/^(liked a message|reacted .*|.* reacted to your message)$/i.test(row.preview)))
    .map((row) => ({ name: row.name, age: row.age, unread: row.unread, voice: row.voice, preview: row.voice && !row.preview ? 'Voicenote' : row.preview }))
  return {
    scannedAt: state.scannedAt || 0,
    looked: state.looked || 0,
    unread: rows.filter((row) => row.unread).length,
    toReply,
    unreachable: rows.filter((row) => row.unreachable).map((row) => ({ name: row.name, handled: row.handled })),
  }
}

module.exports = { scan, summary, parseRow }

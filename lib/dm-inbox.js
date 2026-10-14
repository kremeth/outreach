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
// Not a reply: a like or reaction, or a line Instagram writes on its own (connected, accepted, unsent,
// a story mention...). Never listed, read or unread.
const NOT_A_REPLY = /^(·|liked a message|liked your (message|story|note)|reacted .*|.* reacted (.* )?to your (message|story)|.*sent an attachment|mentioned you in (their|a) story|replied to your story|unsent a message|this message (was|has been) unsent|you can now message .*|.*accepted your (message )?request.*|.*is now connected.*|you.re now connected.*|say hi to .*|started a (video|audio) chat|missed (video|audio) chat|.*changed the (theme|group photo|group name).*|.*joined the (group|chat).*|.*left the (group|chat).*)$/i

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
  // "No reply needed" stays until they write something new.
  const dismissed = Object.fromEntries(Object.entries(previous.dismissed || {}).filter(([name, preview]) => rows.some((row) => row.name === name && row.preview === preview)))
  const state = { scannedAt: Date.now(), looked: rows.length, rows, dismissed }
  save(state)
  return summary(state)
}

// What their last message is about, from the preview (a hint for the list and the reply box).
function tagOf(preview) {
  const text = String(preview || '')
  if (/^\d+ new messages?$/i.test(text) || /voice message/i.test(text)) return ''
  if (/only (do |work on |take )?paid|paid (partnerships?|collab\w*) only|my rates|media kit|work for free|charge for/i.test(text)) return 'paid'
  if (/not (the best|a good|really a|the right) fit|give this a pass|pass on this|i.ll pass|going to pass|not into|not my thing|(no|don.t have( the)?) capacity|not at this time|can.t commit|clash with|not for me|don.t think i.d be|not interested|no thanks/i.test(text)) return 'declined'
  if (/back burner|reconnect (later|in|around|next)|later on|next year|in the future|not right now|at the moment/i.test(text) && !/\?/.test(text)) return 'later'
  if (/\?/.test(text)) return 'question'
  if (/@[\w.-]+\.\w+|e-?mail|manager|agent/i.test(text)) return 'contact'
  if (/keen|interested|hear more|love to|would love|sounds (good|great|amazing|interesting)|tell me more|in mind|let.s (do|collab|go)|count me in|i.m in|definitely/i.test(text)) return 'interested'
  return ''
}

function dismiss(name, preview) {
  const state = load()
  state.dismissed = { ...(state.dismissed || {}), [name]: preview }
  save(state)
}

function summary(state = load()) {
  const rows = state.rows || []
  const dismissed = state.dismissed || {}
  const toReply = rows
    .filter((row) => !row.ours && !row.unreachable && !NOT_A_REPLY.test(String(row.preview || '').trim()) && String(row.preview || '').trim() && dismissed[row.name] !== row.preview)
    .map((row) => ({ name: row.name, age: row.age, unread: row.unread, voice: row.voice, tag: tagOf(row.preview), preview: row.voice && !row.preview ? 'Voicenote' : row.preview }))
  return {
    scannedAt: state.scannedAt || 0,
    looked: state.looked || 0,
    unread: rows.filter((row) => row.unread).length,
    toReply,
    unreachable: rows.filter((row) => row.unreachable).map((row) => ({ name: row.name, handled: row.handled })),
  }
}

module.exports = { scan, summary, parseRow, dismiss, tagOf }

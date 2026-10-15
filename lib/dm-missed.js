// Replies we missed: every chat Outreach reads for any reason (relaunches, reply relaunch checks, chats
// read ahead, drafts...) is looked at here; when THEY wrote last (Instagram's own lines such as
// "Auto-detected outcome" or reactions aside), the conversation goes on "DMs to reply" (unread), however
// old, until we answer or it is dismissed. Kept in data/dm-missed.json by username.
const fs = require('fs')
const path = require('path')

const STORE_PATH = path.join(__dirname, '..', 'data', 'dm-missed.json')
const RELAUNCH_STATE = path.join(__dirname, '..', 'data', 'hustle', 'reply-relaunch.json')

// Lines Instagram writes into the chat itself (not a message from them).
const SYSTEM = /^(auto-detected outcome|we've identified a lead|this account can.t receive|.*reacted .* to your message|liked a message|you.re now connected|.*accepted your (message )?request|this message (was|has been) unsent)/i
const UNREACHABLE = /can.t receive your message|don.t allow new message requests/i

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
  } catch {
    return { missed: {}, dismissed: {} }
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const tmp = `${STORE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
  fs.renameSync(tmp, STORE_PATH)
}

const clean = (text) => String(text || '').replace(/\d+:\d{2}/, '').replace(/(view|hide) transcription/gi, '').replace(/\s+/g, ' ').trim()

// Their message if they wrote last, else null. { unreachable: true } when the chat says they can't
// receive our messages (handled elsewhere: unfollow, Keep hustling No).
function theirLast(messages) {
  const real = (messages || []).filter((message) => !SYSTEM.test(String(message.text || '').trim()) || message.ours)
  if ((messages || []).some((message) => !message.ours && UNREACHABLE.test(message.text || ''))) return { unreachable: true }
  const last = real[real.length - 1]
  if (!last || last.ours) return null
  return { text: last.voice ? clean(last.text) || 'Voicenote' : clean(last.text) || 'New message', voice: Boolean(last.voice), at: last.at || 0 }
}

// A chat just read (any reason). name: the display name when known.
function note(username, messages, name = '') {
  username = String(username || '').replace(/^@/, '').toLowerCase()
  if (!username || !Array.isArray(messages) || !messages.length) return
  const state = load()
  const last = theirLast(messages)
  if (!last || last.unreachable) {
    if (state.missed[username]) {
      delete state.missed[username]
      save(state)
    }
    return
  }
  const before = state.missed[username]
  if (before && before.text === last.text) return
  state.missed[username] = { username, name: name || before?.name || '', text: last.text, voice: last.voice, at: last.at || before?.at || 0, notedAt: Date.now() }
  save(state)
}

// We answered (from the list, or the inbox shows ours last).
function answered(username) {
  const state = load()
  username = String(username || '').toLowerCase()
  if (!state.missed[username]) return
  delete state.missed[username]
  save(state)
}

// "No reply needed": off the list until they write something new.
function dismiss(username) {
  const state = load()
  username = String(username || '').toLowerCase()
  const item = state.missed[username]
  if (!item) return false
  state.dismissed[username] = item.text
  delete state.missed[username]
  save(state)
  return true
}

function list() {
  const state = load()
  return Object.values(state.missed).filter((item) => state.dismissed[item.username] !== item.text)
}

// The chats read before this existed: the reply relaunch checks remember each chat's last message.
// Only the ones where they wrote last (Instagram's lines aside: then their message text is unknown).
function backfill() {
  let rows = {}
  try { rows = JSON.parse(fs.readFileSync(RELAUNCH_STATE, 'utf8')).rows || {} } catch {}
  const state = load()
  let added = 0
  for (const row of Object.values(rows)) {
    const username = String(row.username || '').toLowerCase()
    if (!username || row.lastOurs || !row.lastText || UNREACHABLE.test(row.lastText) || state.missed[username]) continue
    const system = SYSTEM.test(row.lastText)
    state.missed[username] = { username, name: '', text: system ? 'New message' : clean(row.lastText), voice: /view transcription/i.test(row.lastText), at: row.lastAt || 0, notedAt: row.checkedAt || Date.now(), partial: true }
    added++
  }
  if (added) save(state)
  return added
}

module.exports = { note, answered, dismiss, list, backfill, theirLast }

// Replies we missed: every chat Outreach reads for any reason (relaunches, reply relaunch checks, chats
// read ahead, drafts...) is looked at here; when THEY wrote last (Instagram's own lines such as
// "Auto-detected outcome" or reactions aside), the conversation goes on "DMs to reply" (unread), however
// old, until we answer or it is dismissed. Kept in data/dm-missed.json by username.
// Dealt with (answered, or "No reply needed") is remembered for good in `handled` (username -> their
// last message then): that same message never comes back, from any chat read or restart; only a new one.
const fs = require('fs')
const path = require('path')

const STORE_PATH = path.join(__dirname, '..', 'data', 'dm-missed.json')
const RELAUNCH_STATE = path.join(__dirname, '..', 'data', 'hustle', 'reply-relaunch.json')

// Lines Instagram writes into the chat itself (not a message from them).
const SYSTEM = /^(auto-detected outcome|not everyone can message this|we've identified a lead|this account can.t receive|.*reacted .* to your message|liked a message|you.re now connected|.*accepted your (message )?request|this message (was|has been) unsent)/i
const UNREACHABLE = /can.t receive your message|don.t allow new message requests|not everyone can message this (profile|account)/i

function load() {
  try {
    const state = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
    // 17 Oct: entries from before handled had a source. The ones the person dismissed are kept as
    // dismissed; the others were set wrongly on 17 Oct morning (conversations never answered) and go.
    if (state.handled && Object.values(state.handled).some((item) => !item.source)) {
      for (const [username, item] of Object.entries(state.handled)) {
        if (item.source) continue
        if (state.dismissed?.[username] !== undefined) item.source = 'dismissed'
        else delete state.handled[username]
      }
      save(state)
    }
    return state
  } catch {
    return { missed: {}, dismissed: {}, handled: {} }
  }
}

// Their last message was already dealt with: the same text, or older than when it was dealt with.
function wasHandled(state, username, text, at) {
  const done = (state.handled || {})[username]
  if (!done) return false
  if (done.text && done.text === text) return true
  return Boolean(at && done.at && at < done.at - 60 * 1000)
}

// source: 'dismissed' ("No reply needed", kept for good), 'liked' (their message liked as the answer,
// kept for good: a like adds no message, so the chat still ends with theirs) or 'answered' (a reply
// went out; a chat read later that still ends with theirs says it did not arrive).
function markHandled(state, username, text, source, at = Date.now()) {
  state.handled = { ...(state.handled || {}), [username]: { text: text || '', at, source } }
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
  return { text: last.voice ? clean(last.text) || 'Voicenote' : clean(last.text) || 'New message', voice: Boolean(last.voice), at: last.at || 0, thread: real.slice(-12) }
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
  // A chat just read is the truth: their message last = waiting on us, even if a reply was logged as
  // sent (it may not have gone through). Only "No reply needed" on that same message keeps it off.
  const done = state.handled?.[username]
  if (done && done.source === 'answered') delete state.handled[username]
  if (done && ['dismissed', 'liked'].includes(done.source) && wasHandled(state, username, last.text, last.at)) {
    if (state.missed[username]) {
      delete state.missed[username]
      save(state)
    }
    return
  }
  const before = state.missed[username]
  if (before && before.text === last.text && !before.partial) return
  // The chat's last messages are kept so a "no" can be recognised (then it is closed out, not listed).
  const thread = last.thread.map((message) => ({ ours: Boolean(message.ours), text: String(message.voice ? clean(message.text) || '(voicenote)' : message.text || '').slice(0, 4000) }))
  state.missed[username] = { username, name: name || before?.name || '', text: last.text, voice: last.voice, at: last.at || before?.at || 0, notedAt: Date.now(), thread, verdict: before && before.text === last.text ? before.verdict || '' : '' }
  save(state)
}

// The reply check's verdict on their last message: 'ongoing' (listed) or 'no' (closed out instead).
function setVerdict(username, text, verdict, reason = '') {
  const state = load()
  const item = state.missed[String(username).toLowerCase()]
  if (!item || item.text !== text) return
  item.verdict = verdict
  item.reason = reason
  save(state)
}

function unchecked() {
  return Object.values(load().missed).filter((item) => !item.verdict)
}

// We answered (from the list, or the inbox shows ours last).
function answered(username) {
  const state = load()
  username = String(username || '').toLowerCase()
  if (!username) return
  markHandled(state, username, state.missed[username]?.text || '', 'answered')
  delete state.missed[username]
  save(state)
}

// Their last message liked (the "Like message" answer): off the list until they write something new.
// text: their message when known; at: when the like went out (messages from before it count as liked).
function liked(username, text = '', at = Date.now()) {
  const state = load()
  username = String(username || '').replace(/^@/, '').toLowerCase()
  if (!username) return
  markHandled(state, username, state.missed[username]?.text || clean(text), 'liked', at)
  delete state.missed[username]
  save(state)
}

// "No reply needed": off the list until they write something new.
// text: their message as the list showed it (when nothing is on the missed list for them).
function dismiss(username, text = '') {
  const state = load()
  username = String(username || '').replace(/^@/, '').toLowerCase()
  if (!username) return false
  const item = state.missed[username]
  const last = item?.text || clean(text)
  state.dismissed[username] = last
  markHandled(state, username, last, 'dismissed')
  delete state.missed[username]
  save(state)
  return true
}

function list() {
  const state = load()
  return Object.values(state.missed).filter((item) => state.dismissed[item.username] !== item.text && item.verdict !== 'no' && !wasHandled(state, item.username, item.text, item.at))
}

// The chats read before this existed: the reply relaunch checks remember each chat's last message.
// Only the ones where they wrote last (Instagram's lines aside: then their message text is unknown).
function backfill() {
  let rows = {}
  try { rows = JSON.parse(fs.readFileSync(RELAUNCH_STATE, 'utf8')).rows || {} } catch {}
  const state = load()
  // Once only (it used to run at every start, bringing back chats answered or dismissed since).
  if (state.backfilled) return 0
  state.backfilled = Date.now()
  let added = 0
  for (const row of Object.values(rows)) {
    const username = String(row.username || '').toLowerCase()
    if (!username || row.lastOurs || !row.lastText || UNREACHABLE.test(row.lastText) || state.missed[username] || state.handled?.[username]) continue
    const system = SYSTEM.test(row.lastText)
    const voice = /view transcription/i.test(row.lastText)
    const text = system ? 'New message' : clean(row.lastText) || (voice ? 'Voicenote' : 'New message')
    // Only their last line is known: a "no" can still be told from it; an unknown one is listed.
    state.missed[username] = { username, name: '', text, voice, at: row.lastAt || 0, notedAt: row.checkedAt || Date.now(), partial: true, thread: system || text === 'Voicenote' ? [] : [{ ours: false, text }], verdict: system || text === 'Voicenote' ? 'ongoing' : '' }
    added++
  }
  save(state)
  return added
}

// Was this message from them already dealt with? at: when they wrote it (0 unknown; -1 = by text only).
// dismissedOnly: only "No reply needed" counts (for the inbox list: when the inbox shows their message
// last, they are waiting on us whatever was answered before).
function isHandled(username, text, at = 0, dismissedOnly = false) {
  const state = load()
  username = String(username || '').replace(/^@/, '').toLowerCase()
  const done = (state.handled || {})[username]
  if (!done) return false
  if (dismissedOnly && done.source !== 'dismissed') return false
  if (done.text && done.text === clean(text)) return true
  return at > 0 && wasHandled(state, username, '', at)
}

module.exports = { isHandled, SYSTEM, note, answered, liked, dismiss, list, backfill, theirLast, setVerdict, unchecked }

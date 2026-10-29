// Chats kept on this computer, so "Write it for me" answers at once: every conversation read in the
// Outreach panel (proposing a reply, reading new messages, reply relaunch checks, chats read ahead in
// quiet moments) is saved here, with what we send from the list added on. A reply is drafted ahead for
// each conversation waiting on us, from the saved chat plus their latest message (from the inbox
// list), and drafted again whenever they write something new or the full chat comes in.
// data/dm-chats.json: { chats: { name: { username, messages, readAt } }, drafts: { name: { preview, reply, at, from } } }
const fs = require('fs')
const path = require('path')

const STORE_PATH = path.join(__dirname, '..', 'data', 'dm-chats.json')
const KEEP = 30
const HIDDEN_PREVIEW = /^\d+ new messages?$|^new message$|voice message/i
// An inbox preview for a message without words ("D-Wayne sent 2 photos.", "sent an attachment").
const ATTACHMENT_PREVIEW = /\bsent (an? |\d+ )?(photos?|videos?|attachments?|gifs?|stickers?|reels?|posts?)\b|\bshared a (reel|post|story)\b|\bsent a (reel|post)\b/i
// Instagram's own notes in a chat (read as their messages before 27 Oct): never a message.
const INSTAGRAM_NOTE = /^(auto-detected outcome\b|this account can.t receive your message|you can now (message|call)\b|messages and calls are (now )?(secured|end-to-end))/i
const isNote = (message) => !message.voice && INSTAGRAM_NOTE.test(String(message.text || '').trim())

let cache = null

function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
  } catch {
    cache = {}
  }
  cache.chats = cache.chats || {}
  cache.drafts = cache.drafts || {}
  // Saved before the notes were left out: taken out now (their draft written again without them).
  let cleaned = false
  for (const [key, chat] of Object.entries(cache.chats)) {
    if (!(chat.messages || []).some(isNote)) continue
    chat.messages = chat.messages.filter((message) => !isNote(message))
    delete cache.drafts[key]
    cleaned = true
  }
  if (cleaned) save()
  return cache
}

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const tmp = `${STORE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 1))
  fs.renameSync(tmp, STORE_PATH)
}

const clean = (text) => String(text || '').replace(/\d+:\d{2}/, '').replace(/(view|hide) transcription/gi, '').trim()

// A chat just read in the panel. name: the inbox name when known (else found by username).
function remember({ name, username, messages, threadId = '' }) {
  const store = load()
  const key = name || Object.keys(store.chats).find((entry) => username && store.chats[entry].username === username) || (username ? `@${username}` : '')
  if (!key || !Array.isArray(messages) || !messages.length) return
  const previousMessages = store.chats[key]?.messages
  store.chats[key] = {
    username: username || store.chats[key]?.username || '',
    // The conversation's own inbox address: opens even when the profile link does not.
    threadId: threadId || store.chats[key]?.threadId || '',
    readAt: Date.now(),
    messages: messages.filter((message) => !isNote(message)).slice(-KEEP).map((message) => ({ ours: Boolean(message.ours), voice: Boolean(message.voice), text: message.voice ? clean(message.text) : String(message.text || ''), at: message.at || 0, ...(message.images?.length ? { images: message.images } : {}) })),
  }
  // A draft written without the full chat, or before the chat changed (a new message, a voicenote now
  // transcribed), is written again from it.
  const before = JSON.stringify(previousMessages || [])
  if (store.drafts[key]?.from === 'list' || before !== JSON.stringify(store.chats[key].messages)) delete store.drafts[key]
  save()
}

// What we just sent from the list (so the saved chat stays whole until it is read again).
function addOurs(name, message) {
  const store = load()
  const chat = store.chats[name]
  if (!chat) return
  chat.messages = [...chat.messages, { ours: true, voice: Boolean(message.voice), text: message.text || '', at: Date.now() }].slice(-KEEP)
  delete store.drafts[name]
  save()
}

function chatOf(name, username) {
  const chats = load().chats
  return chats[name] || (username && (chats[`@${username}`] || Object.values(chats).find((chat) => chat.username === username))) || null
}

// The chat to draft from: the saved chat, with their latest message from the inbox list added when the
// saved one does not have it yet. Nothing saved: our first voicenote and their answer (from the list).
function history(item) {
  const chat = chatOf(item.name, item.username)
  const latest = HIDDEN_PREVIEW.test(item.preview || '') ? '' : String(item.preview || '').trim()
  if (chat) {
    const messages = [...chat.messages]
    const theirs = messages.filter((message) => !message.ours).map((message) => message.text.trim())
    if (latest && !theirs.some((text) => text && (text === latest || text.startsWith(latest.replace(/…$/, '')))) ) messages.push({ ours: false, text: latest, at: 0 })
    return { messages, complete: true }
  }
  if (!latest) return null
  const who = item.voice || 'one of the founders'
  return {
    complete: false,
    messages: [
      { ours: true, voice: true, at: 0, text: `(${who}'s first voicenote: introduces himself as a co-founder of Nutricode, says he loves their content, asks if they'd be keen to collab, and explains Nutricode: connect your wearable, we analyse the last 30 days of sleep, recovery and training data, build a personalised supplement stack, re-analyse every 30 days) (any messages in between are not saved on this computer)` },
      { ours: false, at: 0, text: latest },
    ],
  }
}

// model: the drafts' current model; one written by another model is written again.
function draftFor(item, model) {
  const draft = load().drafts[item.name]
  return draft && draft.preview === item.preview && (!model || draft.model === model) ? draft : null
}

function rememberDraft(item, reply, from, model) {
  const store = load()
  store.drafts[item.name] = { preview: item.preview, reply, from, model, at: Date.now() }
  save()
}

module.exports = { ATTACHMENT_PREVIEW, INSTAGRAM_NOTE, isNote, remember, addOurs, chatOf, history, draftFor, rememberDraft, HIDDEN_PREVIEW }

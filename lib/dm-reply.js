// Replies from the "DMs to reply" list: a proposed text (drafted from the whole chat by Gemini, following
// prompts/dm-reply.md, where the instructions of the person's own ChatGPT GPT can be pasted), and a
// queue of replies to send (a text DM, or the "Message 2" voicenote of whoever sent the first one). The
// queue waits while Instagram is busy with Launch and sends one at a time, through the app's safety gate.
const fs = require('fs')
const path = require('path')
const drafts = require('./comment-draft')

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'dm-reply.md')
const QUEUE_PATH = path.join(__dirname, '..', 'data', 'dm-reply-queue.json')

const SCHEMA = { type: 'OBJECT', properties: { reply: { type: 'STRING' } }, required: ['reply'] }

function transcript(messages) {
  return messages.map((message) => {
    const when = message.at ? new Date(message.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''
    const body = message.voice
      ? `[voicenote${String(message.text || '').replace(/\d+:\d{2}/, '').replace(/(view|hide) transcription/gi, '').trim() ? `: ${String(message.text).replace(/\d+:\d{2}/, '').replace(/(view|hide) transcription/gi, '').trim()}` : ''}]`
      : message.text || '[GIF, sticker, photo or attachment]'
    return `${message.ours ? 'US' : 'THEM'}${when ? ` (${when})` : ''}: ${body}`
  }).join('\n')
}

async function draft({ name, messages }) {
  const instructions = fs.readFileSync(PROMPT_PATH, 'utf8')
  const answer = await drafts.ask(
    [{ text: instructions }, { text: `The chat with ${name}, oldest first ("US" is nutricode.io):\n${transcript(messages)}\n\nreply: the next message from us.` }],
    SCHEMA, 0.7, 30000, (parsed) => {
      if (!String(parsed.reply || '').trim()) throw new Error('Gemini wrote no reply.')
      return parsed
    }, { purpose: 'dm reply draft' })
  return String(answer.reply).trim()
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'))
  } catch {
    return { items: [] }
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true })
  const tmp = `${QUEUE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
  fs.renameSync(tmp, QUEUE_PATH)
}

function add(item) {
  const state = load()
  const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), status: 'queued', ...item }
  state.items.push(entry)
  state.items = state.items.slice(-200)
  save(state)
  return entry
}

function update(id, change) {
  const state = load()
  const item = state.items.find((entry) => entry.id === id)
  if (item) Object.assign(item, change)
  save(state)
  return item
}

function next() {
  return load().items.find((entry) => entry.status === 'queued') || null
}

// The latest reply per conversation name, for the list (queued, sending, sent, failed).
function byName() {
  const out = {}
  for (const item of load().items) out[item.name] = { status: item.status, kind: item.kind, error: item.error || '', at: item.at }
  return out
}

module.exports = { draft, add, update, next, byName, transcript }

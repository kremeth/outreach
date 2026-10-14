// Replies from the "DMs to reply" list: a proposed text (drafted from the whole chat by OpenAI's GPT-6.1
// Sol with high reasoning, following prompts/dm-reply.md, built from Mathieu's own ChatGPT history;
// Gemini only if OpenAI fails), and a
// queue of replies to send (a text DM, or the "Message 2" voicenote of whoever sent the first one). The
// queue waits while Instagram is busy with Launch and sends one at a time, through the app's safety gate.
const fs = require('fs')
const path = require('path')
const drafts = require('./comment-draft')
const openai = require('./openai')

// The model that writes the replies (a draft written by another model is written again).
const MODEL = 'gpt-6.1-sol'

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
  const input = `The chat with ${name}, oldest first ("US" is nutricode.io):\n${transcript(messages)}\n\nreply: the next message from us.`
  try {
    const answer = await openai.ask({
      model: MODEL, effort: 'high', instructions, input, name: 'dm_reply', purpose: 'dm reply draft',
      schema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false },
    })
    if (String(answer.reply || '').trim()) return String(answer.reply).trim()
    throw new Error('GPT wrote no reply.')
  } catch (error) {
    console.error('dm reply draft (OpenAI)', error.message)
  }
  // OpenAI down or out of credit: Gemini, so the button still works.
  const answer = await drafts.ask(
    [{ text: instructions }, { text: input }],
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
  const state = load()
  // A send that never finished (the app restarted in the middle): it may have gone out, so it is never
  // retried on its own; the person checks the chat.
  let changed = false
  for (const entry of state.items) {
    if (entry.status === 'sending' && Date.now() - (entry.startedAt || entry.at) > 15 * 60 * 1000) {
      entry.status = 'failed'
      entry.error = `Interrupted${entry.sentParts ? ` after part ${entry.sentParts}` : ''}: check the chat before sending again.`
      changed = true
    }
  }
  if (changed) save(state)
  // A reply waiting on a safety limit (voicenotes used up for today...) steps aside for the others.
  return state.items.find((entry) => entry.status === 'queued' && !(entry.waitUntil > Date.now())) || null
}

// Replies not sent yet, oldest first, with why they wait.
function outgoing() {
  return load().items.filter((entry) => ['queued', 'sending'].includes(entry.status)).map((entry) => ({
    name: entry.name, kind: entry.kind, status: entry.status,
    waitUntil: entry.waitUntil > Date.now() ? entry.waitUntil : 0, waitReason: entry.waitUntil > Date.now() ? entry.waitReason || '' : '',
  }))
}

// The latest reply per conversation name, for the list (queued, sending, sent, failed).
function byName() {
  const out = {}
  for (const item of load().items) out[item.name] = { status: item.status, kind: item.kind, error: item.error || '', at: item.at, sentAt: item.sentAt || 0, sentParts: item.sentParts || 0 }
  return out
}

module.exports = { MODEL, draft, add, update, next, byName, transcript, outgoing }

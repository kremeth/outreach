// Reads a chat where a creator wrote back and decides whether it is a no. Only a clear no counts:
// anything still open (questions, interest, "maybe later", unclear, an auto-reply) is "ongoing".
const drafts = require('./comment-draft')

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdict: { type: 'STRING', enum: ['no', 'ongoing'] },
    reason: { type: 'STRING' },
  },
  required: ['verdict', 'reason'],
}

const INSTRUCTIONS = `nutricode.io reached out to an Instagram creator about a collaboration (a voicenote, then short reminder messages). Below is their chat, oldest message first. "US" is nutricode.io, "THEM" is the creator.

Decide if the creator has said no.
- "no": they declined, or the chat very clearly means no. For example: "not interested", "no thanks", "we're all good", "not for me", "please stop messaging", "we don't do collabs", "we only work with paid partnerships and aren't taking new ones", a polite but final decline.
- "ongoing": anything else. Questions, interest, asking for details or rates, "maybe later", "not right now but keep in touch", a thumbs up, an emoji, an auto-reply, small talk, anything unclear. When in doubt, it is "ongoing".

reason: one short sentence quoting or paraphrasing what they said.`

function transcript(thread) {
  return thread
    .map((message) => `${message.ours ? 'US' : 'THEM'}: ${message.voice ? '[voicenote]' : ''}${message.voice && message.text ? ' ' : ''}${message.voice ? '' : message.text || '[attachment]'}`)
    .join('\n')
}

async function classify(thread) {
  if (!Array.isArray(thread) || !thread.some((message) => !message.ours)) throw new Error('There is no reply from them to read.')
  return drafts.ask([{ text: INSTRUCTIONS }, { text: transcript(thread) }], SCHEMA, 0, 30000, (parsed) => {
    if (!['no', 'ongoing'].includes(parsed.verdict)) throw new Error('Gemini gave no verdict.')
    return { verdict: parsed.verdict, reason: String(parsed.reason || '').trim().slice(0, 200) }
  }, { purpose: 'reply check' })
}

// Before a reply relaunch (or closing a quiet conversation out): is the next move really theirs, in
// this chat? Only "waiting" allows a nudge. A conversation that moved elsewhere (email, management, a
// call), ended with thanks, where they reacted to our last message, or where the next step is ours,
// is "closed"; anything unclear is "unsure". Never a nudge on doubt.
const OPEN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    state: { type: 'STRING', enum: ['waiting', 'closed', 'unsure'] },
    reason: { type: 'STRING' },
  },
  required: ['state', 'reason'],
}

const OPEN_INSTRUCTIONS = `nutricode.io (a nutrition app) is talking to an Instagram creator about a collaboration. Below is the end of their chat, oldest first. "US" is nutricode.io, "THEM" is the creator; dates are when each message was sent; [reacted X] means the other side reacted to that message with X.

Our last message has not been answered with a message. nutricode.io wants to send a light nudge (a funny GIF, then "giving this one last try"). That is only fine when the conversation is genuinely waiting on THEM, in this chat. A nudge in the wrong place looks careless and damages the relationship.

state:
- "waiting": our last message asked them something, proposed something, or sent something they were expected to respond to (details, a voicenote, an offer, a question), and they have not responded at all since. The next move is clearly theirs, in this chat.
- "closed": the loop is closed or moved on, so no nudge: they handed off to someone or somewhere else (management, an agent, an email, a phone number, a website, a form) and we acknowledged it; they reacted to our last message (an acknowledgement); our last message was a thank-you, a sign-off, an "I'll email them", "speak soon", or anything where the next step is OURS; the collaboration is already agreed or under way; they declined; we already sent a final nudge ourselves ("giving this one last try", "last nudge from me", "last little follow up from me", "one last check in from me", "final nudge from my side", "last one from me", "one last time", "last follow-up" or any other wording of a last message), so nothing more should follow.
- "unsure": anything else, or not enough to tell. When in doubt, "unsure".
reason: one short sentence on what decided it.`

function openTranscript(thread) {
  return thread.slice(-12).map((message) => {
    const when = message.at ? new Date(message.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'time unknown'
    const body = message.voice ? '[voicenote]' : message.text || '[GIF, sticker, photo or attachment]'
    return `${message.ours ? 'US' : 'THEM'} (${when}): ${body}${message.reaction ? ` [reacted ${message.reaction}]` : ''}`
  }).join('\n')
}

async function conversationOpen(thread) {
  const last = thread[thread.length - 1]
  // A reaction from them on our last message is their answer to it: no nudge, no question asked.
  if (last?.ours && last.reaction) return { state: 'closed', reason: `They reacted ${last.reaction} to our last message.` }
  return drafts.ask([{ text: OPEN_INSTRUCTIONS }, { text: openTranscript(thread) }], OPEN_SCHEMA, 0, 30000, (parsed) => {
    if (!['waiting', 'closed', 'unsure'].includes(parsed.state)) throw new Error('Gemini gave no answer.')
    return { state: parsed.state, reason: String(parsed.reason || '').trim().slice(0, 200) }
  }, { purpose: 'reply relaunch check' })
}

module.exports = { classify, transcript, conversationOpen }

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

module.exports = { classify, transcript }

const fs = require('fs')
const path = require('path')

const KEY_PATH = path.join(__dirname, '..', 'data', 'gemini-key.txt')
const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest']

const DRAFT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    description: { type: 'STRING' },
    comments: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['description', 'comments'],
}

const REWRITE_SCHEMA = {
  type: 'OBJECT',
  properties: { comments: { type: 'ARRAY', items: { type: 'STRING' } } },
  required: ['comments'],
}

// The voice of every comment, first drafts and rewrites alike.
const STYLE = `Write exactly 5 comment options, as a real person scrolling Instagram would.

Tone: witty and clever by default. Dry, observational, a smart one-liner about something specific in the post. Instagram-native: casual, lowercase is fine, reads like a friend in the comments.

Never:
- ask a question, and never use a question mark
- cheesy or cheap lines: "love this", "goals", "obsessed", "slay", "queen", "living for this", "this is everything", "yasss", "so inspiring", motivational-poster phrasing
- generic praise that could sit under any post
- hashtags, links, @mentions, a pitch, or anything about a brand or product
- more than one exclamation mark, or more than one emoji unless asked for emojis
- details that are not in the photo, the caption or the bio
- anything mean, dark, morbid, suggestive, or about their body or looks; funny should feel warm, never at their expense

Each comment: one short sentence, under 120 characters. Make the five clearly different from each other.`

const DRAFT_INSTRUCTIONS = `You help nutricode.io leave one Instagram comment on a creator's latest post.
First describe the cover photo in one or two plain sentences.
Then: ${STYLE}`

const REWRITE_INSTRUCTIONS = `You help nutricode.io leave one Instagram comment on a creator's latest post. The post is described below.
${STYLE}`

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function context({ name, username, bio, caption, description, avoid = [], guidance = '' }) {
  return [
    `Name: ${name || ''}`,
    `Username: @${username || ''}`,
    `Bio: ${bio || '(empty)'}`,
    `Latest post caption: ${caption || '(no caption)'}`,
    ...(description ? [`What the photo shows: ${description}`] : []),
    ...(avoid.length ? [`These were rejected, write 5 clearly different ones:\n${avoid.map((text) => `- ${text}`).join('\n')}`] : []),
    ...(guidance ? [`Direction from the person picking the comment, follow it closely: ${guidance}`] : []),
  ].join('\n')
}

// Questions are filtered out even if the model slips one in; too few left means try again.
function cleanComments(list) {
  return (list || [])
    .map((line) => String(line || '').trim().replace(/^["“]|["”]$/g, ''))
    .filter((line) => line && !line.includes('?'))
    .slice(0, 5)
}

async function ask(parts, schema, temperature) {
  const key = fs.readFileSync(KEY_PATH, 'utf8').trim()
  if (!key) throw new Error('The Gemini key is missing.')
  let lastError
  for (let attempt = 0; attempt < 6; attempt++) {
    const model = MODELS[attempt % MODELS.length]
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature,
            responseMimeType: 'application/json',
            responseSchema: schema,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: AbortSignal.timeout(60000),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        lastError = new Error(payload.error?.message || `Gemini ${response.status}`)
        if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError
      } else {
        const text = (payload.candidates?.[0]?.content?.parts || []).filter((part) => part.text && !part.thought).map((part) => part.text).join('')
        const parsed = JSON.parse(text)
        const comments = cleanComments(parsed.comments)
        if (comments.length < 5) throw new Error('Gemini did not return 5 usable comments.')
        return { ...parsed, comments }
      }
    } catch (error) {
      lastError = error
      if (/Gemini (400|401|403|404)/.test(error.message || '')) throw error
    }
    await sleep(attempt ? 1200 * attempt : 0)
  }
  throw lastError || new Error('Could not write the comments.')
}

// First draft for a post: looks at the photo, describes it, writes 5 comments.
async function generate({ name, username, bio, caption, image, avoid = [], guidance = '' }) {
  const parsed = await ask([
    { text: DRAFT_INSTRUCTIONS },
    { inline_data: { mime_type: image.mime || 'image/jpeg', data: image.data } },
    { text: context({ name, username, bio, caption, avoid, guidance }) },
  ], DRAFT_SCHEMA, 0.9)
  if (!parsed.description) throw new Error('Gemini did not describe the photo.')
  return { description: String(parsed.description).trim(), comments: parsed.comments }
}

// New options for the same post: text only, reusing the description, so it comes back fast.
async function rewrite({ name, username, bio, caption, description, avoid = [], guidance = '' }) {
  const parsed = await ask([
    { text: REWRITE_INSTRUCTIONS },
    { text: context({ name, username, bio, caption, description, avoid, guidance }) },
  ], REWRITE_SCHEMA, 1)
  return { comments: parsed.comments }
}

module.exports = { generate, rewrite }

const fs = require('fs')
const path = require('path')

const KEY_PATH = path.join(__dirname, '..', 'data', 'gemini-key.txt')
const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest']

const DRAFT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    description: { type: 'STRING' },
    comments: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['transcript', 'description', 'comments'],
}

const REWRITE_SCHEMA = {
  type: 'OBJECT',
  properties: { comments: { type: 'ARRAY', items: { type: 'STRING' } } },
  required: ['comments'],
}

// The voice of every comment, first drafts and rewrites alike. Modelled on what gets picked and
// typed in Hustling: short, plain, the way people actually comment, not clever-sounding AI lines.
const STYLE = `Write exactly 7 comment options that look like real Instagram comments from a follower: the kind you'd see under any fitness or lifestyle post.

How real comments sound:
- Short: usually 2 to 8 words, never more than one short sentence.
- Everyday words, how people actually text. Not clever, not writerly, not a punchline. A friend reacting, not a copywriter.
- Natural capitalisation and punctuation: "What a team", "the fit 🔥🔥🔥", "ohhh that top!!", "Massive effort mate". Exclamation marks are fine.
- Most of them mention one concrete thing from the post (the dog, the view, the run, the outfit, what they said), in plain words.
- Emojis: about half of them have emojis, usually at the end, sometimes repeated (🔥🔥, 😂😂). Use common ones: 🔥 😂 🙌 👏 💪 😍 👀 🤣 ❤️ 🫡 🥹 ⚡️. The others have none.
- Mix it up: a hype one, a warm one, one that reacts to a specific detail, one light and funny at most.

Good (this is the register):
- What a team 👏
- The fit 🔥🔥🔥
- ohhh the dog in the back seat 😂
- That view though
- Massive effort, well deserved!!
- need that sauna after today 🥵
- haha the coffee at the end is the real reason
- Looking strong 💪

Bad (sounds like AI, never write like this):
- "thrusters into kettlebell swings is pure villain behavior"
- "the pink shoes are doing all the diplomatic heavy lifting here"
- "giving high school portrait day with significantly cooler shoes"
- "the closet organization in the background deserves its own segment"
So never use: "giving", "hit(s) different", "peak", "top tier", "elite", "legendary", "energy", "vibes", "villain", "unhinged", "the real MVP", "deserves its own", "doing the heavy lifting", "is valid", "main character", "understood the assignment", "core memory", "chef's kiss", "no notes", "lowkey", "we love to see it".

Never:
- ask a question, and never use a question mark
- cheesy lines: "slay", "queen", "obsessed", "yasss", "living for this", "so inspiring", motivational-poster phrasing
- hashtags, links, @mentions, a pitch, or anything about a brand or product
- details that are not in the post (photo, video, slides, transcript), the caption or the bio
- anything mean, dark, morbid, suggestive, or about their body, weight or attractiveness (outfits and gear are fine)
- slide or timestamp references ("slide 3", "at 0:12"), or picking out an embarrassing moment someone in the post would not want highlighted

Make the seven clearly different from each other.`

// What to read from the post before writing, per format. The comments are about the whole post,
// never just its cover.
const READ = {
  photo: `The post is the photo below.
transcript: leave empty.
description: describe the photo in one or two plain sentences.`,
  video: `The post is the video below (a reel). Watch and listen to all of it, not just the first frame.
transcript: write down what is said in it, word for word, in its original language. Leave it empty if nobody speaks (music only).
description: describe the whole video in two to four plain sentences: what happens from start to end, and any text shown on screen.`,
  carousel: `The post is a carousel: the images and videos below are its slides, in order. Look at every slide, not just the first.
transcript: write down anything said in the video slides, word for word. Leave it empty if nobody speaks.
description: describe the whole carousel in two to four plain sentences: what the slides show together, and any text on them.`,
}

function draftInstructions(format) {
  return `You help nutricode.io leave one Instagram comment on a creator's latest post.
${READ[format] || READ.photo}
comments: react to the post as a whole (what is said and shown across all of it), not only the cover.
${STYLE}`
}

const REWRITE_INSTRUCTIONS = `You help nutricode.io leave one Instagram comment on a creator's latest post. The post is described below.
${STYLE}`

function apiKey() {
  const key = fs.readFileSync(KEY_PATH, 'utf8').trim()
  if (!key) throw new Error('The Gemini key is missing.')
  return key
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function context({ name, username, bio, caption, description, transcript, avoid = [], guidance = '' }) {
  return [
    `Name: ${name || ''}`,
    `Username: @${username || ''}`,
    `Bio: ${bio || '(empty)'}`,
    `Latest post caption: ${caption || '(no caption)'}`,
    ...(description ? [`What the post shows: ${description}`] : []),
    ...(transcript ? [`What is said in it: ${transcript}`] : []),
    ...(avoid.length ? [`These were rejected, write clearly different ones:\n${avoid.map((text) => `- ${text}`).join('\n')}`] : []),
    ...(guidance ? [`Direction from the person picking the comment, follow it closely: ${guidance}`] : []),
  ].join('\n')
}

// AI-sounding phrases the prompt bans; anything that still uses one is dropped.
const BANNED = /\b(giving|hits? different|peak|top tier|elite|legendary|energy|vibes?|villain|unhinged|mvp|deserves its own|heavy lifting|is valid|main character|understood the assignment|core memory|chef'?s kiss|no notes|lowkey|we love to see it|slay|queen|obsessed|yass+|living for this|so inspiring)\b/i

// 7 are asked for; questions and banned phrases are filtered out and the first 5 kept. Too few left
// means try again.
function cleanComments(list) {
  return (list || [])
    .map((line) => String(line || '').trim().replace(/^["“]|["”]$/g, ''))
    .filter((line) => line && !line.includes('?') && !BANNED.test(line))
    .slice(0, 5)
}

function acceptComments(parsed) {
  const comments = cleanComments(parsed.comments)
  if (comments.length < 5) throw new Error('Gemini did not return 5 usable comments.')
  return { ...parsed, comments }
}

// One Gemini call with a JSON answer, retried on busy or failed answers. accept() checks the answer
// (throwing makes it try again) and returns what the caller gets.
async function ask(parts, schema, temperature, timeoutMs = 60000, accept = acceptComments) {
  let lastError
  for (let attempt = 0; attempt < 6; attempt++) {
    const model = MODELS[attempt % MODELS.length]
    const key = apiKey()
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
        signal: AbortSignal.timeout(timeoutMs),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        lastError = new Error(payload.error?.message || `Gemini ${response.status}`)
        if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError
      } else {
        const text = (payload.candidates?.[0]?.content?.parts || []).filter((part) => part.text && !part.thought).map((part) => part.text).join('')
        return accept(JSON.parse(text))
      }
    } catch (error) {
      lastError = error
      if (/Gemini (400|401|403|404)/.test(error.message || '')) throw error
    }
    await sleep(attempt ? 1200 * attempt : 0)
  }
  throw lastError || new Error('Gemini did not answer.')
}

// Videos too big to send inline (over ~12 MB) go through Gemini's file upload instead.
async function upload({ mime, buffer }) {
  const key = apiKey()
  const base = 'https://generativelanguage.googleapis.com'
  const start = await fetch(`${base}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'instagram-post' } }),
    signal: AbortSignal.timeout(30000),
  })
  const target = start.headers.get('x-goog-upload-url')
  if (!start.ok || !target) throw new Error(`Gemini upload ${start.status}`)
  const sent = await fetch(target, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: buffer,
    signal: AbortSignal.timeout(300000),
  })
  let file = (await sent.json().catch(() => ({}))).file
  if (!sent.ok || !file?.name) throw new Error(`Gemini upload ${sent.status}`)
  // Videos are processed before they can be used.
  for (let waited = 0; file.state === 'PROCESSING' && waited < 90000; waited += 2000) {
    await sleep(2000)
    file = await (await fetch(`${base}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15000) })).json()
  }
  if (file.state !== 'ACTIVE') throw new Error('Gemini could not process the video.')
  return { mime, uri: file.uri }
}

function mediaPart(item) {
  if (item.uri) return { file_data: { mime_type: item.mime, file_uri: item.uri } }
  return { inline_data: { mime_type: item.mime || 'image/jpeg', data: item.data } }
}

// First draft for a post: reads the whole post (photo, every carousel slide, or the full video with
// its sound), describes it, transcribes what is said, writes 5 comments.
async function generate({ name, username, bio, caption, format = 'photo', media, avoid = [], guidance = '' }) {
  const parsed = await ask([
    { text: draftInstructions(format) },
    ...media.map(mediaPart),
    { text: context({ name, username, bio, caption, avoid, guidance }) },
  ], DRAFT_SCHEMA, 0.9, format === 'photo' ? 60000 : 150000)
  if (!parsed.description) throw new Error('Gemini did not describe the post.')
  return { description: String(parsed.description).trim(), transcript: String(parsed.transcript || '').trim(), comments: parsed.comments }
}

// New options for the same post: text only, reusing the description and transcript, so it comes back fast.
async function rewrite({ name, username, bio, caption, description, transcript, avoid = [], guidance = '' }) {
  const parsed = await ask([
    { text: REWRITE_INSTRUCTIONS },
    { text: context({ name, username, bio, caption, description, transcript, avoid, guidance }) },
  ], REWRITE_SCHEMA, 1)
  return { comments: parsed.comments }
}

module.exports = { generate, rewrite, upload, ask }

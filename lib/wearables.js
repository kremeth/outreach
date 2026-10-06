const fs = require('fs')
const path = require('path')

const KEY_PATH = path.join(__dirname, '..', 'data', 'gemini-key.txt')
const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest']
const MAX_PHOTOS = 24
const DEVICES = ['WHOOP', 'Garmin', 'Apple Watch', 'Oura', 'Polar', 'Other smartwatch', 'Other fitness band', 'Other smart ring', 'Unknown', 'None']
const BRAND_WORDS = /\b(whoop|garmin|oura(ring)?|apple ?watch|polar ?(watch|vantage|pacer|grit|ignite)|fitbit|coros|suunto|amazfit|ultrahuman|ringconn|galaxy ?watch|galaxy ?ring|pixel ?watch)\b/i

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdict: { type: 'STRING', enum: ['wearable', 'possible', 'none'] },
    device: { type: 'STRING', enum: DEVICES },
    confidence: { type: 'NUMBER' },
    photos: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          photo: { type: 'INTEGER' },
          device: { type: 'STRING', enum: DEVICES },
          where: { type: 'STRING' },
        },
        required: ['photo', 'device', 'where'],
      },
    },
    reason: { type: 'STRING' },
  },
  required: ['verdict', 'device', 'confidence', 'photos', 'reason'],
}

const INSTRUCTIONS = `You are screening an Instagram creator for a fitness-wearable outreach campaign.
The photos from their profile are numbered in order, followed by their bio and captions.

Look carefully at every wrist, forearm, upper arm and finger in every photo, including small, blurry, background or partly hidden ones.

Counts as a fitness wearable: any smartwatch or sports watch (Apple Watch, Garmin, Polar, Coros, Suunto, Fitbit, Samsung, Pixel, Amazfit and similar), any fitness band or screenless strap (WHOOP on the wrist or bicep, Fitbit bands and similar), and any smart ring (Oura, Ultrahuman, RingConn, Samsung Galaxy Ring and similar).
Does not count: bracelets, bangles, jewellery rings, hair ties, sweatbands, and analogue dress watches that clearly have no screen.

If you see a watch or band but cannot tell whether it is smart, treat it as possible.
Answer "wearable" if at least one photo clearly shows one, "possible" if something might be one, and "none" only after checking every photo and finding nothing that could be one.
List every photo number where you saw a wearable or possible wearable, with the device and where in the photo it is.`

function apiKey() {
  const key = fs.readFileSync(KEY_PATH, 'utf8').trim()
  if (!key) throw new Error(`No Gemini key in ${KEY_PATH}`)
  return key
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function brandMention(profile) {
  const texts = [profile.bio, profile.name, ...(profile.images || []).map((image) => image.alt)]
  for (const text of texts) {
    const match = String(text || '').match(BRAND_WORDS)
    if (match) return { word: match[0], text: String(text).slice(0, 160) }
  }
  return null
}

async function fetchPhoto(mediaBase, src) {
  const response = await fetch(`${mediaBase}/media?src=${encodeURIComponent(src)}`, { signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`photo ${response.status}`)
  const type = response.headers.get('content-type') || 'image/jpeg'
  return { mime: type.split(';')[0], data: Buffer.from(await response.arrayBuffer()).toString('base64') }
}

async function fetchPhotos(mediaBase, images) {
  const results = await Promise.all(images.map((image) => fetchPhoto(mediaBase, image.src).catch(() => null)))
  return results
}

async function callGemini(parts) {
  const key = apiKey()
  let lastError
  for (let attempt = 0; attempt < 8; attempt++) {
    const model = MODELS[attempt % MODELS.length]
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0 },
        }),
        signal: AbortSignal.timeout(120000),
      })
      const payload = await response.json().catch(() => ({}))
      if (response.ok) {
        const text = (payload.candidates?.[0]?.content?.parts || []).filter((part) => part.text && !part.thought).map((part) => part.text).join('')
        return { answer: JSON.parse(text), model, usage: payload.usageMetadata || {} }
      }
      lastError = new Error(`Gemini ${response.status}: ${payload.error?.message || 'error'}`)
      if (response.status === 429 && /free_tier|per ?day|check your plan/i.test(payload.error?.message || '')) {
        const quota = new Error('Gemini quota used up (the key is on the free tier: 20 requests per day). Enable billing on the Google AI Studio project, then rerun.')
        quota.fatal = true
        throw quota
      }
      if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError
    } catch (error) {
      lastError = error
      if (error.fatal || /Gemini (400|401|403|404)/.test(error.message)) throw error
    }
    await sleep(Math.min(30000, 1500 * 2 ** Math.floor(attempt / MODELS.length)))
  }
  throw lastError
}

async function screen(profile, mediaBase) {
  const images = (profile.images || []).slice(0, MAX_PHOTOS)
  const photos = await fetchPhotos(mediaBase, images)
  const parts = [{ text: INSTRUCTIONS }]
  let sent = 0
  photos.forEach((photo, index) => {
    if (!photo) return
    parts.push({ text: `Photo ${index + 1}:` })
    parts.push({ inline_data: { mime_type: photo.mime, data: photo.data } })
    sent++
  })
  const captions = images
    .map((image, index) => (image.alt ? `Photo ${index + 1} caption: ${String(image.alt).slice(0, 300)}` : ''))
    .filter(Boolean)
  parts.push({ text: [`Name: ${profile.name || ''}`, `Bio: ${profile.bio || ''}`, ...captions].join('\n') })
  if (!sent) throw new Error('No photos could be downloaded')
  const { answer, model, usage } = await callGemini(parts)
  return { ...answer, model, sent, tokens: usage.totalTokenCount || 0, promptTokens: usage.promptTokenCount || 0 }
}

function decide(profile, verdict, mention) {
  if (!profile) return { action: 'keep', why: 'profile did not load' }
  if (profile.private) return { action: 'keep', why: 'private account' }
  if (!(profile.images || []).length) return { action: 'keep', why: 'no photos' }
  if (mention) return { action: 'keep', why: `mentions "${mention.word}"` }
  if (!verdict) return { action: 'keep', why: 'not screened' }
  if (verdict.verdict !== 'none' || (verdict.photos || []).length) return { action: 'keep', why: `${verdict.verdict}: ${verdict.device}` }
  return { action: 'auto-no', why: 'no wearable in any photo' }
}

module.exports = { screen, decide, brandMention, MODELS }

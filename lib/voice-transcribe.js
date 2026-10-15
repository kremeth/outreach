// Their voicenotes, transcribed by Gemini (Instagram's own transcription often fails): the panel hands
// over the voicenote files of a chat (app/instagram.js voiceAudio: nothing is played), each one is
// transcribed once and kept in data/voice-transcripts.json by its file name.
const fs = require('fs')
const path = require('path')
const drafts = require('./comment-draft')

const STORE_PATH = path.join(__dirname, '..', 'data', 'voice-transcripts.json')
const SCHEMA = { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] }

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function save(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 1))
}

const keyOf = (url) => (String(url || '').match(/audioclip-[\d-]+\.\w+/) || [String(url || '').split('?')[0]])[0]

async function transcribe({ url, audio, mime }) {
  const store = load()
  const key = keyOf(url)
  if (store[key]) return store[key].text
  const answer = await drafts.ask([
    { inlineData: { mimeType: mime || 'audio/mp4', data: audio } },
    { text: 'Transcribe this Instagram voice message exactly as spoken (any language, keep it in that language). Only the words, no notes. If nothing is said, answer "(no words)".' },
  ], SCHEMA, 0, 60000, (parsed) => {
    if (!String(parsed.text || '').trim()) throw new Error('Gemini wrote no transcript.')
    return parsed
  }, { purpose: 'voicenote transcript' })
  const text = String(answer.text).trim()
  store[key] = { text, at: Date.now() }
  save(store)
  return text
}

// A chat's messages with their voicenotes' words filled in (theirs, newest first, matched in order).
// ig: lib/ig-app. Only when one of theirs has no usable words yet.
async function fill(ig, username, messages) {
  const useless = (text) => !String(text || '').replace(/\d+:\d{2}/, '').replace(/(view|hide) transcription|unable to transcribe|try again|transcription (is )?(not |un)?available|[,.\s]+/gi, '').trim()
  const theirs = messages.filter((message) => !message.ours && message.voice)
  if (!theirs.some((message) => useless(message.text))) return messages
  const result = await ig.voiceAudio({ username, max: 4 })
  const voices = (result.voices || []).filter((voice) => voice.audio)
  const texts = []
  for (const voice of voices) {
    try {
      texts.push(await transcribe(voice))
    } catch (error) {
      console.error('voicenote transcript', username, error.message)
      texts.push('')
    }
  }
  // The last voicenotes of theirs in the chat line up with the files read (both oldest first).
  const targets = theirs.slice(-texts.length)
  return messages.map((message) => {
    const at = targets.indexOf(message)
    return at >= 0 && texts[at] ? { ...message, text: `${texts[at]}`, transcribed: true } : message
  })
}

module.exports = { transcribe, fill, keyOf }

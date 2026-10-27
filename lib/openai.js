// OpenAI (Responses API), for the DM reply drafts: GPT-6.1 Sol with high reasoning (chosen 15 Oct 2026).
// The key lives in data/openai-key.txt (never committed). Every call's tokens are logged to
// data/openai-usage.jsonl and priced in lib/api-usage.js next to Gemini.
const fs = require('fs')
const path = require('path')

const KEY_PATH = path.join(__dirname, '..', 'data', 'openai-key.txt')
const USAGE_PATH = path.join(__dirname, '..', 'data', 'openai-usage.jsonl')

function apiKey() {
  const key = fs.readFileSync(KEY_PATH, 'utf8').trim()
  if (!key) throw new Error('No OpenAI key in data/openai-key.txt.')
  return key
}

function logUsage(purpose, model, usage) {
  if (!usage) return
  const line = {
    at: new Date().toISOString(),
    purpose: purpose || 'other',
    model,
    input: usage.input_tokens || 0,
    cached: usage.input_tokens_details?.cached_tokens || 0,
    output: usage.output_tokens || 0, // includes the reasoning tokens
    reasoning: usage.output_tokens_details?.reasoning_tokens || 0,
  }
  fs.appendFile(USAGE_PATH, `${JSON.stringify(line)}\n`, () => {})
}

// instructions: the fixed part first (OpenAI caches a repeated prefix at a tenth of the price);
// input: this call's text. schema: a JSON schema the answer must follow (strict).
async function ask({ model, effort = 'high', instructions, input, schema, name = 'answer', purpose, timeoutMs = 120000 }) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          reasoning: { effort },
          instructions,
          input,
          text: { format: { type: 'json_schema', name, schema, strict: true } },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        lastError = new Error(payload.error?.message || `OpenAI ${response.status}`)
        if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError
        await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)))
        continue
      }
      logUsage(purpose, model, payload.usage)
      const text = (payload.output || []).filter((item) => item.type === 'message')
        .flatMap((item) => item.content || []).filter((part) => part.type === 'output_text').map((part) => part.text).join('')
      return JSON.parse(text)
    } catch (error) {
      lastError = error
      if (error.name !== 'TimeoutError' && !/fetch failed|network/i.test(error.message || '')) throw error
    }
  }
  throw lastError
}

// Your own voice note (the 🎙️ in DMs), in words: the recording as it came from the page (webm, mp4...).
async function transcribe({ audio, mime = 'audio/webm' }) {
  const extension = (mime.match(/audio\/(\w+)/) || [])[1] || 'webm'
  let lastError
  for (const model of ['gpt-4o-transcribe', 'whisper-1']) {
    try {
      const form = new FormData()
      form.append('model', model)
      form.append('file', new Blob([Buffer.from(audio, 'base64')], { type: mime }), `note.${extension === 'mpeg' ? 'mp3' : extension}`)
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey()}` }, body: form, signal: AbortSignal.timeout(60000),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error?.message || `OpenAI ${response.status}`)
      fs.appendFile(USAGE_PATH, `${JSON.stringify({ at: new Date().toISOString(), purpose: 'your voice note', model, input: payload.usage?.input_tokens || 0, output: payload.usage?.output_tokens || 0 })}\n`, () => {})
      return String(payload.text || '').trim()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

module.exports = { ask, transcribe, USAGE_PATH }

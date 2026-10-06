// Embeds each sheet row's name, handle and bio with Gemini so fit/train.py can learn Yes-type profiles.
// Resumable: rows already in data/fit/text.jsonl are skipped.
const fs = require('fs')
const path = require('path')
const sheet = require('../lib/sheet')
const data = require('../lib/data')

const MODEL = 'gemini-embedding-2'
const DIMENSIONS = 768
const BATCH = 100
const OUT_DIR = path.join(__dirname, '..', 'data', 'fit')
const OUT = path.join(OUT_DIR, 'text.jsonl')
const KEY = fs.readFileSync(path.join(__dirname, '..', 'data', 'gemini-key.txt'), 'utf8').trim()
const REVIEWER_NOTES_BEFORE_ROW = 250

function profileText(row) {
  const bio = row.sheetRow < REVIEWER_NOTES_BEFORE_ROW ? '' : row.notes
  return [`Name: ${row.name}`, `Handle: @${data.usernameFrom(row.link) || row.handle}`, `Bio: ${bio}`].join('\n').slice(0, 2000)
}

async function embed(texts) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`, {
      method: 'POST',
      headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${MODEL}`,
          content: { parts: [{ text }] },
          taskType: 'CLASSIFICATION',
          outputDimensionality: DIMENSIONS,
        })),
      }),
      signal: AbortSignal.timeout(60000),
    }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: { message: error.message } }) }))
    const payload = await response.json().catch(() => ({}))
    if (response.ok) return payload.embeddings.map((item) => item.values)
    if (attempt >= 5 || ![0, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`Embedding failed (${response.status}): ${payload.error?.message || ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt))
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const done = new Set()
  if (fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean)) done.add(JSON.parse(line).sheetRow)
  }
  const rows = (await sheet.loadAll()).filter((row) => !done.has(row.sheetRow))
  console.log(`${done.size} already embedded, ${rows.length} to go`)
  const out = fs.createWriteStream(OUT, { flags: 'a' })
  for (let start = 0; start < rows.length; start += BATCH) {
    const batch = rows.slice(start, start + BATCH)
    const texts = batch.map(profileText)
    const vectors = await embed(texts)
    batch.forEach((row, index) => {
      out.write(`${JSON.stringify({
        sheetRow: row.sheetRow,
        keep: row.keep,
        followers: row.followers,
        location: row.location,
        name: row.name,
        username: data.usernameFrom(row.link),
        text: texts[index],
        vector: vectors[index].map((value) => Math.round(value * 1e5) / 1e5),
      })}\n`)
    })
    if ((start / BATCH) % 10 === 0) console.log(`${Math.min(start + BATCH, rows.length)}/${rows.length}`)
  }
  await new Promise((resolve) => out.end(resolve))
  console.log('done')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})

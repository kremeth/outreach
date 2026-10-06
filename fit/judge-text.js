// Asks Gemini, from name + handle + bio only, whether each profile is a real person who could be a
// fitness / athlete / lifestyle creator, or a brand, business, organisation or page.
//   node fit/judge-text.js --from 5500 --decided     judge decided rows (to measure accuracy)
//   node fit/judge-text.js --pending                 judge all pending rows
// Resumable: results go to data/fit/judged.jsonl.
const fs = require('fs')
const path = require('path')

const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest']
const BATCH = 40
const WORKERS = 4
const DATA = path.join(__dirname, '..', 'data', 'fit')
const OUT = path.join(DATA, 'judged.jsonl')
const KEY = fs.readFileSync(path.join(__dirname, '..', 'data', 'gemini-key.txt'), 'utf8').trim()

const KINDS = ['real person creator', 'real person', 'business or brand', 'organisation, club, team or media', 'page or aggregator', 'unclear']

const INSTRUCTIONS = `We run influencer outreach for a fitness-wearable app. We want Instagram accounts of real individual people who are fitness, athlete, sport, health, outdoor or lifestyle content creators, or at least real people who might wear a smartwatch, fitness band or smart ring.
We do not want brands, shops, businesses, agencies, restaurants, venues, clubs, teams, events, media outlets, magazines, government bodies, charities, meme pages, fan pages or aggregators. An individual who also runs a business (a personal trainer, a dietitian, a photographer) still counts as a real person.

For each profile below, classify the account:
- kind: one of ${KINDS.map((kind) => `"${kind}"`).join(', ')}
- fits: true if it could plausibly be the kind of person we want, false only if you are confident it is not (for example clearly a business, organisation or page)
- reason: a few words
Judge from the name, handle and bio. When unsure, answer fits = true and kind = "unclear".`

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      id: { type: 'INTEGER' },
      kind: { type: 'STRING', enum: KINDS },
      fits: { type: 'BOOLEAN' },
      reason: { type: 'STRING' },
    },
    required: ['id', 'kind', 'fits', 'reason'],
  },
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : process.argv[index + 1]
}

async function judge(batch) {
  const listing = batch.map((row) => `[${row.sheetRow}] ${row.text.replace(/\n/g, ' | ')} | Followers: ${row.followers}`).join('\n')
  for (let attempt = 0; ; attempt++) {
    const model = MODELS[attempt % MODELS.length]
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${INSTRUCTIONS}\n\nUse the number in square brackets as the id.\n\n${listing}` }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0 },
      }),
      signal: AbortSignal.timeout(120000),
    }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: { message: error.message } }) }))
    const payload = await response.json().catch(() => ({}))
    if (response.ok) {
      const text = (payload.candidates?.[0]?.content?.parts || []).filter((part) => part.text && !part.thought).map((part) => part.text).join('')
      try {
        return { answers: JSON.parse(text), model, tokens: payload.usageMetadata?.totalTokenCount || 0 }
      } catch {}
    }
    if (attempt >= 7 || (response.status && ![429, 500, 502, 503, 504, 200].includes(response.status))) {
      throw new Error(`Gemini failed (${response.status}): ${payload.error?.message || 'bad answer'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** Math.floor(attempt / 2)))
  }
}

async function main() {
  const rows = fs.readFileSync(path.join(DATA, 'text.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => {
    const { vector, ...rest } = JSON.parse(line)
    return rest
  })
  const from = Number(option('from') || 0)
  const decided = (row) => ['yes', 'no'].includes(row.keep.toLowerCase())
  const wanted = rows.filter((row) => row.sheetRow >= from && (process.argv.includes('--pending') ? !decided(row) : decided(row)))
  const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).sheetRow) : [])
  const todo = wanted.filter((row) => !done.has(row.sheetRow))
  console.log(`${wanted.length} rows selected, ${todo.length} to judge`)
  const out = fs.createWriteStream(OUT, { flags: 'a' })
  const batches = []
  for (let start = 0; start < todo.length; start += BATCH) batches.push(todo.slice(start, start + BATCH))
  let next = 0
  let finished = 0
  let tokens = 0
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (next < batches.length) {
      const batch = batches[next++]
      const { answers, model, tokens: used } = await judge(batch)
      tokens += used
      const byId = new Map(answers.map((answer) => [answer.id, answer]))
      for (const row of batch) {
        const answer = byId.get(row.sheetRow)
        if (!answer) continue
        out.write(`${JSON.stringify({ sheetRow: row.sheetRow, keep: row.keep, name: row.name, username: row.username, kind: answer.kind, fits: answer.fits, reason: answer.reason, model })}\n`)
      }
      finished += batch.length
      if ((finished / BATCH) % 10 === 0 || finished === todo.length) console.log(`${finished}/${todo.length}  ~${Math.round(tokens / finished)} tokens/profile`)
    }
  }))
  await new Promise((resolve) => out.end(resolve))
  console.log('done')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})

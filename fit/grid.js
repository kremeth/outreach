// For each sheet row: load the Instagram profile, stitch its first 12 photos into one grid image,
// ask Gemini to describe the grid, and embed name + handle + bio + followers + grid description.
// Uses its own background Chrome so the review tool is not slowed down.
//   node fit/grid.js --set train [--limit N]    decided rows (Yes and No), shuffled
//   node fit/grid.js --set pending [--limit N]  undecided rows
// Resumable: results go to data/fit/grid.jsonl, grid images to data/fit/grids/.
process.env.IG_PREVIEW_PORT = process.env.IG_PREVIEW_PORT || '9335'
process.env.IG_PREVIEW_PROFILE = process.env.IG_PREVIEW_PROFILE || require('path').join(__dirname, '..', 'data', 'ig-chrome-grid')
process.env.IG_PREVIEW_TABS = process.env.IG_PREVIEW_TABS || '4'

const fs = require('fs')
const https = require('https')
const path = require('path')
const sharp = require('sharp')
const sheet = require('../lib/sheet')
const data = require('../lib/data')
const preview = require('../lib/ig-preview')

const DATA = path.join(__dirname, '..', 'data', 'fit')
const GRIDS = path.join(DATA, 'grids')
const OUT = path.join(DATA, 'grid.jsonl')
const KEY = fs.readFileSync(path.join(__dirname, '..', 'data', 'gemini-key.txt'), 'utf8').trim()
const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest']
const EMBED_MODEL = 'gemini-embedding-2'
const DIMENSIONS = 768
const WORKERS = Number(process.env.GRID_WORKERS) || 12
const TILE = 256
const COLUMNS = 3
const PHOTOS = 12
const PAUSE_AFTER_FAILURES = 8
const PAUSE_MS = 5 * 60 * 1000
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const DESCRIBE = `This image is an Instagram profile grid: the account's 12 most recent posts, 3 across and 4 down, followed by the account's bio.
Describe the account in 80 to 120 words of plain text, covering:
- whether it is an individual person, a couple or family, or a brand, business, organisation, club, media outlet or page;
- the main content themes and activities (for example running, gym, sport, outdoors, travel, food, fashion, beauty, parenting, products, events);
- how often a real person appears, and whether it looks like the same person;
- the style (candid phone photos, professional shoots, product shots, text graphics, memes, reposts);
- any visible watches, fitness bands or rings.
Do not guess the brand of anything you cannot see clearly. Write plain sentences with no markdown, bold or lists.`

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shuffled(items, seed) {
  const copy = [...items]
  let state = seed
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

function download(src) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(src)
    if (!parsed.hostname.endsWith('cdninstagram.com') && !parsed.hostname.endsWith('fbcdn.net')) return reject(new Error('blocked host'))
    const request = https.get(parsed, { headers: { Referer: 'https://www.instagram.com/', 'User-Agent': USER_AGENT } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        return reject(new Error(`photo ${response.statusCode}`))
      }
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve(Buffer.concat(chunks)))
    })
    request.setTimeout(20000, () => request.destroy(new Error('photo timeout')))
    request.on('error', reject)
  })
}

async function buildGrid(images, file) {
  const buffers = await Promise.all(images.slice(0, PHOTOS).map((image) => download(image.src).catch(() => null)))
  const tiles = await Promise.all(buffers.map((buffer) => (buffer ? sharp(buffer).resize(TILE, TILE, { fit: 'cover' }).jpeg().toBuffer().catch(() => null) : null)))
  const rows = Math.ceil(PHOTOS / COLUMNS)
  const composite = tiles
    .map((tile, index) => (tile ? { input: tile, left: (index % COLUMNS) * (TILE + 2), top: Math.floor(index / COLUMNS) * (TILE + 2) } : null))
    .filter(Boolean)
  const image = await sharp({
    create: { width: COLUMNS * TILE + (COLUMNS - 1) * 2, height: rows * TILE + (rows - 1) * 2, channels: 3, background: '#ffffff' },
  }).composite(composite).jpeg({ quality: 82 }).toBuffer()
  fs.writeFileSync(file, image)
  return { image, tiles: composite.length }
}

async function gemini(model, body) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}`, {
    method: 'POST',
    headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: { message: error.message } }) }))
  const payload = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, payload }
}

async function withRetries(task) {
  for (let attempt = 0; ; attempt++) {
    const result = await task(attempt)
    if (result.ok) return result.payload
    const message = result.payload?.error?.message || ''
    if (result.status === 429 && /free_tier|check your plan/i.test(message)) throw Object.assign(new Error('Gemini quota used up'), { fatal: true })
    if (attempt >= 7 || (result.status && ![429, 500, 502, 503, 504].includes(result.status))) throw new Error(`Gemini ${result.status}: ${message.slice(0, 200)}`)
    await sleep(1500 * 2 ** Math.floor(attempt / 2))
  }
}

async function describe(image, bio) {
  const payload = await withRetries((attempt) => gemini(`${MODELS[attempt % MODELS.length]}:generateContent`, {
    contents: [{ role: 'user', parts: [{ text: DESCRIBE }, { inline_data: { mime_type: 'image/jpeg', data: image.toString('base64') } }, { text: `Bio: ${bio || '(empty)'}` }] }],
    generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
  }))
  const text = (payload.candidates?.[0]?.content?.parts || []).filter((part) => part.text && !part.thought).map((part) => part.text).join('').trim()
  if (!text) throw new Error('empty description')
  return { text, tokens: payload.usageMetadata?.totalTokenCount || 0 }
}

async function embed(text) {
  const payload = await withRetries(() => gemini(`${EMBED_MODEL}:embedContent`, {
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text }] },
    taskType: 'CLASSIFICATION',
    outputDimensionality: DIMENSIONS,
  }))
  return payload.embedding.values.map((value) => Math.round(value * 1e5) / 1e5)
}

function profileText(row, profile, description) {
  return [
    `Name: ${profile?.name || row.name}`,
    `Handle: @${row.username}`,
    `Followers: ${row.followers}`,
    `Bio: ${profile?.bio || row.notes || ''}`,
    `Grid: ${description}`,
  ].join('\n')
}

async function main() {
  const set = option('set', 'train')
  const limit = Number(option('limit', 0)) || Infinity
  fs.mkdirSync(GRIDS, { recursive: true })
  const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).sheetRow) : [])
  const rows = (await sheet.loadAll()).map((row) => ({ ...row, username: data.usernameFrom(row.link) }))
  const decided = (row) => ['yes', 'no'].includes(row.keep.toLowerCase())
  let selected = set === 'pending' ? rows.filter((row) => !decided(row)) : shuffled(rows.filter(decided), 7)
  if (set === 'pending') {
    const judgedFile = path.join(DATA, 'judged.jsonl')
    const judged = new Map((fs.existsSync(judgedFile) ? fs.readFileSync(judgedFile, 'utf8').split('\n').filter(Boolean) : []).map((line) => {
      const item = JSON.parse(line)
      return [item.sheetRow, item]
    }))
    const unjudged = selected.filter((row) => !judged.has(row.sheetRow)).length
    if (unjudged) throw new Error(`${unjudged} pending rows have no text check yet. Run: node fit/judge-text.js --pending`)
    const before = selected.length
    selected = selected.filter((row) => judged.get(row.sheetRow).fits)
    console.log(`text check already ruled out ${before - selected.length} of ${before} pending rows; building grids for the other ${selected.length}`)
  }
  const todo = selected.filter((row) => !done.has(row.sheetRow)).slice(0, limit)
  console.log(`${set}: ${selected.length} rows, ${selected.length - todo.length} already done or skipped by --limit, ${todo.length} to go`)

  const out = fs.createWriteStream(OUT, { flags: 'a' })
  const stats = { done: 0, ok: 0, failed: 0, tokens: 0, started: Date.now() }
  let failuresInRow = 0
  let pausedUntil = 0
  let next = 0

  async function work(row) {
    while (Date.now() < pausedUntil) await sleep(5000)
    const record = { sheetRow: row.sheetRow, keep: row.keep, username: row.username, name: row.name, followers: row.followers, status: 'ok' }
    if (!row.username) return { ...record, status: 'no username' }
    let profile
    try {
      profile = await preview.profile(row.username)
      failuresInRow = 0
    } catch (error) {
      if (['timeout', 'login', 'server'].includes(error.kind)) {
        failuresInRow++
        if (failuresInRow >= PAUSE_AFTER_FAILURES) {
          console.log(`Instagram keeps failing (${error.kind}); pausing ${PAUSE_MS / 60000} minutes`)
          pausedUntil = Date.now() + PAUSE_MS
          failuresInRow = 0
        }
      }
      return { ...record, status: error.kind || 'error', error: error.message }
    }
    record.private = !!profile.private
    record.photos = (profile.images || []).length
    record.bio = profile.bio || ''
    const gridFile = path.join(GRIDS, `${row.sheetRow}.jpg`)
    let description = profile.private ? 'Private account; posts are not visible.' : 'No posts visible.'
    if (record.photos) {
      const grid = await buildGrid(profile.images, gridFile)
      record.tiles = grid.tiles
      if (grid.tiles) {
        const described = await describe(grid.image, record.bio)
        description = described.text
        record.tokens = described.tokens
      }
    }
    record.description = description
    record.text = profileText(row, profile, description)
    record.vector = await embed(record.text)
    return record
  }

  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (next < todo.length) {
      const row = todo[next++]
      let record
      try {
        record = await work(row)
      } catch (error) {
        if (error.fatal) {
          console.error(error.message)
          process.exit(2)
        }
        record = { sheetRow: row.sheetRow, keep: row.keep, username: row.username, status: 'error', error: error.message }
      }
      if (record.status === 'ok' || record.status === 'missing' || record.status === 'restricted' || record.status === 'no username') out.write(`${JSON.stringify(record)}\n`)
      stats.done++
      stats.tokens += record.tokens || 0
      if (record.status === 'ok') stats.ok++
      else stats.failed++
      if (stats.done % 25 === 0 || stats.done === todo.length) {
        const minutes = (Date.now() - stats.started) / 60000
        console.log(`${new Date().toTimeString().slice(0, 8)} ${stats.done}/${todo.length}  ok ${stats.ok}  failed ${stats.failed}  ${(stats.done / minutes).toFixed(1)}/min  ~${Math.round(stats.tokens / Math.max(1, stats.ok))} tokens/profile`)
      }
    }
  }))
  await new Promise((resolve) => out.end(resolve))
  console.log('done')
  process.exit(0)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})

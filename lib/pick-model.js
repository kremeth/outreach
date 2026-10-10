// Predicts which of the 5 suggested comments gets picked in Hustling, learned from the
// "HUSTLING Training Data" tab. Each round is a choice among 5: a conditional logit (softmax over the
// 5 comments) on:
//   flash              the Gemini judge's guess (see "the judge" below)
//   position           which of the 5 slots it is in
//   positionByMachine  the same, per computer (the two people favour different slots)
//   style              length, emojis, exclamation marks, capitals, "haha"...
//   context            how close its meaning is to the post (embeddings of comment and post)
// Judge scores are prequential: a round is only ever judged from the rounds before it, so the judge
// never knows the answer. Every retrain searches feature sets and regularisation with 5-fold
// cross-validation on the older rounds, keeps the best, scores it on the newest rounds it never saw
// (the test split), then refits it on everything for use. It retrains itself as new rounds come in.
//
// On top of that sits an attention network (lib/nn): 2 self-attention blocks over the 5 comments and
// the post, 2 cross-attention blocks from each comment to a memory of recent picks, stacked on the
// logit model's own (out-of-fold) score. It is cross-validated on the same folds and only used when
// its cross-validated log-loss beats the logit model's.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { fork } = require('child_process')
const writer = require('./sheet-writer')
const drafts = require('./comment-draft')
const netInputs = require('./nn/pick-features')
const pickNet = require('./nn/pick-net')
const netTrainer = require('./nn/pick-net-train')

const TAB = 'HUSTLING Training Data'
const DIR = path.join(__dirname, '..', 'data', 'pick-model')
const MODEL_PATH = path.join(DIR, 'model.json')
const EMBED_PATH = path.join(DIR, 'embeddings.json')
const JUDGE_PATH = path.join(DIR, 'judge.json')
const HISTORY_PATH = path.join(DIR, 'history.json')
const KEY_PATH = path.join(__dirname, '..', 'data', 'gemini-key.txt')
const EMBED_MODEL = 'gemini-embedding-001'
const DIMS = 256
const TEST_SHARE = 0.2
const FOLDS = 5
const RETRAIN_AFTER_ROUNDS = 5
const RETRAIN_EVERY_MS = 24 * 60 * 60 * 1000
const CHECK_EVERY_MS = 20 * 60 * 1000
// Rounds judged from fewer earlier picks than this only serve as examples; they are not fitted or tested.
const MIN_HISTORY = 25
const MAX_EXAMPLES = 160

const SETS = [
  ['position'],
  ['position', 'positionByMachine'],
  ['flash'],
  ['position', 'flash'],
  ['position', 'positionByMachine', 'flash'],
  ['position', 'positionByMachine', 'flash', 'style'],
  ['position', 'positionByMachine', 'flash', 'style', 'context'],
]
const L2 = [0.01, 0.1, 1]

// ---------- data ----------

async function readTab() {
  await writer.prepare()
  const result = await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!A1:Z`)}`)
  return result.values || []
}

// Rounds where one of the 5 was picked, oldest first (a pick that was taken back is dropped), and
// the full history the judge learns from: picks, rejections of all 5 (with the direction asked for
// next) and comments people wrote themselves.
function roundsFrom(values) {
  const [header = [], ...lines] = values
  const rows = lines.map((line) => Object.fromEntries(header.map((name, index) => [name, String(line[index] ?? '')])))
  const rounds = []
  const history = historyFrom(rows)
  for (const row of rows) {
    if (row.Outcome === 'undo pick') {
      const last = rounds.map((round) => round.postId).lastIndexOf(row['Post ID'])
      if (last >= 0) rounds.splice(last, 1)
      continue
    }
    const comments = [1, 2, 3, 4, 5].map((n) => row[`Comment ${n}`].trim())
    const picked = Number(row['Picked #']) - 1
    if (row.Outcome !== 'picked' || comments.some((text) => !text) || !(picked >= 0 && picked < 5)) continue
    const liveJudge = String(row['Judge %'] || '').split('/').map(Number)
    rounds.push({
      key: `${row.Time}|${row['Post ID']}`,
      liveJudge: liveJudge.length === 5 && liveJudge.every((value) => value >= 0 && value <= 1) && liveJudge.some((value) => value > 0) ? liveJudge : null,
      time: row.Time,
      machine: row.Machine,
      postId: row['Post ID'],
      comments,
      picked,
      context: [row['Image description'], row.Caption, row.Transcript].filter(Boolean).join('\n').slice(0, 2500),
    })
  }
  return { rounds: rounds.sort((a, b) => a.time.localeCompare(b.time)), history }
}

function historyFrom(rows) {
  const out = []
  for (const row of rows) {
    const comments = [1, 2, 3, 4, 5].map((n) => row[`Comment ${n}`].trim())
    if (comments.some((text) => !text)) continue
    let outcome = null
    if (row.Outcome === 'picked') outcome = Number(row['Picked #']) >= 1 && Number(row['Picked #']) <= 5 ? { picked: Number(row['Picked #']) } : null
    else if (row.Outcome === 'own comment') outcome = { own: row['Picked comment'] }
    else if (row.Outcome === 'reloaded') {
      const next = rows.find((other) => other['Post ID'] === row['Post ID'] && other.Time > row.Time && Number(other.Round) === Number(row.Round || 1) + 1)
      outcome = { reloaded: true, direction: next?.['Rewrite direction'] || '' }
    }
    if (!outcome) continue
    const post = [row['Image description'], row.Caption].filter(Boolean).join(' ').replace(/\s+/g, ' ')
    out.push({ time: row.Time, machine: row.Machine, comments, post, ...outcome })
  }
  return out
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value))
  fs.renameSync(`${file}.tmp`, file)
}

// ---------- embeddings (cached on disk, normalised) ----------

let embedCache = null
const hash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 20)

function normalise(vector) {
  const length = Math.hypot(...vector) || 1
  return vector.map((value) => value / length)
}

async function embed(texts) {
  if (!embedCache) embedCache = readJson(EMBED_PATH, {})
  const missing = [...new Set(texts.filter((text) => text && !embedCache[hash(text)]))]
  const key = fs.readFileSync(KEY_PATH, 'utf8').trim()
  for (let start = 0; start < missing.length; start += 100) {
    const batch = missing.slice(start, start + 100)
    let payload = null
    for (let attempt = 0; attempt < 4 && !payload; attempt++) {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: batch.map((text) => ({ model: `models/${EMBED_MODEL}`, content: { parts: [{ text }] }, taskType: 'SEMANTIC_SIMILARITY', outputDimensionality: DIMS })),
        }),
        signal: AbortSignal.timeout(30000),
      }).catch(() => null)
      if (response?.ok) payload = await response.json()
      else await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
    }
    if (!payload?.embeddings) throw new Error('Gemini embeddings did not answer.')
    batch.forEach((text, index) => {
      embedCache[hash(text)] = normalise(payload.embeddings[index].values).map((value) => Math.round(value * 1e5) / 1e5)
    })
  }
  if (missing.length) writeJson(EMBED_PATH, embedCache)
  return texts.map((text) => (text ? embedCache[hash(text)] : null))
}

const dot = (a, b) => {
  let sum = 0
  for (let index = 0; index < a.length; index++) sum += a[index] * b[index]
  return sum
}

// ---------- the judge ----------
// Gemini Flash, reasoning before it answers (about 3 seconds). It sees every earlier round from both
// people (picks, full rejections with the direction asked for, own comments), labelled by person,
// and gives the chance that this round's person picks each of the 5. Evaluated on the older rounds
// before being chosen: 40% right vs 36% for the earlier judge that only saw picks. (Gemini Pro
// scored no better, took 15-20 seconds and gave all-or-nothing answers, so it was dropped.)
const JUDGES = {
  flash: { models: ['gemini-3.8-flash', 'gemini-flash-latest'], thinking: 2048 },
}
const HISTORY_LIMIT = 220
const JUDGE_SCHEMA = { type: 'OBJECT', properties: { scores: { type: 'ARRAY', items: { type: 'NUMBER' } } }, required: ['scores'] }
const listed = (comments) => comments.map((text, index) => `${index + 1}. ${text}`).join('\n')

function personOf(people, machine) {
  const index = people.indexOf(machine)
  return `Person ${index >= 0 ? index + 1 : people.length + 1}`
}

function outcomeText(item, people) {
  const who = personOf(people, item.machine)
  if (item.picked) return `${who} PICKED #${item.picked}`
  if (item.own != null) return `${who} REJECTED ALL 5 and wrote their own: "${item.own}"`
  return `${who} REJECTED ALL 5 and asked for new ones${item.direction ? `, wanting: "${item.direction}"` : ''}`
}

function judgeHeader(people) {
  return `Two people (${people.map((machine) => personOf(people, machine)).join(' and ')}) take turns choosing an Instagram comment to post under creators' posts. Each round they see 5 suggested comments and either pick one, or reject all 5 (asking for new ones, sometimes with a direction, or writing their own). Below is every past round, oldest first. Learn each person's taste: what they pick, what they reject, the directions they give. People's taste can drift, so recent rounds matter more.

`
}

function roundsText(items, people, first = 1) {
  return items.map((item, index) => `Round ${first + index}\n${item.post ? `Post: ${item.post.slice(0, 160)}\n` : ''}${listed(item.comments)}\n→ ${outcomeText(item, people)}`).join('\n\n')
}

function targetText(target, people) {
  const who = personOf(people, target.machine)
  return `\n\nNew round, chosen by ${who}.
${target.context ? `Post: ${target.context.replace(/\s+/g, ' ').slice(0, 300)}\n` : ''}${listed(target.comments)}

Give the probability (0 to 1, the 5 adding to 1) that ${who} picks each comment, assuming they pick one of these 5.`
}

function judgePrompt(target, history, people) {
  const past = history.filter((item) => item.time < target.time).slice(-HISTORY_LIMIT)
  return `${judgeHeader(people)}${roundsText(past, people)}${targetText(target, people)}`
}

const peopleIn = (history) => [...new Set(history.map((item) => item.machine))].sort()

function acceptScores(parsed) {
  if (!Array.isArray(parsed.scores) || parsed.scores.length !== 5) throw new Error('The judge did not score all 5.')
  const total = parsed.scores.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0)
  if (!total) throw new Error('The judge gave no scores.')
  return parsed.scores.map((value) => Math.max(0, Number(value) || 0) / total)
}

// target: { comments, context, machine, time } (time: only history before it is shown).
async function judge(which, target, history) {
  const people = peopleIn(history)
  return drafts.ask([{ text: judgePrompt(target, history, people) }], JUDGE_SCHEMA, 0, 180000, acceptScores, { ...JUDGES[which], purpose: 'pick predictor: training' })
}

// ---------- live predictions, with the history cached at Gemini ----------
// The history is ~27k tokens and the same for every prediction, so it is uploaded once as a Gemini
// cache (cached tokens cost a fraction of normal ones) and each prediction only sends the rounds
// since the cache was made plus the 5 new comments (~100 tokens). The prompt reads exactly as above.
// The cache lasts an hour and is rebuilt after 25 new rounds; if caching fails, the full prompt is sent.
const CACHE_TTL_S = 3600
const CACHE_REBUILD_AFTER = 25
const CACHE_MODEL = 'gemini-3.8-flash'
let judgeCache = null
let judgeCacheBuilding = null

async function geminiRequest(method, urlPath, body) {
  const key = fs.readFileSync(KEY_PATH, 'utf8').trim()
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${urlPath}`, {
    method,
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error?.message || `Gemini ${response.status}`)
  return payload
}

function cacheFits(cache, past, people) {
  return cache
    && cache.expires - Date.now() > 5 * 60 * 1000
    && cache.people === people.join('|')
    && past.length >= cache.end
    && past[cache.end - 1]?.time === cache.lastTime
    && past.length - cache.end < CACHE_REBUILD_AFTER
}

async function historyCache(past, people) {
  if (cacheFits(judgeCache, past, people)) return judgeCache
  if (!judgeCacheBuilding) {
    judgeCacheBuilding = (async () => {
      const start = Math.max(0, past.length - HISTORY_LIMIT)
      const prefix = `${judgeHeader(people)}${roundsText(past.slice(start), people)}`
      const created = await geminiRequest('POST', 'cachedContents', { model: `models/${CACHE_MODEL}`, contents: [{ role: 'user', parts: [{ text: prefix }] }], ttl: `${CACHE_TTL_S}s` })
      drafts.logUsage('pick predictor: history cache', CACHE_MODEL, created.usageMetadata, true)
      const old = judgeCache
      judgeCache = { name: created.name, start, end: past.length, lastTime: past[past.length - 1]?.time, people: people.join('|'), expires: Date.now() + CACHE_TTL_S * 1000 }
      if (old) geminiRequest('DELETE', old.name).catch(() => {})
      return judgeCache
    })().finally(() => {
      judgeCacheBuilding = null
    })
  }
  return judgeCacheBuilding
}

async function judgeLive(target, history) {
  const people = peopleIn(history)
  const past = history.filter((item) => item.time < target.time)
  try {
    const cache = await historyCache(past, people)
    const newer = past.slice(cache.end)
    const rest = `${newer.length ? `\n\n${roundsText(newer, people, cache.end - cache.start + 1)}` : ''}${targetText(target, people)}`
    return await drafts.ask([{ text: rest }], JUDGE_SCHEMA, 0, 60000, acceptScores, { models: [CACHE_MODEL], thinking: JUDGES.flash.thinking, cachedContent: cache.name, purpose: 'pick predictor' })
  } catch (error) {
    console.error('pick predictor cache', error.message)
    judgeCache = null
    return drafts.ask([{ text: judgePrompt(target, history, people) }], JUDGE_SCHEMA, 0, 180000, acceptScores, { ...JUDGES.flash, purpose: 'pick predictor (uncached)' })
  }
}

// Live predictions remember the judge's raw scores (here, and in the training tab's "Judge %" column
// for the other computer), so a retrain reuses them instead of asking Gemini again. They were made
// from the history before the pick, exactly what a retrain would ask for.
const LIVE_JUDGE_PATH = path.join(DIR, 'live-judge.json')
const commentsKey = (comments) => hash(JSON.stringify(comments.map((text) => String(text || '').trim())))
let liveJudge = null
function rememberLiveJudge(comments, scores) {
  if (!liveJudge) liveJudge = readJson(LIVE_JUDGE_PATH, {})
  liveJudge[commentsKey(comments)] = scores
  const keys = Object.keys(liveJudge)
  for (const key of keys.slice(0, Math.max(0, keys.length - 3000))) delete liveJudge[key]
  writeJson(LIVE_JUDGE_PATH, liveJudge)
}

// Judges every round that has no score yet, each from the history before it only. Cached for good.
// Rounds scored live (on this computer or the other) reuse that score: no Gemini call.
async function judgeAll(rounds, history) {
  const store = readJson(JUDGE_PATH, {})
  if (!liveJudge) liveJudge = readJson(LIVE_JUDGE_PATH, {})
  for (const round of rounds) {
    if (store[round.key]?.flash) continue
    const live = round.liveJudge || liveJudge[commentsKey(round.comments)]
    if (live) store[round.key] = { ...store[round.key], flash: live }
  }
  const todo = []
  for (const round of rounds) for (const which of Object.keys(JUDGES)) if (!store[round.key]?.[which]) todo.push([round, which])
  for (let start = 0; start < todo.length; start += 8) {
    await Promise.all(todo.slice(start, start + 8).map(async ([round, which]) => {
      const scores = await judge(which, round, history).catch((error) => {
        console.error('judge', which, error.message)
        return null
      })
      if (scores) store[round.key] = { ...store[round.key], [which]: scores }
    }))
    writeJson(JUDGE_PATH, store)
  }
  return store
}

// ---------- features ----------

const EMOJI = /\p{Extended_Pictographic}/gu

function style(text) {
  const emojis = (text.match(EMOJI) || []).length
  const letters = text.replace(/[^\p{L}]/gu, '')
  return [
    Math.log(1 + text.length),
    text.split(/\s+/).filter(Boolean).length,
    emojis ? 1 : 0,
    emojis,
    /!/.test(text) ? 1 : 0,
    /^\p{Lu}/u.test(text) ? 1 : 0,
    letters && letters === letters.toLowerCase() ? 1 : 0,
    /\b(haha+|lol|lmao)\b/i.test(text) ? 1 : 0,
    /[.]$/.test(text.trim()) ? 1 : 0,
  ]
}

const logScore = (value) => Math.log(Math.max(0.02, value ?? 0.2))

// Raw (unscaled) features of the 5 comments in a round. `info` holds judge scores and embeddings.
function features(round, info, sets, machines) {
  return round.comments.map((text, index) => {
    const out = []
    if (sets.includes('flash')) out.push(logScore(info.judge?.flash?.[index]))
    if (sets.includes('position')) out.push(...[1, 2, 3, 4].map((slot) => (index === slot ? 1 : 0)))
    if (sets.includes('positionByMachine')) {
      for (const machine of machines) out.push(...[1, 2, 3, 4].map((slot) => (index === slot && round.machine === machine ? 1 : 0)))
    }
    if (sets.includes('style')) out.push(...style(text))
    if (sets.includes('context')) out.push(info.context && info.comments?.[index] ? dot(info.comments[index], info.context) : 0)
    return out
  })
}

// ---------- conditional logit ----------

function softmax(scores) {
  const top = Math.max(...scores)
  const exps = scores.map((score) => Math.exp(score - top))
  const total = exps.reduce((a, b) => a + b, 0)
  return exps.map((value) => value / total)
}

function standardiser(rows) {
  const size = rows[0]?.[0]?.length || 0
  const mu = new Array(size).fill(0)
  const sd = new Array(size).fill(0)
  let count = 0
  for (const round of rows) for (const candidate of round) { count++; candidate.forEach((value, index) => { mu[index] += value }) }
  for (let index = 0; index < size; index++) mu[index] /= Math.max(1, count)
  for (const round of rows) for (const candidate of round) candidate.forEach((value, index) => { sd[index] += (value - mu[index]) ** 2 })
  for (let index = 0; index < size; index++) sd[index] = Math.sqrt(sd[index] / Math.max(1, count)) || 1
  return { mu, sd }
}

const scale = (vector, { mu, sd }) => vector.map((value, index) => (value - mu[index]) / sd[index])

// Maximum likelihood with an L2 penalty, by Adam on the full batch. examples: [{ x: [5][k], picked }]
function fit(examples, l2) {
  const k = examples[0].x[0].length
  const w = new Array(k).fill(0)
  const m = new Array(k).fill(0)
  const s = new Array(k).fill(0)
  const n = examples.length
  for (let step = 1; step <= 500; step++) {
    const grad = w.map((value) => l2 * value)
    for (const example of examples) {
      const probs = softmax(example.x.map((x) => dot(w, x)))
      probs.forEach((p, index) => {
        const g = (p - (index === example.picked ? 1 : 0)) / n
        example.x[index].forEach((x, j) => { grad[j] += g * x })
      })
    }
    grad.forEach((g, j) => {
      m[j] = 0.9 * m[j] + 0.1 * g
      s[j] = 0.999 * s[j] + 0.001 * g * g
      w[j] -= (0.05 * (m[j] / (1 - 0.9 ** step))) / (Math.sqrt(s[j] / (1 - 0.999 ** step)) + 1e-8)
    })
  }
  return w
}

// Right first guess, right within the top 2, log-loss; overall and per computer.
function evaluate(model, rounds, infoOf) {
  let correct = 0
  let top2 = 0
  let loss = 0
  const byMachine = {}
  for (const round of rounds) {
    const probs = probabilities(model, round, infoOf(round))
    const order = probs.map((p, index) => [p, index]).sort((a, b) => b[0] - a[0]).map(([, index]) => index)
    const hit = order[0] === round.picked
    if (hit) correct++
    if (order.slice(0, 2).includes(round.picked)) top2++
    loss -= Math.log(Math.max(1e-9, probs[round.picked]))
    const mine = (byMachine[round.machine] ||= { rounds: 0, correct: 0 })
    mine.rounds++
    if (hit) mine.correct++
  }
  const n = Math.max(1, rounds.length)
  return { accuracy: correct / n, top2: top2 / n, logLoss: loss / n, rounds: rounds.length, byMachine }
}

function train(rounds, infoOf, config, machines) {
  const raw = rounds.map((round) => features(round, infoOf(round), config.sets, machines))
  const scaling = standardiser(raw)
  const examples = raw.map((x, index) => ({ x: x.map((vector) => scale(vector, scaling)), picked: rounds[index].picked }))
  return { config, machines, scaling, weights: fit(examples, config.l2) }
}

function probabilities(model, round, info) {
  const x = features(round, info, model.config.sets, model.machines).map((vector) => scale(vector, model.scaling))
  return softmax(x.map((vector) => dot(model.weights, vector)))
}

// Deterministic fold assignment, so both computers choose the same model from the same data.
function foldOf(count) {
  const order = [...Array(count).keys()]
  let seed = 7
  for (let index = order.length - 1; index > 0; index--) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const other = seed % (index + 1)
    ;[order[index], order[other]] = [order[other], order[index]]
  }
  const fold = new Array(count)
  order.forEach((position, index) => { fold[position] = index % FOLDS })
  return fold
}

// ---------- training run ----------

let training = null
let current = null

function load() {
  if (!current) current = readJson(MODEL_PATH, null)
  return current
}

async function retrain(reason = 'manual') {
  if (training) return training
  training = (async () => {
    const started = Date.now()
    const { rounds, history } = roundsFrom(await readTab())
    const usable = rounds.slice(MIN_HISTORY)
    if (usable.length < 40) throw new Error(`Only ${rounds.length} picked rounds so far; the model needs ${MIN_HISTORY + 40}.`)
    const judged = await judgeAll(usable, history)
    const vectors = await embed([...rounds.flatMap((round) => round.comments), ...rounds.map((round) => round.context)])
    const info = new Map(rounds.map((round, index) => [round, {
      judge: judged[round.key],
      comments: vectors.slice(index * 5, index * 5 + 5),
      context: vectors[rounds.length * 5 + index],
    }]))
    const infoOf = (round) => info.get(round)
    const machines = [...new Set(rounds.map((round) => round.machine))].sort()

    // Test split: the newest rounds, never seen while choosing or fitting the model.
    const testCount = Math.max(15, Math.round(usable.length * TEST_SHARE))
    const trainRounds = usable.slice(0, usable.length - testCount)
    const testRounds = usable.slice(usable.length - testCount)

    // Model search: every feature set and penalty, 5-fold cross-validation on the training split.
    const fold = foldOf(trainRounds.length)
    const results = []
    for (const sets of SETS) {
      for (const l2 of L2) {
        const config = { sets, l2 }
        const scores = []
        for (let f = 0; f < FOLDS; f++) {
          const inner = trainRounds.filter((_, index) => fold[index] !== f)
          const held = trainRounds.filter((_, index) => fold[index] === f)
          scores.push(evaluate(train(inner, infoOf, config, machines), held, infoOf))
        }
        const avg = (key) => scores.reduce((sum, item) => sum + item[key] * item.rounds, 0) / trainRounds.length
        const byMachine = {}
        for (const item of scores) {
          for (const [machine, counts] of Object.entries(item.byMachine)) {
            const total = (byMachine[machine] ||= { rounds: 0, correct: 0 })
            total.rounds += counts.rounds
            total.correct += counts.correct
          }
        }
        results.push({ config, cv: { accuracy: avg('accuracy'), top2: avg('top2'), logLoss: avg('logLoss'), byMachine } })
      }
    }
    results.sort((a, b) => a.cv.logLoss - b.cv.logLoss)
    const best = results[0]

    // Honest score on the test split, next to the baselines.
    const chosen = train(trainRounds, infoOf, best.config, machines)
    const trainScore = evaluate(chosen, trainRounds, infoOf)
    const testScore = evaluate(chosen, testRounds, infoOf)
    const slotCounts = [0, 0, 0, 0, 0]
    for (const round of trainRounds) slotCounts[round.picked]++
    const favourite = slotCounts.indexOf(Math.max(...slotCounts))
    const judgeAlone = evaluate({ config: { sets: ['flash'] }, machines, scaling: { mu: [0], sd: [1] }, weights: [1] }, testRounds, infoOf)
    const baseline = {
      random: 0.2,
      favouriteSlot: testRounds.filter((round) => round.picked === favourite).length / testRounds.length,
      favourite: favourite + 1,
      judgeAlone: judgeAlone.accuracy,
    }

    // The model in use: the same choice, refit on every usable round.
    const final = train(usable, infoOf, best.config, machines)

    // The attention network, stacked on the logit model. Its logit input is always out-of-fold.
    let network = null
    try {
      network = await trainNetwork({ rounds, usable, trainRounds, testRounds, infoOf, machines, config: best.config, fold, chosen })
    } catch (error) {
      console.error('pick network', error.message)
    }
    const use = network && network.cv.logLoss < best.cv.logLoss ? 'network' : 'logit'
    const picksBySlot = [0, 0, 0, 0, 0]
    for (const round of rounds) picksBySlot[round.picked]++
    const model = {
      trainedAt: new Date().toISOString(),
      reason,
      rounds: rounds.length,
      split: { train: trainRounds.length, test: testRounds.length, examplesOnly: MIN_HISTORY },
      config: best.config,
      cv: best.cv,
      trainScore,
      test: testScore,
      baseline,
      picksBySlot,
      tried: results.length,
      ranking: results.slice(0, 5).map((item) => ({ sets: item.config.sets, l2: item.config.l2, cv: item.cv })),
      machines,
      scaling: final.scaling,
      weights: final.weights,
      use,
      network,
      seconds: Math.round((Date.now() - started) / 1000),
    }
    writeJson(MODEL_PATH, model)
    const past = readJson(HISTORY_PATH, [])
    past.push({ trainedAt: model.trainedAt, reason, rounds: model.rounds, sets: best.config.sets, test: testScore, cv: best.cv, baseline, use, network: network && { cv: network.cv, test: network.test, trainScore: network.trainScore } })
    writeJson(HISTORY_PATH, past.slice(-200))
    current = model
    restoredNets = null
    examplesCache = { at: 0, rounds: [], history: [] }
    return summary()
  })().finally(() => {
    training = null
  })
  return training
}

// ---------- the attention network ----------

// The logit model's log-probabilities for `targets`, from a model fitted on `fitOn`.
function logitLogs(fitOn, targets, infoOf, config, machines, fitted = null) {
  const model = fitted || train(fitOn, infoOf, config, machines)
  return new Map(targets.map((round) => [round, probabilities(model, round, infoOf(round)).map((p) => Math.log(Math.max(1e-6, p)))]))
}

// Out-of-fold logit log-probabilities: each round scored by a model that never saw it.
function outOfFold(list, folds, infoOf, config, machines) {
  const out = new Map()
  for (let f = 0; f <= Math.max(...folds); f++) {
    const inner = list.filter((_, index) => folds[index] !== f)
    const held = list.filter((_, index) => folds[index] === f)
    for (const [round, logs] of logitLogs(inner, held, infoOf, config, machines)) out.set(round, logs)
  }
  return out
}

function networkExample(round, info, history, historyInfo, fitted, logs) {
  const inputs = netInputs.inputsFor(round, info, history, historyInfo, fitted)
  return { ...inputs, wide: inputs.wide.map((row, index) => [logs[index], ...row]), machine: round.machine }
}

async function trainNetwork({ rounds, usable, trainRounds, testRounds, infoOf, machines, config, fold, chosen }) {
  const fitted = netInputs.fitInputs(rounds, infoOf)
  const before = (round) => rounds.slice(0, rounds.indexOf(round))
  const trainLogs = outOfFold(trainRounds, fold, infoOf, config, machines)
  const testLogs = logitLogs(trainRounds, testRounds, infoOf, config, machines, chosen)
  const allLogs = outOfFold(usable, foldOf(usable.length), infoOf, config, machines)
  const build = (list, logs) => list.map((round) => networkExample(round, infoOf(round), before(round), infoOf, fitted, logs.get(round)))
  const dataset = { train: build(trainRounds, trainLogs), test: build(testRounds, testLogs), all: build(usable, allLogs), folds: fold }
  const first = dataset.train[0]
  dataset.dims = { cand: first.cand[0].length, ctx: first.ctx[0].length, mem: first.mem[0].length, wide: first.wide[0].length }
  const result = await inChildProcess(dataset)
  return { ...result, fitted, dims: dataset.dims }
}

// Training runs in its own process so the server stays responsive.
function inChildProcess(dataset) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'nn', 'pick-net-train.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('The attention network took too long to train.'))
    }, 30 * 60 * 1000)
    child.once('message', (message) => {
      clearTimeout(timer)
      child.kill()
      if (message.ok) resolve(message.result)
      else reject(new Error(message.error))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code) reject(new Error(`The network trainer stopped (${code}).`))
    })
    child.send({ dataset })
  })
}

let restoredNets = null
function networkModels(model) {
  if (!restoredNets) restoredNets = model.network.nets.map(pickNet.restore)
  return restoredNets
}

// Retrains when enough new picks came in (or once a day). Checked on start and every 20 minutes.
async function maybeRetrain() {
  try {
    const model = load()
    const { rounds } = roundsFrom(await readTab())
    const due = !model || rounds.length - model.rounds >= RETRAIN_AFTER_ROUNDS || Date.now() - Date.parse(model.trainedAt) > RETRAIN_EVERY_MS
    if (due && rounds.length >= MIN_HISTORY + 40) await retrain(model ? `${rounds.length - model.rounds} new rounds` : 'first training')
  } catch (error) {
    console.error('pick model', error.message)
  }
}

function startAutoRetrain() {
  setTimeout(maybeRetrain, 60 * 1000).unref()
  setInterval(maybeRetrain, CHECK_EVERY_MS).unref()
}

// ---------- scoring a new round ----------

// Whole percentages that add up to exactly 100 (largest remainder).
function percentages(probs) {
  const raw = probs.map((p) => p * 100)
  const out = raw.map(Math.floor)
  let left = 100 - out.reduce((a, b) => a + b, 0)
  raw.map((value, index) => [value - Math.floor(value), index]).sort((a, b) => b[0] - a[0]).forEach(([, index]) => {
    if (left > 0) {
      out[index]++
      left--
    }
  })
  return out
}

// Every pick so far, as examples for the judge (re-read from the sheet at most every 5 minutes).
// Every round so far (re-read from the sheet at most every 5 minutes): picks for the network's
// memory, the full history for the judges.
let examplesCache = { at: 0, rounds: [], history: [] }
async function examples() {
  if (Date.now() - examplesCache.at > 5 * 60 * 1000) {
    const { rounds, history } = roundsFrom(await readTab())
    examplesCache = { at: Date.now(), rounds, history }
  }
  return examplesCache
}

// The chance (in whole percent, adding to 100) that this computer's person picks each of the 5.
async function score({ comments, description = '', caption = '', transcript = '', machine }) {
  const model = load()
  if (!model || !Array.isArray(comments) || comments.length !== 5) return null
  const round = { comments: comments.map((text) => String(text || '').trim()), machine, context: [description, caption, transcript].filter(Boolean).join('\n').slice(0, 2500) }
  const sets = model.config.sets
  const useNetwork = model.use === 'network' && model.network
  const { rounds: past, history: everything } = await examples()
  const target = { ...round, time: new Date().toISOString() }
  const [flash, vectors] = await Promise.all([
    useNetwork || sets.includes('flash') ? judgeLive(target, everything) : null,
    useNetwork || sets.includes('context') ? embed([...round.comments, round.context]) : null,
  ])
  const info = { judge: { flash }, comments: vectors?.slice(0, 5), context: vectors?.[5] }
  if (flash) rememberLiveJudge(round.comments, flash)
  const judgeOut = flash ? flash.map((value) => Math.round(value * 1000) / 1000) : null
  const logitProbs = probabilities(model, round, info)
  if (!useNetwork) return { percent: percentages(logitProbs), judge: judgeOut, model: summary() }
  // The network: this round, the memory of recent picks (their embeddings), and the logit's score.
  const history = past.slice(-netInputs.MEMORY_ROUNDS)
  const historyVectors = await embed(history.flatMap((item) => item.comments))
  const historyInfo = (item) => ({ comments: historyVectors.slice(history.indexOf(item) * 5, history.indexOf(item) * 5 + 5) })
  const example = networkExample(round, info, history, historyInfo, model.network.fitted, logitProbs.map((p) => Math.log(Math.max(1e-6, p))))
  return { percent: percentages(pickNet.probabilities(networkModels(model), netTrainer.tensors(example))), judge: judgeOut, model: summary() }
}

function summary() {
  const model = load()
  if (!model) return { ready: false, training: Boolean(training) }
  return {
    ready: true,
    training: Boolean(training),
    trainedAt: model.trainedAt,
    rounds: model.rounds,
    split: model.split,
    features: model.config.sets,
    use: model.use || 'logit',
    network: model.network ? { cv: model.network.cv, trainScore: model.network.trainScore, test: model.network.test, epochs: model.network.epochs, hp: model.network.hp, params: model.network.params, seconds: model.network.seconds } : null,
    trainScore: model.trainScore,
    test: model.test,
    cv: model.cv,
    baseline: model.baseline,
    picksBySlot: model.picksBySlot,
    history: readJson(HISTORY_PATH, []).slice(-10).map((item) => ({ trainedAt: item.trainedAt, rounds: item.rounds, accuracy: item.test.accuracy })),
  }
}

module.exports = { retrain, maybeRetrain, startAutoRetrain, score, summary, roundsFrom, percentages, foldOf }

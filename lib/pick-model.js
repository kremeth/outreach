// Predicts which of the 5 suggested comments gets picked in Hustling, learned from the
// "HUSTLING Training Data" tab. Each round is a choice among 5: a conditional logit (softmax over the
// 5 comments) on:
//   judge              Gemini's guess, shown every earlier pick as an example (both computers)
//   judgeMine          the same, with only the picks made on the same computer (each person's taste)
//   position           which of the 5 slots it is in
//   positionByMachine  the same, per computer (the two people favour different slots)
//   style              length, emojis, exclamation marks, capitals, "haha"...
//   context            how close its meaning is to the post (embeddings of comment and post)
// Judge scores are prequential: a round is only ever judged from the rounds before it, so the judge
// never knows the answer. Every retrain searches feature sets and regularisation with 5-fold
// cross-validation on the older rounds, keeps the best, scores it on the newest rounds it never saw
// (the test split), then refits it on everything for use. It retrains itself as new rounds come in.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const writer = require('./sheet-writer')
const drafts = require('./comment-draft')

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
  ['judge'],
  ['judgeMine'],
  ['judge', 'judgeMine'],
  ['position', 'judge'],
  ['position', 'judgeMine'],
  ['position', 'judge', 'judgeMine'],
  ['position', 'positionByMachine', 'judge', 'judgeMine'],
  ['position', 'positionByMachine', 'judge', 'judgeMine', 'style'],
  ['position', 'positionByMachine', 'judge', 'judgeMine', 'style', 'context'],
]
const L2 = [0.01, 0.1, 1]

// ---------- data ----------

async function readTab() {
  await writer.prepare()
  const result = await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!A1:Z`)}`)
  return result.values || []
}

// Rounds where one of the 5 was picked, oldest first. A pick that was taken back (undo) is dropped.
function roundsFrom(values) {
  const [header = [], ...lines] = values
  const rows = lines.map((line) => Object.fromEntries(header.map((name, index) => [name, String(line[index] ?? '')])))
  const rounds = []
  for (const row of rows) {
    if (row.Outcome === 'undo pick') {
      const last = rounds.map((round) => round.postId).lastIndexOf(row['Post ID'])
      if (last >= 0) rounds.splice(last, 1)
      continue
    }
    const comments = [1, 2, 3, 4, 5].map((n) => row[`Comment ${n}`].trim())
    const picked = Number(row['Picked #']) - 1
    if (row.Outcome !== 'picked' || comments.some((text) => !text) || !(picked >= 0 && picked < 5)) continue
    rounds.push({
      key: `${row.Time}|${row['Post ID']}`,
      time: row.Time,
      machine: row.Machine,
      postId: row['Post ID'],
      comments,
      picked,
      context: [row['Image description'], row.Caption, row.Transcript].filter(Boolean).join('\n').slice(0, 2500),
    })
  }
  return { rounds: rounds.sort((a, b) => a.time.localeCompare(b.time)) }
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

const JUDGE_SCHEMA = { type: 'OBJECT', properties: { scores: { type: 'ARRAY', items: { type: 'NUMBER' } } }, required: ['scores'] }
const listed = (comments) => comments.map((text, index) => `${index + 1}. ${text}`).join('\n')
const postLine = (context, length) => (context ? ` (post: ${context.replace(/\s+/g, ' ').slice(0, length)})` : '')

// Gemini's probability for each of the 5, having seen `examples` (earlier rounds and their picks).
async function judge(comments, context, examples) {
  if (!examples.length) return [0.2, 0.2, 0.2, 0.2, 0.2]
  const shown = examples.slice(-MAX_EXAMPLES).map((round, index) => `Example ${index + 1}${postLine(round.context, 160)}\n${listed(round.comments)}\nPICKED: ${round.picked + 1}`).join('\n\n')
  const prompt = `A person picks one of 5 suggested comments to post under a creator's Instagram post. Below are their past choices. Learn their taste (tone, length, specificity, humour, what they avoid).\n\n${shown}\n\nFor the new round, give the probability (0 to 1, the 5 adding to 1) that they pick each comment.`
  return drafts.ask([{ text: prompt }, { text: `New round${postLine(context, 300)}\n${listed(comments)}` }], JUDGE_SCHEMA, 0, 60000, (parsed) => {
    if (!Array.isArray(parsed.scores) || parsed.scores.length !== 5) throw new Error('The judge did not score all 5.')
    const total = parsed.scores.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0)
    if (!total) throw new Error('The judge gave no scores.')
    return parsed.scores.map((value) => Math.max(0, Number(value) || 0) / total)
  })
}

// Judges every round that has no score yet, each from the rounds before it only. Cached for good.
async function judgeAll(rounds) {
  const store = readJson(JUDGE_PATH, {})
  const todo = []
  rounds.forEach((round, index) => {
    const earlier = rounds.slice(0, index)
    if (!store[round.key]?.all) todo.push([round, 'all', earlier])
    if (!store[round.key]?.mine) todo.push([round, 'mine', earlier.filter((item) => item.machine === round.machine)])
  })
  for (let start = 0; start < todo.length; start += 8) {
    await Promise.all(todo.slice(start, start + 8).map(async ([round, which, examples]) => {
      const scores = await judge(round.comments, round.context, examples).catch((error) => {
        console.error('judge', error.message)
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
    if (sets.includes('judge')) out.push(logScore(info.judge?.all?.[index]))
    if (sets.includes('judgeMine')) out.push(logScore(info.judge?.mine?.[index]))
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
    const { rounds } = roundsFrom(await readTab())
    const usable = rounds.slice(MIN_HISTORY)
    if (usable.length < 40) throw new Error(`Only ${rounds.length} picked rounds so far; the model needs ${MIN_HISTORY + 40}.`)
    const judged = await judgeAll(rounds)
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
    const testScore = evaluate(train(trainRounds, infoOf, best.config, machines), testRounds, infoOf)
    const slotCounts = [0, 0, 0, 0, 0]
    for (const round of trainRounds) slotCounts[round.picked]++
    const favourite = slotCounts.indexOf(Math.max(...slotCounts))
    const judgeAlone = evaluate({ config: { sets: ['judge'] }, machines, scaling: { mu: [0], sd: [1] }, weights: [1] }, testRounds, infoOf)
    const baseline = {
      random: 0.2,
      favouriteSlot: testRounds.filter((round) => round.picked === favourite).length / testRounds.length,
      favourite: favourite + 1,
      judgeAlone: judgeAlone.accuracy,
    }

    // The model in use: the same choice, refit on every usable round.
    const final = train(usable, infoOf, best.config, machines)
    const picksBySlot = [0, 0, 0, 0, 0]
    for (const round of rounds) picksBySlot[round.picked]++
    const model = {
      trainedAt: new Date().toISOString(),
      reason,
      rounds: rounds.length,
      split: { train: trainRounds.length, test: testRounds.length, examplesOnly: MIN_HISTORY },
      config: best.config,
      cv: best.cv,
      test: testScore,
      baseline,
      picksBySlot,
      tried: results.length,
      ranking: results.slice(0, 5).map((item) => ({ sets: item.config.sets, l2: item.config.l2, cv: item.cv })),
      machines,
      scaling: final.scaling,
      weights: final.weights,
      seconds: Math.round((Date.now() - started) / 1000),
    }
    writeJson(MODEL_PATH, model)
    const past = readJson(HISTORY_PATH, [])
    past.push({ trainedAt: model.trainedAt, reason, rounds: model.rounds, sets: best.config.sets, test: testScore, cv: best.cv, baseline })
    writeJson(HISTORY_PATH, past.slice(-200))
    current = model
    examplesCache = { at: 0, rounds: [] }
    return summary()
  })().finally(() => {
    training = null
  })
  return training
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
let examplesCache = { at: 0, rounds: [] }
async function examples() {
  if (Date.now() - examplesCache.at > 5 * 60 * 1000) {
    examplesCache = { at: Date.now(), rounds: roundsFrom(await readTab()).rounds }
  }
  return examplesCache.rounds
}

// The chance (in whole percent, adding to 100) that this computer's person picks each of the 5.
async function score({ comments, description = '', caption = '', transcript = '', machine }) {
  const model = load()
  if (!model || !Array.isArray(comments) || comments.length !== 5) return null
  const round = { comments: comments.map((text) => String(text || '').trim()), machine, context: [description, caption, transcript].filter(Boolean).join('\n').slice(0, 2500) }
  const sets = model.config.sets
  const past = await examples()
  const [all, mine, vectors] = await Promise.all([
    sets.includes('judge') ? judge(round.comments, round.context, past) : null,
    sets.includes('judgeMine') ? judge(round.comments, round.context, past.filter((item) => item.machine === machine)) : null,
    sets.includes('context') ? embed([...round.comments, round.context]) : null,
  ])
  const info = { judge: { all, mine }, comments: vectors?.slice(0, 5), context: vectors?.[5] }
  return { percent: percentages(probabilities(model, round, info)), model: summary() }
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
    test: model.test,
    cv: model.cv,
    baseline: model.baseline,
    picksBySlot: model.picksBySlot,
    history: readJson(HISTORY_PATH, []).slice(-10).map((item) => ({ trainedAt: item.trainedAt, rounds: item.rounds, accuracy: item.test.accuracy })),
  }
}

module.exports = { retrain, maybeRetrain, startAutoRetrain, score, summary, roundsFrom, percentages }

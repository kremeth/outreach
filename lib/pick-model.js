// Bridge to the local comment ranker (ranker/, Python: Sentence-BERT + an attention network).
// Gemini only writes the 5 comments; everything about ranking them happens on this computer:
//   - the training data is written to data/ranker/dataset.jsonl whenever the training tab is read
//     (reading the Google Sheet is the only network step, and it is not part of the ranker)
//   - training runs locally (python -m ranker.train), every 5 new picks or once a day
//   - predictions come from a local worker (python -m ranker.serve) over stdin/stdout, no sockets
// The ranker itself runs with Hugging Face offline mode on and never needs the network.
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { spawn } = require('child_process')
const writer = require('./sheet-writer')

const ROOT = path.join(__dirname, '..')
const TAB = 'HUSTLING Training Data'
const DATA_DIR = path.join(ROOT, 'data', 'ranker')
const DATASET_PATH = path.join(DATA_DIR, 'dataset.jsonl')
const METRICS_PATH = path.join(DATA_DIR, 'metrics.json')
const CHECKPOINT_PATH = path.join(DATA_DIR, 'checkpoints', 'ranker.pt')
const ENCODER_DIR = path.join(ROOT, 'models', 'sentence_encoder')
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python')
const OFFLINE_ENV = { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', TOKENIZERS_PARALLELISM: 'false' }
const MIN_ROUNDS = 60
const RETRAIN_AFTER_ROUNDS = 5
const RETRAIN_EVERY_MS = 24 * 60 * 60 * 1000
const CHECK_EVERY_MS = 20 * 60 * 1000
const TRAIN_TIMEOUT_MS = 30 * 60 * 1000
const PREDICT_TIMEOUT_MS = 30000

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// Set up: the Python environment and the Sentence-BERT weights are on disk (README: Pick predictor).
function installed() {
  return fs.existsSync(PYTHON) && fs.existsSync(path.join(ENCODER_DIR, 'config.json'))
}

// ---------- the dataset (written locally from the training tab) ----------

async function readTab() {
  await writer.prepare()
  const result = await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!A1:Z`)}`)
  return result.values || []
}

// One line per round that showed 5 comments: picked (picked = 0-4) or all rejected (picked = null).
// A pick that was taken back (undo) is dropped.
function roundsFrom(values) {
  const [header = [], ...lines] = values
  const rows = lines.map((line) => Object.fromEntries(header.map((name, index) => [name, String(line[index] ?? '')])))
  const rounds = []
  for (const row of rows) {
    if (row.Outcome === 'undo pick') {
      const last = rounds.map((round) => round.postId).lastIndexOf(row['Post ID'])
      if (last >= 0 && rounds[last].picked != null) rounds.splice(last, 1)
      continue
    }
    const comments = [1, 2, 3, 4, 5].map((n) => (row[`Comment ${n}`] || '').trim())
    if (comments.some((text) => !text) || !['picked', 'reloaded', 'own comment'].includes(row.Outcome)) continue
    const picked = row.Outcome === 'picked' ? Number(row['Picked #']) - 1 : null
    if (picked != null && !(picked >= 0 && picked < 5)) continue
    rounds.push({
      key: `${row.Time}|${row['Post ID']}`,
      time: row.Time,
      person: row.Machine,
      postId: row['Post ID'],
      comments,
      picked,
      outcome: row.Outcome,
      context: [row['Image description'], row.Caption, row.Transcript].filter(Boolean).join('\n').slice(0, 2500),
    })
  }
  return rounds.sort((a, b) => a.time.localeCompare(b.time))
}

function exportDataset(values) {
  const rounds = roundsFrom(values)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(`${DATASET_PATH}.tmp`, `${rounds.map((round) => JSON.stringify(round)).join('\n')}\n`)
  fs.renameSync(`${DATASET_PATH}.tmp`, DATASET_PATH)
  return rounds.filter((round) => round.picked != null).length
}

// ---------- training (local, in its own process) ----------

let training = null

function runPython(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, { cwd: ROOT, env: { ...process.env, ...OFFLINE_ENV }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`ranker exited with ${code}: ${stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`))
    })
  })
}

async function retrain(reason = 'manual') {
  if (training) return training
  training = (async () => {
    if (!installed()) throw new Error('The local ranker is not set up yet (README: Pick predictor).')
    const picked = exportDataset(await readTab())
    if (picked < MIN_ROUNDS) throw new Error(`Only ${picked} picked rounds so far; the ranker needs ${MIN_ROUNDS}.`)
    console.log(`pick ranker: training locally (${reason}, ${picked} rounds)`)
    await runPython(['-m', 'ranker.train'], TRAIN_TIMEOUT_MS)
    return summary()
  })().finally(() => {
    training = null
  })
  return training
}

// Keeps the local dataset fresh (it is also the ranker's memory of recent picks) and retrains when
// 5 new picks came in, or once a day. Checked on start and every 20 minutes.
async function maybeRetrain() {
  try {
    if (!installed()) return
    const picked = exportDataset(await readTab())
    const metrics = readJson(METRICS_PATH, null)
    const due = !metrics || picked - (metrics.rounds || 0) >= RETRAIN_AFTER_ROUNDS || Date.now() - Date.parse(metrics.trainedAt) > RETRAIN_EVERY_MS
    if (due && picked >= MIN_ROUNDS) await retrain(metrics ? `${picked - metrics.rounds} new rounds` : 'first training')
  } catch (error) {
    console.error('pick ranker', error.message)
  }
}

function startAutoRetrain() {
  setTimeout(maybeRetrain, 60 * 1000).unref()
  setInterval(maybeRetrain, CHECK_EVERY_MS).unref()
}

// ---------- predictions (a local worker that keeps the model loaded) ----------

let worker = null

function startWorker() {
  const child = spawn(PYTHON, ['-m', 'ranker.serve'], { cwd: ROOT, env: { ...process.env, ...OFFLINE_ENV }, stdio: ['pipe', 'pipe', 'ignore'] })
  const state = { child, nextId: 1, pending: new Map() }
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const waiting = state.pending.get(message.id)
    if (!waiting) return
    state.pending.delete(message.id)
    if (message.error) waiting.reject(new Error(message.error))
    else waiting.resolve(message)
  })
  const fail = (error) => {
    for (const waiting of state.pending.values()) waiting.reject(error)
    state.pending.clear()
    if (worker === state) worker = null
  }
  child.on('exit', () => fail(new Error('The local ranker stopped.')))
  child.on('error', fail)
  return state
}

function ask(request) {
  if (!worker) worker = startWorker()
  const state = worker
  const id = state.nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id)
      reject(new Error('The local ranker took too long.'))
    }, PREDICT_TIMEOUT_MS)
    state.pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    state.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`)
  })
}

// The chance (whole percent, adding to 100) that this computer's person picks each of the 5.
async function score({ comments, description = '', caption = '', transcript = '', machine }) {
  if (!installed() || !fs.existsSync(CHECKPOINT_PATH) || !Array.isArray(comments) || comments.length !== 5) return null
  const context = [description, caption, transcript].filter(Boolean).join('\n').slice(0, 2500)
  const result = await ask({ comments, context, person: machine })
  return { percent: result.percentages, probabilities: result.probabilities, best: result.best_index, judge: null, model: summary() }
}

function summary() {
  const metrics = readJson(METRICS_PATH, null)
  if (!metrics || !fs.existsSync(CHECKPOINT_PATH)) return { ready: false, training: Boolean(training), installed: installed() }
  return { ready: true, training: Boolean(training), engine: 'local: Sentence-BERT + attention network (PyTorch)', ...metrics }
}

module.exports = { retrain, maybeRetrain, startAutoRetrain, score, summary, roundsFrom }

// Trains the attention network. Runs in its own process (see pick-model.js), because training keeps
// the CPU busy for a while and the server must stay responsive.
//
// Protocol, the same split and folds as the logit model:
//   1. Model search: for each setting in GRID, 5-fold cross-validation on the training split, scoring
//      the held-out fold after every epoch. The setting and epoch count with the lowest cross-validated
//      log-loss win (the same yardstick the logit model is chosen by, so the two can be compared).
//   2. Train that on the whole training split; score it on the training split and on the test split
//      (the newest rounds, never seen).
//   3. The model in use: the same recipe trained on every usable round.
const ag = require('./autograd')
const net = require('./pick-net')

const DEFAULTS = { d: 16, heads: 2, selfBlocks: 2, crossBlocks: 2, ffMult: 2, drop: 0.3, rate: 0.002, decay: 0.1, batch: 16, maxEpochs: 25, seeds: 3, warmStart: true }
// Kept small on purpose: with ~100 training rounds a big network only memorises.
const GRID = [
  { d: 16, drop: 0.3, decay: 0.1, rate: 0.002 },
  { d: 24, drop: 0.3, decay: 0.3, rate: 0.001 },
  { d: 8, drop: 0.2, decay: 0.1, rate: 0.003 },
]

function tensors(example) {
  const rows = (list) => (list.length ? ag.Tensor.from(list) : new ag.Tensor(new Float64Array(0), 0, 0))
  return { cand: rows(example.cand), ctx: rows(example.ctx), mem: rows(example.mem), wide: rows(example.wide), picked: example.picked, machine: example.machine }
}

function shuffle(list, random) {
  const out = list.slice()
  for (let index = out.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[out[index], out[other]] = [out[other], out[index]]
  }
  return out
}

function logLoss(probs, picked) {
  return -Math.log(Math.max(1e-9, probs[picked]))
}

// Trains one network per seed; calls watch(epoch, nets) after every epoch.
function trainEnsemble(train, dims, hp, epochs, watch) {
  const runs = []
  for (let s = 0; s < hp.seeds; s++) {
    const model = net.createNet(dims, hp, 101 + s)
    const params = Object.values(model.params)
    const optimiser = new ag.AdamW(params, { rate: hp.rate, decay: hp.decay })
    runs.push({ model, optimiser, random: ag.rng(9001 + s) })
  }
  if (watch) watch(0, runs.map((run) => run.model))
  for (let epoch = 1; epoch <= epochs; epoch++) {
    for (const run of runs) {
      const order = shuffle(train, run.random)
      for (let start = 0; start < order.length; start += hp.batch) {
        const batch = order.slice(start, start + hp.batch)
        run.optimiser.zero()
        const losses = batch.map((example) => ag.crossEntropy(net.forward(run.model, example, { drop: hp.drop, random: run.random }), example.picked).loss)
        ag.sum(losses).backward()
        run.optimiser.update(1 / batch.length)
      }
    }
    if (watch) watch(epoch, runs.map((run) => run.model))
  }
  return runs.map((run) => run.model)
}

function score(models, examples) {
  let correct = 0
  let top2 = 0
  let loss = 0
  const byMachine = {}
  for (const example of examples) {
    const probs = net.probabilities(models, example)
    const order = probs.map((p, index) => [p, index]).sort((a, b) => b[0] - a[0]).map(([, index]) => index)
    const hit = order[0] === example.picked
    if (hit) correct++
    if (order.slice(0, 2).includes(example.picked)) top2++
    loss += logLoss(probs, example.picked)
    const mine = (byMachine[example.machine] ||= { rounds: 0, correct: 0 })
    mine.rounds++
    if (hit) mine.correct++
  }
  const n = Math.max(1, examples.length)
  return { accuracy: correct / n, top2: top2 / n, logLoss: loss / n, rounds: examples.length, byMachine }
}

// dataset: { dims, train, test, all, folds } (examples as plain arrays; folds[i] = fold of train[i])
function run(dataset, overrides = {}) {
  const started = Date.now()
  const train = dataset.train.map(tensors)
  const test = dataset.test.map(tensors)
  const all = dataset.all.map(tensors)
  const folds = dataset.folds
  const foldCount = Math.max(...folds) + 1

  // 1. Model search by cross-validation.
  const searched = []
  for (const setting of overrides.grid || GRID) {
    const hp = { ...DEFAULTS, ...setting, ...(overrides.hp || {}) }
    const perEpoch = Array.from({ length: hp.maxEpochs + 1 }, () => ({ loss: 0, correct: 0, top2: 0 }))
    for (let fold = 0; fold < foldCount; fold++) {
      const inner = train.filter((_, index) => folds[index] !== fold)
      const held = train.filter((_, index) => folds[index] === fold)
      trainEnsemble(inner, dataset.dims, hp, hp.maxEpochs, (epoch, models) => {
        const result = score(models, held)
        perEpoch[epoch].loss += result.logLoss * held.length
        perEpoch[epoch].correct += result.accuracy * held.length
        perEpoch[epoch].top2 += result.top2 * held.length
      })
    }
    const curve = perEpoch.map((point, index) => ({ epoch: index, logLoss: point.loss / train.length, accuracy: point.correct / train.length, top2: point.top2 / train.length }))
    const best = curve.reduce((a, b) => (b.logLoss < a.logLoss ? b : a))
    searched.push({ hp, epochs: best.epoch, cv: { logLoss: best.logLoss, accuracy: best.accuracy, top2: best.top2 }, curve })
  }
  searched.sort((a, b) => a.cv.logLoss - b.cv.logLoss)
  const { hp, epochs, cv } = searched[0]

  // 2. Train on the whole training split, score on train and test.
  const chosen = trainEnsemble(train, dataset.dims, hp, epochs)
  const trainScore = score(chosen, train)
  const testScore = score(chosen, test)

  // 3. Train on everything for use.
  const final = trainEnsemble(all, dataset.dims, hp, epochs)
  return {
    hp,
    epochs,
    cv,
    searched: searched.map((item) => ({ hp: item.hp, epochs: item.epochs, cv: item.cv, curve: item.curve.map((point) => Math.round(point.logLoss * 1000) / 1000) })),
    trainScore,
    test: testScore,
    params: net.countParams(final[0]),
    nets: final.map(net.serialise),
    seconds: Math.round((Date.now() - started) / 1000),
  }
}

// As a child process: receives the dataset, sends back the result.
if (require.main === module) {
  process.on('message', (message) => {
    try {
      process.send({ ok: true, result: run(message.dataset, message.overrides) })
    } catch (error) {
      process.send({ ok: false, error: error.stack || error.message })
    }
  })
}

module.exports = { run, score, tensors, DEFAULTS, GRID }

// Turns rounds (5 comments, the post, the pick) into the attention network's inputs:
//   cand  [5, PCA + plain]  each comment's meaning (Gemini embedding, PCA-reduced) + plain features
//   ctx   [1, PCA + 1]      the post's meaning (+ whether there was one)
//   mem   [≤60, PCA + 3]    the 12 rounds before this one: picked and passed-over comments, flagged
//                           picked / same computer / how recent
//   wide  [5, plain]        plain features for the linear head: judge scores, slot, style
// Memory only ever holds earlier rounds, so the network can't see the answer.
const PCA_DIMS = 24
const MEMORY_ROUNDS = 12

const EMOJI = /\p{Extended_Pictographic}/gu

function style(text) {
  const emojis = (text.match(EMOJI) || []).length
  const letters = text.replace(/[^\p{L}]/gu, '')
  return [
    Math.log(1 + text.length),
    text.split(/\s+/).filter(Boolean).length,
    emojis ? 1 : 0,
    /!/.test(text) ? 1 : 0,
    /^\p{Lu}/u.test(text) ? 1 : 0,
    letters && letters === letters.toLowerCase() ? 1 : 0,
    /\b(haha+|lol|lmao)\b/i.test(text) ? 1 : 0,
  ]
}

const logScore = (value) => Math.log(Math.max(0.02, value ?? 0.2))

// Top principal components by power iteration with deflation (no labels involved).
function pca(vectors, dims = PCA_DIMS) {
  const size = vectors[0].length
  const mean = new Array(size).fill(0)
  for (const vector of vectors) for (let i = 0; i < size; i++) mean[i] += vector[i] / vectors.length
  const centred = vectors.map((vector) => vector.map((value, i) => value - mean[i]))
  const components = []
  let seed = 11
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5 }
  for (let c = 0; c < dims; c++) {
    let v = Array.from({ length: size }, random)
    for (let iteration = 0; iteration < 60; iteration++) {
      const next = new Array(size).fill(0)
      for (const x of centred) {
        let dot = 0
        for (let i = 0; i < size; i++) dot += x[i] * v[i]
        for (let i = 0; i < size; i++) next[i] += dot * x[i]
      }
      for (const prior of components) {
        let dot = 0
        for (let i = 0; i < size; i++) dot += next[i] * prior[i]
        for (let i = 0; i < size; i++) next[i] -= dot * prior[i]
      }
      const length = Math.hypot(...next) || 1
      v = next.map((value) => value / length)
    }
    components.push(v)
  }
  // Scale each component to unit variance over the data.
  const spread = components.map((component) => {
    let total = 0
    for (const x of centred) {
      let dot = 0
      for (let i = 0; i < size; i++) dot += x[i] * component[i]
      total += dot * dot
    }
    return Math.sqrt(total / centred.length) || 1
  })
  return { mean, components, spread }
}

function project(basis, vector) {
  if (!vector) return new Array(basis.components.length).fill(0)
  return basis.components.map((component, c) => {
    let dot = 0
    for (let i = 0; i < component.length; i++) dot += (vector[i] - basis.mean[i]) * component[i]
    return dot / basis.spread[c]
  })
}

// info(round) -> { judge: { all, mine }, comments: [5 vectors], context: vector }
function plain(round, info, index) {
  return [
    logScore(info.judge?.all?.[index]),
    logScore(info.judge?.mine?.[index]),
    ...[1, 2, 3, 4].map((slot) => (index === slot ? 1 : 0)),
    ...style(round.comments[index]),
  ]
}

function standardiser(rows) {
  const size = rows[0].length
  const mu = new Array(size).fill(0)
  const sd = new Array(size).fill(0)
  for (const row of rows) row.forEach((value, i) => { mu[i] += value / rows.length })
  for (const row of rows) row.forEach((value, i) => { sd[i] += (value - mu[i]) ** 2 / rows.length })
  return { mu, sd: sd.map((value) => Math.sqrt(value) || 1) }
}

const standard = (row, s) => row.map((value, i) => (value - s.mu[i]) / s.sd[i])

// Everything needed to turn any round into inputs, learned from `rounds` (no labels used).
function fitInputs(rounds, infoOf) {
  const vectors = []
  for (const round of rounds) {
    const info = infoOf(round)
    for (const vector of info.comments || []) if (vector) vectors.push(vector)
    if (info.context) vectors.push(info.context)
  }
  const basis = pca(vectors)
  const plainRows = rounds.flatMap((round) => round.comments.map((_, index) => plain(round, infoOf(round), index)))
  return { basis, plainScale: standardiser(plainRows) }
}

// The network's inputs for `round`, with `history` = the rounds before it (oldest first).
function inputsFor(round, info, history, historyInfo, fitted) {
  const { basis, plainScale } = fitted
  const plainRows = round.comments.map((_, index) => standard(plain(round, info, index), plainScale))
  const cand = round.comments.map((_, index) => [...project(basis, info.comments?.[index]), ...plainRows[index]])
  const ctx = [[...project(basis, info.context), info.context ? 1 : 0]]
  const recent = history.slice(-MEMORY_ROUNDS)
  const mem = []
  recent.forEach((past, position) => {
    const pastInfo = historyInfo(past)
    const recency = (position + 1) / recent.length
    past.comments.forEach((_, index) => {
      mem.push([...project(basis, pastInfo.comments?.[index]), index === past.picked ? 1 : 0, past.machine === round.machine ? 1 : 0, recency])
    })
  })
  return { cand, ctx, mem, wide: plainRows, picked: round.picked }
}

module.exports = { fitInputs, inputsFor, PCA_DIMS, MEMORY_ROUNDS }

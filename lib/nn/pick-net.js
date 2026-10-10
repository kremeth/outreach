// The pick predictor's attention network. One round = 5 candidate comments, the post they are for,
// and a memory of recent rounds (the comments picked and passed over, before this round only).
//
//   comment tokens [5]  ┐
//   post token     [1]  ┴─ 2 self-attention blocks (comments and post look at each other)
//   comment tokens [5]  ── 2 cross-attention blocks (each comment looks at the memory of past picks)
//   memory tokens  [≤60]┘
//   score = deep head on each comment + wide linear head on its plain features (the logit model's
//           log-probability, judge, slot, style)
//
// Pre-norm transformer blocks (layer norm → multi-head attention → residual, layer norm → feed-forward
// → residual), dropout, and a softmax over the 5 scores. Trained with AdamW; see pick-net-train.js.
const ag = require('./autograd')

function createNet(dims, options = {}, seed = 1) {
  const { cand, ctx, mem, wide } = dims
  const d = options.d || 24
  const heads = options.heads || 2
  const selfBlocks = options.selfBlocks ?? 2
  const crossBlocks = options.crossBlocks ?? 2
  const ff = d * (options.ffMult || 2)
  const random = ag.rng(seed)
  const params = {}
  const p = (name, rows, cols, init) => {
    params[name] = ag.param(rows, cols, random, init)
    if (init === 'ones' || init === 'zeros') params[name].noDecay = true
    return params[name]
  }
  p('cand.W', cand, d); p('cand.b', 1, d, 'zeros')
  p('ctx.W', ctx, d); p('ctx.b', 1, d, 'zeros')
  p('mem.W', mem, d); p('mem.b', 1, d, 'zeros')
  const block = (prefix, cross) => {
    p(`${prefix}.ln1.g`, 1, d, 'ones'); p(`${prefix}.ln1.b`, 1, d, 'zeros')
    if (cross) { p(`${prefix}.lnm.g`, 1, d, 'ones'); p(`${prefix}.lnm.b`, 1, d, 'zeros') }
    for (const name of ['q', 'k', 'v', 'o']) p(`${prefix}.${name}`, d, d)
    p(`${prefix}.ln2.g`, 1, d, 'ones'); p(`${prefix}.ln2.b`, 1, d, 'zeros')
    p(`${prefix}.ff1`, d, ff); p(`${prefix}.ff1b`, 1, ff, 'zeros')
    p(`${prefix}.ff2`, ff, d); p(`${prefix}.ff2b`, 1, d, 'zeros')
  }
  for (let index = 0; index < selfBlocks; index++) block(`self${index}`, false)
  for (let index = 0; index < crossBlocks; index++) block(`cross${index}`, true)
  p('out.ln.g', 1, d, 'ones'); p('out.ln.b', 1, d, 'zeros')
  p('out.W', d, 1)
  p('wide.W', wide, 1, 'zeros')
  params['wide.W'].noDecay = false
  // Warm start: the first wide input is the logit model's log-probability. With weight 1 on it and
  // a silent deep head, the network starts out exactly as the logit model and learns corrections.
  if (options.warmStart) {
    params['wide.W'].data[0] = 1
    params['out.W'].data.fill(0)
  }
  return { params, config: { dims, d, heads, selfBlocks, crossBlocks, ffMult: ff / d } }
}

function attention(net, prefix, queries, keysValues, drop, random) {
  const P = net.params
  const { d, heads } = net.config
  const dh = d / heads
  const q = ag.matmul(queries, P[`${prefix}.q`])
  const k = ag.matmul(keysValues, P[`${prefix}.k`])
  const v = ag.matmul(keysValues, P[`${prefix}.v`])
  const outs = []
  for (let h = 0; h < heads; h++) {
    const qh = ag.sliceCols(q, h * dh, (h + 1) * dh)
    const kh = ag.sliceCols(k, h * dh, (h + 1) * dh)
    const vh = ag.sliceCols(v, h * dh, (h + 1) * dh)
    const weights = ag.dropout(ag.softmaxRows(ag.scale(ag.matmulT(qh, kh), 1 / Math.sqrt(dh))), drop, random)
    outs.push(ag.matmul(weights, vh))
  }
  return ag.matmul(heads > 1 ? ag.concatCols(outs) : outs[0], P[`${prefix}.o`])
}

function feedForward(net, prefix, x, drop, random) {
  const P = net.params
  const hidden = ag.relu(ag.addRow(ag.matmul(x, P[`${prefix}.ff1`]), P[`${prefix}.ff1b`]))
  return ag.addRow(ag.matmul(ag.dropout(hidden, drop, random), P[`${prefix}.ff2`]), P[`${prefix}.ff2b`])
}

// Scores for the 5 comments of a round ([5,1] logits). random/drop only while training.
function forward(net, round, { drop = 0, random = null } = {}) {
  const P = net.params
  const { selfBlocks, crossBlocks } = net.config
  const comments = ag.addRow(ag.matmul(round.cand, P['cand.W']), P['cand.b'])
  const post = ag.addRow(ag.matmul(round.ctx, P['ctx.W']), P['ctx.b'])
  let tokens = ag.concatRows([post, comments])
  for (let index = 0; index < selfBlocks; index++) {
    const prefix = `self${index}`
    const normed = ag.layerNorm(tokens, P[`${prefix}.ln1.g`], P[`${prefix}.ln1.b`])
    tokens = ag.add(tokens, ag.dropout(attention(net, prefix, normed, normed, drop, random), drop, random))
    const normed2 = ag.layerNorm(tokens, P[`${prefix}.ln2.g`], P[`${prefix}.ln2.b`])
    tokens = ag.add(tokens, ag.dropout(feedForward(net, prefix, normed2, drop, random), drop, random))
  }
  let h = ag.sliceRows(tokens, 1, 6)
  if (round.mem && round.mem.rows) {
    const memory = ag.addRow(ag.matmul(round.mem, P['mem.W']), P['mem.b'])
    for (let index = 0; index < crossBlocks; index++) {
      const prefix = `cross${index}`
      const normed = ag.layerNorm(h, P[`${prefix}.ln1.g`], P[`${prefix}.ln1.b`])
      const normedMemory = ag.layerNorm(memory, P[`${prefix}.lnm.g`], P[`${prefix}.lnm.b`])
      h = ag.add(h, ag.dropout(attention(net, prefix, normed, normedMemory, drop, random), drop, random))
      const normed2 = ag.layerNorm(h, P[`${prefix}.ln2.g`], P[`${prefix}.ln2.b`])
      h = ag.add(h, ag.dropout(feedForward(net, prefix, normed2, drop, random), drop, random))
    }
  }
  const deep = ag.matmul(ag.layerNorm(h, P['out.ln.g'], P['out.ln.b']), P['out.W'])
  const wide = ag.matmul(round.wide, P['wide.W'])
  return ag.add(deep, wide)
}

function probabilities(nets, round) {
  const total = [0, 0, 0, 0, 0]
  for (const net of nets) {
    const logits = forward(net, round)
    const top = Math.max(...logits.data)
    const exps = Array.from(logits.data, (value) => Math.exp(value - top))
    const sum = exps.reduce((a, b) => a + b, 0)
    exps.forEach((value, index) => { total[index] += value / sum / nets.length })
  }
  return total
}

function serialise(net) {
  return { config: net.config, params: Object.fromEntries(Object.entries(net.params).map(([name, t]) => [name, { rows: t.rows, cols: t.cols, data: Array.from(t.data, (value) => Math.round(value * 1e7) / 1e7) }])) }
}

function restore(saved) {
  const params = {}
  for (const [name, t] of Object.entries(saved.params)) params[name] = new ag.Tensor(Float64Array.from(t.data), t.rows, t.cols)
  return { config: saved.config, params }
}

function countParams(net) {
  return Object.values(net.params).reduce((sum, t) => sum + t.data.length, 0)
}

module.exports = { createNet, forward, probabilities, serialise, restore, countParams }

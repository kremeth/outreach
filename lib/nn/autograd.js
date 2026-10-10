// A small reverse-mode autograd for 2-D tensors: everything the pick predictor's attention network
// needs, in plain JavaScript (no dependencies, so it runs the same on every computer).
// A Tensor is a row-major Float64Array with a shape [rows, cols]; ops record how to send gradients
// back to their inputs, and backward() walks them in reverse order.

class Tensor {
  constructor(data, rows, cols, parents = [], back = null) {
    this.data = data
    this.rows = rows
    this.cols = cols
    this.grad = null
    this.parents = parents
    this.back = back
  }

  static zeros(rows, cols) {
    return new Tensor(new Float64Array(rows * cols), rows, cols)
  }

  static from(rows2d) {
    const rows = rows2d.length
    const cols = rows2d[0].length
    const data = new Float64Array(rows * cols)
    rows2d.forEach((row, r) => row.forEach((value, c) => { data[r * cols + c] = value }))
    return new Tensor(data, rows, cols)
  }

  ensureGrad() {
    if (!this.grad) this.grad = new Float64Array(this.data.length)
    return this.grad
  }

  // Gradients of this scalar with respect to every tensor that led to it.
  backward() {
    const order = []
    const seen = new Set()
    const visit = (node) => {
      if (seen.has(node)) return
      seen.add(node)
      for (const parent of node.parents) visit(parent)
      order.push(node)
    }
    visit(this)
    this.ensureGrad().fill(1)
    for (let index = order.length - 1; index >= 0; index--) {
      const node = order[index]
      if (node.back && node.grad) node.back(node.grad)
    }
  }
}

const needsGrad = (...nodes) => nodes.some((node) => node.parents.length || node.isParam)

function make(data, rows, cols, parents, back) {
  return needsGrad(...parents) ? new Tensor(data, rows, cols, parents, back) : new Tensor(data, rows, cols)
}

// A [n,k] x B [k,m]
function matmul(A, B) {
  const n = A.rows
  const k = A.cols
  const m = B.cols
  if (B.rows !== k) throw new Error(`matmul shapes ${A.rows}x${A.cols} · ${B.rows}x${B.cols}`)
  const out = new Float64Array(n * m)
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      const a = A.data[i * k + p]
      if (a === 0) continue
      const bRow = p * m
      const oRow = i * m
      for (let j = 0; j < m; j++) out[oRow + j] += a * B.data[bRow + j]
    }
  }
  return make(out, n, m, [A, B], (g) => {
    if (needsGrad(A)) {
      const ga = A.ensureGrad()
      for (let i = 0; i < n; i++) for (let p = 0; p < k; p++) {
        let sum = 0
        for (let j = 0; j < m; j++) sum += g[i * m + j] * B.data[p * m + j]
        ga[i * k + p] += sum
      }
    }
    if (needsGrad(B)) {
      const gb = B.ensureGrad()
      for (let i = 0; i < n; i++) for (let p = 0; p < k; p++) {
        const a = A.data[i * k + p]
        if (a === 0) continue
        for (let j = 0; j < m; j++) gb[p * m + j] += a * g[i * m + j]
      }
    }
  })
}

// A [n,k] x B[m,k]^T -> [n,m]
function matmulT(A, B) {
  const n = A.rows
  const k = A.cols
  const m = B.rows
  if (B.cols !== k) throw new Error('matmulT shapes')
  const out = new Float64Array(n * m)
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    let sum = 0
    for (let p = 0; p < k; p++) sum += A.data[i * k + p] * B.data[j * k + p]
    out[i * m + j] = sum
  }
  return make(out, n, m, [A, B], (g) => {
    if (needsGrad(A)) {
      const ga = A.ensureGrad()
      for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
        const gv = g[i * m + j]
        if (gv === 0) continue
        for (let p = 0; p < k; p++) ga[i * k + p] += gv * B.data[j * k + p]
      }
    }
    if (needsGrad(B)) {
      const gb = B.ensureGrad()
      for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
        const gv = g[i * m + j]
        if (gv === 0) continue
        for (let p = 0; p < k; p++) gb[j * k + p] += gv * A.data[i * k + p]
      }
    }
  })
}

function add(A, B) {
  if (A.rows !== B.rows || A.cols !== B.cols) throw new Error('add shapes')
  const out = new Float64Array(A.data.length)
  for (let i = 0; i < out.length; i++) out[i] = A.data[i] + B.data[i]
  return make(out, A.rows, A.cols, [A, B], (g) => {
    if (needsGrad(A)) { const ga = A.ensureGrad(); for (let i = 0; i < g.length; i++) ga[i] += g[i] }
    if (needsGrad(B)) { const gb = B.ensureGrad(); for (let i = 0; i < g.length; i++) gb[i] += g[i] }
  })
}

// A [n,m] + b [1,m] on every row
function addRow(A, b) {
  const { rows, cols } = A
  const out = new Float64Array(A.data.length)
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out[r * cols + c] = A.data[r * cols + c] + b.data[c]
  return make(out, rows, cols, [A, b], (g) => {
    if (needsGrad(A)) { const ga = A.ensureGrad(); for (let i = 0; i < g.length; i++) ga[i] += g[i] }
    if (needsGrad(b)) { const gb = b.ensureGrad(); for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) gb[c] += g[r * cols + c] }
  })
}

function scale(A, s) {
  const out = A.data.map((value) => value * s)
  return make(out, A.rows, A.cols, [A], (g) => {
    const ga = A.ensureGrad()
    for (let i = 0; i < g.length; i++) ga[i] += g[i] * s
  })
}

function relu(A) {
  const out = A.data.map((value) => (value > 0 ? value : 0))
  return make(out, A.rows, A.cols, [A], (g) => {
    const ga = A.ensureGrad()
    for (let i = 0; i < g.length; i++) if (A.data[i] > 0) ga[i] += g[i]
  })
}

function softmaxRows(A) {
  const { rows, cols } = A
  const out = new Float64Array(A.data.length)
  for (let r = 0; r < rows; r++) {
    let top = -Infinity
    for (let c = 0; c < cols; c++) top = Math.max(top, A.data[r * cols + c])
    let total = 0
    for (let c = 0; c < cols; c++) { const e = Math.exp(A.data[r * cols + c] - top); out[r * cols + c] = e; total += e }
    for (let c = 0; c < cols; c++) out[r * cols + c] /= total
  }
  return make(out, rows, cols, [A], (g) => {
    const ga = A.ensureGrad()
    for (let r = 0; r < rows; r++) {
      let dot = 0
      for (let c = 0; c < cols; c++) dot += g[r * cols + c] * out[r * cols + c]
      for (let c = 0; c < cols; c++) ga[r * cols + c] += out[r * cols + c] * (g[r * cols + c] - dot)
    }
  })
}

// Per-row layer norm with learned gain and bias ([1,cols] each).
function layerNorm(A, gain, bias, eps = 1e-5) {
  const { rows, cols } = A
  const out = new Float64Array(A.data.length)
  const xhat = new Float64Array(A.data.length)
  const inv = new Float64Array(rows)
  for (let r = 0; r < rows; r++) {
    let mean = 0
    for (let c = 0; c < cols; c++) mean += A.data[r * cols + c]
    mean /= cols
    let variance = 0
    for (let c = 0; c < cols; c++) variance += (A.data[r * cols + c] - mean) ** 2
    variance /= cols
    inv[r] = 1 / Math.sqrt(variance + eps)
    for (let c = 0; c < cols; c++) {
      const x = (A.data[r * cols + c] - mean) * inv[r]
      xhat[r * cols + c] = x
      out[r * cols + c] = x * gain.data[c] + bias.data[c]
    }
  }
  return make(out, rows, cols, [A, gain, bias], (g) => {
    const gg = gain.ensureGrad()
    const gbias = bias.ensureGrad()
    const ga = needsGrad(A) ? A.ensureGrad() : null
    for (let r = 0; r < rows; r++) {
      let sumG = 0
      let sumGX = 0
      for (let c = 0; c < cols; c++) {
        const gy = g[r * cols + c]
        gg[c] += gy * xhat[r * cols + c]
        gbias[c] += gy
        const gx = gy * gain.data[c]
        sumG += gx
        sumGX += gx * xhat[r * cols + c]
      }
      if (!ga) continue
      for (let c = 0; c < cols; c++) {
        const gx = g[r * cols + c] * gain.data[c]
        ga[r * cols + c] += (inv[r] / cols) * (cols * gx - sumG - xhat[r * cols + c] * sumGX)
      }
    }
  })
}

function sliceCols(A, start, end) {
  const { rows, cols } = A
  const width = end - start
  const out = new Float64Array(rows * width)
  for (let r = 0; r < rows; r++) for (let c = 0; c < width; c++) out[r * width + c] = A.data[r * cols + start + c]
  return make(out, rows, width, [A], (g) => {
    const ga = A.ensureGrad()
    for (let r = 0; r < rows; r++) for (let c = 0; c < width; c++) ga[r * cols + start + c] += g[r * width + c]
  })
}

function sliceRows(A, start, end) {
  const { cols } = A
  const out = A.data.slice(start * cols, end * cols)
  return make(out, end - start, cols, [A], (g) => {
    const ga = A.ensureGrad()
    for (let i = 0; i < g.length; i++) ga[start * cols + i] += g[i]
  })
}

function concatCols(list) {
  const rows = list[0].rows
  const cols = list.reduce((sum, item) => sum + item.cols, 0)
  const out = new Float64Array(rows * cols)
  let offset = 0
  const offsets = list.map((item) => { const at = offset; offset += item.cols; return at })
  list.forEach((item, index) => {
    for (let r = 0; r < rows; r++) for (let c = 0; c < item.cols; c++) out[r * cols + offsets[index] + c] = item.data[r * item.cols + c]
  })
  return make(out, rows, cols, list, (g) => {
    list.forEach((item, index) => {
      if (!needsGrad(item)) return
      const gi = item.ensureGrad()
      for (let r = 0; r < rows; r++) for (let c = 0; c < item.cols; c++) gi[r * item.cols + c] += g[r * cols + offsets[index] + c]
    })
  })
}

function concatRows(list) {
  const cols = list[0].cols
  const rows = list.reduce((sum, item) => sum + item.rows, 0)
  const out = new Float64Array(rows * cols)
  let offset = 0
  const offsets = list.map((item) => { const at = offset; offset += item.data.length; out.set(item.data, at); return at })
  return make(out, rows, cols, list, (g) => {
    list.forEach((item, index) => {
      if (!needsGrad(item)) return
      const gi = item.ensureGrad()
      for (let i = 0; i < item.data.length; i++) gi[i] += g[offsets[index] + i]
    })
  })
}

// Inverted dropout; a no-op outside training.
function dropout(A, p, random) {
  if (!p || !random) return A
  const keep = 1 - p
  const mask = new Float64Array(A.data.length)
  const out = new Float64Array(A.data.length)
  for (let i = 0; i < out.length; i++) {
    mask[i] = random() < keep ? 1 / keep : 0
    out[i] = A.data[i] * mask[i]
  }
  return make(out, A.rows, A.cols, [A], (g) => {
    const ga = A.ensureGrad()
    for (let i = 0; i < g.length; i++) ga[i] += g[i] * mask[i]
  })
}

// Cross-entropy of a column of logits [n,1] against the index that was picked. Returns [1,1] and the probabilities.
function crossEntropy(logits, target) {
  const n = logits.rows
  let top = -Infinity
  for (let i = 0; i < n; i++) top = Math.max(top, logits.data[i])
  const probs = new Float64Array(n)
  let total = 0
  for (let i = 0; i < n; i++) { probs[i] = Math.exp(logits.data[i] - top); total += probs[i] }
  for (let i = 0; i < n; i++) probs[i] /= total
  const loss = -Math.log(Math.max(1e-12, probs[target]))
  const out = make(new Float64Array([loss]), 1, 1, [logits], (g) => {
    const gl = logits.ensureGrad()
    for (let i = 0; i < n; i++) gl[i] += g[0] * (probs[i] - (i === target ? 1 : 0))
  })
  return { loss: out, probs }
}

function sum(list) {
  const total = list.reduce((acc, item) => acc + item.data[0], 0)
  return make(new Float64Array([total]), 1, 1, list, (g) => {
    for (const item of list) if (needsGrad(item)) item.ensureGrad()[0] += g[0]
  })
}

// ---------- parameters and AdamW ----------

// Deterministic random numbers (mulberry32), so a training run can be repeated exactly.
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(random) {
  const u = Math.max(1e-12, random())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
}

function param(rows, cols, random, init = 'xavier') {
  const t = Tensor.zeros(rows, cols)
  t.isParam = true
  if (init === 'ones') t.data.fill(1)
  else if (init === 'xavier') {
    const std = Math.sqrt(2 / (rows + cols))
    for (let i = 0; i < t.data.length; i++) t.data[i] = gaussian(random) * std
  }
  return t
}

class AdamW {
  constructor(params, { rate = 0.003, decay = 0.01, beta1 = 0.9, beta2 = 0.999 } = {}) {
    this.params = params
    this.rate = rate
    this.decay = decay
    this.beta1 = beta1
    this.beta2 = beta2
    this.step = 0
    this.m = params.map((p) => new Float64Array(p.data.length))
    this.v = params.map((p) => new Float64Array(p.data.length))
  }

  zero() {
    for (const p of this.params) if (p.grad) p.grad.fill(0)
  }

  update(scaleBy = 1) {
    this.step++
    const c1 = 1 - this.beta1 ** this.step
    const c2 = 1 - this.beta2 ** this.step
    this.params.forEach((p, index) => {
      if (!p.grad) return
      const m = this.m[index]
      const v = this.v[index]
      const decays = !p.noDecay
      for (let i = 0; i < p.data.length; i++) {
        const g = p.grad[i] * scaleBy
        m[i] = this.beta1 * m[i] + (1 - this.beta1) * g
        v[i] = this.beta2 * v[i] + (1 - this.beta2) * g * g
        if (decays) p.data[i] -= this.rate * this.decay * p.data[i]
        p.data[i] -= (this.rate * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + 1e-8)
      }
    })
  }
}

module.exports = {
  Tensor, matmul, matmulT, add, addRow, scale, relu, softmaxRows, layerNorm, sliceCols, sliceRows,
  concatCols, concatRows, dropout, crossEntropy, sum, rng, param, AdamW,
}

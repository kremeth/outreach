const track = document.getElementById('track')
const kicker = document.getElementById('kicker')
const nameEl = document.getElementById('name')
const meta = document.getElementById('meta')
const notes = document.getElementById('notes')
const status = document.getElementById('status')
const stage = document.getElementById('stage')
const question = document.getElementById('q')
const reviewActions = document.getElementById('review-actions')
const deviceActions = document.getElementById('device-actions')
const noButton = document.getElementById('no')
const yesButton = document.getElementById('yes')
const prevButton = document.getElementById('prev')
const undoButton = document.getElementById('undo')
const fileLink = document.getElementById('fileline')
const keys = document.getElementById('keys')

const PREFETCH_AHEAD = 4
const PRELOAD_PHOTOS = 3
const REFILL_BELOW = 6

let config = { mediaBase: '', yesPath: '', sheetUrl: '' }
let counts = { total: 0, yesCount: 0, toSend: 0, remaining: 0, yesToday: 0, yesTarget: 30 }
let queue = []
let history = []
let people = []
let mode = 'away'
let askingDevice = false
let devices = []
let refilling = null
let saveError = ''
let writeNote = ''
let loadError = ''
const profiles = new Map()
const saving = new Map()
let markReady
const ready = new Promise((resolve) => { markReady = resolve })

function pillClass(ranking) {
  const value = String(ranking || '').toLowerCase()
  if (value === 'good') return 'pill good'
  if (value === 'fair') return 'pill fair'
  return 'pill'
}

async function api(path, body, timeoutMs = 45000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch {
    const error = new Error('The review server is not reachable.')
    error.kind = 'network'
    throw error
  } finally {
    clearTimeout(timer)
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || 'Request failed')
    error.kind = payload.kind || (response.status >= 500 ? 'server' : 'error')
    throw error
  }
  return payload
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const RETRYABLE = new Set(['network', 'server', 'timeout', 'read', 'login', 'error'])

async function withRetries(task, delays) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task()
    } catch (error) {
      if (attempt >= delays.length || !RETRYABLE.has(error.kind)) throw error
      await wait(delays[attempt])
    }
  }
}

function mediaUrl(src) {
  return `${config.mediaBase}/media?src=${encodeURIComponent(src)}`
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function loadProfile(username, urgent) {
  const known = profiles.get(username)
  if (known && known.status !== 'error') {
    if (urgent && known.status === 'loading' && !known.urgent) {
      known.urgent = true
      fetch(`/api/preview?u=${encodeURIComponent(username)}&now=1`).catch(() => {})
    }
    return known.promise
  }
  const entry = { status: 'loading', urgent: !!urgent, data: null, error: null }
  entry.promise = withRetries(
    () => api(`/api/preview?u=${encodeURIComponent(username)}${entry.urgent ? '&now=1' : ''}`),
    [600, 1500, 3000],
  )
    .then((profile) => {
      entry.status = 'ready'
      entry.data = profile
      return profile
    })
    .catch((error) => {
      entry.status = 'error'
      entry.error = error
      throw error
    })
  profiles.set(username, entry)
  return entry.promise
}

function preloadImages(profile) {
  if (profile.avatar) new Image().src = mediaUrl(profile.avatar)
  for (const photo of (profile.images || []).slice(0, PRELOAD_PHOTOS)) {
    const image = new Image()
    image.decoding = 'async'
    image.src = mediaUrl(photo.src)
  }
}

function prefetchAhead() {
  for (const item of queue.slice(1, 1 + PREFETCH_AHEAD)) {
    if (!item.username) continue
    loadProfile(item.username, false).then(preloadImages).catch(() => {})
  }
}

function refill() {
  if (refilling || queue.length >= REFILL_BELOW) return refilling
  const last = queue[queue.length - 1] || history[history.length - 1]?.item
  const from = last ? last.index : -1
  refilling = api(`/api/queue?from=${from}`)
    .then((payload) => {
      const present = new Set(queue.map((item) => item.sheetRow))
      for (const item of payload.queue || []) {
        if (present.has(item.sheetRow) || saving.has(item.sheetRow)) continue
        queue.push(item)
        present.add(item.sheetRow)
      }
      if (!saving.size) counts = takeCounts(payload)
      renderChrome()
      prefetchAhead()
      if (!queue.length) show()
    })
    .catch(() => {
      setTimeout(refill, 2000)
    })
    .finally(() => {
      refilling = null
    })
  return refilling
}

function renderMeta(current) {
  meta.replaceChildren()
  const bits = []
  if (current.username) bits.push(`@${current.username}`)
  if (current.followers) bits.push(`${current.followers} followers`)
  if (current.location) bits.push(current.location)
  if (current.engagement) bits.push(current.engagement)
  if (current.email) bits.push(current.email)
  meta.append(document.createTextNode(bits.join(' · ')))
  if (current.ranking) meta.append(el('span', pillClass(current.ranking), current.ranking))
}

function takeCounts(payload) {
  return {
    total: payload.total,
    yesCount: payload.yesCount,
    toSend: payload.toSend,
    remaining: payload.remaining,
    yesToday: payload.yesToday ?? counts.yesToday,
    yesTarget: payload.yesTarget || counts.yesTarget,
  }
}

function renderTrack() {
  track.hidden = mode !== 'review'
  track.replaceChildren()
  const bar = el('div', 'meter')
  const fill = el('div', 'meter-fill')
  const done = Math.max(0, counts.total - counts.remaining)
  fill.style.width = counts.total ? `${(done / counts.total) * 100}%` : '0%'
  bar.append(fill)
  track.append(bar)
}

function renderStatus() {
  status.replaceChildren()
  const yes = el('div', counts.yesToday >= counts.yesTarget ? 'yes-today done' : 'yes-today', `${counts.yesToday} / ${counts.yesTarget} yes today`)
  status.append(yes, el('div', '', counts.remaining ? `${counts.remaining} left` : 'All reviewed'))
  const warning = offlineNote() || saveError || writeNote || loadError
  if (warning) status.append(el('div', 'warn', warning))
}

function renderChrome() {
  renderTrack()
  renderStatus()
  fileLink.textContent = 'Sheet'
  if (config.sheetUrl) {
    fileLink.href = config.sheetUrl
    fileLink.target = '_blank'
    fileLink.rel = 'noreferrer'
  }
  const canGoBack = mode === 'review' && history.length > 0
  prevButton.disabled = !canGoBack
  undoButton.disabled = !canGoBack
}

function closeZoom() {
  document.getElementById('zoom')?.remove()
}

function openZoom(src, alt, placeholder) {
  closeZoom()
  const layer = el('div', 'zoom')
  layer.id = 'zoom'
  const image = document.createElement('img')
  image.src = placeholder || src
  image.alt = alt || ''
  if (placeholder && placeholder !== src) {
    const full = new Image()
    full.onload = () => {
      if (image.isConnected) image.src = src
    }
    full.src = src
  }
  layer.append(image)
  document.body.append(layer)
  makeZoomable(layer, image)
}

// Zoom only by trackpad pinch (a wheel event with ctrlKey), toward the cursor; two-finger scroll or
// dragging pans once zoomed. Any click closes the viewer (Esc too), except the end of a drag.
function makeZoomable(layer, image) {
  const MAX = 8
  let scale = 1
  let x = 0
  let y = 0
  let drag = null
  let moved = false

  function apply() {
    if (scale <= 1.001) {
      scale = 1
      x = 0
      y = 0
    }
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    layer.classList.toggle('zoomed', scale > 1)
  }

  // Keeps the point under the cursor fixed while the scale changes.
  function zoomAt(clientX, clientY, next) {
    next = Math.min(MAX, Math.max(1, next))
    const rect = image.getBoundingClientRect()
    const originX = rect.left + rect.width / 2 - x
    const originY = rect.top + rect.height / 2 - y
    const ratio = next / scale
    x = (clientX - originX) - (clientX - originX - x) * ratio
    y = (clientY - originY) - (clientY - originY - y) * ratio
    scale = next
    apply()
  }

  layer.addEventListener('wheel', (event) => {
    event.preventDefault()
    if (event.ctrlKey) {
      zoomAt(event.clientX, event.clientY, scale * Math.exp(-event.deltaY * 0.01))
    } else if (scale > 1) {
      x -= event.deltaX
      y -= event.deltaY
      apply()
    }
  }, { passive: false })

  image.addEventListener('pointerdown', (event) => {
    if (scale <= 1) return
    drag = { startX: event.clientX, startY: event.clientY, x, y }
    moved = false
    image.setPointerCapture(event.pointerId)
  })
  image.addEventListener('pointermove', (event) => {
    if (!drag) return
    if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 3) moved = true
    x = drag.x + event.clientX - drag.startX
    y = drag.y + event.clientY - drag.startY
    apply()
  })
  image.addEventListener('pointerup', () => { drag = null })
  image.addEventListener('dragstart', (event) => event.preventDefault())

  layer.addEventListener('click', () => {
    if (moved) {
      moved = false
      return
    }
    closeZoom()
  })
}

function skeleton() {
  const wrap = el('div', 'skeleton')
  const head = el('div', 'ig-head')
  head.append(el('div', 'sk sk-avatar'))
  const lines = el('div', 'sk-lines')
  lines.append(el('div', 'sk sk-line wide'), el('div', 'sk sk-line'), el('div', 'sk sk-line mid'))
  head.append(lines)
  wrap.append(head, el('div', 'sk sk-photo'), el('div', 'sk sk-photo'))
  return wrap
}

function problem(message, username) {
  const box = el('div', 'preview-problem')
  box.append(el('p', '', message))
  const retry = el('button', 'retry', 'Try again')
  retry.type = 'button'
  retry.addEventListener('click', () => {
    profiles.delete(username)
    renderStage()
  })
  box.append(retry)
  return box
}

function feed(profile, username) {
  const fragment = document.createDocumentFragment()
  const head = el('div', 'ig-head')
  if (profile.avatar) {
    const ring = el('div', 'ig-ring')
    const avatar = document.createElement('img')
    avatar.src = mediaUrl(profile.avatar)
    avatar.alt = ''
    ring.append(avatar)
    head.append(ring)
  }
  const copy = el('div')
  copy.append(el('div', 'ig-handle', profile.username || username))
  if (profile.name) copy.append(el('div', 'ig-name', profile.name))
  copy.append(el('div', 'ig-stats', [profile.followers, profile.following].filter(Boolean).join(' · ')))
  head.append(copy)
  if (profile.bio) head.append(el('p', 'ig-bio', profile.bio))
  fragment.append(head)
  const photos = profile.images || []
  photos.forEach((photo, position) => {
    const button = el('button', 'ig-post')
    button.type = 'button'
    const image = document.createElement('img')
    image.alt = photo.alt || ''
    if (photo.width && photo.height) {
      image.width = photo.width
      image.height = photo.height
    }
    image.loading = position < PRELOAD_PHOTOS ? 'eager' : 'lazy'
    image.decoding = 'async'
    image.src = mediaUrl(photo.src)
    button.append(image)
    // The small image is only a stand-in while the full one loads, and only if it has the same shape.
    const sameShape = !photo.fullWidth || !photo.width || Math.abs((photo.width / photo.height) / (photo.fullWidth / photo.fullHeight) - 1) < 0.02
    button.addEventListener('click', () => openZoom(mediaUrl(photo.full || photo.src), photo.alt, sameShape ? image.src : ''))
    fragment.append(button)
  })
  if (!photos.length) {
    fragment.append(el('p', 'preview-wait', profile.private ? 'This account is private.' : 'No photos on this profile.'))
  }
  return fragment
}

function releaseImages(root) {
  for (const image of root.querySelectorAll('img')) image.removeAttribute('src')
}

function renderStage() {
  const current = queue[0]
  releaseImages(stage)
  closeZoom()
  const card = el('div', 'feed-card')
  const scroller = el('div', 'preview-scroll')
  card.append(scroller)
  stage.replaceChildren(card)
  if (!current) return
  if (!current.username) {
    scroller.append(problem('No Instagram username on this row.', ''))
    return
  }
  const username = current.username
  const known = profiles.get(username)
  if (known && known.status === 'ready') {
    scroller.append(feed(known.data, username))
    prefetchAhead()
    return
  }
  scroller.append(skeleton())
  loadProfile(username, true)
    .then((profile) => {
      if (queue[0] !== current || !scroller.isConnected) return
      scroller.replaceChildren(feed(profile, username))
    })
    .catch((error) => {
      if (queue[0] !== current || !scroller.isConnected) return
      scroller.replaceChildren(problem(error.message || 'Could not load this profile.', username))
    })
    .finally(prefetchAhead)
}

function renderHeader() {
  const current = queue[0]
  if (!current) {
    kicker.textContent = 'Prospecting'
    nameEl.textContent = loadError ? 'Could not load the sheet' : 'Everyone is reviewed'
    meta.replaceChildren()
    notes.textContent = ''
    noButton.disabled = true
    yesButton.disabled = true
    return
  }
  kicker.textContent = `Prospecting · row ${current.sheetRow}`
  nameEl.textContent = current.name
  renderMeta(current)
  notes.textContent = current.notes
  noButton.disabled = false
  yesButton.disabled = false
  noButton.classList.toggle('picked', current.choice === 'no')
  yesButton.classList.toggle('picked', current.choice === 'yes')
}

function renderDevices() {
  deviceActions.replaceChildren()
  for (const name of devices) {
    const button = el('button', '', name)
    button.type = 'button'
    button.addEventListener('click', () => choose('yes', name))
    deviceActions.append(button)
  }
}

function renderMode() {
  const asking = mode === 'review' && askingDevice
  question.textContent = asking ? 'Which device?' : 'Keep this profile?'
  reviewActions.hidden = asking
  deviceActions.hidden = !asking
}

function show() {
  if (mode !== 'review') return
  renderMode()
  renderHeader()
  renderChrome()
  renderStage()
}

// Called by the router in tasks.js when the Prospecting screen opens or closes.
function enterProspecting() {
  askingDevice = false
  mode = 'review'
  show()
}

function leaveProspecting() {
  askingDevice = false
  mode = 'away'
  closeZoom()
}

function adjustCounts(item, choice) {
  if (!item.choice) counts.remaining = Math.max(0, counts.remaining - 1)
  if (item.choice === 'yes' && choice !== 'yes') {
    counts.yesCount = Math.max(0, counts.yesCount - 1)
    counts.yesToday = Math.max(0, counts.yesToday - 1)
    if ((item.status || 'to-send') === 'to-send') counts.toSend = Math.max(0, counts.toSend - 1)
  }
  if (item.choice !== 'yes' && choice === 'yes') {
    counts.yesCount++
    counts.yesToday++
    counts.toSend++
  }
}

function updatePeople(item, choice, device) {
  people = people.filter((person) => person.sheetRow !== item.sheetRow)
  if (choice === 'yes') {
    people.push({
      ...item,
      choice: 'yes',
      device: device || item.device || '',
      accepted: item.accepted || 'Not messaged',
      voice: item.voice || '',
      voiceDate: item.voiceDate || '',
      status: item.status && item.status !== 'needs-device' ? item.status : 'to-send',
    })
  }
}

const OUTBOX_KEY = 'voicenote-outbox'
let offlineSince = 0

function persistOutbox() {
  try {
    const list = [...saving.values()].map(({ item, choice, device }) => ({ item, choice, device }))
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(list))
  } catch {}
}

function readOutbox() {
  try {
    const list = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]')
    return Array.isArray(list) ? list.filter((entry) => entry && entry.item && entry.item.sheetRow) : []
  } catch {
    return []
  }
}

function sameSave(item, choice, device) {
  const pending = saving.get(item.sheetRow)
  return pending && pending.choice === choice && pending.device === (device || '')
}

function offlineNote() {
  if (!offlineSince || Date.now() - offlineSince < 4000 || !saving.size) return ''
  const count = saving.size
  return `Not saved yet: ${count} ${count === 1 ? 'answer is' : 'answers are'} waiting and will save automatically.`
}

function save(item, choice, device) {
  saving.set(item.sheetRow, { item, choice, device: device || '', attempt: 0 })
  persistOutbox()
  send(item, choice, device)
}

function send(item, choice, device) {
  if (!sameSave(item, choice, device)) return
  api('/api/decide', { sheetRow: item.sheetRow, choice, device: device || '', link: item.link || '' }, 20000)
    .then((result) => {
      if (!sameSave(item, choice, device)) return
      if (!result.ok) {
        const error = new Error(result.error || 'Could not save.')
        error.kind = 'taken'
        throw error
      }
      saving.delete(item.sheetRow)
      persistOutbox()
      offlineSince = 0
      writeNote = result.writeNote || ''
      if (!saving.size) {
        counts = takeCounts(result)
        saveError = ''
      }
      renderChrome()
    })
    .catch((error) => {
      if (!sameSave(item, choice, device)) return
      // A definite no from the server (someone else decided it, or the row changed): drop it. Nothing
      // was written, and the profile never comes back as "next again".
      if (error.kind === 'taken') {
        saving.delete(item.sheetRow)
        persistOutbox()
        history = history.filter((entry) => entry.item.sheetRow !== item.sheetRow)
        if (choice === 'yes') {
          people = people.filter((person) => person.sheetRow !== item.sheetRow)
          counts.yesCount = Math.max(0, counts.yesCount - 1)
          counts.toSend = Math.max(0, counts.toSend - 1)
          counts.yesToday = Math.max(0, counts.yesToday - 1)
        }
        saveError = error.message
        renderChrome()
        return
      }
      // Anything else is temporary (offline, Google hiccup): the answer stays in the outbox and retries.
      const pending = saving.get(item.sheetRow)
      pending.attempt++
      if (!offlineSince) offlineSince = Date.now()
      setTimeout(() => send(item, choice, device), Math.min(15000, 800 * 2 ** Math.min(pending.attempt, 5)))
      setTimeout(renderStatus, 4100)
      renderStatus()
    })
}

function choose(choice, device) {
  if (mode !== 'review') return
  const item = queue[0]
  if (!item) return
  if (choice === 'yes' && !device) {
    askingDevice = true
    renderMode()
    return
  }
  askingDevice = false
  adjustCounts(item, choice)
  updatePeople(item, choice, device)
  history.push({ item: { ...item, choice, device: device || '' }, previous: item.choice || null })
  queue = queue.slice(1)
  save(item, choice, device)
  show()
  refill()
}

function previous() {
  if (askingDevice) {
    askingDevice = false
    renderMode()
    return
  }
  if (mode !== 'review' || !history.length) return
  const entry = history.pop()
  queue = [entry.item, ...queue.filter((item) => item.sheetRow !== entry.item.sheetRow)]
  show()
}

noButton.addEventListener('click', () => choose('no'))
yesButton.addEventListener('click', () => choose('yes'))
prevButton.addEventListener('click', previous)
undoButton.addEventListener('click', previous)

window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
  const target = event.target
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  const key = event.key.toLowerCase()
  if (key === 'escape' && document.getElementById('zoom')) {
    event.preventDefault()
    closeZoom()
    return
  }
  if (key === 'escape' && askingDevice) {
    askingDevice = false
    renderMode()
    return
  }
  if (mode !== 'review') return
  if (key === 'escape') {
    location.hash = '#/'
    return
  }
  if (key === 'y') choose('yes')
  if (key === 'n') choose('no')
  if (key === 'arrowleft' || key === 'backspace') previous()
})

async function start() {
  let state
  for (let attempt = 0; !state; attempt++) {
    try {
      state = await api('/api/state', null, 15000)
    } catch {
      nameEl.textContent = 'Connecting to the review server…'
      await wait(Math.min(5000, 800 * (attempt + 1)))
    }
  }
  config = { mediaBase: state.mediaBase, yesPath: state.yesPath, sheetUrl: state.sheetUrl }
  markReady()
  counts = takeCounts(state)
  people = state.people || []
  writeNote = state.writeNote || ''
  loadError = state.loadError || ''
  devices = state.devices || []
  const outbox = readOutbox()
  for (const entry of outbox) {
    saving.set(entry.item.sheetRow, { item: entry.item, choice: entry.choice, device: entry.device || '', attempt: 0 })
    if (!entry.item.choice) counts.remaining = Math.max(0, counts.remaining - 1)
    updatePeople(entry.item, entry.choice, entry.device)
  }
  queue = (state.queue || []).filter((item) => !saving.has(item.sheetRow))
  renderDevices()
  show()
  for (const entry of outbox) send(entry.item, entry.choice, entry.device || '')
  refill()
}

start()

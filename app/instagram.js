// Instagram actions inside the app's Instagram panel (a logged-in WebContentsView).
// Every action verifies its result on the page before reporting success.
const guard = require('../lib/ig-guard')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function aborted(error) {
  return error?.errno === -3 || /\(-3\)|ERR_ABORTED/.test(error?.message || '')
}

function fail(message, kind = 'error') {
  return Object.assign(new Error(message), { kind })
}

async function openUrl(wc, url) {
  let finished = false
  const loaded = new Promise((resolve) => {
    const done = () => {
      finished = true
      wc.removeListener('did-finish-load', done)
      resolve()
    }
    wc.on('did-finish-load', done)
  })
  try {
    await wc.loadURL(url)
  } catch (error) {
    if (!aborted(error)) throw error
  }
  if (!finished) await Promise.race([loaded, sleep(15000)])
  await sleep(900)
}

function run(wc, code) {
  return wc.executeJavaScript(code, true)
}

// Points come from getBoundingClientRect (CSS pixels); input events need view pixels, so apply the panel zoom.
async function click(wc, point) {
  const zoom = wc.getZoomFactor() || 1
  const x = Math.round(point.x * zoom)
  const y = Math.round(point.y * zoom)
  wc.focus()
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  await sleep(40)
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  await sleep(70)
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

async function key(wc, keyCode, modifiers = []) {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (keyCode === 'Return' && !modifiers.length) wc.sendInputEvent({ type: 'char', keyCode: '\r' })
  await sleep(30)
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

// problem: 'blocked' (any Instagram warning: stops everything), 'login', 'missing' or ''.
const PAGE_PROBLEM = String.raw`
  const pageText = (document.body && document.body.innerText) || ''
  const popupText = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"]')].map((el) => el.innerText || '').join(' | ')
  const pagePath = location.pathname.toLowerCase()
  const problem = ${guard.WARNING_PATH}.test(pagePath) || ${guard.POPUP_WARNING}.test(popupText) || ${guard.PAGE_WARNING}.test(pageText.slice(0, 2000)) ? 'blocked'
    : pagePath.startsWith('/accounts/login') || /log in to continue|log into instagram/i.test(pageText.slice(0, 3000)) ? 'login'
    : /sorry, this page isn't available|may have been removed/i.test(pageText) ? 'missing'
    : ''
  const warning = problem === 'blocked' ? (popupText || pageText).replace(/\s+/g, ' ').slice(0, 240) : ''
`

const PROBLEM_ONLY = String.raw`(() => {
  ${PAGE_PROBLEM}
  return { problem, warning }
})()`

// Finds the post's own heart (24px, in the same action bar as the Comment icon), never a 12px heart on a comment.
const POST_PARTS = String.raw`
  const big = (svg) => { const rect = svg.getBoundingClientRect(); return rect.width >= 20 && rect.height >= 20 }
  const hearts = (root) => [...root.querySelectorAll('svg[aria-label="Like"], svg[aria-label="Unlike"]')].filter(big)
  const commentIcon = [...document.querySelectorAll('svg[aria-label="Comment"]')].find(big)
  let bar = null
  for (let node = commentIcon; node && node !== document.body; node = node.parentElement) {
    if (hearts(node).length) { bar = node; break }
  }
  const heart = bar ? hearts(bar)[0] : null
  const heartButton = heart ? (heart.closest('[role="button"], button') || heart) : null
  const box = document.querySelector('textarea[aria-label*="comment" i], textarea[placeholder*="comment" i]')
  const form = box ? (box.closest('form') || box.parentElement?.parentElement) : null
  const postButton = form ? [...form.querySelectorAll('[role="button"], button, div')].find((el) => (el.innerText || '').trim() === 'Post' && el.children.length < 3) : null
  const media = [...document.querySelectorAll('main img, main video')]
    .map((el) => ({ el, area: el.getBoundingClientRect().width * el.getBoundingClientRect().height }))
    .filter((item) => item.area > 40000)
    .sort((a, b) => b.area - a.area)[0]?.el || null
`

const scrollTo = (name) => String.raw`(() => {
  ${POST_PARTS}
  const target = ${name}
  if (!target) return false
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  return true
})()`

// Where to click, read after scrolling has settled, and only if that exact spot is really the target
// (not covered by a header, a popup or the edge of the screen).
const aimAt = (name) => String.raw`(() => {
  ${POST_PARTS}
  const target = ${name}
  if (!target) return null
  const rect = target.getBoundingClientRect()
  const x = Math.round(rect.left + rect.width / 2)
  const y = Math.round(rect.top + rect.height / 2)
  const onScreen = rect.width > 0 && x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight
  const hit = onScreen ? document.elementFromPoint(x, y) : null
  return { x, y, clear: Boolean(hit && (target === hit || target.contains(hit) || hit.contains(target))) }
})()`

async function aim(wc, name) {
  if (!(await run(wc, scrollTo(name)))) return null
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(attempt ? 250 : 450)
    const spot = await run(wc, aimAt(name))
    if (spot?.clear) return spot
  }
  return null
}

const POST_STATE = String.raw`(() => {
  ${PAGE_PROBLEM}
  if (problem) return { problem, warning }
  ${POST_PARTS}
  return {
    problem: '',
    hasHeart: Boolean(heart),
    liked: heart ? heart.getAttribute('aria-label') === 'Unlike' : false,
    hasBox: Boolean(box),
    boxText: box ? box.value : '',
    hasPost: Boolean(postButton),
    closed: /comments on this post have been limited|commenting is turned off|comments are turned off/i.test(pageText),
  }
})()`

const shown = (snippet) => String.raw`(() => {
  const want = ${JSON.stringify(snippet)}
  return [...document.querySelectorAll('span, div, h1')].some((el) => el.children.length < 4 && (el.innerText || '').includes(want))
})()`

function problemError(state) {
  if (state?.problem === 'login') return fail('Instagram wants you to log in. Log in inside the Instagram panel, then try again.', 'login')
  if (state?.problem === 'blocked') return fail(`Instagram showed a warning: ${state.warning || 'action limited'}`, 'blocked')
  if (state?.problem === 'missing') return fail('This post no longer exists.', 'missing')
  return null
}

// Checks the current page for an Instagram warning without touching anything.
async function pageProblem(wc) {
  return run(wc, PROBLEM_ONLY).catch(() => ({ problem: '' }))
}

async function waitFor(check, timeoutMs, stepMs = 300) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    last = await check()
    if (last && last.done) return last
    await sleep(stepMs)
  }
  return last
}

async function doubleClick(wc, point) {
  const zoom = wc.getZoomFactor() || 1
  const x = Math.round(point.x * zoom)
  const y = Math.round(point.y * zoom)
  wc.focus()
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  for (const clickCount of [1, 2]) {
    await sleep(60)
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount })
    await sleep(60)
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount })
  }
}

// Watches the panel's own network traffic (Chrome DevTools protocol, invisible to the page) for
// requests matching `pattern`, with their status and the start of their response.
async function watchNetwork(wc, pattern) {
  const dbg = wc.debugger
  const ownsDebugger = !dbg.isAttached()
  if (ownsDebugger) dbg.attach('1.3')
  await dbg.sendCommand('Network.enable')
  const requests = new Map()
  const onMessage = (_event, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      const headers = params.request.headers || {}
      const name = headers['X-FB-Friendly-Name'] || headers['x-fb-friendly-name'] || ''
      const label = `${params.request.url} ${name}`
      if (params.request.method === 'POST' && pattern.test(label) && !/unlike/i.test(label)) {
        requests.set(params.requestId, { url: params.request.url, name, done: false })
      }
    } else if (method === 'Network.responseReceived' && requests.has(params.requestId)) {
      requests.get(params.requestId).status = params.response.status
    } else if (method === 'Network.loadingFinished' && requests.has(params.requestId)) {
      const entry = requests.get(params.requestId)
      dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
        .then((body) => { entry.body = String(body.body || '').slice(0, 4000) })
        .catch(() => {})
        .finally(() => { entry.done = true })
    } else if (method === 'Network.loadingFailed' && requests.has(params.requestId)) {
      Object.assign(requests.get(params.requestId), { done: true, failed: params.errorText || 'failed' })
    }
  }
  dbg.on('message', onMessage)
  return {
    list: () => [...requests.values()],
    stop() {
      dbg.removeListener('message', onMessage)
      if (ownsDebugger) { try { dbg.detach() } catch {} }
    },
  }
}

// Any POST whose address or GraphQL name mentions like (e.g. /api/v1/web/likes/<id>/like/ or
// usePolarisLikeMediaLikeMutation), only while the like is being clicked.
const LIKE_REQUEST = /like/i
const REFUSED = /feedback_required|"spam"\s*:\s*true|try again later|we restrict certain activity|action blocked|"status"\s*:\s*"fail"|checkpoint_required|challenge_required/i

// What Instagram's servers said about the like requests so far.
function likeVerdict(requests) {
  const refused = requests.find((request) => request.done && !request.failed && ((request.status || 0) >= 400 || REFUSED.test(request.body || '')))
  if (refused) {
    const detail = (String(refused.body || '').match(REFUSED) || [])[0] || `status ${refused.status}`
    return { refused: true, reason: `Instagram answered the like with "${detail}".` }
  }
  return {
    accepted: requests.some((request) => request.done && !request.failed && request.status >= 200 && request.status < 300 && !/"errors"\s*:\s*\[/.test(request.body || '')),
    pending: requests.some((request) => !request.done),
    sent: requests.length > 0,
  }
}

// Likes the post. Re-aims and clicks again only when no like request left the browser at all (a
// missed click); never clicks while one is in flight (that would unlike); a refusal is a block.
async function likePost(wc) {
  const net = await watchNetwork(wc, LIKE_REQUEST)
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      // A hidden page queues clicks instead of sending them: never tap again into a hidden page.
      if ((await run(wc, 'document.visibilityState')) !== 'visible') throw fail('macOS paused the Instagram panel, so nothing was clicked. It will try again shortly.', 'hidden')
      const useMedia = attempt === 2
      const spot = await aim(wc, useMedia ? 'media' : 'heartButton')
      if (!spot) continue
      if (useMedia) await doubleClick(wc, spot)
      else await click(wc, spot)
      const seen = await waitFor(async () => {
        const verdict = likeVerdict(net.list())
        const dom = await run(wc, POST_STATE)
        return { ...verdict, dom, done: dom.liked || dom.problem === 'blocked' || verdict.refused || verdict.accepted }
      }, 8000, 300)
      let verdict = likeVerdict(net.list())
      if (verdict.pending) {
        await waitFor(async () => ({ done: !likeVerdict(net.list()).pending }), 10000, 300)
        verdict = likeVerdict(net.list())
      }
      if (seen.dom?.problem === 'blocked') return { blocked: true, reason: seen.dom.warning || 'Instagram showed a warning.' }
      if (verdict.refused) return { blocked: true, reason: verdict.reason }
      if (verdict.accepted) {
        await sleep(1200)
        return { liked: true }
      }
      if ((await run(wc, POST_STATE)).liked) return { liked: true }
      // A request went out but neither failed nor succeeded clearly: do not risk toggling it back.
      if (verdict.sent) return { liked: false, reason: 'Instagram did not confirm the like.' }
    }
    return { liked: false, reason: 'The Like button never responded after 3 tries.' }
  } finally {
    console.log('like requests', JSON.stringify(net.list().map((request) => ({ url: request.url.slice(0, 120), name: request.name, status: request.status, failed: request.failed, body: String(request.body || '').slice(0, 200) }))))
    net.stop()
  }
}

// Errors before Post/Send was pressed are 'notsent' (safe to retry); after it, the attempt may have
// gone through, so it is never retried automatically.
async function untilSent(task) {
  const progress = { pressed: false }
  try {
    return await task(progress)
  } catch (error) {
    if (!progress.pressed && (!error.kind || error.kind === 'error')) error.kind = 'notsent'
    throw error
  }
}

function comment(wc, options) {
  return untilSent((progress) => commentSteps(wc, options, progress))
}

function dm(wc, options) {
  return untilSent((progress) => dmSteps(wc, options, progress))
}

// Likes the post and posts the comment. Only resolves once both are visible on the page.
async function commentSteps(wc, { permalink, message, dryRun = false, allowLiked = false }, progress) {
  const text = String(message || '').trim()
  await openUrl(wc, permalink)
  let state = await waitFor(async () => {
    const value = await run(wc, POST_STATE)
    return { ...value, done: Boolean(value.problem) || (value.hasHeart && (value.hasBox || value.closed)) }
  }, 12000, 400)
  const problem = problemError(state)
  if (problem) throw problem
  if (!state.hasHeart) throw fail('Could not find the Like button on this post.')
  if (state.closed && !state.hasBox) throw fail('Comments are turned off on this post.')
  if (!state.hasBox) throw fail('Could not find the comment box on this post.')
  if (!dryRun && state.liked && !allowLiked) {
    throw fail('This post is already liked from your account, so it was probably handled already. Skipped to avoid a double comment.', 'duplicate')
  }
  // Test mode: finds everything, types into the box, locates Post, then clears the box. Clicks nothing that publishes.
  if (dryRun) {
    const onPost = text ? await run(wc, shown(text.slice(0, 40))) : false
    const heartPoint = await aim(wc, 'heartButton')
    const typedPoint = await aim(wc, 'box')
    await click(wc, typedPoint)
    await sleep(300)
    await wc.insertText(text || 'test')
    await sleep(600)
    const typed = await run(wc, POST_STATE)
    const postPoint = await aim(wc, 'postButton')
    await run(wc, `(() => { const box = document.querySelector('textarea[aria-label*="comment" i]'); box.focus(); return true })()`)
    wc.selectAll()
    await sleep(100)
    await key(wc, 'Backspace')
    await sleep(400)
    const cleared = await run(wc, POST_STATE)
    return { ok: true, dryRun: true, liked: state.liked, heartPoint, typedInBox: typed.boxText, postButton: postPoint, clearedAfter: cleared.boxText === '', commentAlreadyOnPost: onPost }
  }

  let liked = state.liked
  if (!liked) {
    const outcome = await likePost(wc)
    if (outcome.blocked) throw fail(`Instagram refused the like: ${outcome.reason}`, 'blocked')
    if (!outcome.liked) throw fail(`Could not like the post: ${outcome.reason} Nothing was commented.`)
    liked = true
  }

  const boxPoint = await aim(wc, 'box')
  if (!boxPoint) throw fail('Could not find the comment box on this post.')
  await sleep(250)
  await click(wc, boxPoint)
  await sleep(300)
  await wc.insertText(text)
  await sleep(500)
  state = await run(wc, POST_STATE)
  if (!String(state.boxText || '').trim()) throw fail('Could not type into the comment box.')

  const snippet = text.slice(0, 40)
  const posted = async () => {
    const value = await run(wc, POST_STATE)
    const visible = !String(value.boxText || '').trim() && await run(wc, shown(snippet))
    return { ...value, visible, done: visible || Boolean(value.problem) }
  }
  const postPoint = await aim(wc, 'postButton')
  progress.pressed = true
  if (postPoint) await click(wc, postPoint)
  else await key(wc, 'Return')
  let result = await waitFor(posted, 5000)
  if (!result?.visible && !result?.problem && String(result?.boxText || '').trim()) {
    await click(wc, boxPoint)
    await key(wc, 'Return')
    result = await waitFor(posted, 6000)
  }
  if (result?.problem) throw problemError(result)
  if (!result?.visible) throw fail('The comment was typed, but it never appeared on the post. Check the Instagram panel.')
  // Instagram sometimes shows its warning a moment after accepting the comment.
  await sleep(1500)
  const after = problemError(await pageProblem(wc))
  if (after) throw after
  return { ok: true, liked, commented: true }
}

const DM_BOX = String.raw`
  const boxes = [...document.querySelectorAll('div[contenteditable="true"][role="textbox"], textarea')].filter((el) => {
    const rect = el.getBoundingClientRect()
    return rect.width > 40 && rect.height > 10 && rect.top > window.innerHeight * 0.4
  })
  const label = (el) => [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('aria-placeholder')].join(' ')
  const box = boxes.find((el) => /message/i.test(label(el))) || boxes[0] || null
`

const DM_STATE = String.raw`(() => {
  ${PAGE_PROBLEM}
  if (problem) return { problem, warning }
  if (/doesn't allow new message requests|you can't message this account|messaging unavailable/i.test(pageText)) return { problem: 'unreachable' }
  const notNow = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] [role="button"]')].find((el) => /^not now$/i.test((el.innerText || '').trim()))
  if (notNow) { notNow.click(); return { problem: '', waiting: true } }
  ${DM_BOX}
  if (!box) return { problem: '', waiting: true }
  const rect = box.getBoundingClientRect()
  return { problem: '', x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), text: (box.value != null ? box.value : box.innerText || '').trim() }
})()`

// The newest messages in the open chat, oldest first: who sent each one (by side of the chat) and
// whether it is a voicenote. Messages are role="article" bubbles; ours sit on the right half.
// Each message also gets "at": the time of the timestamp shown above its group in the chat (e.g.
// "21 May 2026, 17:35", "Today 10:12", "Fri 15:17"), or null when none is in view.
const THREAD = String.raw`(() => {
  const voiceMark = '[aria-label="Waveform for audio message"], [aria-label="Voice clip"], [aria-label="Audio progress bar"]'
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
  const parse = (raw) => {
    const t = String(raw || '').trim().toLowerCase().replace(/[  ]/g, ' ')
    const clock = t.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/)
    if (!clock || t.length > 40) return null
    let hour = Number(clock[1])
    const minute = Number(clock[2])
    if (clock[3] === 'pm' && hour < 12) hour += 12
    if (clock[3] === 'am' && hour === 12) hour = 0
    const now = new Date()
    let date = null
    let m
    if ((m = t.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?(?:\s+(\d{4}))?/)) && months[m[2]] != null) {
      date = new Date(m[3] ? Number(m[3]) : now.getFullYear(), months[m[2]], Number(m[1]), hour, minute)
      if (!m[3] && date > now) date.setFullYear(date.getFullYear() - 1)
    } else if ((m = t.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/)) && months[m[1]] != null) {
      date = new Date(m[3] ? Number(m[3]) : now.getFullYear(), months[m[1]], Number(m[2]), hour, minute)
      if (!m[3] && date > now) date.setFullYear(date.getFullYear() - 1)
    } else if (/^today/.test(t) || /^\d{1,2}:\d{2}/.test(t)) {
      date = new Date(now)
      date.setHours(hour, minute, 0, 0)
    } else if (/^yesterday/.test(t)) {
      date = new Date(now)
      date.setDate(date.getDate() - 1)
      date.setHours(hour, minute, 0, 0)
    } else {
      const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(t.slice(0, 3))
      if (day < 0) return null
      date = new Date(now)
      date.setDate(date.getDate() - ((date.getDay() - day + 7) % 7 || 7))
      date.setHours(hour, minute, 0, 0)
    }
    return date && !Number.isNaN(date.getTime()) ? date.getTime() : null
  }
  const main = document.querySelector('[role="main"]') || document.body
  const stamps = [...main.querySelectorAll('span, div, time')]
    .filter((el) => el.children.length === 0 && !el.closest('[role="article"]') && el.getBoundingClientRect().height > 0)
    .map((el) => ({ top: el.getBoundingClientRect().top, at: parse(el.innerText) }))
    .filter((stamp) => stamp.at)
    .sort((a, b) => a.top - b.top)
  return [...document.querySelectorAll('[role="main"] [role="article"]')]
    .filter((bubble) => bubble.getBoundingClientRect().height > 0)
    .map((bubble) => {
      const lane = bubble.closest('[role="group"]') || bubble.parentElement
      const area = lane.getBoundingClientRect()
      const box = bubble.getBoundingClientRect()
      return {
        ours: box.left + box.width / 2 > area.left + area.width / 2,
        voice: Boolean(bubble.querySelector(voiceMark)) || /view transcription/i.test(bubble.innerText || ''),
        text: (bubble.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600),
        top: Math.round(box.top),
        at: stamps.filter((stamp) => stamp.top < box.top).pop()?.at || null,
        // A reaction on the message (e.g. their ❤️ under ours): an emoji-only label next to the bubble.
        reaction: [...((bubble.closest('[role="group"]') || bubble.parentElement?.parentElement || bubble).querySelectorAll('span'))]
          .filter((el) => !bubble.contains(el) && el.children.length === 0 && /^[\p{Extended_Pictographic}\uFE0F\u200d\s\d]+$/u.test((el.innerText || '').trim()) && /\p{Extended_Pictographic}/u.test(el.innerText || ''))
          .map((el) => el.innerText.trim()).join(' '),
      }
    })
    .sort((a, b) => a.top - b.top)
})()`

// The newest voicenote bubble's waveform in the open chat: flat means every bar is the same height
// (Instagram drew it while the page was hidden).
async function lastVoiceWaveform(wc) {
  return run(wc, String.raw`(() => {
    const waves = [...document.querySelectorAll('[role="main"] [aria-label="Waveform for audio message"]')]
    const wave = waves[waves.length - 1]
    if (!wave) return { found: false }
    const heights = [...wave.querySelectorAll('rect')].map((rect) => Number(rect.getAttribute('height')) || 0)
    return { found: true, flat: new Set(heights.map((height) => Math.round(height))).size <= 1 }
  })()`).catch(() => ({ found: false }))
}

async function readThread(wc) {
  let messages = []
  for (let attempt = 0; attempt < 12; attempt++) {
    messages = await run(wc, THREAD).catch(() => [])
    if (messages.length) break
    await sleep(500)
  }
  return messages
}

// Relaunch only when they have not answered: for a relaunch the last message is our voicenote (or, for
// creators first contacted by text, our message); for a 2nd relaunch the last is our relaunch text and
// the one before it our voicenote (or our first text).
function threadAllows(messages, { stage, viaVoice }, outgoing = '') {
  if (!messages.length) return { ok: false, reason: 'Could not read the chat, so nothing was sent.' }
  const snippet = String(outgoing).replace(/\s+/g, ' ').trim().slice(0, 30)
  if (snippet && messages.some((message) => message.ours && message.text.includes(snippet))) {
    return { ok: false, reason: 'This exact message is already in the chat, so it was not sent again.' }
  }
  const last = messages[messages.length - 1]
  const before = messages[messages.length - 2]
  if (!last.ours) return { ok: false, reason: 'They replied, so no relaunch.' }
  if (stage === 1) {
    if (viaVoice && !last.voice) return { ok: false, reason: 'The last message is not our voicenote, so no relaunch.' }
    if (!viaVoice && messages.some((message) => !message.ours)) return { ok: false, reason: 'They replied earlier in the chat, so no relaunch.' }
    return { ok: true }
  }
  if (last.voice) return { ok: false, reason: 'The last message is our voicenote, not the relaunch, so no 2nd relaunch.' }
  if (!before || !before.ours) return { ok: false, reason: 'They replied before our relaunch, so no 2nd relaunch.' }
  if (viaVoice && !before.voice) return { ok: false, reason: 'Our relaunch does not follow our voicenote, so no 2nd relaunch.' }
  if (!viaVoice && messages.some((message) => !message.ours)) return { ok: false, reason: 'They replied earlier in the chat, so no 2nd relaunch.' }
  return { ok: true }
}

const DM_SEND = String.raw`(() => {
  const buttons = [...document.querySelectorAll('button, [role="button"]')].filter((el) => {
    const rect = el.getBoundingClientRect()
    return rect.width && rect.top > window.innerHeight * 0.5
  })
  const send = buttons.find((el) => /^send$/i.test((el.innerText || el.getAttribute('aria-label') || '').trim()))
  if (!send) return null
  const rect = send.getBoundingClientRect()
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
})()`

// Sends a text DM. Only resolves once the composer is empty and the message shows in the thread.
async function dmSteps(wc, { username, message, expect }, progress) {
  const text = String(message || '').trim()
  await openUrl(wc, `https://ig.me/m/${encodeURIComponent(username)}`)
  const state = await waitFor(async () => {
    const value = await run(wc, DM_STATE).catch(() => ({ waiting: true }))
    return { ...value, done: Boolean(value.problem) || !value.waiting }
  }, 20000, 500)
  if (state?.problem === 'unreachable') throw fail('This account cannot receive your messages.', 'unreachable')
  if (state?.problem === 'missing') throw fail('This Instagram account no longer exists.', 'missing')
  if (state?.problem) throw problemError(state)
  if (!state || state.waiting) throw fail('The DM opened, but the message box never appeared.')

  if (expect) {
    const messages = await readThread(wc)
    const verdict = threadAllows(messages, expect, message)
    // 'replied' only when they actually wrote something (the chat goes along, so their reply can be
    // read); any other mismatch is 'mismatch'.
    if (!verdict.ok) {
      const replied = messages.some((item) => !item.ours)
      throw Object.assign(fail(verdict.reason, replied ? 'replied' : 'mismatch'), replied ? { thread: messages } : {})
    }
  }

  await click(wc, state)
  await sleep(200)
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) await key(wc, 'Return', ['shift'])
    if (lines[index]) await wc.insertText(lines[index])
  }
  await sleep(500)
  const typed = await run(wc, DM_STATE)
  if (!typed.text) throw fail('Could not type into the message box.')

  const send = await run(wc, DM_SEND)
  progress.pressed = true
  if (send) await click(wc, send)
  else await key(wc, 'Return')
  const snippet = lines.find((line) => line.trim())?.slice(0, 40) || text.slice(0, 40)
  const sent = await waitFor(async () => {
    const value = await run(wc, DM_STATE)
    const visible = !value.text && await run(wc, shown(snippet))
    return { ...value, visible, done: visible || value.problem === 'blocked' }
  }, 8000, 400)
  if (sent?.problem === 'blocked') throw problemError(sent)
  if (!sent?.visible) throw fail('Instagram took the message but it never showed in the chat. Check the Instagram panel before sending again.')
  await sleep(1500)
  const after = problemError(await pageProblem(wc))
  if (after?.kind === 'blocked') throw after
  return { ok: true }
}

// Opens the chat and reads it, without touching anything. The chat has to show at least one message.
async function openThread(wc, username) {
  await openUrl(wc, `https://ig.me/m/${encodeURIComponent(username)}`)
  const state = await waitFor(async () => {
    const value = await run(wc, DM_STATE).catch(() => ({ waiting: true }))
    return { ...value, done: Boolean(value.problem) || !value.waiting }
  }, 20000, 500)
  if (state?.problem === 'missing') throw fail('This Instagram account no longer exists.', 'missing')
  if (state?.problem && state.problem !== 'unreachable') throw problemError(state)
  const messages = await readThread(wc)
  if (!messages.length) throw fail('Could not read the chat, so nothing was done.', 'mismatch')
  return messages
}

const UNFOLLOW_START = 'window.__unfollowStart()'

async function followState(wc) {
  return waitFor(async () => {
    const value = await run(wc, UNFOLLOW_START).catch(() => ({}))
    const page = await pageProblem(wc)
    return { ...value, problem: page.problem, warning: page.warning, done: Boolean(page.problem) || Boolean(value.ok) }
  }, 15000, 500)
}

// The Unfollow choice once it has stopped moving (same place twice in a row) and the spot under its
// centre really is it, so the tap cannot land beside it while the menu is still opening.
async function steadyChoice(wc, timeoutMs) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    const value = await run(wc, 'window.__unfollowChoice()').catch(() => ({}))
    if (value?.ok && value.clear && last && last.x === value.x && last.y === value.y) return value
    last = value?.ok ? value : null
    await sleep(250)
  }
  return null
}

async function untilUnfollowedOrConfirm(wc, timeoutMs) {
  return waitFor(async () => {
    const state = await run(wc, UNFOLLOW_START).catch(() => ({}))
    if (state?.notFollowing) return { notFollowing: true, done: true }
    const confirm = await run(wc, 'window.__unfollowChoice()').catch(() => ({}))
    // A confirmation dialog's Unfollow, or the menu's again if the first tap did not register (safe:
    // once unfollowed, the profile shows Follow and nothing more is tapped).
    if (confirm?.ok && confirm.clear) {
      const steady = await steadyChoice(wc, 1500)
      if (steady) return { confirm: steady, done: true }
    }
    return { done: false }
  }, timeoutMs, 400)
}

// When an unfollow does not take, what was on screen goes to data/unfollow-debug.jsonl.
async function debugUnfollow(wc, username, reason, choice = null) {
  try {
    const snapshot = await run(wc, 'window.__unfollowSnapshot()').catch(() => ({}))
    const line = { at: new Date().toISOString(), username, reason, choice, zoom: wc.getZoomFactor(), ...snapshot }
    require('fs').appendFileSync(require('path').join(__dirname, '..', 'data', 'unfollow-debug.jsonl'), `${JSON.stringify(line)}\n`)
  } catch {}
}

// Unfollows from the profile page: Following → Unfollow (→ confirm), then checks the button says
// Follow, and reloads the profile to be sure Instagram kept it.
async function unfollowSteps(wc, { username }, progress) {
  await openUrl(wc, `https://www.instagram.com/${encodeURIComponent(username)}/`)
  const start = await followState(wc)
  if (start?.problem === 'missing') throw fail('This Instagram account no longer exists.', 'missing')
  if (start?.problem) throw problemError(start)
  if (start?.notFollowing) return { ok: true, unfollowed: false, notFollowing: true }
  if (!start?.click) throw fail(start?.error || 'The profile did not load.')
  await click(wc, start)
  const choice = await steadyChoice(wc, 6000)
  if (!choice) {
    await debugUnfollow(wc, username, 'no Unfollow option')
    await key(wc, 'Escape')
    throw fail('The Following menu did not show an Unfollow option.')
  }
  progress.pressed = true
  await click(wc, choice)
  // Unfollowed straight away, or a confirmation dialog (private accounts, follow requests).
  let after = await untilUnfollowedOrConfirm(wc, 5000)
  if (after?.confirm) {
    await click(wc, after.confirm)
    after = await untilUnfollowedOrConfirm(wc, 5000)
  }
  const problem = problemError(await pageProblem(wc))
  if (problem) throw problem
  if (!after?.notFollowing) {
    // Instagram sometimes takes a while to flip the button: reload and look again before calling it.
    await debugUnfollow(wc, username, 'still Following after tapping', choice)
    await key(wc, 'Escape')
    await sleep(3000)
    await openUrl(wc, `https://www.instagram.com/${encodeURIComponent(username)}/`)
    const reloaded = await followState(wc)
    if (reloaded?.problem) throw problemError(reloaded) || fail('The profile did not reload.')
    if (!reloaded?.notFollowing) throw fail('Tapped Unfollow, but the profile still shows Following. Check the Instagram panel.')
    return { ok: true, unfollowed: true }
  }
  await sleep(2000)
  await openUrl(wc, `https://www.instagram.com/${encodeURIComponent(username)}/`)
  const kept = await followState(wc)
  if (kept?.problem) throw problemError(kept) || fail('The profile did not reload.')
  if (!kept?.notFollowing) throw fail('Instagram did not keep the unfollow: the profile shows Following again.')
  return { ok: true, unfollowed: true }
}

// Closing a creator out. With checkChat, reads the chat first and stops (nothing touched) if they
// ever wrote back, handing their messages over to be judged.
function unfollow(wc, { username, checkChat }) {
  return untilSent(async (progress) => {
    if (checkChat) {
      const messages = await openThread(wc, username)
      if (messages.some((item) => !item.ours)) return { ok: true, replied: true, thread: messages }
    }
    return unfollowSteps(wc, { username }, progress)
  })
}

// Reply relaunches (an ongoing conversation that went quiet): 1 is the "confused Travolta" GIF, picked
// in Instagram's GIF picker by its exact image (pinned), 2 a short text. Sent only if the chat still
// ends with the same message of ours that was checked (expectLast), so a reply in between stops it.
const REPLY_GIF = { query: 'confused travolta', ref: '602658373_1585123589145481_2547763527474712447_n' }

function lastMatches(messages, expectLast) {
  const last = messages[messages.length - 1]
  if (!last || !last.ours) return false
  if (!expectLast) return true
  return last.text.slice(0, 40) === String(expectLast.text || '').slice(0, 40)
}

async function replyRelaunchSteps(wc, { username, step, text, expectLast }, progress) {
  const messages = await openThread(wc, username)
  if (!lastMatches(messages, expectLast)) {
    const replied = !messages[messages.length - 1]?.ours
    throw Object.assign(fail(replied ? 'They wrote back, so no reply relaunch.' : 'The chat changed since it was checked, so nothing was sent.', replied ? 'replied' : 'mismatch'), replied ? { thread: messages } : {})
  }
  if (Number(step) === 2) return dmSteps(wc, { username, message: text }, progress)
  // The GIF: open the picker, search, click only the pinned image.
  const opener = await run(wc, String.raw`(() => {
    const el = [...document.querySelectorAll('[aria-label]')].find((node) => /gif or sticker/i.test(node.getAttribute('aria-label')) && node.getBoundingClientRect().top > window.innerHeight * 0.6)
    if (!el) return null
    const r = (el.closest('button, [role="button"]') || el).getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!opener) throw fail('The GIF button was not found, so nothing was sent.')
  await click(wc, opener)
  const search = await waitFor(async () => {
    const value = await run(wc, String.raw`(() => {
      const el = [...document.querySelectorAll('input')].filter((node) => node.getBoundingClientRect().width && /search (stickers|gifs)/i.test([node.placeholder, node.getAttribute('aria-label')].join(' '))).pop()
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`).catch(() => null)
    return { ...(value || {}), done: Boolean(value) }
  }, 6000, 300)
  if (!search?.x) throw fail('The GIF search did not open, so nothing was sent.')
  await click(wc, search)
  await sleep(250)
  const focused = await run(wc, `(() => { const el = document.activeElement; return Boolean(el && el.tagName === 'INPUT' && /search (stickers|gifs)/i.test([el.placeholder, el.getAttribute('aria-label')].join(' '))) })()`)
  if (!focused) {
    await key(wc, 'Escape')
    throw fail('Could not type into the GIF search, so nothing was sent.')
  }
  await wc.insertText(REPLY_GIF.query)
  const pick = await waitFor(async () => {
    const value = await run(wc, String.raw`(() => {
      const img = [...document.querySelectorAll('img')].find((el) => (el.currentSrc || el.src || '').includes(${JSON.stringify(REPLY_GIF.ref)}) && el.getBoundingClientRect().width > 20)
      const holder = img && img.closest('button, [role="button"]')
      if (!holder || !/send/i.test(holder.getAttribute('aria-label') || '')) return null
      const r = holder.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`).catch(() => null)
    return { ...(value || {}), done: Boolean(value) }
  }, 8000, 400)
  if (!pick?.x) {
    await key(wc, 'Escape')
    throw fail('The Travolta GIF was not among the results, so nothing was sent.')
  }
  const before = messages.length
  progress.pressed = true
  await click(wc, pick)
  const sent = await waitFor(async () => {
    const now = await readThread(wc)
    return { done: now.length > before && now[now.length - 1].ours }
  }, 10000, 500)
  if (!sent?.done) throw fail('The GIF was tapped but never showed in the chat. Check the Instagram panel before sending again.')
  await sleep(1500)
  const after = problemError(await pageProblem(wc))
  if (after?.kind === 'blocked') throw after
  return { ok: true }
}

function replyRelaunch(wc, options) {
  return untilSent((progress) => replyRelaunchSteps(wc, options, progress))
}

// The chat as it is, read only (no action): who sent each message and when.
async function chatState(wc, { username }) {
  return { messages: await openThread(wc, username) }
}

// Read-only look at a chat page, to build on: what timestamps it shows, which buttons sit by the
// message box, and (with gifQuery) what the GIF picker shows for a search. Never presses Send or a
// GIF; the picker is closed again and the message box is left empty.
async function probeChat(wc, { username, gifQuery }) {
  const messages = await openThread(wc, username)
  const page = await run(wc, String.raw`(() => {
    const main = document.querySelector('[role="main"]') || document.body
    const timeLike = /\b(today|yesterday|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b.*\d|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/i
    const stamps = [...main.querySelectorAll('div, span, time, h4, h5')]
      .filter((el) => !el.closest('[role="article"]') && el.children.length === 0 && timeLike.test(el.innerText || '') && (el.innerText || '').length < 40)
      .map((el) => ({ text: el.innerText.trim(), tag: el.tagName, datetime: el.getAttribute('datetime') || '', top: Math.round(el.getBoundingClientRect().top) }))
    const times = [...document.querySelectorAll('time')].slice(-10).map((el) => ({ text: el.innerText, datetime: el.getAttribute('datetime'), title: el.getAttribute('title') }))
    const controls = [...document.querySelectorAll('button, [role="button"], svg[aria-label]')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.top > window.innerHeight * 0.6 })
      .map((el) => ({ label: el.getAttribute('aria-label') || (el.querySelector('svg[aria-label]') || {}).getAttribute?.('aria-label') || (el.innerText || '').trim().slice(0, 30), tag: el.tagName }))
    // Around the last few bubbles: every aria-label and short text, to see how reactions are marked.
    const bubbles = [...main.querySelectorAll('[role="article"]')].slice(-3)
    const around = bubbles.map((bubble) => {
      const lane = bubble.closest('[role="group"]') || bubble.parentElement?.parentElement || bubble
      return [...lane.querySelectorAll('[aria-label], span, img')].map((el) => [el.tagName, el.getAttribute('aria-label') || '', el.tagName === 'IMG' ? (el.alt || '') : (el.children.length ? '' : (el.innerText || '').slice(0, 20))].join('|')).filter((line) => !/\|\|$/.test(line)).slice(0, 25)
    })
    return { stamps: stamps.slice(-15), times, controls: controls.slice(0, 30), around }
  })()`)
  const result = { username, messages: messages.slice(-6).map((m) => ({ ours: m.ours, voice: m.voice, text: m.text.slice(0, 80), top: m.top })), ...page }
  if (!gifQuery) return result
  const opener = await run(wc, String.raw`(() => {
    const el = [...document.querySelectorAll('[aria-label]')].find((node) => /gif|sticker/i.test(node.getAttribute('aria-label')) && node.getBoundingClientRect().top > window.innerHeight * 0.6)
    if (!el) return null
    const r = (el.closest('button, [role="button"]') || el).getBoundingClientRect()
    return { label: el.getAttribute('aria-label'), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  result.gifButton = opener
  if (!opener) return result
  await click(wc, opener)
  await sleep(1500)
  // The picker's tabs (GIFs / Stickers): switch to GIFs when there is such a tab.
  result.pickerTabs = await run(wc, String.raw`(() => {
    const input = [...document.querySelectorAll('input')].find((el) => el.getBoundingClientRect().width && /search/i.test([el.placeholder, el.getAttribute('aria-label')].join(' ')))
    let box = input
    for (let i = 0; i < 6 && box && box.parentElement; i++) box = box.parentElement
    const scope = box || document
    return [...scope.querySelectorAll('button, [role="button"], [role="tab"], div, span')]
      .filter((el) => el.children.length === 0 && /^(gifs?|stickers?)$/i.test((el.innerText || '').trim()))
      .map((el) => { const r = el.getBoundingClientRect(); return { text: el.innerText.trim(), role: el.getAttribute('role') || el.tagName, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })
  })()`)
  const gifTab = (result.pickerTabs || []).find((tab) => /^gifs?$/i.test(tab.text))
  if (gifTab) {
    await click(wc, gifTab)
    await sleep(1200)
  }
  const search = await run(wc, String.raw`(() => {
    const inputs = [...document.querySelectorAll('input')].filter((el) => el.getBoundingClientRect().width && /search/i.test([el.placeholder, el.getAttribute('aria-label')].join(' ')))
    const el = inputs[inputs.length - 1]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { placeholder: el.placeholder, label: el.getAttribute('aria-label'), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  result.gifSearch = search
  if (search) {
    await click(wc, search)
    await sleep(300)
    const focused = await run(wc, `(() => { const el = document.activeElement; return el && el.tagName === 'INPUT' && /search/i.test([el.placeholder, el.getAttribute('aria-label')].join(' ')) })()`)
    result.searchFocused = focused
    if (focused) {
      await wc.insertText(gifQuery)
      await sleep(2500)
      result.gifResults = await run(wc, String.raw`(() => {
        // The picker: the closest ancestor of the search box that holds at least 3 pictures.
        const input = document.activeElement
        let box = input
        const media = (node) => [...node.querySelectorAll('img, video')].filter((el) => el.getBoundingClientRect().width > 30)
        while (box && box.parentElement && media(box).length < 3) box = box.parentElement
        if (!box) return { found: false }
        const r0 = box.getBoundingClientRect()
        const texts = [...box.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.innerText || '').trim()).map((el) => el.innerText.trim()).slice(0, 20)
        const items = media(box).slice(0, 8).map((el) => { const r = el.getBoundingClientRect(); const holder = el.closest('button, [role="button"], [tabindex]'); return { tag: el.tagName, alt: el.alt || '', label: holder?.getAttribute('aria-label') || '', src: el.currentSrc || el.src || '', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), clickable: Boolean(holder) } })
        return { found: true, box: { x: Math.round(r0.left), y: Math.round(r0.top), w: Math.round(r0.width), h: Math.round(r0.height) }, texts, items }
      })()`)
    }
  }
  await key(wc, 'Escape')
  await sleep(400)
  await key(wc, 'Escape')
  await sleep(600)
  const after = await run(wc, DM_STATE).catch(() => ({}))
  result.composerAfter = after.text || ''
  result.lastAfter = (await readThread(wc)).slice(-1).map((m) => ({ ours: m.ours, text: m.text.slice(0, 60) }))
  return result
}

module.exports = { openUrl, run, click, key, sleep, aborted, comment, dm, unfollow, pageProblem, readThread, threadAllows, lastVoiceWaveform, probeChat, chatState, replyRelaunch }

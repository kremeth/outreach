const { spawn } = require('child_process')
const http = require('http')
const https = require('https')
const path = require('path')

const PORT = Number(process.env.IG_PREVIEW_PORT) || 9334
const PROFILE = process.env.IG_PREVIEW_PROFILE || path.join(__dirname, '..', 'data', 'ig-chrome')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TABS = Number(process.env.IG_PREVIEW_TABS) || 3
const CACHE_MS = 30 * 60 * 1000
const MISSING_MS = 5 * 60 * 1000
const CACHE_LIMIT = 400
const COMMAND_TIMEOUT_MS = 8000
const LOAD_TIMEOUT_MS = 10000
// When Instagram puts up a login wall for logged-out viewing (it does this to a whole internet
// connection after a burst of profile loads), stop asking for a while instead of pushing on.
const LOGIN_WALL_MS = 10 * 60 * 1000
const FEED_WIDTH = 750
const agent = new https.Agent({ keepAlive: true, maxSockets: 24 })
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

function devtools(method, urlPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method }, (response) => {
      let body = ''
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.end()
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function profileError(message, kind) {
  const error = new Error(message)
  error.kind = kind
  return error
}

const EXTRACT = (handle) => String.raw`(() => {
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim()
  const html = document.documentElement.innerHTML
  let avatar = ''
  for (const img of document.querySelectorAll('img')) {
    if (/profile picture/i.test(img.alt || '')) {
      avatar = img.currentSrc || img.src || ''
      break
    }
  }
  if (!avatar) {
    const owner = '"username":"${handle}"'
    const pics = [...html.matchAll(/"profile_pic_url":"((?:\\.|[^"\\])*)"/g)]
    const pick = pics.find((pic) => html.slice(Math.max(0, pic.index - 1500), pic.index + 1500).toLowerCase().includes(owner)) || pics[0]
    if (pick) {
      try { avatar = JSON.parse('"' + pick[1] + '"') } catch { avatar = '' }
    }
  }
  function shortcode(pk) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    let id = BigInt(pk)
    let out = ''
    while (id > 0n) {
      out = alphabet[Number(id % 64n)] + out
      id = id / 64n
    }
    return out
  }
  const images = []
  const seen = new Set()
  const re = /"image_versions2":\{"candidates":(\[[\s\S]*?\])\}/g
  let match
  while ((match = re.exec(html))) {
    let candidates
    try { candidates = JSON.parse(match[1]) } catch { continue }
    if (!candidates.length) continue
    const best = candidates.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a))
    if (!best || !best.url || (best.width || 0) < 600) continue
    // Some smaller candidates are square crops; use one with the full photo's shape so the preview
    // and the zoomed photo always match.
    const ratio = (item) => (item.width || 1) / (item.height || 1)
    const sameShape = candidates.filter((item) => Math.abs(ratio(item) / ratio(best) - 1) < 0.02)
    const feed = (sameShape.length ? sameShape : candidates)
      .filter((item) => item.url && (item.width || 0) >= ${FEED_WIDTH})
      .reduce((a, b) => ((b.width || 0) < (a.width || 0) ? b : a), best)
    const key = best.url.split('?')[0]
    if (seen.has(key) || /2885-19/.test(best.url)) continue
    seen.add(key)
    const before = html.slice(Math.max(0, match.index - 180), match.index)
    const pk = before.match(/"pk":"(\d+)"/)
    const after = html.slice(match.index + match[0].length, match.index + match[0].length + 2500)
    const cap = after.match(/"caption":\{"pk":"[^"]*","text":"((?:\\.|[^"\\])*)"/)
    const product = after.match(/"product_type":"(clips|feed|igtv)"/)
    let alt = ''
    if (cap) {
      try { alt = JSON.parse('"' + cap[1] + '"') } catch { alt = '' }
    }
    images.push({
      src: feed.url,
      full: best.url,
      width: feed.width || 0,
      height: feed.height || 0,
      fullWidth: best.width || 0,
      fullHeight: best.height || 0,
      alt,
      code: pk ? shortcode(pk[1]) : '',
      kind: product && product[1] === 'clips' ? 'reel' : 'p',
    })
  }
  if (!images.length) {
    for (const img of document.querySelectorAll('a[href*="/p/"] img, a[href*="/reel/"] img')) {
      const src = img.currentSrc || img.src || ''
      const key = src.split('?')[0]
      if (!src || seen.has(key) || /2885-19/.test(src)) continue
      seen.add(key)
      images.push({ src, full: src, width: 0, height: 0, alt: img.alt || '' })
    }
  }
  const posts = []
  const seenCode = new Set()
  for (const anchor of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
    const href = anchor.getAttribute('href') || ''
    const match = href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/)
    if (!match || seenCode.has(match[2])) continue
    seenCode.add(match[2])
    posts.push({ kind: match[1], code: match[2] })
  }
  images.forEach((image, index) => {
    const post = posts[index]
    if (!post || image.code) return
    image.code = post.code
    image.kind = post.kind
  })
  const media = []
  const seenPk = new Set()
  for (const found of html.matchAll(/"is_timeline_pinned":(true|false),"pk":"(\d+)"/g)) {
    if (seenPk.has(found[2])) continue
    seenPk.add(found[2])
    media.push({ pk: found[2], code: shortcode(found[2]), pinned: found[1] === 'true' })
  }
  const header = [...document.querySelectorAll('header')].find((el) => /followers/i.test(el.innerText)) || document.querySelector('header')
  const stat = (pattern) => {
    const el = [...(header || document).querySelectorAll('a, li, span, div')].find((node) => pattern.test(clean(node.innerText)))
    return el ? clean(el.innerText) : ''
  }
  const heading = document.querySelector('h2, h1')
  const username = clean(heading && heading.innerText)
  const loose = []
  for (const span of (header || document).querySelectorAll('span')) {
    if (span.closest('a')) continue
    if (span.querySelector('span')) continue
    const text = clean(span.innerText)
    if (!text || text.length > 180 || /followers|following/i.test(text)) continue
    if (!loose.includes(text) && text.toLowerCase() !== username.toLowerCase()) loose.push(text)
  }
  return {
    avatar,
    username,
    name: loose[0] || '',
    bio: loose.slice(1).filter((text) => !/^(more|\.\.\. more)$/i.test(text)).join(' ').replace(/(\.\.\.)?\s*more$/i, '').trim(),
    followers: stat(/^[\d.,]+[KkMm]? followers$/),
    following: stat(/^[\d.,]+[KkMm]? following$/),
    private: /This account is private/i.test(document.body.innerText),
    images,
    posts: media,
  }
})()`

// A single post, read from its logged-out desktop page (the only logged-out page that carries the
// reel's video file and every carousel slide). media_type: 1 photo, 2 video, 8 carousel.
const POST_EXTRACT = (code) => String.raw`(() => {
  const code = ${JSON.stringify(code)}
  const path = location.pathname.toLowerCase()
  if (path.startsWith('/accounts/login') || path.startsWith('/challenge')) return { state: 'login' }
  const text = (document.title + ' ' + ((document.body && document.body.innerText) || '').slice(0, 600))
  if (/isn.t available|page not found|may have been removed/i.test(text)) return { state: 'missing' }
  const found = []
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 60) return
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return }
    if (node.code === code && (node.video_versions || node.carousel_media || node.image_versions2 || node.media_type)) found.push(node)
    for (const key in node) walk(node[key], depth + 1)
  }
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    const content = script.textContent || ''
    if (!content.includes(code)) continue
    try { walk(JSON.parse(content), 0) } catch {}
  }
  if (!found.length) return { state: '' }
  const pick = (key) => found.map((node) => node[key]).find((value) => value != null)
  // The full-shape version that fits in 1080 px (or the smallest at least 1080 wide, or the biggest
  // there is): sharp enough, quick to send. Originals can be 3000 px and several MB each.
  const image = (candidates) => {
    const list = (candidates || []).filter((item) => item && item.url)
    const fitted = list.find((item) => /[?&]stp=dst-[^&]*_p1080x1080/.test(item.url))
    if (fitted) return fitted.url
    const big = list.filter((item) => (item.width || 0) >= 1080).sort((a, b) => a.width - b.width)[0]
    return (big || list.sort((a, b) => (b.width || 0) - (a.width || 0))[0] || {}).url || ''
  }
  return {
    state: 'ready',
    mediaType: Number(pick('media_type')) || 0,
    productType: pick('product_type') || '',
    caption: (pick('caption') || {}).text || '',
    video: ((pick('video_versions') || [])[0] || {}).url || '',
    image: image((pick('image_versions2') || {}).candidates),
    slides: (pick('carousel_media') || []).map((child) => ({
      video: ((child.video_versions || [])[0] || {}).url || '',
      image: image((child.image_versions2 || {}).candidates),
    })),
  }
})()`

const PAGE_STATE = (handle) => `(() => {
  const path = location.pathname.toLowerCase()
  if (path.startsWith('/accounts/login') || path.startsWith('/challenge')) return 'login'
  const text = (document.title + ' ' + ((document.body && document.body.innerText) || '').slice(0, 600))
  if (/isn.t available|page not found|may have been removed/i.test(text)) return 'missing'
  if (/Restricted profile|unavailable for certain audiences/i.test(text)) return 'restricted'
  if (path !== '/${handle}/') return ''
  const header = [...document.querySelectorAll('header')].some((el) => /followers/i.test(el.innerText))
  if (!header) return ''
  const settled = document.querySelectorAll('img').length > 4 || /This account is private|No posts yet/i.test(document.body.innerText)
  return settled ? 'ready' : 'header'
})()`

class Tab {
  constructor(target) {
    this.target = target
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.broken = false
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.target.webSocketDebuggerUrl)
      ws.addEventListener('open', async () => {
        this.ws = ws
        try {
          await this.evaluate('1')
          await this.send('Page.enable')
          await this.send('Network.enable')
          await this.send('Network.setBlockedURLs', {
            urls: ['*.mp4*', '*scontent*.jpg*', '*fbcdn.net*.jpg*', '*.webp*', '*.heic*', '*.woff*'],
          })
          await this.setDesktop(false)
          resolve(this)
        } catch (error) {
          reject(error)
        }
      })
      ws.addEventListener('error', () => {
        this.broken = true
        reject(new Error('Could not connect to the preview browser'))
      })
      ws.addEventListener('close', () => {
        this.broken = true
        for (const waiting of this.pending.values()) waiting.reject(new Error('Preview tab closed'))
        this.pending.clear()
      })
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (message.method === 'Page.javascriptDialogOpening') {
          this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
          return
        }
        if (!message.id || !this.pending.has(message.id)) return
        const waiting = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) waiting.reject(new Error(message.error.message || 'Preview command failed'))
        else waiting.resolve(message.result || {})
      })
    })
  }

  send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (!this.ws || this.broken) return Promise.reject(new Error('Preview tab closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Preview tab stopped responding'))
        this.kill()
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  kill() {
    this.broken = true
    try {
      this.ws.close()
    } catch {}
    devtools('GET', `/json/close/${this.target.id}`).catch(() => {})
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true })
    return result.result ? result.result.value : undefined
  }

  async setDesktop(desktop) {
    await this.send('Network.setUserAgentOverride', { userAgent: desktop ? DESKTOP_USER_AGENT : USER_AGENT })
    await this.send('Emulation.setDeviceMetricsOverride', desktop
      ? { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false }
      : { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  }

  async load(handle) {
    try {
      return await this.visit(handle)
    } catch (error) {
      if (error.kind !== 'restricted') throw error
    }
    await this.setDesktop(true)
    try {
      return await this.visit(handle)
    } finally {
      await this.setDesktop(false).catch(() => {})
    }
  }

  async loadPost(code) {
    await this.setDesktop(true)
    try {
      await this.send('Page.navigate', { url: `https://www.instagram.com/p/${code}/` }, LOAD_TIMEOUT_MS + 5000)
      const started = Date.now()
      let post = null
      while (Date.now() - started < LOAD_TIMEOUT_MS) {
        post = await this.evaluate(POST_EXTRACT(code))
        if (post && post.state) break
        await sleep(150)
      }
      if (post?.state === 'missing') throw profileError('This post no longer exists.', 'missing')
      if (post?.state === 'login') throw profileError('Instagram asked for a login on this post.', 'login')
      if (post?.state !== 'ready') throw profileError('Could not read this post.', 'read')
      delete post.state
      return post
    } finally {
      await this.setDesktop(false).catch(() => {})
    }
  }

  async visit(handle) {
    await this.send('Page.navigate', { url: `https://www.instagram.com/${handle}/` }, LOAD_TIMEOUT_MS + 5000)
    const started = Date.now()
    let state = ''
    let headerAt = 0
    while (Date.now() - started < LOAD_TIMEOUT_MS) {
      state = await this.evaluate(PAGE_STATE(handle))
      if (state === 'ready' || state === 'missing' || state === 'login' || state === 'restricted') break
      if (state === 'header') {
        if (!headerAt) headerAt = Date.now()
        if (Date.now() - headerAt > 2500) break
      }
      await sleep(60)
    }
    if (state === 'missing') throw profileError('This Instagram profile does not exist anymore.', 'missing')
    if (state === 'restricted') throw profileError('Instagram only shows this profile to logged-in accounts, so there is no preview.', 'restricted')
    if (state === 'login') throw profileError('Instagram asked for a login on this profile.', 'login')
    if (state !== 'ready' && state !== 'header') throw profileError('Instagram took too long to answer.', 'timeout')
    const profile = await this.evaluate(EXTRACT(handle))
    if (!profile || !profile.images) throw profileError('Could not read this profile.', 'read')
    return profile
  }
}

class Preview {
  constructor() {
    this.loginWallUntil = 0
    this.cache = new Map()
    this.jobs = []
    this.byHandle = new Map()
    this.tabs = []
    this.idle = []
    this.starting = null
  }

  forget(username) {
    const handle = String(username || '').replace(/^@/, '').trim().toLowerCase()
    this.cache.delete(handle)
  }

  profile(username, urgent = false) {
    const handle = String(username || '').replace(/^@/, '').trim().toLowerCase()
    if (!/^[a-z0-9._]+$/.test(handle)) {
      return Promise.reject(profileError('This row has no Instagram username.', 'missing'))
    }
    const cached = this.cache.get(handle)
    if (cached) {
      const fresh = Date.now() - cached.at < (cached.error ? MISSING_MS : CACHE_MS)
      if (fresh) return cached.error ? Promise.reject(cached.error) : Promise.resolve(cached.profile)
      this.cache.delete(handle)
    }
    return this.queue(handle, urgent, async (tab) => {
      try {
        const profile = await this.loadWithRetry(tab, handle)
        this.cache.set(handle, { profile, at: Date.now() })
        while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value)
        return profile
      } catch (error) {
        if (error.kind === 'missing' || error.kind === 'restricted') this.cache.set(handle, { error, at: Date.now() })
        throw error
      }
    })
  }

  // The full post behind a shortcode: caption, video file, every carousel slide.
  post(code) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(code || ''))) return Promise.reject(profileError('This post has no usable link.', 'read'))
    const key = `post:${code}`
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.post)
    return this.queue(key, true, async (tab) => {
      let post
      try {
        post = await tab.loadPost(code)
      } catch (error) {
        if (tab.broken || !['read', 'login'].includes(error.kind)) throw error
        await tab.send('Page.navigate', { url: 'about:blank' }).catch(() => {})
        await sleep(400)
        post = await tab.loadPost(code)
      }
      this.cache.set(key, { post, at: Date.now() })
      return post
    })
  }

  // Until when logged-out viewing is paused after a login wall (0 when it isn't).
  loginWall() {
    return this.loginWallUntil > Date.now() ? this.loginWallUntil : 0
  }

  queue(key, urgent, work) {
    const wall = this.loginWall()
    if (wall) {
      const at = new Date(wall).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
      return Promise.reject(profileError(`Instagram is limiting logged-out viewing from this internet connection for a few minutes (this is not your account). Try again after ${at}.`, 'login'))
    }
    const existing = this.byHandle.get(key)
    if (existing) {
      if (urgent && !existing.running) {
        this.jobs = this.jobs.filter((job) => job !== existing)
        this.jobs.unshift(existing)
      }
      return existing.promise
    }
    const job = { handle: key, work, running: false }
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve
      job.reject = reject
    })
    this.byHandle.set(key, job)
    if (urgent) this.jobs.unshift(job)
    else this.jobs.push(job)
    this.pump()
    return job.promise
  }

  async pump() {
    try {
      await this.ensureTabs()
    } catch (error) {
      for (const job of this.jobs.splice(0)) {
        this.byHandle.delete(job.handle)
        job.reject(error)
      }
      return
    }
    while (this.idle.length && this.jobs.length) {
      const tab = this.idle.shift()
      const job = this.jobs.shift()
      this.run(tab, job)
    }
  }

  async loadWithRetry(tab, handle) {
    try {
      return await tab.load(handle)
    } catch (error) {
      if (tab.broken || !['timeout', 'read', 'login', undefined].includes(error.kind)) throw error
      await tab.send('Page.navigate', { url: 'about:blank' }).catch(() => {})
      await sleep(400)
      return tab.load(handle)
    }
  }

  async run(tab, job) {
    job.running = true
    try {
      job.resolve(await job.work(tab))
    } catch (error) {
      if (error.kind === 'login') this.loginWallUntil = Date.now() + LOGIN_WALL_MS
      if (!error.kind) error.kind = 'server'
      job.reject(error)
    } finally {
      this.byHandle.delete(job.handle)
      if (tab.broken) {
        this.tabs = this.tabs.filter((item) => item !== tab)
      } else {
        this.idle.push(tab)
      }
      this.pump()
    }
  }

  ensureTabs() {
    const healthy = this.tabs.filter((tab) => !tab.broken)
    if (healthy.length >= TABS) return Promise.resolve()
    if (!this.starting) {
      this.starting = this.openTabs().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  async openTabs() {
    await this.ensureChrome()
    this.tabs = this.tabs.filter((tab) => !tab.broken)
    this.idle = this.idle.filter((tab) => !tab.broken)
    const used = new Set(this.tabs.map((tab) => tab.target.id))
    const pages = (await devtools('GET', '/json/list')).filter((item) => item.type === 'page' && !used.has(item.id))
    for (let attempt = 0; this.tabs.length < TABS; attempt++) {
      if (attempt > TABS * 3) throw new Error('Could not open a browser tab for the profile preview')
      const target = pages.shift() || await devtools('PUT', '/json/new?about:blank')
      const tab = new Tab(target)
      try {
        await tab.open()
      } catch {
        tab.kill()
        continue
      }
      this.tabs.push(tab)
      this.idle.push(tab)
    }
  }

  async ensureChrome() {
    if (await this.debuggerUp()) return
    const child = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--window-size=390,844',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { stdio: 'ignore' })
    child.unref()
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await this.debuggerUp()) return
      await sleep(150)
    }
    throw new Error('Could not open a browser for the profile preview')
  }

  debuggerUp() {
    return devtools('GET', '/json/version').then(() => true).catch(() => false)
  }

  // Photos and videos from Instagram's CDN. Resolves { mime, data (base64), buffer, bytes }.
  downloadImage(src, maxBytes = 15 * 1024 * 1024) {
    const read = (target, redirects) => new Promise((resolve, reject) => {
      let parsed
      try { parsed = new URL(target) } catch { reject(new Error('Bad image address')); return }
      const host = parsed.hostname
      if (!host.endsWith('cdninstagram.com') && !host.endsWith('fbcdn.net') && host !== 'www.instagram.com') {
        reject(new Error('Blocked image address'))
        return
      }
      const request = https.get(parsed, {
        agent,
        headers: { Referer: 'https://www.instagram.com/', 'User-Agent': USER_AGENT },
      }, (upstream) => {
        if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location && redirects < 3) {
          upstream.resume()
          resolve(read(new URL(upstream.headers.location, parsed).toString(), redirects + 1))
          return
        }
        const chunks = []
        let bytes = 0
        upstream.on('data', (chunk) => {
          bytes += chunk.length
          chunks.push(chunk)
          if (bytes > maxBytes) {
            request.destroy()
            reject(Object.assign(new Error('This file is too big to read.'), { kind: 'too-big' }))
          }
        })
        upstream.on('end', () => {
          if (bytes > maxBytes) return
          if (upstream.statusCode !== 200) return reject(new Error('Could not download the post.'))
          const buffer = Buffer.concat(chunks)
          resolve({ mime: String(upstream.headers['content-type'] || 'image/jpeg').split(';')[0], data: buffer.toString('base64'), buffer, bytes })
        })
      })
      request.on('error', reject)
    })
    return read(src, 0)
  }

  streamImage(src, res) {
    let parsed
    try {
      parsed = new URL(src)
    } catch {
      return Promise.reject(new Error('Bad image address'))
    }
    const host = parsed.hostname
    if (!host.endsWith('cdninstagram.com') && !host.endsWith('fbcdn.net')) {
      return Promise.reject(new Error('Blocked image address'))
    }
    return new Promise((resolve, reject) => {
      const request = https.get(parsed, {
        agent,
        headers: {
          Referer: 'https://www.instagram.com/',
          'User-Agent': USER_AGENT,
        },
      }, (upstream) => {
        if (upstream.statusCode !== 200) {
          upstream.resume()
          reject(new Error('Image failed'))
          return
        }
        res.writeHead(200, {
          'Content-Type': upstream.headers['content-type'] || 'image/jpeg',
          'Cache-Control': 'private, max-age=86400, immutable',
        })
        upstream.pipe(res)
        upstream.on('end', resolve)
      })
      request.on('error', reject)
      res.on('close', () => request.destroy())
    })
  }
}

module.exports = new Preview()

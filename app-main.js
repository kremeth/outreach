// Outreach: one window. The To do UI (served by server.js) on the left, a logged-in Instagram
// panel on the right. Comments, likes, DMs and voicenotes all run in that panel; server.js asks
// for them over a small local control port.
const { app, BaseWindow, WebContentsView, ipcMain, session, shell, powerSaveBlocker } = require('electron')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const ig = require('./app/instagram')
const voice = require('./app/voice')
const guard = require('./lib/ig-guard')
const log = require('./lib/shared-log')

const ROOT = __dirname
const SERVER_PORT = Number(process.env.PORT) || 8787
const CONTROL_PORT = SERVER_PORT + 3
const UI_URL = `http://127.0.0.1:${SERVER_PORT}/`
const PANEL_MIN = 480
const PANEL_CSS_WIDTH = 840
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const LOG_PATH = path.join(ROOT, 'data', 'server.log')

let win = null
let ui = null
let panel = null
let server = null
let panelTask = ''
let panelHidden = false
let quitting = false

app.userAgentFallback = CHROME_UA
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')
// Outreach often runs on another desktop or behind other apps: never slow down or pause its pages.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

// macOS App Nap pauses apps whose windows have been out of sight for a while (another desktop),
// which freezes the Instagram page. Turn it off for this app (takes effect from the next launch;
// the Dock app also has LSAppNapIsDisabled in its Info.plist).
if (process.platform === 'darwin' && process.env.__CFBundleIdentifier) {
  try {
    spawnSync('defaults', ['write', process.env.__CFBundleIdentifier, 'NSAppSleepDisabled', '-bool', 'YES'])
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function serverUp(timeout = 1500) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port: SERVER_PORT, path: '/api/hustle/status', timeout }, (response) => {
      response.resume()
      resolve(response.statusCode === 200)
    })
    request.on('error', () => resolve(false))
    request.on('timeout', () => {
      request.destroy()
      resolve(false)
    })
  })
}

// server.js needs a real Node (22+), not Electron's built-in one.
function nodeBinary() {
  if (process.env.OUTREACH_NODE) return process.env.OUTREACH_NODE
  for (const args of [['-lc', 'command -v node'], ['-ilc', 'command -v node']]) {
    const found = spawnSync('/bin/zsh', args, { encoding: 'utf8', timeout: 8000 })
    const line = String(found.stdout || '').trim().split('\n').pop()
    if (line && fs.existsSync(line)) return line
  }
  return 'node'
}

// The two secret files are not in the repo; each computer gets them privately (see README).
function missingSecrets() {
  return ['google-service-account.json', 'gemini-key.txt'].filter((name) => !fs.existsSync(path.join(ROOT, 'data', name)))
}

async function ensureServer() {
  if (await serverUp()) return
  const missing = missingSecrets()
  if (missing.length) {
    throw new Error(`Outreach is missing ${missing.map((name) => `data/${name}`).join(' and ')}. Ask your co-founder for ${missing.length === 1 ? 'it' : 'them'}, put ${missing.length === 1 ? 'it' : 'them'} in the data folder, then open Outreach again.`)
  }
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
  const log = fs.openSync(LOG_PATH, 'a')
  fs.writeSync(log, `\n[${new Date().toISOString()}] starting server\n`)
  server = spawn(nodeBinary(), [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: ['ignore', log, log] })
  const child = server
  child.on('exit', (code, signal) => {
    try { fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] server stopped (code ${code}, signal ${signal})\n`) } catch {}
    // Bring it back unless Outreach itself is quitting.
    if (!quitting && server === child) setTimeout(() => ensureServer().catch((error) => console.error(error)), 2000)
  })
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await serverUp()) return
    if (server.exitCode !== null) throw new Error(`The server stopped while starting. See ${LOG_PATH}.`)
    await sleep(500)
  }
  throw new Error(`The server did not start. See ${LOG_PATH}.`)
}

// If the server stops answering for about a minute while its process is still alive (frozen), restart it.
function watchServer() {
  let misses = 0
  setInterval(async () => {
    if (quitting) return
    if (await serverUp(10000)) {
      misses = 0
      return
    }
    misses++
    if (misses < 4 || !server || server.exitCode !== null) return
    misses = 0
    try { fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] server not answering, restarting it\n`) } catch {}
    server.kill('SIGKILL')
  }, 20000)
}

function layout() {
  if (!win || win.isDestroyed()) return
  const { width, height } = win.getContentBounds()
  const panelWidth = Math.max(PANEL_MIN, Math.round(width * 0.4))
  panel.setBounds({ x: width - panelWidth, y: 0, width: panelWidth, height })
  // Prospecting gets the whole window by laying the UI over the panel. The panel is never hidden:
  // a hidden Instagram page defers clicks (a Like tap would not go out until it is shown again).
  if (panelHidden) {
    ui.setBounds({ x: 0, y: 0, width, height })
    win.contentView.addChildView(ui)
  } else {
    ui.setBounds({ x: 0, y: 0, width: Math.max(0, width - panelWidth), height })
  }
  // Instagram only shows the inline comment box in its desktop layout (about 830 CSS px and up).
  panel.webContents.setZoomFactor(Math.max(0.6, Math.min(1, panelWidth / PANEL_CSS_WIDTH)))
}

function isInstagram(url) {
  return /^https:\/\/(www\.)?(instagram\.com|ig\.me)\//i.test(url)
}

function createWindow() {
  const partition = 'persist:instagram'
  const igSession = session.fromPartition(partition)
  igSession.setUserAgent(CHROME_UA)
  igSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...(details.responseHeaders || {}) }
    for (const key of Object.keys(headers)) {
      if (/content-security-policy/i.test(key)) delete headers[key]
    }
    callback({ responseHeaders: headers })
  })
  igSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'media'))

  win = new BaseWindow({
    width: 1560,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    title: 'Outreach',
    backgroundColor: '#f6f6f3',
  })
  // Not slowed down in the background either: the To do page keeps its live numbers up to date.
  ui = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  panel = new WebContentsView({
    webPreferences: {
      preload: path.join(ROOT, 'record-preload-ig.js'),
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Keeps Instagram running normally when the window is minimised or behind other apps.
      backgroundThrottling: false,
    },
  })
  try { ui.setBackgroundColor('#f6f6f3') } catch {}
  try { panel.setBackgroundColor('#ffffff') } catch {}
  win.contentView.addChildView(ui)
  win.contentView.addChildView(panel)

  // Instagram links from the UI open in the panel; anything else (the Google Sheet) in the default browser.
  ui.webContents.setWindowOpenHandler(({ url }) => {
    if (isInstagram(url)) {
      if (!voice.active() && !panelTask) ig.openUrl(panel.webContents, url).catch(() => {})
    } else if (/^https?:/i.test(url)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) panel.webContents.loadURL(url).catch(() => {})
    return { action: 'deny' }
  })

  const followRoute = (_event, url) => {
    const hidden = /#\/prospect/.test(url)
    if (hidden !== panelHidden) {
      panelHidden = hidden
      layout()
    }
  }
  ui.webContents.on('did-navigate', followRoute)
  ui.webContents.on('did-navigate-in-page', followRoute)

  // Watchdog: a checkpoint, challenge or suspension page anywhere in the panel stops every computer.
  const watch = (_event, url) => {
    if (!guard.isWarningUrl(url)) return
    accountId().then((account) => guard.trip(account, `Instagram opened ${new URL(url).pathname}`)).catch((error) => console.error(error))
  }
  panel.webContents.on('did-navigate', watch)
  panel.webContents.on('did-navigate-in-page', watch)

  // The keyboard: while Outreach is working in the Instagram panel (sending, commenting, reading...), a
  // real key press never reaches Instagram, only Outreach's own; the keyboard goes back to the Outreach
  // page the person was typing in. When the panel is idle, typing in it by hand works as usual.
  panel.webContents.on('before-input-event', (event, input) => {
    if (!panelTask && !voice.active?.()) return
    if (ig.ownKeys()) return
    if (input.type !== 'keyDown' && input.type !== 'keyUp' && input.type !== 'char' && input.type !== 'rawKeyDown') return
    event.preventDefault()
    if (!ui || ui.webContents.isDestroyed()) return
    if (!ui.webContents.isFocused()) ui.webContents.focus()
    // The key itself is passed on to the Outreach page, so nothing the person typed is lost.
    const modifiers = [input.shift && 'shift', input.control && 'control', input.alt && 'alt', input.meta && 'meta'].filter(Boolean)
    if (input.type === 'keyUp') ui.webContents.sendInputEvent({ type: 'keyUp', keyCode: input.key, modifiers })
    else if (input.type === 'keyDown' || input.type === 'rawKeyDown') {
      ui.webContents.sendInputEvent({ type: 'keyDown', keyCode: input.key, modifiers })
      if (input.key.length === 1 && !input.control && !input.meta) ui.webContents.sendInputEvent({ type: 'char', keyCode: input.key, modifiers })
    }
  })

  ipcMain.on('voice-state', (event, state) => {
    if (event.sender === panel.webContents) voice.onVoiceState(state)
  })

  win.on('resize', layout)
  panel.webContents.on('did-finish-load', layout)
  win.on('closed', () => app.quit())
  layout()
  win.center()
  ui.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<body style="margin:0;display:grid;place-items:center;height:100vh;background:#f6f6f3;color:#6b6b64;font:15px -apple-system,sans-serif">Starting Outreach…</body>')}`)
  panel.webContents.loadURL('https://www.instagram.com/').catch(() => {})
}

// The scraper account (a second Instagram account, logged in by the person in its own window, its own
// session: never the outreach account). Its window opens on request; the scraper reads Instagram's own
// web API from inside that logged-in page (same requests the site makes), one at a time.
// Several scraper accounts (1, 2...), each in its own window and session ('persist:scraper' for the
// first, 'persist:scraper2' for the second...), each reading one thing at a time.
const scraperPartition = (account) => (account > 1 ? `persist:scraper${account}` : 'persist:scraper')
let appQuitting = false
app.on('before-quit', () => { appQuitting = true })
const scrapers = {}
// Each scraper account's @username, by its Instagram id (looked up once).
const scraperNames = {}
let scraperNameError = ''
function scraperOf(account) {
  account = Math.max(1, Math.min(9, Number(account) || 1))
  if (!scrapers[account]) scrapers[account] = { account, win: null, view: null, busy: false, followingRead: null, progress: { username: '', loaded: 0, at: 0, reading: false } }
  return scrapers[account]
}

function openScraper(account = 1, show = true) {
  const scraper = scraperOf(account)
  if (scraper.win && !scraper.win.isDestroyed()) {
    if (show) scraper.win.show()
    return scraper.view.webContents
  }
  const partition = scraperPartition(scraper.account)
  session.fromPartition(partition).setUserAgent(CHROME_UA)
  scraper.win = new BaseWindow({ width: 900, height: 900, title: `Outreach · scraper account ${scraper.account}`, show })
  scraper.view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  scraper.win.contentView.addChildView(scraper.view)
  const fit = () => {
    const [width, height] = scraper.win.getContentSize()
    scraper.view.setBounds({ x: 0, y: 0, width, height })
  }
  scraper.win.on('resize', fit)
  fit()
  scraper.win.on('close', (event) => {
    // Closing only hides it (the scraper keeps its page), except when Outreach itself is quitting.
    if (appQuitting) return
    event.preventDefault()
    scraper.win.hide()
  })
  scraper.view.webContents.loadURL('https://www.instagram.com/').catch(() => {})
  return scraper.view.webContents
}

async function scraperAccount(account = 1) {
  const cookies = await session.fromPartition(scraperPartition(Math.max(1, Number(account) || 1))).cookies.get({ url: 'https://www.instagram.com', name: 'ds_user_id' })
  return cookies[0]?.value || ''
}

const scraperUi = require('./app/scraper')

// The logged-in Instagram account (its numeric id), so limits are counted per account across computers.
async function accountId() {
  const cookies = await session.fromPartition('persist:instagram').cookies.get({ url: 'https://www.instagram.com', name: 'ds_user_id' })
  return cookies[0]?.value || ''
}

// One Instagram action at a time (comment, DM or voicenote), always through
// the safety gate: shared limits, the cross-computer account lock, then a record of the attempt.
// Instagram must see its page as visible, or it defers what we click. If the window was minimised,
// bring it back without stealing focus.
// A paused page answers slowly or not at all, so the check itself has a time limit. A panel that
// stays paused is 'hidden': nothing was clicked, and Launch simply tries again a little later.
async function ensurePanelLive() {
  const state = () => Promise.race([
    panel.webContents.executeJavaScript('document.visibilityState', true).catch(() => 'hidden'),
    sleep(3000).then(() => 'hidden'),
  ])
  if ((await state()) === 'visible') return
  if (win.isMinimized()) win.restore()
  win.showInactive()
  panel.webContents.invalidate()
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(400)
    if ((await state()) === 'visible') return
  }
  // Still not live: the panel's page is stuck (blank or frozen renderer). Reloaded, at most every 5
  // minutes, so Launch never sits on a dead panel.
  if (Date.now() - lastPanelReload > 5 * 60 * 1000) {
    lastPanelReload = Date.now()
    console.log('Instagram panel stuck: reloading it')
    if (panel.webContents.isCrashed()) panel.webContents.reload()
    else panel.webContents.loadURL('https://www.instagram.com/').catch(() => {})
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(500)
      if ((await state()) === 'visible') return
    }
  }
  throw Object.assign(new Error('macOS paused the Instagram panel, so nothing was clicked. It will try again shortly.'), { kind: 'hidden' })
}
let lastPanelReload = 0

// describe(result, failure) says what to record in the shared log: { target, detail }, or null for nothing.
async function inPanel(kind, label, describe, task) {
  if (panelTask) throw Object.assign(new Error(`Instagram is busy (${panelTask}). Try again in a moment.`), { kind: 'busy' })
  panelTask = label
  // The person typing in Outreach keeps (gets back) the keyboard once the panel is done.
  const uiHadFocus = Boolean(ui && !ui.webContents.isDestroyed() && ui.webContents.isFocused())
  try {
    await ensurePanelLive()
    const account = await accountId()
    if (!account) throw Object.assign(new Error('Instagram is not logged in. Log in inside the Instagram panel first.'), { kind: 'login' })
    await guard.check(kind, account)
    await guard.lock(account)
    let result = null
    let failure = null
    try {
      result = await task(panel.webContents, account)
    } catch (error) {
      failure = error
    }
    const reachedInstagram = !failure || !['missing', 'unreachable', 'duplicate', 'login', 'busy', 'replied', 'mismatch', 'hidden'].includes(failure.kind)
    const outcome = !failure ? '' : failure.kind === 'notsent' ? ' notsent' : ' failed'
    // describe can name several actions (Message 2: two voicenotes back to back).
    const entries = reachedInstagram ? [].concat(describe(result, failure) || []) : []
    for (const entry of entries) await guard.record(kind, account, entry.target, `${entry.detail}${outcome}`).catch((error) => console.error(error))
    if (failure?.kind === 'blocked') await guard.trip(account, failure.message).catch((error) => console.error(error))
    if (failure) throw failure
    return result
  } finally {
    panelTask = ''
    if (uiHadFocus && ui && !ui.webContents.isDestroyed()) ui.webContents.focus()
  }
}

async function guardStatus() {
  await log.refresh(3000)
  const account = await accountId()
  return { ...guard.status(account), now: Date.now(), machine: log.MACHINE, loggedIn: Boolean(account) }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

// While Launch is running, keep the Mac and its display awake: a sleeping display makes Instagram
// treat the page as hidden (clicks are deferred and voicenote waveforms come out flat).
let awake = null
function keepAwakeWhileLaunched() {
  const check = () => {
    const request = http.get({ host: '127.0.0.1', port: SERVER_PORT, path: '/api/autopilot/running', timeout: 5000 }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        let running = false
        try { running = JSON.parse(body).running } catch {}
        if (running && awake === null) awake = [powerSaveBlocker.start('prevent-display-sleep'), powerSaveBlocker.start('prevent-app-suspension')]
        if (!running && awake !== null) {
          for (const id of awake) powerSaveBlocker.stop(id)
          awake = null
        }
      })
    })
    request.on('error', () => {})
    request.on('timeout', () => request.destroy())
  }
  setInterval(check, 30000)
  check()
}

function startControl() {
  const control = http.createServer(async (req, res) => {
    const reply = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    // Only server.js talks to this port. Browsers add an Origin header, so this blocks web pages from posting here.
    if (req.headers.origin) return reply(403, { error: 'Forbidden' })
    try {
      const url = new URL(req.url, `http://127.0.0.1:${CONTROL_PORT}`)
      const body = req.method === 'POST' ? await readBody(req) : {}
      if (url.pathname === '/health') return reply(200, { ok: true, panelTask, voice: voice.getStatus().phase })
      if (url.pathname === '/guard') return reply(200, await guardStatus())
      if (url.pathname === '/comment' && body.dryRun) return reply(200, await ig.comment(panel.webContents, body))
      if (url.pathname === '/comment') {
        return reply(200, await inPanel('comment', 'posting a comment', () => ({ target: body.username || '', detail: body.pk || body.permalink }), (wc) => ig.comment(wc, body)))
      }
      if (url.pathname === '/dm') {
        // A reply to someone who wrote to us has its own allowance (answer); outreach DMs count as dm.
        return reply(200, await inPanel(body.detail === 'reply' ? 'answer' : 'dm', 'sending a DM', () => ({ target: body.username || '', detail: body.detail || 'dm' }), (wc) => ig.dm(wc, body)))
      }
      if (url.pathname === '/unfollow') {
        // Counted only once Unfollow was tapped; reading the chat or a profile we don't follow is not an action.
        const describe = (result, failure) => (result?.unfollowed || failure ? { target: body.username || '', detail: `close:${body.sheetRow || ''}` } : null)
        return reply(200, await inPanel('unfollow', 'unfollowing', describe, (wc) => ig.unfollow(wc, body)))
      }
      // An ongoing conversation that went quiet: the chat read only (no action), then, when due, a reply
      // relaunch (a DM: counted and paced like the other relaunches).
      if (url.pathname === '/chat-state') {
        if (panelTask) return reply(409, { error: `Instagram is busy (${panelTask}).`, kind: 'busy' })
        panelTask = 'reading a chat'
        try {
          await ensurePanelLive()
          return reply(200, await ig.chatState(panel.webContents, body))
        } finally {
          panelTask = ''
        }
      }
      // Their voicenotes' audio (read only, panel muted), downloaded with the panel's own session, for
      // Gemini to transcribe.
      if (url.pathname === '/voice-audio') {
        if (panelTask) return reply(409, { error: `Instagram is busy (${panelTask}).`, kind: 'busy' })
        panelTask = 'reading voicenotes'
        try {
          await ensurePanelLive()
          const result = await ig.voiceAudio(panel.webContents, body)
          const igSession = session.fromPartition('persist:instagram')
          for (const voice of result.voices) {
            if (!voice.url) continue
            try {
              const response = await igSession.fetch(voice.url)
              const buffer = Buffer.from(await response.arrayBuffer())
              if (response.ok && buffer.length > 1000 && buffer.length < 20 * 1024 * 1024) {
                voice.audio = buffer.toString('base64')
                voice.mime = (response.headers.get('content-type') || 'audio/mp4').split(';')[0]
              }
            } catch (error) {
              voice.error = error.message
            }
          }
          return reply(200, result)
        } finally {
          panelTask = ''
        }
      }
      if (url.pathname === '/inbox-state') {
        if (panelTask) return reply(409, { error: `Instagram is busy (${panelTask}).`, kind: 'busy' })
        panelTask = 'reading the inbox'
        try {
          await ensurePanelLive()
          return reply(200, await ig.inboxState(panel.webContents, body))
        } finally {
          panelTask = ''
        }
      }
      if (url.pathname === '/inbox-open') {
        if (panelTask) return reply(409, { error: `Instagram is busy (${panelTask}).`, kind: 'busy' })
        panelTask = 'reading a chat'
        try {
          await ensurePanelLive()
          return reply(200, await ig.openInboxRow(panel.webContents, body))
        } finally {
          panelTask = ''
        }
      }
      if (url.pathname === '/our-stories') {
        if (panelTask) return reply(409, { error: `Instagram is busy (${panelTask}).`, kind: 'busy' })
        panelTask = 'looking at our stories'
        try {
          await ensurePanelLive()
          return reply(200, await ig.ourStories(panel.webContents, body))
        } finally {
          panelTask = ''
        }
      }
      // Likes their latest message (from the DMs to reply list): a reply action, in the replies' allowance.
      if (url.pathname === '/like-last') {
        if (body.dryRun) return reply(200, await inPanel('answer', 'finding a message to like', () => null, (wc) => ig.likeLast(wc, body)))
        const describe = (result, failure) => (result?.already ? null : { target: body.username || '', detail: 'like-message' })
        return reply(200, await inPanel('answer', 'liking a message', describe, (wc) => ig.likeLast(wc, body)))
      }
      // Reacts to one of their messages (from the DMs to reply list): a reply action.
      if (url.pathname === '/react') {
        const describe = (result) => (result?.already ? null : { target: body.username || '', detail: `react:${body.emoji || ''}` })
        return reply(200, await inPanel('answer', 'reacting to a message', describe, (wc) => ig.react(wc, body)))
      }
      if (url.pathname === '/reply-relaunch') {
        const describe = () => ({ target: body.username || '', detail: `reply${Number(body.step) === 2 ? 2 : 1}:${body.sheetRow || ''}` })
        return reply(200, await inPanel('dm', 'sending a reply relaunch', describe, (wc) => ig.replyRelaunch(wc, body)))
      }
      // A scraper account (body.account, 1 by default): open its window (to log in), hide it, how far
      // its list read has got, whether it is logged in.
      if (url.pathname === '/scraper/open') {
        openScraper(body.account, true)
        return reply(200, { ok: true })
      }
      // Out of sight while it scrapes (it runs the same hidden; it is only shown to log in or verify).
      if (url.pathname === '/scraper/hide') {
        const scraper = scraperOf(body.account)
        if (scraper.win && !scraper.win.isDestroyed() && scraper.win.isVisible()) scraper.win.hide()
        return reply(200, { ok: true })
      }
      if (url.pathname === '/scraper/progress') return reply(200, scraperOf(body.account).progress)
      if (url.pathname === '/scraper/status') {
        const id = await scraperAccount(body.account)
        const outreach = await accountId()
        // Its @username (for the card): asked once from inside its own window, then remembered.
        let username = scraperNames[id] || ''
        if (id && !username && body.withName) {
          try {
            const wc = openScraper(body.account, false)
            // The page loaded first (a window just opened is still loading).
            if (wc.isLoading()) await Promise.race([new Promise((resolve) => wc.once('did-stop-loading', resolve)), new Promise((resolve) => setTimeout(resolve, 15000))])
            // Its own profile link in Instagram's side menu ("Profile"), else Instagram's account info.
            username = await Promise.race([
              wc.executeJavaScript(`(async () => {
                const id = '${id}'
                const notes = []
                // 1. In the page's own data: the logged-in account's username next to its id.
                const html = document.documentElement.innerHTML
                const near = html.match(new RegExp('"username":"([A-Za-z0-9._]+)"[^{}]{0,400}?"(?:pk|id|pk_id)":"' + id + '"')) || html.match(new RegExp('"(?:pk|id|pk_id)":"' + id + '"[^{}]{0,400}?"username":"([A-Za-z0-9._]+)"'))
                if (near) return near[1]
                notes.push('no page data')
                // 2. Its profile link in the side menu (by text, label or its picture).
                const link = [...document.querySelectorAll('a[href]')].find((a) => /^profile$/i.test((a.innerText || a.getAttribute('aria-label') || '').trim()) || /profile picture/i.test(a.querySelector('img')?.alt || ''))
                const fromLink = link && (link.getAttribute('href') || '').match(/^\\/([A-Za-z0-9._]+)\\/?$/)
                if (fromLink) return fromLink[1]
                notes.push('no menu link')
                // 3. Instagram's own account endpoint, with the headers the site sends.
                try {
                  const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || ''
                  const response = await fetch('/api/v1/accounts/current_user/?edit=true', { headers: { 'X-IG-App-ID': '936619743392459', 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest', 'X-ASBD-ID': '129477' }, credentials: 'include' })
                  const text = await response.text()
                  const found = text.match(/"username":"([A-Za-z0-9._]+)"/)
                  if (found) return found[1]
                  notes.push('current_user ' + response.status + ' ' + text.slice(0, 120))
                } catch (error) { notes.push('current_user ' + error.message) }
                return '!' + location.href + ' ' + notes.join(' | ')
              })()`),
              new Promise((resolve) => setTimeout(() => resolve(''), 10000)),
            ])
            if (String(username).startsWith('!')) {
              console.error('scraper username lookup:', username)
              scraperNameError = username
              username = ''
            }
            if (username) scraperNames[id] = username
          } catch {}
        }
        return reply(200, { loggedIn: Boolean(id), id, username, sameAsOutreach: Boolean(id && id === outreach), nameError: username ? '' : scraperNameError })
      }
      // A scraper account, driven like a person (app/scraper.js): one profile, or one creator's whole
      // following list. Never the outreach account; one thing at a time per account.
      if (url.pathname === '/scraper/profile' || url.pathname === '/scraper/following') {
        const scraper = scraperOf(body.account)
        const id = await scraperAccount(scraper.account)
        if (!id) return reply(409, { error: 'The scraper account is not logged in.', kind: 'login' })
        if (id === (await accountId())) return reply(409, { error: 'The scraper window is logged into the outreach account. Log into the scraper account there instead.', kind: 'login' })
        // The same creator's list asked again (the server restarted meanwhile): the read in progress, or the
        // one just finished, is handed over, so a list is never read twice.
        if (url.pathname === '/scraper/following' && scraper.followingRead?.username === body.username) {
          if (scraper.followingRead.promise) return reply(200, await scraper.followingRead.promise)
          if (scraper.followingRead.result && Date.now() - scraper.followingRead.at < 12 * 3600 * 1000) return reply(200, scraper.followingRead.result)
        }
        if (scraper.busy) return reply(409, { error: 'The scraper is busy.', kind: 'busy' })
        scraper.busy = true
        try {
          const wc = openScraper(scraper.account, false)
          if (url.pathname === '/scraper/profile') return reply(200, await scraperUi.profile(wc, body))
          scraper.progress = { username: body.username, loaded: 0, at: Date.now(), reading: true }
          const promise = scraperUi.following(wc, body, (loaded) => { scraper.progress = { username: body.username, loaded, at: Date.now(), reading: true } })
          scraper.followingRead = { username: body.username, promise }
          let result
          try {
            result = await promise
          } catch (error) {
            scraper.followingRead = null
            scraper.progress = { ...scraper.progress, reading: false }
            throw error
          }
          scraper.followingRead = { username: body.username, result, at: Date.now() }
          scraper.progress = { username: body.username, loaded: (result.usernames || []).length, at: Date.now(), reading: false }
          return reply(200, result)
        } finally {
          scraper.busy = false
        }
      }
      // Read-only look at a chat (no action, nothing sent), to build on.
      if (url.pathname === '/probe-chat') {
        if (panelTask) return reply(409, { error: `Instagram is busy (${panelTask}).`, kind: 'busy' })
        panelTask = 'reading a chat'
        try {
          await ensurePanelLive()
          return reply(200, await ig.probeChat(panel.webContents, body))
        } finally {
          panelTask = ''
        }
      }
      if (url.pathname === '/voice/reply') {
        // One record per voicenote that went out (or was attempted).
        const describe = (result, failure) => {
          if (!result?.sent && !failure) return null
          const names = [].concat(body.clipNames && body.clipNames.length ? body.clipNames : body.clipName)
          const count = result?.parts || Math.max(1, failure?.sentParts || 0)
          return names.slice(0, count).map((name) => ({ target: body.username || '', detail: `voice-reply:${name || ''}` }))
        }
        return reply(200, await inPanel('answerVoice', 'sending a voicenote reply', describe, (wc, account) => voice.sendReply(account, body)))
      }
      if (url.pathname === '/voice/status') return reply(200, voice.getStatus())
      if (url.pathname === '/voice/next') {
        const describe = (result, failure) => {
          const item = result?.item || failure?.item
          return item && (result?.sent || failure) ? { target: item.username, detail: `voice:${item.sheetRow}` } : null
        }
        return reply(200, await inPanel('voice', 'sending a voicenote', describe, (wc, account) => voice.sendNext(account)))
      }
      reply(404, { error: 'Not found' })
    } catch (error) {
      console.error(error)
      reply(502, { error: error.message || 'Instagram action failed.', kind: error.kind || 'error', waitMs: error.waitMs || 0, thread: error.thread || undefined, sentParts: error.sentParts || 0 })
    }
  })
  control.listen(CONTROL_PORT, '127.0.0.1')
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.focus()
  })
  app.on('before-quit', () => {
    quitting = true
    if (server && server.exitCode === null) server.kill()
  })
  app.whenReady().then(async () => {
    createWindow()
    voice.init({
      webContents: panel.webContents,
      hookSource: fs.readFileSync(path.join(ROOT, 'record-ig-hook.js'), 'utf8'),
      ensureLive: ensurePanelLive,
    })
    startControl()
    try {
      await ensureServer()
      watchServer()
      await ui.webContents.loadURL(UI_URL)
      keepAwakeWhileLaunched()
      // The page never stays blank: a load that failed (the server restarting at that moment) or a page
      // that crashed is loaded again a few seconds later; and every minute, a page with nothing on it is
      // reloaded.
      ui.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
        if (isMainFrame && code !== -3) setTimeout(() => ui.webContents.loadURL(UI_URL).catch(() => {}), 3000)
      })
      ui.webContents.on('render-process-gone', () => setTimeout(() => ui.webContents.loadURL(UI_URL).catch(() => {}), 2000))
      setInterval(async () => {
        const empty = await ui.webContents.executeJavaScript('!document.body || document.body.innerText.trim().length < 20', true).catch(() => true)
        if (empty) ui.webContents.loadURL(UI_URL).catch(() => {})
      }, 60 * 1000).unref?.()
    } catch (error) {
      ui.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<body style="font:15px -apple-system,sans-serif;padding:40px;background:#f6f6f3;color:#111">${error.message}</body>`)}`)
    }
  })
}

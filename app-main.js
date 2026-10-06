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

app.userAgentFallback = CHROME_UA
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function serverUp() {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port: SERVER_PORT, path: '/api/hustle/status', timeout: 1500 }, (response) => {
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
  server = spawn(nodeBinary(), [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: ['ignore', log, log] })
  server.on('exit', (code) => console.log(`server exited ${code}`))
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await serverUp()) return
    if (server.exitCode !== null) throw new Error(`The server stopped while starting. See ${LOG_PATH}.`)
    await sleep(500)
  }
  throw new Error(`The server did not start. See ${LOG_PATH}.`)
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
  ui = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
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

// The logged-in Instagram account (its numeric id), so limits are counted per account across computers.
async function accountId() {
  const cookies = await session.fromPartition('persist:instagram').cookies.get({ url: 'https://www.instagram.com', name: 'ds_user_id' })
  return cookies[0]?.value || ''
}

// One Instagram action at a time (comment, DM or voicenote), always through
// the safety gate: shared limits, the cross-computer account lock, then a record of the attempt.
// Instagram must see its page as visible, or it defers what we click. If the window was minimised,
// bring it back without stealing focus.
async function ensurePanelLive() {
  const state = () => panel.webContents.executeJavaScript('document.visibilityState', true).catch(() => 'hidden')
  if ((await state()) === 'visible') return
  if (win.isMinimized()) win.restore()
  win.showInactive()
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(300)
    if ((await state()) === 'visible') return
  }
  throw Object.assign(new Error('The Instagram panel is not visible, so nothing was clicked. Keep the Outreach window open.'), { kind: 'notsent' })
}

// describe(result, failure) says what to record in the shared log: { target, detail }, or null for nothing.
async function inPanel(kind, label, describe, task) {
  if (panelTask) throw Object.assign(new Error(`Instagram is busy (${panelTask}). Try again in a moment.`), { kind: 'busy' })
  panelTask = label
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
    const reachedInstagram = !failure || !['missing', 'unreachable', 'duplicate', 'login', 'busy', 'replied', 'mismatch'].includes(failure.kind)
    const outcome = !failure ? '' : failure.kind === 'notsent' ? ' notsent' : ' failed'
    const entry = reachedInstagram ? describe(result, failure) : null
    if (entry) await guard.record(kind, account, entry.target, `${entry.detail}${outcome}`).catch((error) => console.error(error))
    if (failure?.kind === 'blocked') await guard.trip(account, failure.message).catch((error) => console.error(error))
    if (failure) throw failure
    return result
  } finally {
    panelTask = ''
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

// While Launch is running, keep the Mac awake so the day's schedule is not cut short by sleep.
let awake = null
function keepAwakeWhileLaunched() {
  const check = () => {
    const request = http.get({ host: '127.0.0.1', port: SERVER_PORT, path: '/api/autopilot/running', timeout: 5000 }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        let running = false
        try { running = JSON.parse(body).running } catch {}
        if (running && awake === null) awake = powerSaveBlocker.start('prevent-app-suspension')
        if (!running && awake !== null) {
          powerSaveBlocker.stop(awake)
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
        return reply(200, await inPanel('dm', 'sending a DM', () => ({ target: body.username || '', detail: body.detail || 'dm' }), (wc) => ig.dm(wc, body)))
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
      reply(502, { error: error.message || 'Instagram action failed.', kind: error.kind || 'error', waitMs: error.waitMs || 0 })
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
    if (server && server.exitCode === null) server.kill()
  })
  app.whenReady().then(async () => {
    createWindow()
    voice.init({
      webContents: panel.webContents,
      hookSource: fs.readFileSync(path.join(ROOT, 'record-ig-hook.js'), 'utf8'),
    })
    startControl()
    try {
      await ensureServer()
      await ui.webContents.loadURL(UI_URL)
      keepAwakeWhileLaunched()
    } catch (error) {
      ui.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<body style="font:15px -apple-system,sans-serif;padding:40px;background:#f6f6f3;color:#111">${error.message}</body>`)}`)
    }
  })
}

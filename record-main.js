const {
  app,
  BaseWindow,
  WebContentsView,
  ipcMain,
  session,
  protocol,
  net,
} = require('electron')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const queue = require('./lib/send-queue')

const FOOTER = 108
const PAUSE_MIN_MS = 75 * 1000
const PAUSE_MAX_MS = 180 * 1000
const SETTLE_BEFORE_SEND_MS = 2500
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'voice',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
])

app.userAgentFallback = CHROME_UA
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')
if (process.env.SEND_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.SEND_DEBUG_PORT)

let win = null
let bar = null
let video = null
let instagram = null
let hookSource = ''
let startTimer = null
let profiles = []
let current = null
let paused = false
let busy = false
let pauseToken = 0

function randomPauseMs() {
  return PAUSE_MIN_MS + Math.floor(Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS + 1))
}

async function waitWhilePaused() {
  while (paused) await sleep(400)
}

async function waitWithCountdown(totalMs, label) {
  const token = ++pauseToken
  const ends = Date.now() + totalMs
  while (Date.now() < ends) {
    if (token !== pauseToken || paused) return false
    const left = Math.max(0, Math.ceil((ends - Date.now()) / 1000))
    pushStatus({
      phase: 'waiting',
      title: status.title,
      text: `${label} ${left}s…`,
      remaining: profiles.length,
      sentToday: queue.sentToday(),
    })
    await sleep(Math.min(1000, ends - Date.now()))
  }
  return token === pauseToken && !paused
}

const status = {
  phase: 'loading',
  text: 'Loading the send queue…',
  detail: '',
  title: 'Voicenote send',
  remaining: 0,
  sentToday: 0,
  dailyLimit: queue.DAILY_LIMIT,
}

function pushStatus(patch) {
  Object.assign(status, patch)
  if (bar && !bar.webContents.isDestroyed()) bar.webContents.send('status', { ...status })
}

function layout() {
  if (!win || win.isDestroyed()) return
  const bounds = win.getContentBounds()
  const width = Math.max(0, Math.round(bounds.width))
  const height = Math.max(0, Math.round(bounds.height))
  const top = Math.max(0, height - FOOTER)
  const left = Math.round(width * 0.38)
  bar.setBounds({ x: 0, y: 0, width, height })
  video.setBounds({ x: 0, y: 0, width: left, height: top })
  instagram.setBounds({ x: left, y: 0, width: Math.max(0, width - left), height: top })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ig(code) {
  return instagram.webContents.executeJavaScript(code, true)
}

async function ensureHook() {
  const ready = await ig('Boolean(window.__loadVoice)').catch(() => false)
  if (!ready) await ig(hookSource)
}

async function playVideo() {
  await video.webContents.executeJavaScript(`
    (async () => {
      const node = document.getElementById('v')
      node.pause()
      node.currentTime = 0
      node.muted = true
      node.volume = 0
      await node.play()
    })()
  `, true)
}

async function pauseVideo() {
  await video.webContents.executeJavaScript(`document.getElementById('v').pause()`, true)
}

let audioPath = ''
let finishing = false

async function loadClip(file) {
  audioPath = file
  const audioB64 = fs.readFileSync(file).toString('base64')
  await video.webContents.loadFile(path.join(__dirname, 'web', 'player.html'))
  await ensureHook()
  return ig(`window.__loadVoice(${JSON.stringify(audioB64)})`)
}

function clock(seconds) {
  const value = Math.max(0, Math.round(seconds || 0))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

function aborted(error) {
  return error?.errno === -3 || /\(-3\)|ERR_ABORTED/.test(error?.message || '')
}

async function openUrl(url) {
  let finished = false
  const loaded = new Promise((resolve) => {
    const done = () => {
      finished = true
      instagram.webContents.removeListener('did-finish-load', done)
      resolve()
    }
    instagram.webContents.on('did-finish-load', done)
  })
  try {
    await instagram.webContents.loadURL(url)
  } catch (error) {
    if (!aborted(error)) throw error
  }
  if (!finished) await loaded
  await sleep(900)
  await ensureHook()
}

async function prepareCurrent() {
  if (!current) {
    pushStatus({
      phase: 'done',
      title: 'Queue empty',
      text: paused ? 'Paused.' : 'No more profiles to message today.',
      detail: '',
      remaining: profiles.length,
      sentToday: queue.sentToday(),
    })
    return
  }

  busy = true
  if (!current.clip) {
    const pick = queue.pickVoice(current.device)
    if (!pick) {
      pushStatus({
        phase: 'error',
        title: `${current.name} · ${current.device}`,
        text: `No voice clip for ${current.device}.`,
        detail: '',
      })
      busy = false
      return
    }
    current.voice = pick.voice
    current.clip = pick.clip
  }

  pushStatus({
    phase: 'preparing',
    title: `${current.name} · ${current.device} · ${current.voice}`,
    text: `Following @${current.username}…`,
    detail: '',
    remaining: profiles.length,
    sentToday: queue.sentToday(),
  })

  try {
    await openUrl(`https://www.instagram.com/${current.username}/`)
    let state = await ig('window.__igPageState()')
    if (state.kind === 'login') throw new Error('Log into Instagram in this window, then click Retry.')
    if (state.kind === 'blocked') throw Object.assign(new Error('Instagram blocked this action.'), { blocked: true, detail: state.text })

    const followed = await ig('window.__followProfile()')
    if (followed.kind === 'blocked' || followed.blocked) throw Object.assign(new Error('Instagram blocked following.'), { blocked: true, detail: followed.text })
    if (followed.click) {
      console.log('follow click', followed.label, followed.x, followed.y)
      await clickInPage(followed.x, followed.y)
      await sleep(1500)
    } else if (!followed.ok && followed.error) console.warn('follow', followed)

    pushStatus({
      phase: 'preparing',
      title: `${current.name} · ${current.device} · ${current.voice}`,
      text: `Opening the DM with @${current.username}…`,
      remaining: profiles.length,
      sentToday: queue.sentToday(),
    })
    await openUrl(`https://ig.me/m/${encodeURIComponent(current.username)}`)
    state = await ig('window.__igPageState()')
    if (state.kind === 'login') throw new Error('Log into Instagram in this window, then click Retry.')
    if (state.kind === 'blocked') throw Object.assign(new Error('Instagram blocked messaging.'), { blocked: true, detail: state.text })

    let composer = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      composer = await ig('window.__composerReady()')
      if (composer?.ok) break
      await sleep(500)
    }
    const canMessage = await ig('window.__canMessage()')
    if (canMessage.kind === 'unreachable') {
      await queue.markUnreachable(current, canMessage.error)
      pushStatus({
        phase: 'preparing',
        title: `${current.name}`,
        text: 'Cannot message this account. Marked NA, moving on…',
      })
      profiles = profiles.filter((item) => item.sheetRow !== current.sheetRow)
      current = profiles[0] || null
      busy = false
      return prepareCurrent()
    }
    if (!composer?.ok) throw new Error('The DM is open, but the voice button is not there yet.')

    const loaded = await loadClip(current.clip)
    pushStatus({
      phase: 'ready',
      title: `${current.name} · ${current.device} · ${current.voice}`,
      text: `Ready · ${clock(loaded.duration)}. Sending automatically…`,
      detail: `@${current.username}`,
      remaining: profiles.length,
      sentToday: queue.sentToday(),
    })
    busy = false
    if (paused) return
    await sleep(SETTLE_BEFORE_SEND_MS)
    if (paused || !current) return
    await record()
    return
  } catch (error) {
    console.error(error)
    if (error.blocked) {
      paused = true
      pushStatus({
        phase: 'blocked',
        title: 'Paused · Instagram warning',
        text: error.message,
        detail: error.detail || 'Wait, then click Resume.',
        remaining: profiles.length,
        sentToday: queue.sentToday(),
      })
    } else {
      pushStatus({
        phase: 'error',
        title: current ? `${current.name} · @${current.username}` : 'Error',
        text: error.message || 'Could not prepare this profile.',
        detail: 'Click Retry or Skip.',
        remaining: profiles.length,
        sentToday: queue.sentToday(),
      })
    }
  } finally {
    busy = false
  }
}

async function clickInPage(x, y) {
  instagram.webContents.focus()
  const point = { x, y }
  await instagram.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  await sleep(40)
  await instagram.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  await sleep(80)
  await instagram.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
}

async function record() {
  if (status.phase !== 'ready' || !current || busy) return status
  pushStatus({ phase: 'starting', text: 'Starting the voice note…', detail: '' })
  clearTimeout(startTimer)
  startTimer = setTimeout(() => {
    if (status.phase !== 'starting' || !current) return
    current.recordFails = (current.recordFails || 0) + 1
    if (current.recordFails < 2) {
      console.warn('recording did not start, opening the DM again')
      pushStatus({ phase: 'preparing', text: 'Voice note did not start. Opening the DM again…' })
      prepareCurrent()
      return
    }
    pushStatus({
      phase: 'error',
      text: 'Instagram did not start recording.',
      detail: 'Click Retry or Skip.',
    })
  }, 8000)
  try {
    await ensureHook()
    const result = await ig('window.__startIgRecord()')
    console.log('mic', JSON.stringify(result))
    if (!result?.ok) {
      clearTimeout(startTimer)
      pushStatus({
        phase: 'ready',
        text: result?.error || 'Could not find the microphone button.',
        detail: (result?.labels || []).join(' · '),
      })
      return status
    }
    await sleep(1200)
    if (status.phase === 'starting') await clickInPage(result.x, result.y)
    await sleep(1500)
    if (status.phase === 'starting') {
      const state = await ig(`document.documentElement.dataset.voiceState || ''`)
      if (state !== 'recording' && state !== 'speech') await clickInPage(result.x, result.y)
    }
  } catch (error) {
    clearTimeout(startTimer)
    pushStatus({ phase: 'ready', text: 'Could not reach the Instagram chat.', detail: error.message })
  }
  return status
}

async function finish() {
  if (finishing || status.phase !== 'recording' || !current) return
  finishing = true
  clearTimeout(startTimer)
  pushStatus({ phase: 'sending', text: 'Voice note finished. Sending…' })
  await pauseVideo().catch(() => {})
  try {
    const result = await ig('window.__finishIgRecord()')
    console.log('send result', JSON.stringify(result))
    if (!result?.ok) {
      pushStatus({
        phase: 'ready',
        text: 'The recording ended, but Instagram did not show Send.',
        detail: (result?.labels || []).join(' · '),
      })
      return
    }
    await queue.markSent(current, current.voice)
    const sent = current
    profiles = profiles.filter((item) => item.sheetRow !== sent.sheetRow)
    current = null
    pushStatus({
      phase: 'sent',
      title: `${sent.name} · ${sent.voice}`,
      text: `Sent. ${queue.remainingToday()} left today.`,
      remaining: profiles.length,
      sentToday: queue.sentToday(),
    })
    await sleep(1200)
    if (paused) {
      pushStatus({ phase: 'paused', title: 'Paused', text: 'Paused after send. Click Resume for the next profile.', remaining: profiles.length, sentToday: queue.sentToday() })
      return
    }
    if (!queue.remainingToday()) {
      pushStatus({
        phase: 'done',
        title: 'Daily limit reached',
        text: `Sent ${queue.DAILY_LIMIT} today. Come back tomorrow.`,
        remaining: profiles.length,
        sentToday: queue.sentToday(),
      })
      return
    }
    if (!profiles.length) {
      current = null
      await prepareCurrent()
      return
    }
    const waitMs = randomPauseMs()
    pushStatus({
      phase: 'waiting',
      title: `Next: ${profiles[0].name}`,
      text: `Waiting before the next send…`,
      remaining: profiles.length,
      sentToday: queue.sentToday(),
    })
    const ok = await waitWithCountdown(waitMs, 'Waiting')
    if (!ok) {
      if (paused) {
        pushStatus({ phase: 'paused', title: 'Paused', text: 'Paused during the wait. Click Resume to continue.', remaining: profiles.length, sentToday: queue.sentToday() })
      }
      return
    }
    await waitWhilePaused()
    current = profiles[0] || null
    await prepareCurrent()
  } catch (error) {
    pushStatus({ phase: 'ready', text: 'Could not press Send.', detail: error.message })
  } finally {
    finishing = false
  }
}

async function cancel() {
  if (status.phase !== 'recording' && status.phase !== 'starting') return status
  clearTimeout(startTimer)
  await pauseVideo().catch(() => {})
  try {
    await ig('window.__cancelIgRecord()')
  } catch (error) {
    console.error(error)
  }
  pushStatus({ phase: 'ready', text: 'Cancelled. Nothing was sent.', title: current ? `${current.name} · ${current.device} · ${current.voice}` : status.title })
  return status
}

async function skip() {
  if (!current || busy || ['starting', 'recording', 'sending'].includes(status.phase)) return status
  queue.log({ ...current, result: 'skipped' })
  profiles = profiles.filter((item) => item.sheetRow !== current.sheetRow)
  current = profiles[0] || null
  await prepareCurrent()
  return status
}

async function retry() {
  if (busy || ['starting', 'recording', 'sending'].includes(status.phase)) return status
  paused = false
  if (current) current.recordFails = 0
  await prepareCurrent()
  return status
}

async function togglePause() {
  if (['starting', 'recording', 'sending'].includes(status.phase)) return status
  paused = !paused
  if (paused) {
    pauseToken += 1
    pushStatus({
      phase: 'paused',
      title: 'Paused',
      text: current ? `Paused on @${current.username}.` : 'Paused.',
      remaining: profiles.length,
      sentToday: queue.sentToday(),
    })
  } else {
    await prepareCurrent()
  }
  return status
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
  igSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media')
  })

  win = new BaseWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Voicenote send',
    backgroundColor: '#000000',
  })

  bar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'record-preload-bar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  video = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'record-preload-player.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  instagram = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'record-preload-ig.js'),
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  try { bar.setBackgroundColor('#10110f') } catch (error) {}
  try { video.setBackgroundColor('#000000') } catch (error) {}
  try { instagram.setBackgroundColor('#ffffff') } catch (error) {}

  win.contentView.addChildView(bar)
  win.contentView.addChildView(video)
  win.contentView.addChildView(instagram)

  instagram.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) instagram.webContents.loadURL(url).catch((error) => { if (!aborted(error)) console.error(error) })
    return { action: 'deny' }
  })

  ipcMain.on('voice-state', (event, state) => {
    if (!instagram || event.sender !== instagram.webContents) return
    if (state === 'recording' && (status.phase === 'starting' || status.phase === 'ready')) {
      clearTimeout(startTimer)
      pushStatus({ phase: 'recording', text: 'Recording silently. It sends when the voice note ends.' })
    } else if (state === 'speech' && status.phase === 'recording') {
      playVideo().catch((error) => {
        pushStatus({ phase: 'recording', text: 'Recording, but the voice note did not start.', detail: error.message })
      })
    } else if (state === 'ended') {
      finish()
    }
  })

  ipcMain.on('note-ended', (event) => {
    if (!video || event.sender !== video.webContents) return
    finish()
  })

  win.on('resize', layout)
  bar.webContents.on('did-finish-load', () => {
    layout()
    pushStatus({})
  })
  bar.webContents.loadFile(path.join(__dirname, 'web', 'record-bar.html'))
  video.webContents.loadFile(path.join(__dirname, 'web', 'player.html'))
  instagram.webContents.loadURL('about:blank').catch(() => {})
  layout()
  win.center()
  setTimeout(layout, 100)
}

async function bootQueue() {
  pushStatus({ phase: 'loading', text: 'Loading Yes profiles that still need a voice note…' })
  profiles = await queue.loadQueue()
  const remaining = queue.remainingToday()
  if (!remaining) {
    pushStatus({
      phase: 'done',
      title: 'Daily limit reached',
      text: `Already sent ${queue.DAILY_LIMIT} today.`,
      remaining: profiles.length,
      sentToday: queue.sentToday(),
    })
    return
  }
  profiles = profiles.slice(0, remaining)
  current = profiles[0] || null
  pushStatus({
    phase: 'loading',
    text: `${profiles.length} ready · ${queue.sentToday()}/${queue.DAILY_LIMIT} sent today`,
    remaining: profiles.length,
    sentToday: queue.sentToday(),
  })
  await prepareCurrent()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.focus()
  })

  app.whenReady().then(async () => {
    if (!fs.existsSync(queue.CLIPS_DIR) || !fs.readdirSync(queue.CLIPS_DIR).length) {
      throw new Error(`Missing voice clips in ${queue.CLIPS_DIR}`)
    }
    hookSource = fs.readFileSync(path.join(__dirname, 'record-ig-hook.js'), 'utf8')
    protocol.handle('voice', () => net.fetch(pathToFileURL(audioPath || path.join(queue.CLIPS_DIR, 'Mathieu Garmin.m4a')).toString()))
    ipcMain.handle('record', () => record())
    ipcMain.handle('cancel', () => cancel())
    ipcMain.handle('skip', () => skip())
    ipcMain.handle('retry', () => retry())
    ipcMain.handle('pause', () => togglePause())
    createWindow()
    await bootQueue()
  }).catch((error) => {
    console.error(error)
    pushStatus({ phase: 'error', text: error.message || String(error) })
  })

  app.on('window-all-closed', () => app.quit())
}

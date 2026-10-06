const {
  app,
  BaseWindow,
  WebContentsView,
  ipcMain,
  session,
  shell,
  dialog,
} = require('electron')
const path = require('path')
const data = require('./lib/data')

const HEADER = 148
const FOOTER = 118
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

app.userAgentFallback = CHROME_UA
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

let headers = []
let rows = []
let decisions = {}
let index = 0
let mode = 'review'
let win = null
let chrome = null
let instagram = null
let loadedLink = ''
let profileLoaded = false
let loadError = ''
let saveError = ''
let lastDecideAt = 0

function current() {
  return rows[index] || null
}

function choiceFor(row) {
  if (!row) return null
  return decisions[data.profileKey(row)]?.choice || null
}

function allDecided() {
  return rows.length > 0 && rows.every((row) => decisions[data.profileKey(row)])
}

function publicState() {
  const row = current()
  const url = instagram && !instagram.webContents.isDestroyed() ? instagram.webContents.getURL() : ''
  const username = row ? data.usernameFrom(row['DIRECT LINK']) : ''
  const urlLower = String(url || '').toLowerCase()
  const needsLogin = /accounts\/login|\/login\b/i.test(urlLower)
  const offProfile = Boolean(
    urlLower.startsWith('http') &&
      username &&
      !urlLower.includes(encodeURIComponent(username).toLowerCase()) &&
      !urlLower.includes(username.toLowerCase()) &&
      !needsLogin,
  )
  const yesCount = rows.filter((item) => choiceFor(item) === 'yes').length

  return {
    mode,
    index,
    total: rows.length,
    yesCount,
    remaining: rows.filter((item) => !choiceFor(item)).length,
    allDone: allDecided(),
    needsLogin,
    offProfile,
    profileLoaded,
    loadError: saveError || loadError,
    yesPath: data.prettyPath(data.YES_PATH),
    decision: choiceFor(row),
    current: row
      ? {
          name: row.NAME || 'Untitled',
          username,
          followers: row.FOLLOWERS || '',
          email: row.EMAIL || '',
          location: row.LOCATION || '',
          notes: row.NOTES || '',
          ranking: data.rankingOf(row),
          engagement: row['Engagement Rate'] || '',
          link: row['DIRECT LINK'] || '',
        }
      : null,
    track: rows.map((item) => choiceFor(item)),
    yesList: rows
      .map((item, itemIndex) => ({
        index: itemIndex,
        name: item.NAME || 'Untitled',
        username: data.usernameFrom(item['DIRECT LINK']),
        followers: item.FOLLOWERS || '',
        location: item.LOCATION || '',
        notes: item.NOTES || '',
        choice: choiceFor(item),
      }))
      .filter((item) => item.choice === 'yes'),
  }
}

function broadcast() {
  if (chrome && !chrome.webContents.isDestroyed()) {
    chrome.webContents.send('state', publicState())
  }
  const row = current()
  if (win && !win.isDestroyed()) {
    if (mode === 'saved') win.setTitle('Saved voicenotes')
    else win.setTitle(`${row?.NAME || 'Review'} · Voicenote review`)
  }
}

function layout() {
  if (!win || win.isDestroyed() || !chrome || !instagram) return
  const bounds = win.getContentBounds()
  const width = Math.max(0, Math.round(bounds.width))
  const height = Math.max(0, Math.round(bounds.height))
  chrome.setBounds({ x: 0, y: 0, width, height })
  if (mode === 'review') {
    instagram.setBounds({
      x: 0,
      y: HEADER,
      width,
      height: Math.max(0, height - HEADER - FOOTER),
    })
  } else {
    instagram.setBounds({ x: 0, y: height, width: 0, height: 0 })
  }
}

function showProfile(force = false) {
  const link = String(current()?.['DIRECT LINK'] || '').trim()
  if (!link) {
    loadError = 'This row has no profile link.'
    profileLoaded = false
    broadcast()
    return
  }
  if (!force && link === loadedLink) return
  loadedLink = link
  profileLoaded = false
  loadError = ''
  broadcast()
  instagram.webContents.loadURL(link).catch((error) => {
    loadError = error?.message || 'Could not open this profile.'
    broadcast()
  })
}

function go(nextIndex) {
  if (!rows.length) return publicState()
  index = Math.max(0, Math.min(rows.length - 1, nextIndex))
  mode = 'review'
  showProfile(false)
  layout()
  broadcast()
  return publicState()
}

function nextUndecidedFrom(start) {
  for (let step = 1; step <= rows.length; step++) {
    const next = (start + step) % rows.length
    if (!decisions[data.profileKey(rows[next])]) return next
  }
  return -1
}

function decide(choice) {
  const now = Date.now()
  if (now - lastDecideAt < 350) return publicState()
  if (choice !== 'yes' && choice !== 'no') return publicState()
  const row = current()
  if (!row) return publicState()

  lastDecideAt = now
  const nextDecisions = data.record(decisions, row, choice)
  try {
    data.persist(headers, rows, nextDecisions)
    decisions = nextDecisions
    saveError = ''
  } catch (error) {
    saveError = 'Could not save. If voicenote-yes.csv is open in Excel or Numbers, close it and try again.'
    console.error(error)
    broadcast()
    return publicState()
  }

  const next = nextUndecidedFrom(index)
  if (next !== -1) index = next
  mode = 'review'
  showProfile(false)
  layout()
  broadcast()
  return publicState()
}

function safeExternal(link) {
  try {
    const url = new URL(link)
    if (url.protocol === 'https:' || url.protocol === 'http:') return shell.openExternal(url.href)
  } catch {
    return undefined
  }
  return undefined
}

function createWindow() {
  const partition = 'persist:instagram'
  const igSession = session.fromPartition(partition)
  igSession.setUserAgent(CHROME_UA)
  igSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = CHROME_UA
    callback({ requestHeaders: details.requestHeaders })
  })

  win = new BaseWindow({
    width: 1180,
    height: 920,
    minWidth: 880,
    minHeight: 680,
    title: 'Voicenote review',
    backgroundColor: '#10110f',
  })

  chrome = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  instagram = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-ig.js'),
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  try { chrome.setBackgroundColor('#10110f') } catch {}
  try { instagram.setBackgroundColor('#ffffff') } catch {}

  win.contentView.addChildView(chrome)
  win.contentView.addChildView(instagram)
  chrome.webContents.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  instagram.webContents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/i.test(url)) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520,
        height: 760,
        autoHideMenuBar: true,
        webPreferences: {
          partition,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      },
    }
  })

  instagram.webContents.on('did-finish-load', async () => {
    profileLoaded = true
    loadError = ''
    console.log('loaded', instagram.webContents.getURL(), '|', instagram.webContents.getTitle())
    broadcast()
    if (process.env.REVIEW_SHOT) {
      const fs = require('fs')
      const image = await instagram.webContents.capturePage()
      fs.writeFileSync('/tmp/voicenote-ig.png', image.toPNG())
      const chromeImage = await chrome.webContents.capturePage()
      fs.writeFileSync('/tmp/voicenote-chrome.png', chromeImage.toPNG())
      console.log('saved screenshots', image.getSize(), chromeImage.getSize())
    }
  })
  instagram.webContents.on('did-navigate', () => broadcast())
  instagram.webContents.on('did-navigate-in-page', () => broadcast())
  instagram.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    profileLoaded = false
    loadError = `Instagram didn't load (${description}). Use Reload or Open in browser.`
    broadcast()
  })
  instagram.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('Instagram preload failed', preloadPath, error)
  })

  win.on('resize', layout)
  win.on('close', () => {
    console.log('window close requested')
  })
  win.on('closed', () => {
    console.log('window closed')
  })
  chrome.webContents.on('did-finish-load', () => {
    layout()
    broadcast()
  })

  layout()
  win.center()
  win.show()
  setTimeout(layout, 80)
  setTimeout(layout, 400)

  if (allDecided()) mode = 'saved'
  showProfile(false)
  layout()
}

function registerIpc() {
  ipcMain.handle('get-state', () => publicState())
  ipcMain.handle('decide', (_event, choice) => decide(choice))
  ipcMain.handle('jump', (_event, nextIndex) => go(Number(nextIndex)))
  ipcMain.handle('prev', () => go(index - 1))
  ipcMain.handle('retry', () => {
    showProfile(true)
    return publicState()
  })
  ipcMain.handle('open-external', () => {
    const link = current()?.['DIRECT LINK']
    if (link) return safeExternal(link)
    return undefined
  })
  ipcMain.handle('show-yes-file', () => {
    shell.showItemInFolder(data.YES_PATH)
  })
  ipcMain.handle('set-mode', (_event, nextMode) => {
    mode = nextMode === 'saved' ? 'saved' : 'review'
    layout()
    broadcast()
    return publicState()
  })
  ipcMain.on('shortcut', (event, key) => {
    if (!instagram || event.sender !== instagram.webContents) return
    if (mode !== 'review') return
    if (key === 'y') decide('yes')
    if (key === 'n') decide('no')
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.focus()
  })

  app.whenReady().then(() => {
    const loaded = data.loadRows()
    headers = loaded.headers
    rows = loaded.rows
    decisions = data.loadDecisions()
    index = data.firstUndecided(rows, decisions)
    data.persist(headers, rows, decisions)
    registerIpc()
    createWindow()
    console.log(`Reviewing ${rows.length} profiles`)
    console.log(`Yes file: ${data.YES_PATH}`)
  }).catch((error) => {
    console.error(error)
    dialog.showErrorBox('Voicenote review', error.message || String(error))
    app.quit()
  })

  app.on('render-process-gone', (_event, _contents, details) => {
    console.error('render-process-gone', details)
  })
  app.on('child-process-gone', (_event, details) => {
    console.error('child-process-gone', details)
  })
  app.on('window-all-closed', () => app.quit())
}

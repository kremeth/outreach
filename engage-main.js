const { app, BrowserWindow, session } = require('electron')
const fs = require('fs')

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const jobPath = process.argv[2]
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'))

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function writeResult(result) {
  fs.writeFileSync(`${jobPath}.result`, JSON.stringify(result))
}

const FIND = `(() => {
  const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim()
  const path = location.pathname.toLowerCase()
  if (path.startsWith('/accounts/login') || /log in to instagram/i.test(document.body.innerText || '')) return { login: true }
  const buttons = [...document.querySelectorAll('button, [role="button"]')]
  const labelOf = (el) => clean([el.getAttribute('aria-label'), el.innerText, ...[...el.querySelectorAll('svg[aria-label]')].map((node) => node.getAttribute('aria-label'))].filter(Boolean).join(' '))
  const point = (el) => {
    const rect = el.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }
  const unlike = buttons.find((el) => /^unlike$/i.test(labelOf(el)) || el.querySelector('svg[aria-label="Unlike"]'))
  const like = buttons.find((el) => /^like$/i.test(labelOf(el)) || (el.querySelector('svg[aria-label="Like"]') && !el.querySelector('svg[aria-label="Unlike"]')))
  const box = document.querySelector('textarea[aria-label*="comment" i], textarea[placeholder*="comment" i], form textarea')
  const closed = /comments on this post have been limited|commenting is turned off/i.test(document.body.innerText || '')
  return {
    login: false,
    closed,
    liked: Boolean(unlike),
    like: like ? point(like) : null,
    box: Boolean(box),
  }
})()`

const FOCUS_BOX = `(() => {
  const box = document.querySelector('textarea[aria-label*="comment" i], textarea[placeholder*="comment" i], form textarea')
  if (!box) return false
  box.focus()
  return true
})()`

const CLICK_POST = `(() => {
  const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim()
  const post = [...document.querySelectorAll('button, [role="button"], div')].find((el) => clean(el.innerText) === 'Post' && el.children.length < 3)
  if (!post) return null
  const rect = post.getBoundingClientRect()
  if (!rect.width) return null
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
})()`

async function click(win, point) {
  win.webContents.focus()
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
  await sleep(40)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(60)
  win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
}

async function run(win) {
  await win.loadURL(job.permalink)
  let found = null
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(500)
    found = await win.webContents.executeJavaScript(FIND, true)
    if (found.login || found.closed || found.box) break
  }
  if (!found || found.login) throw new Error('Log into Instagram in the comment window, then pick the comment again.')
  if (found.closed) throw new Error('Comments are turned off on this post.')
  if (!found.box) throw new Error('Could not find the comment box on this post.')
  let liked = found.liked
  if (!liked) {
    if (!found.like) throw new Error('Could not find the Like button.')
    await click(win, found.like)
    liked = true
    await sleep(600)
  }
  const focused = await win.webContents.executeJavaScript(FOCUS_BOX, true)
  if (!focused) throw new Error('Could not focus the comment box.')
  win.webContents.focus()
  await win.webContents.insertText(job.message)
  await sleep(500)
  let post = null
  for (let attempt = 0; attempt < 8; attempt++) {
    post = await win.webContents.executeJavaScript(CLICK_POST, true)
    if (post) break
    await sleep(300)
  }
  if (!post) throw new Error('The comment was typed, but Instagram did not show Post.')
  await click(win, post)
  await sleep(1200)
  return { ok: true, liked }
}

app.userAgentFallback = CHROME_UA
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

app.whenReady().then(async () => {
  session.defaultSession.setUserAgent(CHROME_UA)
  const ig = session.fromPartition('persist:instagram')
  ig.setUserAgent(CHROME_UA)
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'Comment',
    webPreferences: { partition: 'persist:instagram', contextIsolation: true, nodeIntegration: false },
  })
  try {
    const result = await run(win)
    writeResult(result)
    setTimeout(() => app.exit(0), 800)
  } catch (error) {
    writeResult({ ok: false, error: error.message || String(error) })
    setTimeout(() => app.exit(1), 1200)
  }
}).catch((error) => {
  writeResult({ ok: false, error: error.message || String(error) })
  app.exit(1)
})

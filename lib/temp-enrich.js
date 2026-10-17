// TEMP Scrape enricher: each username on the "TEMP Scrape" tab gets its profile link, follower count and
// bio, read from the public profile page the way link previews read it (the person's own script,
// instagram_profile_to_csv.py: the page's description says "998 Followers, 1,266 Following, 810 Posts -
// Name (@user) on Instagram: "bio""). No login, no account involved.
// - Slow on purpose (this home connection is also nutricode.io's): one profile every 45 to 75 seconds,
//   about 60 an hour, around the clock. A login wall or "please wait" (logged-out viewing limited for this
//   connection) pauses it and everything else viewing Instagram logged out here (shared wall, longer
//   each time it comes back).
// - Writes columns C to E (URL, FOLLOWERS, BIO) of the row, after checking the row still holds that
//   username (the scraper accounts only add rows at the bottom; the person may edit the tab).
// - Only on the Mac that has data/wearable/RUN_HERE (one Mac does it, not both).
const fs = require('fs')
const path = require('path')
const writer = require('./sheet-writer')
const preview = require('./ig-preview')

const TAB = 'TEMP Scrape'
const MARKER = path.join(__dirname, '..', 'data', 'wearable', 'RUN_HERE')
const STATE_PATH = path.join(__dirname, '..', 'data', 'temp-enrich.json')
const GAP_MS = [45 * 1000, 75 * 1000]
const USER_AGENT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
// Shown in FOLLOWERS when the profile is gone or private-and-empty (so it is not tried again).
const NOT_FOUND = 'not found'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const between = ([min, max]) => min + Math.random() * (max - min)
const range = (a1) => `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!${a1}`)}`

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { day: '', today: 0, left: 0, status: 'idle', message: '', pausedUntil: 0 }
  }
}

function save(state) {
  const tmp = `${STATE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
  fs.renameSync(tmp, STATE_PATH)
}

const decode = (text) => String(text || '').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))

// "1,066" -> 1066, "12.3K" -> 12300, "1.2M" -> 1200000.
function count(text) {
  const match = String(text || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB]?)/i)
  return match ? Math.round(parseFloat(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[match[2].toLowerCase()] || 1)) : 0
}

// One profile: { followers, bio } | { notFound } ; throws kind 'wall' when Instagram limits this connection.
async function profile(username) {
  const response = await fetch(`https://www.instagram.com/${encodeURIComponent(username)}/`, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(20000) })
  if (response.status === 404) return { notFound: true }
  if (response.status === 429 || /accounts\/login|challenge/.test(response.url)) throw Object.assign(new Error(`Instagram is limiting logged-out viewing (${response.status})`), { kind: 'wall' })
  const page = await response.text()
  const meta = {}
  for (const match of page.matchAll(/<meta\s+(?:content="([^"]*)"\s+(?:name|property)="([^"]*)"|(?:name|property)="([^"]*)"\s+content="([^"]*)")\s*\/?>/gi)) {
    const [name, content] = match[2] ? [match[2], match[1]] : [match[3], match[4]]
    meta[name.toLowerCase()] = decode(content)
  }
  const description = meta.description || meta['og:description'] || ''
  const followers = description.match(/([\d,.]+\s*[KMB]?)\s+Followers/i)
  if (!followers) {
    if (/please wait a few minutes/i.test(page)) throw Object.assign(new Error('Instagram said to wait a few minutes'), { kind: 'wall' })
    // A page with no profile on it (gone, or not a profile).
    if (/page isn.t available|Page Not Found/i.test(page) || !/@[\w.]+/.test(description)) return { notFound: true, odd: !/page isn.t available|Page Not Found/i.test(page) }
    return { notFound: true }
  }
  const bio = (description.match(/on Instagram:\s*"?([\s\S]*?)"?\s*$/i) || [])[1] || ''
  return { followers: count(followers[1]), bio: bio.replace(/\s+/g, ' ').trim() }
}

let running = null
function run(log = () => {}) {
  if (!fs.existsSync(MARKER)) return Promise.resolve(null)
  if (!running) running = work(log).finally(() => { running = null })
  return running
}

async function work(log) {
  const state = load()
  const day = new Date().toDateString()
  if (state.day !== day) {
    state.day = day
    state.today = 0
  }
  await writer.prepare()
  // Header for the new columns (once).
  const header = ((await writer.api('GET', range('A1:E1'))).values || [[]])[0] || []
  if (header[2] !== 'URL' || header[3] !== 'FOLLOWERS' || header[4] !== 'BIO') {
    await writer.api('PUT', `${range('C1:E1')}?valueInputOption=RAW`, { values: [['URL', 'FOLLOWERS', 'BIO']] })
  }
  let odd = 0
  for (;;) {
    // Paused by a wall (seen here, or by anything else viewing Instagram logged out on this Mac).
    const wall = preview.loginWall()
    if (wall) {
      state.status = 'paused'
      state.pausedUntil = wall
      state.message = `Instagram is limiting logged-out viewing from this connection; carrying on after ${new Date(wall).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}.`
      save(state)
      await sleep(wall - Date.now() + 60 * 1000)
      continue
    }
    // The next rows to do (a batch at a time, to keep sheet reads low).
    const rows = (await writer.api('GET', range('A2:D'))).values || []
    const todo = []
    rows.forEach((row, index) => {
      const username = String(row[0] || '').replace(/^@/, '').trim().toLowerCase()
      if (username && !String(row[3] || '').trim()) todo.push({ row: index + 2, username })
    })
    state.left = todo.length
    state.total = rows.filter((row) => String(row[0] || '').trim()).length
    if (!todo.length) {
      state.status = 'idle'
      state.message = 'Every username on TEMP Scrape has its followers and bio.'
      save(state)
      return state
    }
    state.status = 'running'
    state.message = ''
    save(state)
    for (const item of todo.slice(0, 40)) {
      if (preview.loginWall()) break
      let result
      try {
        result = await profile(item.username)
      } catch (error) {
        if (error.kind === 'wall') {
          preview.noteWall()
          log(`temp enrich: ${error.message}; paused`)
          break
        }
        log(`temp enrich @${item.username}: ${error.message}`)
        await sleep(between(GAP_MS))
        continue
      }
      // Several "no profile" pages in a row that do not say so: likely Instagram holding pages back.
      odd = result.odd ? odd + 1 : 0
      if (odd >= 5) {
        preview.noteWall()
        log('temp enrich: 5 empty profile pages in a row; paused as a wall')
        odd = 0
        break
      }
      // Still the same username on that row (nothing moved): written.
      const now = ((await writer.api('GET', range(`A${item.row}`))).values || [[]])[0]?.[0] || ''
      if (String(now).replace(/^@/, '').trim().toLowerCase() === item.username) {
        const values = result.notFound ? [`https://www.instagram.com/${item.username}/`, NOT_FOUND, ''] : [`https://www.instagram.com/${item.username}/`, result.followers, result.bio]
        await writer.api('PUT', `${range(`C${item.row}:E${item.row}`)}?valueInputOption=RAW`, { values: [values] })
        state.today++
        state.left = Math.max(0, state.left - 1)
        state.lastAt = Date.now()
        save(state)
      }
      await sleep(between(GAP_MS))
    }
  }
}

function summary() {
  const state = load()
  return { status: state.status, message: state.message, today: state.day === new Date().toDateString() ? state.today : 0, left: state.left || 0, total: state.total || 0, perHour: 60 }
}

module.exports = { run, summary, profile }

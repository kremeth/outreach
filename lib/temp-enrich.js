// TEMP Scrape enricher: each username on the "TEMP Scrape" tab gets its profile link, follower count and
// bio, read from the public profile page the way link previews read it (the person's own script,
// instagram_profile_to_csv.py: the page's description says "998 Followers, 1,266 Following, 810 Posts -
// Name (@user) on Instagram: "bio""). No login, no account involved.
// - Through NordVPN's Australian proxy servers only (data/nordvpn-service.txt: the service credentials,
//   username then password, never committed): only these page loads go through them, nothing else on
//   this Mac changes connection (nutricode.io stays on the home connection). One worker per proxy, each
//   one profile every 40 to 80 seconds (about 60 an hour per IP): 15 proxies, about 15,000 a day. A
//   proxy whose IP Instagram limits rests for an hour; the others carry on.
// - Without the credentials file: one slow worker on the home connection (about 60 an hour), which a
//   login wall pauses together with everything else viewing Instagram logged out here.
// - Only a real profile page is written: its description names that username and its follower count (a
//   profile always shows one; an empty bio means they wrote none). A proxy that fails (407, no
//   connection, an empty or cut page) never writes anything: the username goes back in the queue and the
//   proxy rests. "not found" only after MISSES_FOR_GONE pages without a profile, at different times.
// - Results are written to columns C to E (URL, FOLLOWERS, BIO) every 20 seconds in one batch, each to
//   the row that holds that username at the time (the scraper accounts add rows at the bottom; the
//   person may edit the tab).
// - Only on the Mac that has data/wearable/RUN_HERE (one Mac does it, not both).
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const writer = require('./sheet-writer')
const preview = require('./ig-preview')

const TAB = 'TEMP Scrape'
const DATA = path.join(__dirname, '..', 'data')
const MARKER = path.join(DATA, 'wearable', 'RUN_HERE')
const STATE_PATH = path.join(DATA, 'temp-enrich.json')
const CREDENTIALS_PATH = path.join(DATA, 'nordvpn-service.txt')
const PROXIES = 15
const GAP_MS = [40 * 1000, 80 * 1000]
const PROXY_REST_MS = 60 * 60 * 1000
const DAILY = 16000
const USER_AGENT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
// Shown in FOLLOWERS when the profile is gone (so it is not tried again).
const NOT_FOUND = 'not found'
const MISSES_FOR_GONE = 3
const MISSES_PATH = path.join(DATA, 'temp-enrich-misses.json')
const loadMisses = () => { try { return JSON.parse(fs.readFileSync(MISSES_PATH, 'utf8')) } catch { return {} } }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const between = ([min, max]) => min + Math.random() * (max - min)
const range = (a1) => `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!${a1}`)}`

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { day: '', today: 0, left: 0, status: 'idle', message: '' }
  }
}

function save(state) {
  const tmp = `${STATE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
  fs.renameSync(tmp, STATE_PATH)
}

function credentials() {
  try {
    const [username, password] = fs.readFileSync(CREDENTIALS_PATH, 'utf8').split('\n').map((line) => line.trim())
    return username && password ? { username, password } : null
  } catch {
    return null
  }
}

// NordVPN's Australian servers that work as HTTPS proxies (port 89), least loaded first.
async function proxyServers() {
  const url = 'https://api.nordvpn.com/v1/servers/recommendations?filters[servers_technologies][identifier]=proxy_ssl&filters[country_id]=13&limit=40'
  const list = await fetch(url, { signal: AbortSignal.timeout(20000) }).then((response) => response.json())
  return list.map((server) => String(server.hostname || '').replace(/\.nordvpn\.com$/, '.proxy.nordvpn.com')).filter(Boolean)
}

const decode = (text) => String(text || '').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))

// "1,066" -> 1066, "12.3K" -> 12300, "1.2M" -> 1200000.
function count(text) {
  const match = String(text || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB]?)/i)
  return match ? Math.round(parseFloat(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[match[2].toLowerCase()] || 1)) : 0
}

// The start of a profile page (up to the end of <head>, where the description is; the whole page is
// about 860 KB), through a proxy (curl) or directly.
function pageStart(username, proxy) {
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/`
  if (!proxy) {
    return (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20000)
      let page = ''
      try {
        const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: controller.signal })
        if (response.status === 404) return { status: 404, page: '' }
        if (/accounts\/login|challenge/.test(response.url)) return { status: 401, page: '' }
        const decoder = new TextDecoder()
        for await (const chunk of response.body) {
          page += decoder.decode(chunk, { stream: true })
          if (/<\/head>/i.test(page) || page.length > 400000) break
        }
        return { status: response.status, page }
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    })()
  }
  return new Promise((resolve, reject) => {
    const auth = credentials()
    // -w after the body would never come (the download is cut short), so the status line is read from
    // the headers (-D -) at the start of the output.
    const child = spawn('curl', ['-s', '-L', '--max-time', '25', '-D', '-', '-x', `https://${proxy}:89`, '--proxy-user', `${auth.username}:${auth.password}`, '-A', USER_AGENT, '-H', 'Accept-Language: en-US,en;q=0.9', url])
    let page = ''
    let done = false
    const finish = (error) => {
      if (done) return
      done = true
      child.kill('SIGKILL')
      const statuses = [...page.matchAll(/^HTTP\/[\d.]+ (\d{3})/gm)].map((match) => Number(match[1]))
      // The proxy refused (407: credentials not accepted) or no page came through it: the proxy's fault.
      if (statuses.includes(407)) return reject(Object.assign(new Error(`${proxy} refused the NordVPN credentials (407)`), { kind: 'proxy', auth: true }))
      if (error || !/<html/i.test(page)) return reject(Object.assign(new Error(`${proxy}: no page came through${error ? ` (${error.message})` : ''}`), { kind: 'proxy' }))
      const location = (page.match(/^location: (.+)$/gim) || []).join(' ')
      const status = statuses[statuses.length - 1] || 0
      resolve({ status: /accounts\/login|challenge/.test(location) ? 401 : status, page })
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      page += chunk
      if (/<\/head>/i.test(page) || page.length > 400000) finish()
    })
    child.on('close', (code) => finish(code ? new Error(`curl ${code}`) : null))
    child.on('error', finish)
  })
}

// One profile: { followers, bio } | { missing } (no profile on the page); throws kind 'wall' when
// Instagram limits that IP, kind 'proxy' when the proxy (or connection) failed.
async function profile(username, proxy = null) {
  const { status, page } = await pageStart(username, proxy)
  if (status === 404) return { missing: true }
  if (status === 429 || status === 401 || /please wait a few minutes/i.test(page)) throw Object.assign(new Error(`Instagram is limiting logged-out viewing (${status || 'wait'})`), { kind: 'wall' })
  const meta = {}
  for (const match of page.matchAll(/<meta\s+(?:content="([^"]*)"\s+(?:name|property)="([^"]*)"|(?:name|property)="([^"]*)"\s+content="([^"]*)")\s*\/?>/gi)) {
    const [name, content] = match[2] ? [match[2], match[1]] : [match[3], match[4]]
    meta[name.toLowerCase()] = decode(content)
  }
  const description = meta.description || meta['og:description'] || ''
  const followers = description.match(/([\d,.]+\s*[KMB]?)\s+Followers/i)
  if (!followers) {
    // Cut short before the description (no </head>): the connection's fault, tried again.
    if (!/<\/head>/i.test(page)) throw Object.assign(new Error('the page was cut short'), { kind: 'proxy' })
    // A page with no profile on it: gone, or Instagram holding it back. Only counted, never written
    // at once (see MISSES_FOR_GONE).
    return { missing: true }
  }
  // The profile asked for (not another page).
  if (!new RegExp(`@${username.replace(/[.]/g, '\\.')}\\b`, 'i').test(description) && !new RegExp(`instagram\\.com/${username.replace(/[.]/g, '\\.')}`, 'i').test(page)) return { missing: true }
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
  const fresh = () => {
    const day = new Date().toDateString()
    if (state.day !== day) {
      state.day = day
      state.today = 0
    }
  }
  fresh()
  await writer.prepare()
  const header = ((await writer.api('GET', range('A1:E1'))).values || [[]])[0] || []
  if (header[2] !== 'URL' || header[3] !== 'FOLLOWERS' || header[4] !== 'BIO') {
    await writer.api('PUT', `${range('C1:E1')}?valueInputOption=RAW`, { values: [['URL', 'FOLLOWERS', 'BIO']] })
  }
  // The usernames still to do (from the tab), handed out one at a time to the workers.
  let queue = []
  const taken = new Set()
  const refill = async () => {
    const rows = (await writer.api('GET', range('A2:D'))).values || []
    state.total = rows.filter((row) => String(row[0] || '').trim()).length
    queue = []
    for (const row of rows) {
      const username = String(row[0] || '').replace(/^@/, '').trim().toLowerCase()
      if (username && !String(row[3] || '').trim() && !taken.has(username)) queue.push(username)
    }
    state.left = queue.length + taken.size
  }
  await refill()
  if (!queue.length) {
    state.status = 'idle'
    state.message = 'Every username on TEMP Scrape has its followers and bio.'
    save(state)
    return state
  }
  // Results waiting to be written, each to the row holding that username when written.
  const results = new Map()
  let writing = false
  const flush = async () => {
    if (writing || !results.size) return
    writing = true
    try {
      const batch = new Map(results)
      const names = ((await writer.api('GET', range('A2:A'))).values || []).map((row) => String(row[0] || '').replace(/^@/, '').trim().toLowerCase())
      const data = []
      for (const [username, values] of batch) {
        const at = names.indexOf(username)
        if (at !== -1) data.push({ range: `${writer.quoteTitle(TAB)}!C${at + 2}:E${at + 2}`, values: [values] })
      }
      if (data.length) await writer.api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data })
      for (const username of batch.keys()) {
        results.delete(username)
        taken.delete(username)
      }
      state.today += data.length
      state.left = Math.max(0, state.left - data.length)
      state.lastAt = Date.now()
      save(state)
    } catch (error) {
      log(`temp enrich: sheet write failed (${error.message}); tried again shortly`)
    } finally {
      writing = false
    }
  }
  const next = async () => {
    fresh()
    if (state.today + results.size >= DAILY) return null
    if (!queue.length) await refill().catch(() => {})
    // A username whose page showed no profile is looked at again only 30 minutes later (another IP).
    const at = queue.findIndex((name) => !misses[name] || Date.now() - misses[name].at > 30 * 60 * 1000)
    if (at === -1) return null
    const [username] = queue.splice(at, 1)
    taken.add(username)
    return username
  }
  // The "not found" written before 17 Oct afternoon came from failed proxy pages: cleared once, redone.
  if (!state.clearedNotFound) {
    const values = (await writer.api('GET', range('D2:D'))).values || []
    const data = []
    values.forEach((row, index) => { if (String(row[0] || '').trim() === NOT_FOUND) data.push({ range: `${writer.quoteTitle(TAB)}!C${index + 2}:E${index + 2}`, values: [['', '', '']] }) })
    for (let at = 0; at < data.length; at += 500) await writer.api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: data.slice(at, at + 500) })
    state.clearedNotFound = Date.now()
    save(state)
    log(`temp enrich: ${data.length} earlier "not found" cleared, to be redone`)
    await refill()
  }
  const auth = credentials()
  let servers = []
  if (auth) servers = await proxyServers().catch((error) => { log(`temp enrich: NordVPN server list failed (${error.message})`); return [] })
  // Only proxies that accept the credentials right now (a quick look through each one).
  const accepts = async (server) => {
    try {
      await pageStart('instagram', server)
      return true
    } catch (error) {
      return false
    }
  }
  const working = []
  for (const server of servers.slice(0, 30)) {
    if (working.length >= PROXIES) break
    if (await accepts(server)) working.push(server)
  }
  if (auth && servers.length && !working.length) {
    state.proxyProblem = 'NordVPN is refusing the service credentials (all its proxies said 407). Copy them again from Nord Account > NordVPN > Set up NordVPN manually into data/nordvpn-service.txt. Until then: the slow home connection.'
    log(`temp enrich: ${state.proxyProblem}`)
  } else state.proxyProblem = ''
  const workers = working.length ? working : [null]
  const misses = loadMisses()
  const saveMisses = () => fs.writeFileSync(MISSES_PATH, JSON.stringify(misses))
  const rested = {}
  state.status = 'running'
  state.mode = workers[0] ? `${workers.length} NordVPN proxies` : 'home connection'
  state.perHour = workers.length * 60
  state.message = ''
  save(state)
  log(`temp enrich: ${state.left} to do, ${state.mode}`)
  const flusher = setInterval(() => flush().catch(() => {}), 20 * 1000)
  const worker = async (proxy, index) => {
    // The workers start spread out (not all at once).
    await sleep(index * between([2000, 5000]))
    let empty = 0
    for (;;) {
      if (!proxy) {
        const wall = preview.loginWall()
        if (wall) {
          await sleep(wall - Date.now() + 60 * 1000)
          continue
        }
      } else if ((rested[proxy] || 0) > Date.now()) {
        if (rested[proxy] === Infinity) return // this proxy refuses the credentials: out
        await sleep(rested[proxy] - Date.now())
        continue
      }
      const username = await next()
      if (!username) return
      let result = null
      try {
        result = await profile(username, proxy)
      } catch (error) {
        // Nothing is written: the username goes back for another worker (or this one later).
        taken.delete(username)
        queue.unshift(username)
        if (error.kind === 'wall') {
          if (proxy) {
            rested[proxy] = Date.now() + PROXY_REST_MS
            log(`temp enrich: ${proxy} limited by Instagram; rests an hour`)
          } else preview.noteWall()
        } else if (error.kind === 'proxy') {
          rested[proxy] = error.auth ? Infinity : Date.now() + 10 * 60 * 1000
          log(`temp enrich: ${error.message}; ${error.auth ? 'proxy left out' : 'rests 10 minutes'}`)
          if (error.auth) return
        } else log(`temp enrich @${username}${proxy ? ` via ${proxy}` : ''}: ${error.message}`)
        await sleep(between(GAP_MS))
        continue
      }
      if (result.missing) {
        // No profile on the page: counted. Gone only after MISSES_FOR_GONE such pages at different times;
        // until then it waits (and is tried again later, often through another IP).
        const miss = misses[username] = { count: (misses[username]?.count || 0) + 1, at: Date.now() }
        saveMisses()
        taken.delete(username)
        if (miss.count >= MISSES_FOR_GONE) results.set(username, [`https://www.instagram.com/${username}/`, NOT_FOUND, ''])
        else queue.push(username)
        // Many empty pages in a row through the same IP: Instagram is holding pages back from it.
        empty++
        if (empty >= 4) {
          empty = 0
          if (proxy) rested[proxy] = Date.now() + PROXY_REST_MS
          else preview.noteWall()
          log(`temp enrich: 4 pages without a profile in a row${proxy ? ` via ${proxy}` : ''}; resting an hour`)
        }
      } else {
        empty = 0
        if (misses[username]) {
          delete misses[username]
          saveMisses()
        }
        results.set(username, [`https://www.instagram.com/${username}/`, result.followers, result.bio])
      }
      await sleep(between(GAP_MS))
    }
  }
  try {
    await Promise.all(workers.map((proxy, index) => worker(proxy, index)))
  } finally {
    clearInterval(flusher)
    while (writing) await sleep(500)
    await flush()
  }
  state.status = 'idle'
  state.message = state.today >= DAILY ? `Today's ${DAILY.toLocaleString('en-AU')} are done.` : 'Every username on TEMP Scrape has its followers and bio.'
  save(state)
  return state
}

function summary() {
  const state = load()
  const today = state.day === new Date().toDateString() ? state.today : 0
  return { status: state.status, message: state.proxyProblem || state.message, problem: Boolean(state.proxyProblem), today, left: state.left || 0, total: state.total || 0, perHour: state.perHour || 60, mode: state.mode || '' }
}

module.exports = { run, summary, profile, proxyServers }

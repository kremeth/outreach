// TEMP Scrape enricher: each username on the "TEMP Scrape" tab gets its profile link, follower count and
// bio, read from the public profile page the way link previews read it (the person's own script,
// instagram_profile_to_csv.py: the page's description says "998 Followers, 1,266 Following, 810 Posts -
// Name (@user) on Instagram: "bio""). No login, no account involved.
// - Through NordVPN's proxy servers (data/nordvpn-service.txt: the service credentials, username then
//   password, never committed): only these page loads go through them, nothing else on this Mac changes
//   connection (nutricode.io stays on the home connection). NordVPN allows 10 connections at once per
//   account (the person's own NordVPN apps included) and refuses logins (407) beyond that, so at most
//   ACTIVE proxies are used at a time, the same ones kept. One worker per proxy, one profile every 30 to
//   60 seconds. A proxy refused by NordVPN cools down 15 minutes, one limited by Instagram rests an hour;
//   either way the pool manager (every 2 minutes) brings in another server, checked first with one light
//   request (not Instagram). Australian servers first, then New Zealand, Singapore, the US, the UK.
// - Never stops: a watchdog restarts the workers when nothing was done for 15 minutes while usernames
//   wait; with no proxy working, one slow worker on the home connection carries on (about 60 an hour)
//   until proxies are back.
// - The home connection worker: a login wall pauses it together with everything else viewing Instagram
//   logged out here.
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
const ACTIVE = 6
const GAP_MS = [30 * 1000, 60 * 1000]
const HOME_GAP_MS = [45 * 1000, 75 * 1000]
const REFUSED_COOL_MS = 15 * 60 * 1000
const PROXY_REST_MS = 60 * 60 * 1000
const DAILY = 16000
const USER_AGENT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
// Shown in FOLLOWERS when the profile is gone (so it is not tried again).
const NOT_FOUND = 'not found'
const MISSES_FOR_GONE = 3
// Shown in FOLLOWERS for a profile Instagram only shows when logged in (age-restricted and the like).
const LOGIN_ONLY = 'login only'
// A profile that always loads: the control for "is this IP limited, or only that profile?".
const CONTROL = 'instagram'
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

// NordVPN's servers that work as HTTPS proxies (port 89), least loaded first: Australia, then New
// Zealand, Singapore, the US and the UK.
const COUNTRIES = [13, 156, 195, 228, 227]
async function proxyServers() {
  const all = []
  for (const country of COUNTRIES) {
    const url = `https://api.nordvpn.com/v1/servers/recommendations?filters[servers_technologies][identifier]=proxy_ssl&filters[country_id]=${country}&limit=30`
    const list = await fetch(url, { signal: AbortSignal.timeout(20000) }).then((response) => response.json()).catch(() => [])
    for (const server of Array.isArray(list) ? list : []) {
      const host = String(server.hostname || '').replace(/\.nordvpn\.com$/, '.proxy.nordvpn.com')
      if (host && !all.includes(host)) all.push(host)
    }
  }
  return all
}

// One light request through a proxy (not Instagram): does NordVPN accept the login there right now?
function proxyAccepts(proxy) {
  const auth = credentials()
  if (!auth) return Promise.resolve(false)
  return new Promise((resolve) => {
    const child = spawn('curl', ['-s', '-o', '/dev/null', '-w', '%{http_connect}', '--max-time', '15', '-x', `https://${proxy}:89`, '--proxy-user', `${auth.username}:${auth.password}`, 'https://api.ipify.org'])
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('close', () => resolve(out.trim() === '200'))
    child.on('error', () => resolve(false))
  })
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
  if (status === 429 || /please wait a few minutes/i.test(page)) throw Object.assign(new Error(`Instagram is limiting logged-out viewing (${status || 'wait'})`), { kind: 'wall' })
  // Sent to the login page: some profiles always are (age-restricted and the like), whatever the IP;
  // the caller checks a control profile through the same IP to tell which.
  if (status === 401) throw Object.assign(new Error('Instagram sent this profile to the login page'), { kind: 'login' })
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
  // Their display name: "... Posts - Name (@user) on Instagram" (none when only "@user" is shown).
  const name = (description.match(/Posts\s*-\s*(?:See Instagram photos and videos from\s*)?(.*?)\s*\(@/i) || [])[1] || ''
  return { followers: count(followers[1]), bio: bio.replace(/\s+/g, ' ').trim(), name: name.trim() }
}

let running = null
function run(log = () => {}) {
  if (!fs.existsSync(MARKER)) return Promise.resolve(null)
  if (!running) running = work(log).catch((error) => log(`temp enrich stopped: ${error.message}`)).finally(() => { running = null })
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
  const header = ((await writer.api('GET', range('A1:F1'))).values || [[]])[0] || []
  if (header[2] !== 'URL' || header[3] !== 'FOLLOWERS' || header[4] !== 'BIO' || header[5] !== 'NAME') {
    await writer.api('PUT', `${range('C1:F1')}?valueInputOption=RAW`, { values: [['URL', 'FOLLOWERS', 'BIO', 'NAME']] })
  }
  const misses = loadMisses()
  const saveMisses = () => fs.writeFileSync(MISSES_PATH, JSON.stringify(misses))
  // The usernames still to do (from the tab), handed out one at a time to the workers.
  let queue = []
  let refilledAt = 0
  const taken = new Set()
  const results = new Map()
  const refill = async () => {
    refilledAt = Date.now()
    const rows = (await writer.api('GET', range('A2:D'))).values || []
    state.total = rows.filter((row) => String(row[0] || '').trim()).length
    queue = []
    for (const row of rows) {
      const username = String(row[0] || '').replace(/^@/, '').trim().toLowerCase()
      if (username && !String(row[3] || '').trim() && !taken.has(username) && !results.has(username)) queue.push(username)
    }
    state.left = queue.length + taken.size
  }
  if (!state.clearedNotFound) {
    const values = (await writer.api('GET', range('D2:D'))).values || []
    const data = []
    values.forEach((row, index) => { if (String(row[0] || '').trim() === NOT_FOUND) data.push({ range: `${writer.quoteTitle(TAB)}!C${index + 2}:E${index + 2}`, values: [['', '', '']] }) })
    for (let at = 0; at < data.length; at += 500) await writer.api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: data.slice(at, at + 500) })
    state.clearedNotFound = Date.now()
    save(state)
  }
  await refill()
  // Results, written each to the row holding that username, in one batch every 20 seconds.
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
        if (at !== -1) data.push({ range: `${writer.quoteTitle(TAB)}!C${at + 2}:F${at + 2}`, values: [values] })
      }
      if (data.length) await writer.api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data })
      for (const username of batch.keys()) {
        results.delete(username)
        taken.delete(username)
      }
      fresh()
      state.today += data.length
      state.left = Math.max(0, queue.length + taken.size)
      state.lastAt = Date.now()
      save(state)
    } catch (error) {
      log(`temp enrich: sheet write failed (${error.message}); tried again shortly`)
    } finally {
      writing = false
    }
  }
  const next = () => {
    fresh()
    if (state.today + results.size >= DAILY) return null
    // A username whose page showed no profile is looked at again only 30 minutes later (another IP).
    const at = queue.findIndex((name) => !misses[name] || Date.now() - misses[name].at > 30 * 60 * 1000)
    if (at === -1) return null
    const [username] = queue.splice(at, 1)
    taken.add(username)
    return username
  }
  const giveBack = (username) => {
    taken.delete(username)
    queue.unshift(username)
  }
  const record = (username, result, route) => {
    if (result.missing) {
      // No profile on the page: counted. Gone only after MISSES_FOR_GONE such pages at different times.
      const miss = misses[username] = { count: (misses[username]?.count || 0) + 1, at: Date.now() }
      saveMisses()
      taken.delete(username)
      if (miss.count >= MISSES_FOR_GONE) results.set(username, [`https://www.instagram.com/${username}/`, NOT_FOUND, '', ''])
      else queue.push(username)
      route.empty = (route.empty || 0) + 1
      return route.empty >= 4 // many empty pages in a row through one IP: held back from it
    }
    route.empty = 0
    if (misses[username]) {
      delete misses[username]
      saveMisses()
    }
    results.set(username, [`https://www.instagram.com/${username}/`, result.followers, result.bio, result.name || ''])
    lastResult = Date.now()
    return false
  }

  // The proxy pool: servers -> { until (resting / cooling), worker running }.
  let servers = []
  let serversAt = 0
  const pool = new Map() // host -> { active, until, why }
  let generation = 0
  let lastResult = Date.now()
  let homeRunning = false
  const activeCount = () => [...pool.values()].filter((entry) => entry.active).length

  const proxyWorker = async (host, gen) => {
    const entry = pool.get(host)
    const route = {}
    await sleep(between([1000, 8000]))
    while (gen === generation && entry.active) {
      const username = next()
      if (!username) { await sleep(60 * 1000); continue }
      try {
        const result = await profile(username, host)
        if (record(username, result, route)) {
          entry.active = false
          entry.until = Date.now() + PROXY_REST_MS
          entry.why = 'pages held back'
          log(`temp enrich: 4 pages without a profile in a row via ${host}; rests an hour`)
        }
      } catch (error) {
        if (error.kind === 'login') {
          // Only that profile, or the whole IP? A control profile through the same proxy decides.
          const control = await profile(CONTROL, host).then(() => true).catch(() => false)
          if (control) {
            const tries = (misses[`login:${username}`]?.count || 0) + 1
            misses[`login:${username}`] = { count: tries, at: Date.now() }
            saveMisses()
            taken.delete(username)
            if (tries >= 2) results.set(username, [`https://www.instagram.com/${username}/`, LOGIN_ONLY, '', ''])
            else queue.push(username) // once more, later, through another IP
            await sleep(between(GAP_MS))
            continue
          }
          error.kind = 'wall'
        }
        giveBack(username)
        entry.active = false
        if (error.kind === 'wall') {
          entry.until = Date.now() + PROXY_REST_MS
          entry.why = 'limited by Instagram'
          log(`temp enrich: ${host} limited by Instagram; rests an hour`)
        } else {
          entry.until = Date.now() + (error.auth ? REFUSED_COOL_MS : 10 * 60 * 1000)
          entry.why = error.auth ? 'refused by NordVPN' : 'no page'
        }
      }
      await sleep(between(GAP_MS))
    }
  }

  // With no proxy working: one slow worker on the home connection until proxies are back.
  const homeWorker = async (gen) => {
    homeRunning = true
    const route = {}
    try {
      while (gen === generation && activeCount() === 0) {
        const wall = preview.loginWall()
        if (wall) { await sleep(Math.min(wall - Date.now() + 60 * 1000, 5 * 60 * 1000)); continue }
        const username = next()
        if (!username) { await sleep(60 * 1000); continue }
        try {
          if (record(username, await profile(username, null), route)) preview.noteWall()
        } catch (error) {
          if (error.kind === 'login' && await profile(CONTROL, null).then(() => true).catch(() => false)) {
            taken.delete(username)
            results.set(username, [`https://www.instagram.com/${username}/`, LOGIN_ONLY, '', ''])
          } else {
            giveBack(username)
            if (error.kind === 'wall' || error.kind === 'login') preview.noteWall()
          }
        }
        await sleep(between(HOME_GAP_MS))
      }
    } finally {
      homeRunning = false
    }
  }

  // Every 2 minutes: the pool kept full (one new server checked at a time), the home worker when no
  // proxy works, the tab read again now and then, and the watchdog.
  const manage = async () => {
    if (credentials()) {
      if (!servers.length || Date.now() - serversAt > 6 * 3600 * 1000) {
        const list = await proxyServers().catch(() => [])
        if (list.length) { servers = list; serversAt = Date.now() }
      }
      let checks = 0
      for (const host of servers) {
        if (activeCount() >= ACTIVE || checks >= 2) break
        const entry = pool.get(host) || { active: false, until: 0 }
        pool.set(host, entry)
        if (entry.active || entry.until > Date.now()) continue
        checks++
        if (await proxyAccepts(host)) {
          entry.active = true
          entry.why = ''
          proxyWorker(host, generation)
        } else {
          entry.until = Date.now() + REFUSED_COOL_MS
          entry.why = 'refused by NordVPN'
        }
      }
    }
    if (activeCount() === 0 && !homeRunning) homeWorker(generation)
    if (Date.now() - refilledAt > 15 * 60 * 1000 || (!queue.length && Date.now() - refilledAt > 5 * 60 * 1000)) await refill().catch(() => {})
    // Watchdog: usernames waiting, nothing done for 15 minutes: every worker restarted.
    if (queue.length && Date.now() - lastResult > 15 * 60 * 1000) {
      log('temp enrich: nothing done for 15 minutes; workers restarted')
      generation++
      lastResult = Date.now()
      for (const entry of pool.values()) { entry.active = false; entry.until = 0 }
      for (const username of [...taken]) if (!results.has(username)) giveBack(username)
    }
    const active = activeCount()
    state.status = 'running'
    state.message = queue.length || taken.size ? '' : 'Every username on TEMP Scrape has its followers and bio (new ones are picked up as they come).'
    state.mode = active ? `${active} NordVPN proxies` : 'home connection (no NordVPN proxy accepted right now)'
    state.perHour = active ? Math.round(active * 3600 / 45) : 60
    state.proxyProblem = credentials() && !active ? 'No NordVPN proxy is accepting the login right now (NordVPN allows 10 connections at once, the NordVPN apps included); carrying on slowly through the home connection and trying the proxies again every 2 minutes.' : ''
    save(state)
  }

  log(`temp enrich: ${state.left} to do`)
  const flusher = setInterval(() => flush().catch(() => {}), 20 * 1000)
  try {
    for (;;) {
      await manage().catch((error) => log(`temp enrich manager: ${error.message}`))
      await sleep(2 * 60 * 1000)
    }
  } finally {
    clearInterval(flusher)
    generation++
    await flush().catch(() => {})
  }
}

function summary() {
  const state = load()
  const today = state.day === new Date().toDateString() ? state.today : 0
  return { status: state.status, message: state.proxyProblem || state.message, problem: Boolean(state.proxyProblem), today, left: state.left || 0, total: state.total || 0, perHour: state.perHour || 60, mode: state.mode || '' }
}

module.exports = { run, summary, profile, proxyServers }

// Finding new creators (since 17 Oct: following lists only). Each scraper account (an Instagram account
// of its own, logged in by the person in its own Outreach window, never the outreach account) takes the
// next creator on "1. Influencer Contact List" (in order, skipping the ones on "Scraped"), reads everyone
// they follow, and adds those usernames to the "TEMP Scrape" tab; the creator then goes on "Scraped".
// - Several accounts read side by side: a creator is claimed by one account, so no two read the same.
// - TEMP Scrape is only ever appended to (one writer at a time, the tab read again just before), so the
//   accounts never overwrite each other or what the person changed there. A username already on a tab
//   or already in TEMP Scrape is not added again.
// - Each account: at most USERNAMES_PER_DAY usernames loaded a day (Instagram stopped serving lists to
//   an account at about 3,900 in a day, 17 Oct) and LISTS_PER_DAY lists, 8:00 to 21:00, a 10 to 20 minute
//   break after each. Which list next: the next creator in order whose list fits in what is left today
//   (plus LEEWAY); one that does not fit is left for an account with more room (sizes are remembered,
//   for every account) and this one tries the next, at most SKIPS_PER_DAY times a day (each look opens
//   a profile). A list longer than a whole day goes to an account at the start of its day.
//   A warning from Instagram stops that account until the person dealt with it ("Done, resume").
// (The earlier version also opened every followed account; see git history before 17 Oct evening.)
const fs = require('fs')
const path = require('path')
const writer = require('./sheet-writer')
const data = require('./data')

// The scraper accounts (1 is the first one, logged into the 'persist:scraper' window; 2 to 5 in
// 'persist:scraper2'...). 5 x USERNAMES_PER_DAY = 15,000 usernames a day.
const ACCOUNTS = [1, 2, 3, 4, 5]
const CONTACT_TAB = '1. Influencer Contact List'
const REACH_TAB = 'Customer Reach Out'
const SCRAPED_TAB = 'Scraped'
const TEMP_TAB = 'TEMP Scrape'
const LISTS_PER_DAY = 8
const USERNAMES_PER_DAY = 3000
const LEEWAY = 500
const SKIPS_PER_DAY = 6
// How many each creator follows, once seen (shared by the accounts, so a list too long for one is not
// looked at again by another that has no room either).
const SIZES_PATH = path.join(__dirname, '..', 'data', 'following-sizes.json')
const loadSizes = () => { try { return JSON.parse(fs.readFileSync(SIZES_PATH, 'utf8')) } catch { return {} } }
function rememberSize(username, count) {
  const sizes = loadSizes()
  sizes[username] = count
  fs.writeFileSync(SIZES_PATH, JSON.stringify(sizes))
}
// Does a list of `size` fit in what this account has `left` today?
const fits = (size, left) => size <= left + LEEWAY || (size > USERNAMES_PER_DAY && left >= USERNAMES_PER_DAY)
const BREAK_AFTER_LIST_MS = [10 * 60 * 1000, 20 * 60 * 1000]
const daytime = () => { const hour = new Date().getHours(); return hour >= 8 && hour < 21 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const between = ([min, max]) => min + Math.random() * (max - min)
const STOPS = ['blocked', 'login']

const statePath = (account) => path.join(__dirname, '..', 'data', account === 1 ? 'following-scraper.json' : `following-scraper-${account}.json`)

function load(account) {
  try {
    return JSON.parse(fs.readFileSync(statePath(account), 'utf8'))
  } catch {
    return { day: '', today: { lists: 0, creators: 0, added: 0 }, current: null, skipped: [], status: 'idle', message: '' }
  }
}

function save(account, state) {
  fs.mkdirSync(path.dirname(statePath(account)), { recursive: true })
  const tmp = `${statePath(account)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
  fs.renameSync(tmp, statePath(account))
}

function freshDay(state) {
  const day = new Date().toDateString()
  if (state.day !== day) {
    state.day = day
    state.today = { lists: 0, creators: 0, added: 0, loaded: 0, skips: 0 }
    if (state.status === 'done for today' || state.status === 'stopped') state.status = 'idle'
    if (state.status !== 'needs check') state.message = '' // a warning waits for the person, day or not
  }
  return state
}

// Every handle already on the two tabs (nothing is added twice), the creators in order, the ones on
// Scraped, and the ones an older version started (their finds say "Found in @x's following").
async function known() {
  const contactValues = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(CONTACT_TAB)}!A1:H`)}`)).values || []
  const reachValues = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(REACH_TAB)}!A1:C`)}`)).values || []
  const scrapedValues = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(SCRAPED_TAB)}!A1:A`)}`)).values || []
  const handles = new Set()
  const sources = []
  const started = new Set()
  for (const row of contactValues.slice(3)) {
    const via = String(row[7] || '').match(/^Found in @([\w.]+)'s following/)
    if (via) started.add(via[1].toLowerCase())
    const username = (data.usernameFrom(row[2] || '') || String(row[1] || '').replace(/^@/, '')).trim().toLowerCase()
    if (!username) continue
    if (!handles.has(username)) sources.push(username)
    handles.add(username)
  }
  for (const row of reachValues.slice(1)) {
    const username = (String(row[0] || '').replace(/^@/, '') || data.usernameFrom(row[2] || '')).trim().toLowerCase()
    if (username) handles.add(username)
  }
  const scraped = new Set(scrapedValues.slice(1).map((row) => data.usernameFrom(row[0] || '').toLowerCase()).filter(Boolean))
  return { handles, sources, scraped, started }
}

async function appendRows(tab, rows) {
  if (!rows.length) return
  await writer.api('POST', `/values/${encodeURIComponent(`${writer.quoteTitle(tab)}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows })
}

// One writer at a time for TEMP Scrape and Scraped (the accounts run side by side in this server).
let sheetLock = Promise.resolve()
function locked(task) {
  const run = sheetLock.then(task, task)
  sheetLock = run.then(() => {}, () => {})
  return run
}

// TEMP Scrape: [USERNAME, FOUND IN], header on row 1. Made when missing.
async function tempUsernames() {
  try {
    const values = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(TEMP_TAB)}!A2:A`)}`)).values || []
    return values.map((row) => String(row[0] || '').replace(/^@/, '').trim().toLowerCase()).filter(Boolean)
  } catch (error) {
    if (!/unable to parse range|not found/i.test(error.message)) throw error
    await writer.api('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: TEMP_TAB } } }] })
    await writer.api('PUT', `/values/${encodeURIComponent(`${writer.quoteTitle(TEMP_TAB)}!A1`)}?valueInputOption=RAW`, { values: [['USERNAME', 'FOUND IN']] })
    return []
  }
}

// Adds a list's new usernames at the bottom of TEMP Scrape (read again first, inside the lock).
function addToTemp(usernames, via, handles) {
  return locked(async () => {
    const waiting = new Set(await tempUsernames())
    const rows = []
    for (const username of usernames) {
      if (!username || handles.has(username) || waiting.has(username)) continue
      waiting.add(username)
      rows.push([username, `@${via}`])
    }
    // In chunks, so a very long list is not one huge request.
    for (let at = 0; at < rows.length; at += 2000) await appendRows(TEMP_TAB, rows.slice(at, at + 2000))
    fs.writeFileSync(WAITING_PATH, JSON.stringify({ count: waiting.size, at: Date.now() }))
    return { added: rows.length, waiting: waiting.size }
  })
}
// How many usernames TEMP Scrape held after the last list (for the card).
const WAITING_PATH = path.join(__dirname, '..', 'data', 'temp-scrape-count.json')

// Creators taken by an account in this run of the server (claimed before reading; never two at once).
const claimed = new Set()
const pendingScraped = []
async function flushPending() {
  const rows = pendingScraped.splice(0)
  if (rows.length) await locked(() => appendRows(SCRAPED_TAB, rows))
}

const running = {}
// Runs every account (or one) until its lists for the day are read, a warning stops it, or 21:00.
function run(ig, log = () => {}, account = 0) {
  const accounts = account ? [account] : ACCOUNTS
  return Promise.all(accounts.map((each) => {
    if (!running[each]) running[each] = work(ig, log, each).finally(() => { running[each] = null })
    return running[each]
  }))
}

async function work(ig, log, account) {
  const state = freshDay(load(account))
  const name = `Scraper ${account}`
  if (['done for today', 'stopped', 'needs check'].includes(state.status) || !daytime()) {
    save(account, state)
    return state
  }
  const status = await ig.scraperStatus(account).catch(() => ({ loggedIn: false }))
  // The same Instagram account in two scraper windows: only the first one reads.
  const others = await Promise.all(ACCOUNTS.filter((other) => other < account).map((other) => ig.scraperStatus(other).catch(() => ({}))))
  const duplicate = status.id && others.some((other) => other.id === status.id)
  if (!status.loggedIn || status.sameAsOutreach || duplicate) {
    state.status = 'needs login'
    state.message = status.sameAsOutreach ? 'This scraper window is logged into the outreach account: log into a scraper account there instead.'
      : duplicate ? 'This window is logged into the same account as another scraper window: log into a different account there.'
        : 'Log the scraper account into its window (button on the card).'
    save(account, state)
    return state
  }
  // Out of sight: it reads hidden (shown only to log in or verify).
  await ig.scraperHide(account).catch(() => {})
  // The accounts start a few minutes apart each day (not all reading at the same moment).
  if (account > 1 && !(state.today.lists || 0)) {
    state.message = 'Starting shortly (the accounts start a few minutes apart).'
    save(account, state)
    await sleep((account - 1) * between([3 * 60 * 1000, 6 * 60 * 1000]))
    state.message = ''
  }
  await writer.prepare()
  const sheet = await known()
  const markScraped = async (username) => {
    claimed.add(username)
    if (sheet.scraped.has(username)) return
    sheet.scraped.add(username)
    pendingScraped.push([`https://www.instagram.com/${username}/`])
    await flushPending()
  }
  // The window still busy (a read from before a restart): wait for it, never skip.
  const whenFree = async (action) => {
    for (;;) {
      try {
        return await action()
      } catch (error) {
        if (error.kind !== 'busy') throw error
        await sleep(60 * 1000)
      }
    }
  }
  const startedBefore = (username) => sheet.started.has(username) || ACCOUNTS.some((each) => (each === account ? state : load(each)).started?.[username])
  state.status = 'running'
  state.message = ''
  save(account, state)
  try {
    while (daytime()) {
      const left = USERNAMES_PER_DAY - (state.today.loaded || 0)
      if ((state.today.lists || 0) >= LISTS_PER_DAY || left < 50) {
        state.status = 'done for today'
        state.message = `${(state.today.loaded || 0).toLocaleString('en-AU')} usernames read today (the safe daily amount is ${USERNAMES_PER_DAY.toLocaleString('en-AU')}); more tomorrow.`
        break
      }
      // The next creator nobody has read or is reading, whose list (when its size is known) fits today.
      const sizes = loadSizes()
      let next = null
      for (const username of sheet.sources) {
        if (sheet.scraped.has(username) || claimed.has(username) || (state.skipped || []).includes(username)) continue
        if (sizes[username] && !fits(sizes[username], left)) continue
        if (startedBefore(username)) {
          await markScraped(username)
          continue
        }
        next = username
        break
      }
      if (!next) {
        state.status = 'done for today'
        state.message = 'Every creator on the list has been read.'
        break
      }
      claimed.add(next)
      state.current = { username: next }
      save(account, state)
      let result
      try {
        result = await whenFree(() => ig.scraperFollowing(next, left + LEEWAY, account, { budget: left + LEEWAY, cap: USERNAMES_PER_DAY }))
        if (result.followingCount) rememberSize(next, result.followingCount)
        if (result.overBudget) {
          // Too long for what this account has left today: left for an account with more room (or a fresh
          // day), and this one tries the next creator, a few times a day at most.
          claimed.delete(next)
          state.current = null
          state.today.skips = (state.today.skips || 0) + 1
          log(`${name}: @${next} follows ${Number(result.followingCount || 0).toLocaleString('en-AU')}, more than the ${left.toLocaleString('en-AU')} left today; left for another account.`)
          if (state.today.skips >= SKIPS_PER_DAY) {
            state.status = 'done for today'
            state.message = `${(state.today.loaded || 0).toLocaleString('en-AU')} usernames read today; the next lists are too long for what is left, so more tomorrow.`
            break
          }
          save(account, state)
          await sleep(between([20 * 1000, 60 * 1000]))
          continue
        }
        state.today.lists = (state.today.lists || 0) + 1
        state.today.loaded = (state.today.loaded || 0) + (result.usernames || []).length
      } catch (error) {
        if (STOPS.includes(error.kind)) {
          claimed.delete(next) // not read: another account (or this one, later) takes it
          throw error
        }
        log(`${name}: @${next}'s following could not be read (${error.message}); on Scraped, next line.`)
        state.skipped = [...(state.skipped || []), next].slice(-2000)
        await markScraped(next)
        state.current = null
        save(account, state)
        continue
      }
      const usernames = result.usernames || []
      const followingCount = result.followingCount || 0
      // Far fewer than they follow: Instagram is holding the list back from this account (typically
      // right after a check). This account stops until tomorrow; the creator is left for a later read.
      if (followingCount >= 50 && usernames.length < Math.min(followingCount, left) * 0.2) {
        claimed.delete(next)
        state.current = null
        throw Object.assign(new Error(`Instagram only showed ${usernames.length} of @${next}'s ${followingCount.toLocaleString('en-AU')} following, so it is limiting this scraper account for now. Paused until tomorrow.`), { kind: 'limited' })
      }
      const { added, waiting } = await addToTemp(usernames, next, sheet.handles)
      state.started = { ...(state.started || {}), [next]: Date.now() }
      await markScraped(next)
      state.today.creators = (state.today.creators || 0) + 1
      state.today.added = (state.today.added || 0) + added
      state.current = null
      save(account, state)
      log(`${name}: read @${next}'s following (${usernames.length}), ${added} new into ${TEMP_TAB} (${waiting} there).`)
      // A break after a list, like a person would take.
      state.message = 'Short break after reading a following list.'
      save(account, state)
      await sleep(between(BREAK_AFTER_LIST_MS))
      state.message = ''
    }
    if (state.status === 'running') {
      state.status = 'done for today'
      if (!state.message) state.message = 'Stopped for the night (runs 8:00 to 21:00).'
    }
  } catch (error) {
    if (error.kind === 'limited') {
      state.status = 'stopped'
      state.message = error.message
    } else if (STOPS.includes(error.kind)) {
      // A warning (Instagram wants the account verified) or logged out: this account waits for the
      // person ("Done, resume" on the card).
      state.status = error.kind === 'login' ? 'needs login' : 'needs check'
      state.message = error.kind === 'login' ? 'The scraper account was logged out: log it back in.' : error.message
    } else {
      state.status = 'idle'
      state.message = `Paused: ${error.message}`
    }
    if (state.current) claimed.delete(state.current.username)
    state.current = null
  }
  await flushPending().catch((error) => { state.message = `${state.message} (sheet write failed: ${error.message})` })
  save(account, state)
  return state
}

// "Done, resume" after the person verified the account (or logged it in) in its window.
function resume(ig, log, account = 1) {
  const state = load(account)
  if (['needs check', 'stopped', 'needs login'].includes(state.status)) {
    state.status = 'idle'
    state.message = ''
    save(account, state)
  }
  return run(ig, log, account)
}

function summary() {
  const accounts = ACCOUNTS.map((account) => {
    const state = freshDay(load(account))
    return { account, status: state.status, message: state.message, today: state.today, current: state.current ? { username: state.current.username } : null }
  })
  const first = accounts[0]
  let waiting = 0
  try { waiting = JSON.parse(fs.readFileSync(WAITING_PATH, 'utf8')).count || 0 } catch { waiting = load(1).waiting || 0 }
  return { ...first, accounts, listsPerDay: LISTS_PER_DAY, usernamesPerDay: USERNAMES_PER_DAY, waiting }
}

module.exports = { run, resume, summary, flushPending, ACCOUNTS }

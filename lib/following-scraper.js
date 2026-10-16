// Since 17 Oct: the scraper account only reads following lists. For each creator on "1. Influencer
// Contact List" (in order, skipping the ones on "Scraped"), every username they follow goes into the
// "TEMP Scrape" tab (not already on a tab or waiting there), then the creator goes on "Scraped". At most
// LISTS_PER_DAY lists a day, 8:00 to 21:00, with a break after each; any warning stops it.
// (Below: the earlier profile-visiting code, kept for when profiles are looked at again.)
// Finding new creators through the people we already know: for each creator on "1. Influencer Contact
// List" (in order, skipping the ones on the "Scraped" tab), read everyone they follow with the scraper
// account (a second Instagram account, logged in by the person in its own window, never the outreach
// account), and for each followed account its bio and follower count. Then:
//   - in Australia with 10,000+ followers -> a new row at the bottom of 1. Influencer Contact List
//     (Keep hustling "pending", so the wearable model and prospecting pick it up)
//   - in Australia with fewer               -> a new row on "Customer Reach Out"
//   - anywhere else                         -> dropped
// Never a duplicate: a handle already on either tab is skipped. Each creator is scraped once: a creator
// whose list is done goes on "Scraped", and so does one whose list was started before (rows on the
// sheet say "Found in @x's following", or this Mac read it) or that can't be read (gone, private,
// following nobody); the next line of 1. Influencer Contact List is next.
// Daily budget: DAILY profile visits, whole creators only (one that would not fit waits for tomorrow,
// unless nothing was done yet today: then it starts and carries on the next day where it stopped). At
// the first warning or block from Instagram, that creator counts as done (on "Scraped") and the day
// stops. Requests are paced (a few seconds apart) and run between 8:00 and 21:00.
const fs = require('fs')
const path = require('path')
const writer = require('./sheet-writer')
const data = require('./data')

const STATE_PATH = path.join(__dirname, '..', 'data', 'following-scraper.json')
const CONTACT_TAB = '1. Influencer Contact List'
const REACH_TAB = 'Customer Reach Out'
const SCRAPED_TAB = 'Scraped'
// Profiles the scraper account visits a day (since 17 Oct: every account is visited, Meta's API is kept
// for Prospecting). Starts at START_DAILY and climbs 200 a day up to DAILY while Instagram raises no
// check; after a check it drops to 60% and climbs back the same way once 3 days pass without one.
const DAILY = 2000
const START_DAILY = 1000
// Every username of every following list read waits here (a tab of its own, so nothing is left on the
// table): visited from the top, removed once visited. A new creator's list is read only when fewer than
// a day's worth are left.
const TEMP_TAB = 'TEMP Scrape'
const TEMP_SAVE_EVERY = 50
const MIN_FOLLOWERS = 10000
// The scraper account's own activity, paced like a person (it got a "confirm you're human" check at
// ~1,600 profile visits in a few hours, 15 Oct; now spread over the whole day):
// - every followed account is visited (accounts already on a tab cost nothing);
// - at most LISTS_PER_DAY following lists a day, with a 10 to 20 minute break after each one;
// - any warning stops everything until the person has dealt with it.
// 2,000 over 8:00-21:00: 10-20 s between profiles, a 2-5 minute pause every 40-70, at most 170 an hour.
const PROFILE_GAP_MS = [10000, 20000]
const VISITS_PER_HOUR = 170
const PAUSE_EVERY = [40, 70]
const PAUSE_MS = [2 * 60 * 1000, 5 * 60 * 1000]
const LISTS_PER_DAY = 8
const BREAK_AFTER_LIST_MS = [10 * 60 * 1000, 20 * 60 * 1000]
// Rows are written to the sheets as soon as they are found.
const FLUSH_EVERY = 1
// The scraper account works 8:00 to 21:00 (reading lists, visits). Checking the accounts of a list it
// already read goes through Meta's API, which does not involve Instagram or the account: it carries on
// at night too (personal accounts found then wait for the next day's visits).
const daytime = () => { const hour = new Date().getHours(); return hour >= 8 && hour < 21 }

const AUS = /\b(australia|aussie|aus|straya|sydney|syd|melbourne|melb|brisbane|brissy|perth|adelaide|canberra|hobart|darwin|gold coast|sunshine coast|byron|newcastle|wollongong|geelong|cairns|townsville|toowoomba|ballarat|bendigo|launceston|nsw|new south wales|queensland|qld|tasmania|tassie|western australia|south australia|northern territory)\b|🇦🇺|\.com\.au\b|\.net\.au\b|\.org\.au\b/i
const NOT_AUS = /🇳🇿|new zealand|\bnz\b|auckland|wellington|christchurch|london|\buk\b|united kingdom|england|🇬🇧|\busa\b|🇺🇸|new york|\bnyc\b|los angeles|california|canada|🇨🇦|toronto|vancouver|dubai|singapore|ireland|dublin|south africa|bali/i
// Clear signs of Australia that outweigh another country being mentioned (e.g. "Sydney ✈️ London").
const STRONG_AUS = /australia|🇦🇺|\.com\.au\b|\b(sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|gold coast)\b/i

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const between = ([min, max]) => min + Math.random() * (max - min)

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { day: '', today: { scraped: 0, contacts: 0, reach: 0, discarded: 0, creators: 0 }, current: null, skipped: [], status: 'idle', message: '' }
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  const tmp = `${STATE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
  fs.renameSync(tmp, STATE_PATH)
}

function freshDay(state) {
  const day = new Date().toDateString()
  if (state.day !== day) {
    state.day = day
    state.today = { scraped: 0, contacts: 0, reach: 0, discarded: 0, creators: 0 }
    // Back up towards the full amount after an Instagram check: +200 a day once 3 days passed without one.
    if (!state.dailyCap) state.dailyCap = START_DAILY
    else if (state.dailyCap < DAILY && Date.now() - (state.checkedAt || 0) > 3 * 86400000) state.dailyCap = Math.min(DAILY, state.dailyCap + 200)
    if (state.status === 'done for today' || state.status === 'stopped') state.status = 'idle'
    if (state.status !== 'needs check') state.message = '' // a warning waits for the person, day or not
  }
  return state
}

// Is this account in Australia? From what it says about itself: bio, name, business address, links.
function inAustralia(user) {
  const address = user.business_address_json ? (() => { try { return JSON.parse(user.business_address_json) } catch { return {} } })() : {}
  // Not the name: "Victoria" or "Darwin" are names too.
  const text = [user.biography, address.city_name, address.street_address, user.business_email, user.external_url].filter(Boolean).join(' \n ')
  if (NOT_AUS.test(text) && !STRONG_AUS.test(text)) return false
  return AUS.test(text)
}

function emailIn(user) {
  if (user.business_email) return user.business_email
  const found = String(user.biography || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/)
  return found ? found[0] : ''
}

async function columnsOf(tab, headerRow) {
  const values = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(tab)}!A${headerRow}:Z${headerRow}`)}`)).values || [[]]
  return values[0].map((name) => String(name || '').trim())
}

// Every handle already on the two tabs (so nothing is added twice) and the creators already scraped.
async function known() {
  const contactValues = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(CONTACT_TAB)}!A1:H`)}`)).values || []
  const reachValues = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(REACH_TAB)}!A1:C`)}`)).values || []
  const scrapedValues = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(SCRAPED_TAB)}!A1:A`)}`)).values || []
  const handles = new Set()
  const sources = []
  // Creators whose following list was already worked on (their finds say so in NOTES, column H).
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
  await writer.api('POST', `/values/${encodeURIComponent(`${writer.quoteTitle(tab)}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { values: rows })
}

// TEMP Scrape: [USERNAME, FOUND IN (the creator whose following it came from)], header on row 1.
async function readTemp() {
  let values
  try {
    values = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(TEMP_TAB)}!A1:B`)}`)).values || []
  } catch (error) {
    if (!/unable to parse range|not found/i.test(error.message)) throw error
    await writer.api('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: TEMP_TAB } } }] })
    await writeTemp([])
    return null // just made
  }
  return values.slice(1).map((row) => ({ username: String(row[0] || '').replace(/^@/, '').trim().toLowerCase(), via: String(row[1] || '').replace(/^@/, '').trim() })).filter((entry) => entry.username)
}

async function writeTemp(queue) {
  await writer.api('POST', `/values/${encodeURIComponent(`${writer.quoteTitle(TEMP_TAB)}!A:B`)}:clear`, {})
  await writer.api('PUT', `/values/${encodeURIComponent(`${writer.quoteTitle(TEMP_TAB)}!A1`)}?valueInputOption=RAW`, { values: [['USERNAME', 'FOUND IN'], ...queue.map((entry) => [entry.username, entry.via ? `@${entry.via}` : ''])] })
}

const STOPS = ['blocked', 'login']

let running = null
// Rows found but not written yet (written every FLUSH_EVERY, at the end, and when the server stops).
const pending = { contacts: [], reach: [], scraped: [] }
async function flushPending() {
  await appendRows(CONTACT_TAB, pending.contacts.splice(0))
  await appendRows(REACH_TAB, pending.reach.splice(0))
  await appendRows(SCRAPED_TAB, pending.scraped.splice(0))
}

// The scraper account's profile visits in the last hour and today (kept in the state file).
function visitRoom(state) {
  const now = Date.now()
  state.visits = (state.visits || []).filter((at) => now - at < 3600 * 1000)
  return state.visits.length < VISITS_PER_HOUR && (state.today.visited || 0) < capOf(state)
}
const capOf = (state) => state.dailyCap || START_DAILY
// Every visit: counted, then the gap to the next one (and now and then a few minutes' pause).
async function noteVisit(state) {
  state.visits = [...(state.visits || []), Date.now()]
  state.today.visited = (state.today.visited || 0) + 1
  state.sincePause = (state.sincePause || 0) + 1
  if (!state.pauseAt) state.pauseAt = Math.round(between(PAUSE_EVERY))
  if (state.sincePause >= state.pauseAt) {
    state.sincePause = 0
    state.pauseAt = Math.round(between(PAUSE_EVERY))
    await sleep(between(PAUSE_MS))
  } else await sleep(between(PROFILE_GAP_MS))
}

// Runs until the day's budget is used, a warning stops it, or 21:00. Safe to call often.
function run(ig, log = () => {}) {
  if (!running) running = work(ig, log).finally(() => { running = null })
  return running
}

async function work(ig, log) {
  let state = freshDay(load())
  const hour = new Date().getHours()
  if (['done for today', 'stopped', 'needs check'].includes(state.status) || hour < 8 || hour >= 21) return state
  const status = await ig.scraperStatus().catch(() => ({ loggedIn: false }))
  if (!status.loggedIn || status.sameAsOutreach) {
    state.status = 'needs login'
    state.message = status.sameAsOutreach ? 'The scraper window is logged into the outreach account: log into the scraper account there instead.' : 'Log the scraper account into its window (button on the card).'
    save(state)
    return state
  }
  // The scraper window goes out of sight: it scrapes hidden (shown only to log in or verify).
  await ig.scraperHide().catch(() => {})
  await writer.prepare()
  state.contactColumns = await columnsOf(CONTACT_TAB, 3)
  const sheet = await known()
  const flush = flushPending
  // Done with this creator for good: on "Scraped", never looked at again.
  const markScraped = async (username) => {
    if (sheet.scraped.has(username)) return
    pending.scraped.push([`https://www.instagram.com/${username}/`])
    sheet.scraped.add(username)
    await flush()
  }
  // The scraper window still busy (e.g. a list read started before a restart): wait for it, never skip.
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
  // One account's profile (from the API or a visit): AUS with 10k+ to 1. Influencer Contact List, AUS
  // under 10k to Customer Reach Out, others not added. Written straight away.
  const place = async (username, profile, via) => {
    if (!profile || !profile.exists) return
    if (!inAustralia({ biography: profile.bio || '' })) {
      state.today.discarded++
      save(state)
      return
    }
    sheet.handles.add(username)
    const url = `https://www.instagram.com/${username}/`
    const followers = profile.followers || 0
    if (followers >= MIN_FOLLOWERS) {
      pending.contacts.push(contactRow(state.contactColumns, { name: profile.fullName || username, username, url, followers, email: emailIn({ biography: profile.bio }), bio: profile.bio || '', via }))
      state.today.contacts++
    } else {
      pending.reach.push([username, profile.fullName || '', url, String(followers), String(profile.bio || '').replace(/\s+/g, ' ').trim(), ''])
      state.today.reach++
    }
    if (pending.contacts.length + pending.reach.length >= FLUSH_EVERY) await flush()
    save(state)
  }
  // The waiting usernames: TEMP Scrape is the list (the person may edit it); a brand new tab starts with
  // what this Mac had waiting (the old queue and the rest of a list in progress).
  let queue = await readTemp()
  if (queue === null) {
    queue = [...(state.personalQueue || []).map((entry) => ({ username: entry.username || entry, via: entry.via || '' }))]
    if (state.current?.list) {
      for (const username of state.current.list.slice(state.current.done)) queue.push({ username, via: state.current.username })
      await markScraped(state.current.username)
      state.current = null
    }
    queue = queue.filter((entry, index) => entry.username && !sheet.handles.has(entry.username) && queue.findIndex((other) => other.username === entry.username) === index)
    await writeTemp(queue)
  }
  state.personalQueue = []
  state.waiting = queue.length
  let unsaved = 0
  const saveTemp = async () => {
    await writeTemp(queue)
    unsaved = 0
  }
  // Reads the next creator's whole following list into TEMP Scrape (then it is on Scraped). false: none
  // left to read, or not today.
  const readNextCreator = async () => {
    if ((state.today.lists || 0) >= LISTS_PER_DAY) return false
    let next = null
    for (const username of sheet.sources) {
      if (sheet.scraped.has(username) || (state.skipped || []).includes(username)) continue
      // Started before by the older versions (not finished): on Scraped, each creator is read once.
      if (sheet.started.has(username) || state.started?.[username]) {
        await markScraped(username)
        continue
      }
      next = username
      break
    }
    if (!next) return false
    // Only the following list (opening their profile is part of reading it): no other visit.
    state.current = { username: next, following: 0, done: 0, list: null }
    save(state)
    let usernames
    let followingCount = 0
    try {
      const result = await whenFree(() => ig.scraperFollowing(next))
      usernames = result.usernames || []
      followingCount = result.followingCount || 0
      state.today.lists = (state.today.lists || 0) + 1
    } catch (error) {
      if (STOPS.includes(error.kind)) throw error
      log(`Scraper: @${next}'s following could not be read (${error.message}); on Scraped, next line.`)
      state.skipped = [...(state.skipped || []), next].slice(-2000)
      await markScraped(next)
      state.current = null
      save(state)
      return true
    }
    // Far fewer than they follow (or none): Instagram is holding the list back from this account,
    // typically right after a check. Paused until tomorrow instead of reading the wrong people.
    if (followingCount >= 50 && usernames.length < followingCount * 0.2) {
      state.current = null
      throw Object.assign(new Error(`Instagram only showed ${usernames.length} of @${next}'s ${followingCount.toLocaleString('en-AU')} following, so it is limiting the scraper account for now. Paused until tomorrow.`), { kind: 'limited' })
    }
    // All of them into TEMP Scrape (the ones already on a tab or waiting are left out). The tab is read
    // again first, so what the person changed there is kept.
    queue = (await readTemp()) || []
    const waiting = new Set(queue.map((entry) => entry.username))
    let added = 0
    for (const username of usernames) {
      if (sheet.handles.has(username) || waiting.has(username)) continue
      waiting.add(username)
      queue.push({ username, via: next })
      added++
    }
    await saveTemp()
    state.started = { ...(state.started || {}), [next]: Date.now() }
    await markScraped(next)
    state.today.creators++
    state.current = null
    state.waiting = queue.length
    save(state)
    log(`Scraper: read @${next}'s following (${usernames.length}), ${added} new into ${TEMP_TAB} (${queue.length} waiting).`)
    // A break after a list, like a person would take.
    state.message = 'Short break after reading a following list.'
    save(state)
    await sleep(between(BREAK_AFTER_LIST_MS))
    state.message = ''
    return true
  }
  state.status = 'running'
  state.message = ''
  save(state)
  let noMoreCreators = false
  try {
    // Since 17 Oct the scraper only reads following lists into TEMP Scrape (no profile visits): up to
    // LISTS_PER_DAY a day, with a break after each.
    while (daytime()) {
      if ((state.today.lists || 0) >= LISTS_PER_DAY) {
        state.status = 'done for today'
        state.message = `${LISTS_PER_DAY} following lists today (the safe daily amount); more tomorrow.`
        break
      }
      if (!(await readNextCreator())) {
        state.status = 'done for today'
        state.message = 'Every creator on the list has been read.'
        break
      }
    }
    if (state.status === 'running') {
      state.status = 'done for today'
      if (!state.message) state.message = (state.today.visited || 0) >= capOf(state) ? `Today's ${capOf(state).toLocaleString('en-AU')} profiles are done.` : 'Stopped for the night (runs 8:00 to 21:00).'
    }
  } catch (error) {
    if (error.kind === 'limited') {
      state.status = 'stopped'
      state.message = error.message
    } else if (STOPS.includes(error.kind)) {
      // A warning (Instagram wants the account verified) or the account logged out: everything stops
      // until the person has dealt with it in the scraper window and pressed "Done, resume". The creator
      // in progress stays where it was (it is not finished, so not on Scraped).
      state.status = error.kind === 'login' ? 'needs login' : 'needs check'
      // An Instagram check: fewer visits a day from now on (back up slowly once all is quiet).
      if (error.kind !== 'login') {
        state.dailyCap = Math.max(500, Math.round(capOf(state) * 0.6 / 50) * 50)
        state.checkedAt = Date.now()
      }
      state.message = error.kind === 'login' ? 'The scraper account was logged out: log it back in.' : error.message
    } else {
      state.status = 'idle'
      state.message = `Paused: ${error.message}`
    }
  }
  await flush().catch((error) => { state.message = `${state.message} (sheet write failed: ${error.message})` })
  if (unsaved) await saveTemp().catch((error) => console.error('scraper: TEMP Scrape not saved', error.message))
  save(state)
  return state
}

// A new row for 1. Influencer Contact List, by its header names (row 3).
function contactRow(columns, item) {
  const row = new Array(columns.length).fill('')
  const set = (name, value) => {
    const index = columns.findIndex((column) => column.toLowerCase() === name.toLowerCase())
    if (index !== -1) row[index] = value
  }
  set('NAME', item.name)
  set('IG HANDLE', item.username)
  set('DIRECT LINK', item.url)
  set('FOLLOWERS', item.followers.toLocaleString('en-AU'))
  set('EMAIL', item.email)
  set('LOCATION', 'AUS')
  set('NOTES', `Found in @${item.via}'s following. ${String(item.bio || '').replace(/\s+/g, ' ').trim()}`.slice(0, 500))
  set('KEEP HUSTLING?', 'pending')
  return row
}

async function prepare() {
  await writer.prepare()
  const state = load()
  state.contactColumns = await columnsOf(CONTACT_TAB, 3)
  save(state)
  return state
}

// "Done, resume" after the person verified the account (or logged it back in) in the scraper window.
function resume(ig, log) {
  const state = load()
  if (['needs check', 'stopped', 'needs login'].includes(state.status)) {
    state.status = 'idle'
    state.message = ''
    save(state)
  }
  return run(ig, log)
}

function summary() {
  const state = freshDay(load())
  return { status: state.status, message: state.message, today: state.today, listsPerDay: LISTS_PER_DAY, daily: capOf(state), fullDaily: DAILY, waiting: state.waiting || 0, slowed: Boolean(state.checkedAt && capOf(state) < DAILY && Date.now() - state.checkedAt < 30 * 86400000), current: state.current ? { username: state.current.username, done: state.current.done, following: state.current.following } : null }
}

module.exports = { run, resume, prepare, summary, inAustralia, flushPending }

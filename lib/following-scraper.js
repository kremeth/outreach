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
// for Prospecting). After an Instagram check it drops to 60% and climbs back 200 a day after 3 clean days.
const DAILY = 2000
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
    if (state.dailyCap && state.dailyCap < DAILY && Date.now() - (state.checkedAt || 0) > 3 * 86400000) state.dailyCap = Math.min(DAILY, state.dailyCap + 200)
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
const capOf = (state) => state.dailyCap || DAILY
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
  const visitQueued = async () => {
    const entry = state.personalQueue.shift()
    const username = entry?.username || entry
    if (!username || typeof username !== 'string' || sheet.handles.has(username)) return
    const profile = await whenFree(() => ig.scraperProfile(username)).catch((error) => {
      if (STOPS.includes(error.kind)) throw error
      return null
    })
    state.today.scraped++
    await place(username, profile, entry?.via || '')
    await noteVisit(state)
  }
  state.status = 'running'
  state.message = ''
  save(state)
  try {
    while ((state.today.visited || 0) < capOf(state) && daytime()) {
      // Accounts left waiting by the old API-first version: visited first.
      if (state.personalQueue?.length) {
        while (!visitRoom(state)) await sleep(60 * 1000)
        await visitQueued()
        save(state)
        continue
      }
      // A creator waiting to be read whose list was already started before (e.g. lost in a restart):
      // not read again, it goes on Scraped and the next line is next.
      if (state.current && !state.current.list && (sheet.started.has(state.current.username) || state.started?.[state.current.username])) {
        log(`Scraper: @${state.current.username}'s following was already started before, so it goes on Scraped (not read twice).`)
        await markScraped(state.current.username)
        state.current = null
        save(state)
      }
      // The creator in progress, or the next one on the list not yet scraped.
      if (!state.current) {
        if (!daytime()) break
        if ((state.today.lists || 0) >= LISTS_PER_DAY) {
          state.status = 'done for today'
          state.message = `${LISTS_PER_DAY} following lists today (the safe daily amount); more tomorrow.`
          break
        }
        // Ones started before (not finished) go on Scraped on the way, so each is done once.
        let next = null
        for (const username of sheet.sources) {
          if (sheet.scraped.has(username) || (state.skipped || []).includes(username)) continue
          if (sheet.started.has(username) || state.started?.[username]) {
            await markScraped(username)
            continue
          }
          next = username
          break
        }
        if (!next) {
          state.status = 'done for today'
          state.message = 'Every creator on the list has been scraped.'
          break
        }
        while (!visitRoom(state)) await sleep(5 * 60 * 1000)
        const creator = await whenFree(() => ig.scraperProfile(next))
        await noteVisit(state)
        if (!creator.exists || creator.isPrivate || !creator.following) {
          // Gone, private or following nobody: on Scraped too (looked at once), and the next line.
          state.skipped = [...(state.skipped || []), next].slice(-2000)
          await markScraped(next)
          save(state)
          continue
        }
        // Whole creators only: one that would not fit in what is left today waits for tomorrow, unless
        // nothing was done yet today (then it starts, and carries on tomorrow where it stopped).
        if ((state.today.visited || 0) > 20 && (state.today.visited || 0) + creator.following > capOf(state)) {
          state.status = 'done for today'
          state.message = `Next: @${next} (follows ${creator.following.toLocaleString('en-AU')}), tomorrow.`
          break
        }
        state.current = { username: next, following: creator.following, done: 0, list: null }
        save(state)
      }
      const current = state.current
      if (!current.list && !daytime()) break
      if (!current.list) {
        try {
          const result = await whenFree(() => ig.scraperFollowing(current.username))
          current.list = result.usernames
          state.today.lists = (state.today.lists || 0) + 1
        } catch (error) {
          if (STOPS.includes(error.kind)) throw error
          // Can't be read (private, not shown): on Scraped, the next line.
          state.skipped = [...(state.skipped || []), current.username].slice(-2000)
          await markScraped(current.username)
          state.current = null
          save(state)
          continue
        }
        // Far fewer than they follow (or none): Instagram is holding the list back from this account,
        // typically right after a check. Pause until tomorrow instead of reading the wrong people.
        if (current.following >= 50 && current.list.length < current.following * 0.2) {
          const got = current.list.length
          current.list = null
          throw Object.assign(new Error(`Instagram only showed ${got} of @${current.username}'s ${current.following.toLocaleString('en-AU')} following, so it is limiting the scraper account for now. Paused until tomorrow.`), { kind: 'limited' })
        }
        current.following = current.list.length
        // Read: from now on this creator is never read again (its list is kept until it is done).
        state.started = { ...(state.started || {}), [current.username]: Date.now() }
        save(state)
      }
      while (current.done < current.list.length && daytime()) {
        const username = current.list[current.done]
        // Already on one of the tabs: nothing to look at (costs no visit).
        if (!username || sheet.handles.has(username)) {
          current.done++
          continue
        }
        if ((state.today.visited || 0) >= capOf(state)) break
        while (!visitRoom(state)) {
          state.message = 'Pacing: the hour\'s profile visits are used, carrying on shortly.'
          save(state)
          await sleep(60 * 1000)
        }
        state.message = ''
        // Every account through the scraper account (bio, followers, location), never Meta's API.
        const profile = await whenFree(() => ig.scraperProfile(username)).catch((error) => {
          if (STOPS.includes(error.kind)) throw error
          return null
        })
        current.done++
        state.today.scraped++
        await place(username, profile, current.username)
        await noteVisit(state)
      }
      if (current.done >= current.list.length) {
        // This creator's following list is done.
        await markScraped(current.username)
        state.today.creators++
        state.current = null
        await flush()
        save(state)
        log(`Scraped @${current.username}'s following (${current.list.length}).`)
        // A break before the next list, like a person would take.
        state.message = 'Short break before the next creator.'
        save(state)
        await sleep(between(BREAK_AFTER_LIST_MS))
        state.message = ''
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
  return { status: state.status, message: state.message, today: state.today, daily: capOf(state), fullDaily: DAILY, current: state.current ? { username: state.current.username, done: state.current.done, following: state.current.following } : null }
}

module.exports = { run, resume, prepare, summary, inAustralia, flushPending }

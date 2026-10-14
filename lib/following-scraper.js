// Finding new creators through the people we already know: for each creator on "1. Influencer Contact
// List" (in order, skipping the ones on the "Scraped" tab), read everyone they follow with the scraper
// account (a second Instagram account, logged in by the person in its own window, never the outreach
// account), and for each followed account its bio and follower count. Then:
//   - in Australia with 10,000+ followers -> a new row at the bottom of 1. Influencer Contact List
//     (Keep hustling "pending", so the wearable model and prospecting pick it up)
//   - in Australia with fewer               -> a new row on "Customer Reach Out"
//   - anywhere else                         -> dropped
// Never a duplicate: a handle already on either tab is skipped. A creator whose list is done goes on
// "Scraped".
// Daily budget: 5,000 followed accounts, whole creators only (one that would not fit waits for tomorrow,
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
const DAILY = 5000
const MIN_FOLLOWERS = 10000
const PAGE = 50
const PROFILE_GAP_MS = [3000, 6000]
const PAGE_GAP_MS = [2500, 5000]
const FLUSH_EVERY = 25

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
    if (state.status === 'done for today' || state.status === 'stopped') state.status = 'idle'
    state.message = ''
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
  const contactValues = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(CONTACT_TAB)}!A1:C`)}`)).values || []
  const reachValues = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(REACH_TAB)}!A1:C`)}`)).values || []
  const scrapedValues = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(SCRAPED_TAB)}!A1:A`)}`)).values || []
  const handles = new Set()
  const sources = []
  for (const row of contactValues.slice(3)) {
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
  return { handles, sources, scraped }
}

async function appendRows(tab, rows) {
  if (!rows.length) return
  await writer.api('POST', `/values/${encodeURIComponent(`${writer.quoteTitle(tab)}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { values: rows })
}

class Blocked extends Error {}

// One API read through the scraper account. A warning, a block, a login page or "try again later" is
// Blocked: the day stops.
async function get(ig, url) {
  const result = await ig.scraperFetch(url)
  const text = JSON.stringify(result.json || result.text || '')
  if (result.status === 429 || result.status === 401 || result.status === 403 || /checkpoint|challenge|feedback_required|please wait a few minutes|try again later|login_required|spam/i.test(text)) {
    throw new Blocked(`Instagram answered ${result.status}: ${text.slice(0, 160)}`)
  }
  if (result.status !== 200 || !result.json) throw new Error(`Instagram answered ${result.status} for ${url.split('?')[0]}`)
  return result.json
}

async function profileOf(ig, username) {
  const json = await get(ig, `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`)
  return json?.data?.user || null
}

let running = null

// Runs until the day's budget is used, a warning stops it, or the window closes. Safe to call often.
function run(ig, log = () => {}) {
  if (!running) running = work(ig, log).finally(() => { running = null })
  return running
}

async function work(ig, log) {
  let state = freshDay(load())
  const hour = new Date().getHours()
  if (state.status === 'done for today' || state.status === 'stopped' || hour < 8 || hour >= 21) return state
  const status = await ig.scraperStatus().catch(() => ({ loggedIn: false }))
  if (!status.loggedIn || status.sameAsOutreach) {
    state.status = 'needs login'
    state.message = status.sameAsOutreach ? 'The scraper window is logged into the outreach account: log into the scraper account there instead.' : 'Log the scraper account into its window (button on the card).'
    save(state)
    return state
  }
  await writer.prepare()
  state.contactColumns = await columnsOf(CONTACT_TAB, 3)
  const sheet = await known()
  const pending = { contacts: [], reach: [], scraped: [] }
  const flush = async () => {
    await appendRows(CONTACT_TAB, pending.contacts.splice(0))
    await appendRows(REACH_TAB, pending.reach.splice(0))
    await appendRows(SCRAPED_TAB, pending.scraped.splice(0))
  }
  state.status = 'running'
  state.message = ''
  save(state)
  try {
    while (state.today.scraped < DAILY && new Date().getHours() < 21) {
      // The creator in progress, or the next one on the list not yet scraped.
      if (!state.current) {
        const next = sheet.sources.find((username) => !sheet.scraped.has(username) && !(state.skipped || []).includes(username))
        if (!next) {
          state.status = 'done for today'
          state.message = 'Every creator on the list has been scraped.'
          break
        }
        const profile = await profileOf(ig, next).catch((error) => {
          if (error instanceof Blocked) throw error
          return null
        })
        await sleep(between(PROFILE_GAP_MS))
        if (!profile || profile.is_private || !profile.id) {
          // Gone or private (its following list cannot be read): left out, not marked as scraped.
          state.skipped = [...(state.skipped || []), next].slice(-2000)
          save(state)
          continue
        }
        const following = profile.edge_follow?.count || 0
        // Whole creators only: one that would not fit in what is left today waits for tomorrow, unless
        // nothing was done yet today (then it starts and carries on tomorrow where it stopped).
        if (state.today.scraped > 0 && state.today.scraped + following > DAILY) {
          state.status = 'done for today'
          state.message = `Next: @${next} (follows ${following.toLocaleString('en-AU')}), tomorrow.`
          break
        }
        state.current = { username: next, id: profile.id, following, cursor: '', done: 0 }
        save(state)
      }
      const current = state.current
      const query = `count=${PAGE}${current.cursor ? `&max_id=${encodeURIComponent(current.cursor)}` : ''}`
      const page = await get(ig, `https://www.instagram.com/api/v1/friendships/${current.id}/following/?${query}`)
      await sleep(between(PAGE_GAP_MS))
      for (const user of page.users || []) {
        const username = String(user.username || '').toLowerCase()
        current.done++
        state.today.scraped++
        if (!username || sheet.handles.has(username)) continue
        const profile = await profileOf(ig, username).catch((error) => {
          if (error instanceof Blocked) throw error
          return null
        })
        await sleep(between(PROFILE_GAP_MS))
        if (!profile) continue
        const followers = profile.edge_followed_by?.count || 0
        if (!inAustralia(profile)) {
          state.today.discarded++
          continue
        }
        sheet.handles.add(username)
        const url = `https://www.instagram.com/${username}/`
        if (followers >= MIN_FOLLOWERS) {
          pending.contacts.push(contactRow(state.contactColumns, { name: profile.full_name || username, username, url, followers, email: emailIn(profile), bio: profile.biography || '', via: current.username }))
          state.today.contacts++
        } else {
          pending.reach.push([username, profile.full_name || '', url, String(followers), String(profile.biography || '').replace(/\s+/g, ' ').trim(), ''])
          state.today.reach++
        }
        if (pending.contacts.length + pending.reach.length >= FLUSH_EVERY) await flush()
        save(state)
      }
      current.cursor = page.next_max_id || ''
      save(state)
      if (!page.next_max_id || !page.users?.length) {
        // This creator's following list is done.
        pending.scraped.push([`https://www.instagram.com/${current.username}/`])
        sheet.scraped.add(current.username)
        state.today.creators++
        state.current = null
        await flush()
        save(state)
        log(`Scraped @${current.username}'s following (${current.done}).`)
      }
    }
    if (state.status === 'running') {
      state.status = 'done for today'
      if (!state.message) state.message = state.today.scraped >= DAILY ? `Today's ${DAILY.toLocaleString('en-AU')} are done.` : 'Stopped for the night (runs 8:00 to 21:00).'
    }
  } catch (error) {
    if (error instanceof Blocked) {
      // A warning: the creator in progress counts as done (on Scraped) and the day stops.
      if (state.current) {
        pending.scraped.push([`https://www.instagram.com/${state.current.username}/`])
        state.current = null
      }
      state.status = 'stopped'
      state.message = `Stopped for today: ${error.message}`
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

function summary() {
  const state = freshDay(load())
  return { status: state.status, message: state.message, today: state.today, daily: DAILY, current: state.current ? { username: state.current.username, done: state.current.done, following: state.current.following } : null }
}

module.exports = { run, prepare, summary, inAustralia }

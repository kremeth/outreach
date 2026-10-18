// From TEMP Scrape to the sheet, automatically, once a username is enriched (lib/temp-enrich.js: URL,
// FOLLOWERS, BIO): in Australia by its bio (the rules the scraper used since 14 Oct) and
//   - 10,000+ followers -> a new row on "1. Influencer Contact List" (Keep hustling "pending", so the
//     wearable model and Prospecting pick it up)
//   - fewer             -> a new row on "Customer Reach Out"
//   - not in Australia, or not found -> left where it is.
// Never a duplicate: a handle already on either tab (or added earlier in the same pass) is not added
// again. Each TEMP Scrape row gets column G "MOVED" (where it went, or why not), so it is looked at once.
// Every 5 minutes, only on the Mac with data/wearable/RUN_HERE (both Macs appending would duplicate).
const fs = require('fs')
const path = require('path')
const writer = require('./sheet-writer')
const data = require('./data')

const TEMP_TAB = 'TEMP Scrape'
const CONTACT_TAB = '1. Influencer Contact List'
const REACH_TAB = 'Customer Reach Out'
const MIN_FOLLOWERS = 10000
const MARKER = path.join(__dirname, '..', 'data', 'wearable', 'RUN_HERE')
const STATE_PATH = path.join(__dirname, '..', 'data', 'temp-promote.json')

const AUS = /\b(australia|aussie|aus|straya|sydney|syd|melbourne|melb|brisbane|brissy|perth|adelaide|canberra|hobart|darwin|gold coast|sunshine coast|byron|newcastle|wollongong|geelong|cairns|townsville|toowoomba|ballarat|bendigo|launceston|nsw|new south wales|queensland|qld|tasmania|tassie|western australia|south australia|northern territory)\b|🇦🇺|\.com\.au\b|\.net\.au\b|\.org\.au\b/i
const NOT_AUS = /🇳🇿|new zealand|\bnz\b|auckland|wellington|christchurch|london|\buk\b|united kingdom|england|🇬🇧|\busa\b|🇺🇸|new york|\bnyc\b|los angeles|california|canada|🇨🇦|toronto|vancouver|dubai|singapore|ireland|dublin|south africa|bali/i
// Clear signs of Australia that outweigh another country being mentioned (e.g. "Sydney ✈️ London").
const STRONG_AUS = /australia|🇦🇺|\.com\.au\b|\b(sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|gold coast)\b/i

function inAustralia(bio) {
  const text = String(bio || '')
  if (NOT_AUS.test(text) && !STRONG_AUS.test(text)) return false
  return AUS.test(text)
}

const emailIn = (bio) => (String(bio || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [''])[0]
const range = (tab, a1) => `/values/${encodeURIComponent(`${writer.quoteTitle(tab)}!${a1}`)}`

function load() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) } catch { return { day: '', today: { contacts: 0, reach: 0 }, total: { contacts: 0, reach: 0 } } }
}

// A new row for 1. Influencer Contact List, by its header names (row 3).
function contactRow(columns, item) {
  const row = new Array(columns.length).fill('')
  const set = (name, value) => {
    const index = columns.findIndex((column) => column.toLowerCase() === name.toLowerCase())
    if (index !== -1) row[index] = value
  }
  set('NAME', item.name || item.username)
  set('IG HANDLE', item.username)
  set('DIRECT LINK', `https://www.instagram.com/${item.username}/`)
  set('FOLLOWERS', Number(item.followers).toLocaleString('en-AU'))
  set('EMAIL', emailIn(item.bio))
  set('LOCATION', 'AUS')
  set('NOTES', `Found in ${item.via || 'a'}'s following. ${String(item.bio || '').replace(/\s+/g, ' ').trim()}`.slice(0, 500))
  set('KEEP HUSTLING?', 'pending')
  return row
}

let running = null
function run(log = () => {}) {
  if (!fs.existsSync(MARKER)) return Promise.resolve(null)
  if (!running) running = work(log).finally(() => { running = null })
  return running
}

async function work(log) {
  await writer.prepare()
  const temp = (await writer.api('GET', range(TEMP_TAB, 'A1:G'))).values || []
  if ((temp[0] || [])[6] !== 'MOVED') await writer.api('PUT', `${range(TEMP_TAB, 'G1')}?valueInputOption=RAW`, { values: [['MOVED']] })
  // Enriched and not looked at yet.
  const todo = []
  temp.slice(1).forEach((row, index) => {
    const username = String(row[0] || '').replace(/^@/, '').trim().toLowerCase()
    const followers = String(row[3] || '').trim()
    if (username && followers && !String(row[6] || '').trim()) todo.push({ row: index + 2, username, via: String(row[1] || '').trim(), followers, bio: String(row[4] || ''), name: String(row[5] || '').trim() })
  })
  if (!todo.length) return { moved: 0 }
  // Every handle already on the two tabs.
  const contactValues = (await writer.api('GET', range(CONTACT_TAB, 'A1:C'))).values || []
  const reachValues = (await writer.api('GET', range(REACH_TAB, 'A1:C'))).values || []
  const handles = new Set()
  for (const row of contactValues.slice(3)) {
    const username = (data.usernameFrom(row[2] || '') || String(row[1] || '').replace(/^@/, '')).trim().toLowerCase()
    if (username) handles.add(username)
  }
  for (const row of reachValues.slice(1)) {
    const username = (String(row[0] || '').replace(/^@/, '') || data.usernameFrom(row[2] || '')).trim().toLowerCase()
    if (username) handles.add(username)
  }
  const columns = (((await writer.api('GET', range(CONTACT_TAB, 'A3:Z3'))).values || [[]])[0] || []).map((name) => String(name || '').trim())
  const contacts = []
  const reach = []
  const marks = []
  for (const item of todo) {
    let moved
    if (item.followers === 'not found') moved = 'not found'
    else if (handles.has(item.username)) moved = 'already on the sheet'
    else if (!inAustralia(item.bio)) moved = 'not Australia'
    else if (Number(item.followers) >= MIN_FOLLOWERS) {
      contacts.push(contactRow(columns, item))
      moved = CONTACT_TAB
    } else {
      reach.push([item.username, item.name || '', `https://www.instagram.com/${item.username}/`, String(item.followers), item.bio.replace(/\s+/g, ' ').trim(), ''])
      moved = REACH_TAB
    }
    if (moved === CONTACT_TAB || moved === REACH_TAB) handles.add(item.username)
    marks.push({ range: `${writer.quoteTitle(TEMP_TAB)}!G${item.row}`, values: [[moved]] })
  }
  // The new rows first, then the marks (a failure in between means a row is looked at again, and the
  // duplicate check then skips it).
  if (contacts.length) await writer.api('POST', `${range(CONTACT_TAB, 'A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { values: contacts })
  if (reach.length) await writer.api('POST', `${range(REACH_TAB, 'A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { values: reach })
  for (let at = 0; at < marks.length; at += 500) await writer.api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: marks.slice(at, at + 500) })
  const state = load()
  const day = new Date().toDateString()
  if (state.day !== day) { state.day = day; state.today = { contacts: 0, reach: 0 } }
  state.today.contacts += contacts.length
  state.today.reach += reach.length
  state.total.contacts += contacts.length
  state.total.reach += reach.length
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1))
  if (contacts.length || reach.length) log(`temp promote: ${contacts.length} to ${CONTACT_TAB}, ${reach.length} to ${REACH_TAB} (${todo.length} looked at)`)
  return { moved: contacts.length + reach.length, looked: todo.length }
}

function summary() {
  const state = load()
  const today = state.day === new Date().toDateString() ? state.today : { contacts: 0, reach: 0 }
  return { today, total: state.total }
}

module.exports = { run, summary, inAustralia }

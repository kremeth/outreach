// Live numbers shared between the two Macs. Some of the work only runs on one Mac (the one with
// data/wearable/RUN_HERE): the scraper accounts, the TEMP Scrape enricher and mover, the wearable model
// (Prospecting's numbers) and usually Launch. That Mac publishes its live numbers to the "Live status"
// tab of the Google Sheet every minute (one JSON cell); the other Mac reads them every minute and shows
// them in its own To do page, so both people see the same numbers whichever Mac does the work.
const fs = require('fs')
const os = require('os')
const path = require('path')
const writer = require('./sheet-writer')

const TAB = 'Live status'
const MARKER = path.join(__dirname, '..', 'data', 'wearable', 'RUN_HERE')
// Older than this, the other Mac's numbers are not shown (that Mac is off or Outreach is closed).
const STALE_MS = 10 * 60 * 1000

const runsHere = () => fs.existsSync(MARKER)
const range = (a1) => `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!${a1}`)}`

let tabReady = false
async function ensureTab() {
  if (tabReady) return
  await writer.prepare()
  const meta = await writer.api('GET', '?fields=sheets.properties(title)')
  if (!(meta.sheets || []).some((sheet) => sheet.properties.title === TAB)) {
    try {
      await writer.api('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: TAB } } }] })
    } catch (error) {
      if (!/already exists/i.test(error.message || '')) throw error
    }
  }
  tabReady = true
}

function machineName() {
  try {
    // data/display-name.txt (e.g. "Mathieu's Mac"); not machine-name.txt, which tags the shared log.
    const name = fs.readFileSync(path.join(__dirname, '..', 'data', 'display-name.txt'), 'utf8').trim()
    if (name) return name
  } catch {}
  return os.hostname().replace(/\.local$/i, '').replace(/-\d+$/, '').replace(/-/g, ' ')
}

// The working Mac: its numbers, written to the tab (A1 the JSON, A2 when, for a person looking).
async function publish(snapshot) {
  if (!runsHere()) return
  await ensureTab()
  const body = JSON.stringify({ ...snapshot, at: Date.now(), machine: machineName() })
  await writer.api('PUT', `${range('A1:A2')}?valueInputOption=RAW`, { values: [[body.slice(0, 49000)], [`Published by ${machineName()} at ${new Date().toLocaleString('en-AU')}`]] })
}

// The other Mac: the working Mac's numbers (null when there are none, or they are too old).
let remote = null
async function fetchRemote() {
  if (runsHere()) return null
  await ensureTab()
  const cell = (((await writer.api('GET', range('A1'))).values || [[]])[0] || [])[0]
  try {
    const parsed = JSON.parse(cell || 'null')
    remote = parsed && Date.now() - parsed.at < STALE_MS ? parsed : null
  } catch {
    remote = null
  }
  return remote
}

function current() {
  if (runsHere() || !remote || Date.now() - remote.at > STALE_MS) return null
  return remote
}

module.exports = { publish, fetchRemote, current, runsHere, machineName, TAB }

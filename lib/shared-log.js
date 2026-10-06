// Shared log in the Google Sheet ("App Log" tab). Every computer running Outreach appends to it and
// reads it back, so two people never work on the same creator and Instagram limits count actions
// from both computers. Rows are only ever appended (INSERT_ROWS), never edited, so nothing overwrites.
//
// Columns: Time | Machine | Account | Action | Target | Detail | Until
//   claim    Target is being worked on by Machine until Until
//   comment / dm / voice   an Instagram action; Until is when the next one of that kind may start
//   skip     a Hustling post skipped (Target = username, Detail = post id)
//   block    Instagram warned this Account; every action stops until Until
const fs = require('fs')
const os = require('os')
const path = require('path')
const writer = require('./sheet-writer')

const TAB = 'App Log'
const HEADERS = ['Time', 'Machine', 'Account', 'Action', 'Target', 'Detail', 'Until']
const READ_BACK_ROWS = 6000
const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const NAME_PATH = path.join(__dirname, '..', 'data', 'machine-name.txt')

let entries = []
let cursor = 0
let started = null
let refreshing = null
let lastRefresh = 0

function machineName() {
  if (process.env.OUTREACH_MACHINE) return process.env.OUTREACH_MACHINE
  try {
    const name = fs.readFileSync(NAME_PATH, 'utf8').trim()
    if (name) return name
  } catch {}
  return os.hostname().replace(/\.local$/i, '')
}

const MACHINE = machineName()

function parse(values, row) {
  const [time, machine, account, action, target, detail, until] = values
  return {
    row,
    time: Date.parse(time) || 0,
    machine: machine || '',
    account: account || '',
    action: action || '',
    target: target || '',
    detail: detail || '',
    until: Date.parse(until) || 0,
  }
}

function quoted() {
  return writer.quoteTitle(TAB)
}

async function start() {
  if (!started) {
    started = (async () => {
      const meta = await writer.api('GET', '?fields=sheets.properties(title,gridProperties.rowCount)')
      let tab = (meta.sheets || []).find((item) => item.properties.title === TAB)
      if (!tab) {
        try {
          await writer.api('POST', ':batchUpdate', {
            requests: [{ addSheet: { properties: { title: TAB, gridProperties: { rowCount: 1000, columnCount: HEADERS.length, frozenRowCount: 1 } } } }],
          })
          await writer.api('PUT', `/values/${encodeURIComponent(`${quoted()}!A1:G1`)}?valueInputOption=RAW`, { values: [HEADERS] })
        } catch (error) {
          // The other computer may have created it at the same moment.
          if (!/already exists/i.test(error.message || '')) throw error
        }
        tab = { properties: { gridProperties: { rowCount: 1000 } } }
      }
      const rowCount = tab.properties.gridProperties?.rowCount || 1000
      cursor = Math.max(1, rowCount - READ_BACK_ROWS)
    })()
    started.catch(() => { started = null })
  }
  return started
}

async function readNew() {
  await start()
  const result = await writer.api('GET', `/values/${encodeURIComponent(`${quoted()}!A${cursor + 1}:G`)}`)
  const values = result.values || []
  values.forEach((row, offset) => {
    if (row.some(Boolean) && row[0] !== 'Time') entries.push(parse(row, cursor + 1 + offset))
  })
  cursor += values.length
  const cutoff = Date.now() - KEEP_MS
  if (entries.length && entries[0].time < cutoff) entries = entries.filter((entry) => entry.time >= cutoff)
  lastRefresh = Date.now()
}

function refresh(maxAgeMs = 5000) {
  if (Date.now() - lastRefresh < maxAgeMs) return Promise.resolve()
  if (!refreshing) refreshing = readNew().finally(() => { refreshing = null })
  return refreshing
}

async function refreshThrough(row) {
  for (let attempt = 0; attempt < 4 && cursor < row; attempt++) {
    if (refreshing) await refreshing.catch(() => {})
    await refresh(0)
  }
}

async function append({ account = '', action, target = '', detail = '', until = 0 }) {
  await start()
  const values = [[new Date().toISOString(), MACHINE, account, action, target, String(detail), until ? new Date(until).toISOString() : '']]
  const result = await writer.api('POST', `/values/${encodeURIComponent(`${quoted()}!A1:G1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values })
  const match = String(result?.updates?.updatedRange || '').match(/!A(\d+)/)
  return match ? Number(match[1]) : 0
}

function targetsOf(entry) {
  return entry.target.split(',')
}

// Who else holds an unexpired claim on this target (or null).
function claimedByOther(target, now = Date.now()) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.action !== 'claim' || entry.machine === MACHINE || entry.until <= now) continue
    if (targetsOf(entry).includes(target)) return entry.machine
  }
  return null
}

function heldByMe(target, now = Date.now()) {
  return entries.some((entry) => entry.action === 'claim' && entry.machine === MACHINE && entry.until > now && targetsOf(entry).includes(target))
}

// Claims several targets in one row. Returns the targets this computer now holds: a target goes to
// whichever claim landed first in the sheet, so two computers claiming at once can never both win.
async function claimMany(targets, ttlMs) {
  await refresh(0)
  const now = Date.now()
  const free = targets.filter((target) => !claimedByOther(target, now))
  const needed = free.filter((target) => !heldByMe(target, now))
  if (!needed.length) return free
  const row = await append({ action: 'claim', target: needed.join(','), until: now + ttlMs })
  await refreshThrough(row)
  return free.filter((target) => !entries.some((entry) => entry.action === 'claim'
    && entry.machine !== MACHINE
    && entry.until > now
    && entry.row < row
    && targetsOf(entry).includes(target)))
}

async function claim(target, ttlMs) {
  const held = await claimMany([target], ttlMs)
  return held.includes(target) ? { ok: true } : { ok: false, by: claimedByOther(target) || 'another computer' }
}

function list(filter) {
  return entries.filter(filter)
}

module.exports = { MACHINE, refresh, append, claim, claimMany, claimedByOther, list }

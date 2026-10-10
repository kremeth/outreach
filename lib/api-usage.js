// What the Gemini API actually cost, in USD, from the token counts Gemini reports with every answer
// (logged per call in data/gemini-usage.jsonl by lib/comment-draft.js), priced at Google's published
// per-token rates. Each computer writes only its own daily totals to the "API Usage" tab of the
// Google Sheet, so the To do card shows both computers together without either overwriting the other.
const fs = require('fs')
const writer = require('./sheet-writer')
const log = require('./shared-log')
const drafts = require('./comment-draft')

const TAB = 'API Usage'
const HEADERS = ['Date', 'Machine', 'USD', 'Calls', 'Input tokens', 'Cached tokens', 'Output tokens', 'Updated']
const SYNC_MS = 2 * 60 * 1000

// USD per 1M tokens. Gemini 3.8 Flash: introductory rates to 31 Dec 2026, then double.
// Cached = context-cache reads; cache writes are billed as ordinary input.
const RATES = [
  { model: /gemini-3\.8-flash|gemini-flash-latest/, until: '2027-01-01', input: 0.75, cached: 0.075, output: 3.75 },
  { model: /gemini-3\.8-flash|gemini-flash-latest/, until: '9999-12-31', input: 1.5, cached: 0.15, output: 7.5 },
  { model: /gemini-pro-latest|gemini-3\.1-pro/, until: '9999-12-31', input: 2.0, cached: 0.2, output: 12.0 },
]

function rateFor(model, at) {
  return RATES.find((rate) => rate.model.test(model || '') && String(at || '') < rate.until) || RATES[0]
}

function costOf(entry) {
  const rate = rateFor(entry.model, entry.at)
  const fresh = Math.max(0, (entry.input || 0) - (entry.cached || 0)) + (entry.cacheWrite || 0)
  return (fresh * rate.input + (entry.cached || 0) * rate.cached + (entry.output || 0) * rate.output) / 1e6
}

function localDay(date) {
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// When this computer's call log starts (the first call it tracked).
function firstTracked() {
  if (!fs.existsSync(drafts.USAGE_PATH)) return ''
  const first = fs.readFileSync(drafts.USAGE_PATH, 'utf8').split('\n', 1)[0]
  try { return JSON.parse(first).at } catch { return '' }
}

// This computer's spend per local day, from its own call log.
function localDays() {
  const days = {}
  if (!fs.existsSync(drafts.USAGE_PATH)) return days
  for (const line of fs.readFileSync(drafts.USAGE_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const day = localDay(entry.at)
    const row = (days[day] ||= { usd: 0, calls: 0, input: 0, cached: 0, output: 0 })
    row.usd += costOf(entry)
    row.calls++
    row.input += entry.input || 0
    row.cached += entry.cached || 0
    row.output += entry.output || 0
  }
  return days
}

let sheetRows = []
let syncing = null
let syncedAt = 0

async function ensureTab() {
  const meta = await writer.api('GET', '?fields=sheets.properties(title)')
  if ((meta.sheets || []).some((item) => item.properties.title === TAB)) return
  try {
    await writer.api('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { rowCount: 1000, columnCount: HEADERS.length, frozenRowCount: 1 } } } }] })
    await writer.api('PUT', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!A1`)}?valueInputOption=RAW`, { values: [HEADERS] })
  } catch (error) {
    if (!/already exists/i.test(error.message || '')) throw error
  }
}

// Writes this computer's daily totals (its own rows only) and reads everyone's.
function sync() {
  if (!syncing) {
    syncing = (async () => {
      await writer.prepare()
      await ensureTab()
      const range = `${writer.quoteTitle(TAB)}!A1:H`
      const values = (await writer.api('GET', `/values/${encodeURIComponent(range)}`)).values || []
      const rows = values.slice(1)
      const mine = localDays()
      const updates = []
      const appends = []
      for (const [day, total] of Object.entries(mine)) {
        const line = [day, log.MACHINE, Math.round(total.usd * 1e6) / 1e6, total.calls, total.input, total.cached, total.output, new Date().toISOString()]
        const index = rows.findIndex((row) => row[0] === day && row[1] === log.MACHINE)
        if (index === -1) appends.push(line)
        else if (Number(rows[index][3]) !== total.calls) updates.push({ range: `${writer.quoteTitle(TAB)}!A${index + 2}:H${index + 2}`, values: [line] })
      }
      if (updates.length) await writer.api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: updates })
      if (appends.length) await writer.api('POST', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: appends })
      sheetRows = rows.map((row) => ({ day: row[0], machine: row[1], usd: Number(row[2]) || 0, calls: Number(row[3]) || 0, input: Number(row[4]) || 0, cached: Number(row[5]) || 0, output: Number(row[6]) || 0 }))
      syncedAt = Date.now()
    })().catch((error) => console.error('api usage', error.message)).finally(() => {
      syncing = null
    })
  }
  return syncing
}

function startSync() {
  setTimeout(sync, 20 * 1000).unref()
  setInterval(sync, SYNC_MS).unref()
}

// Today, this week (from Monday) and this month, both computers: this one live from its own log, the
// other from the tab.
async function totals() {
  if (!syncedAt) await sync()
  const now = new Date()
  const today = localDay(now)
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
  const weekStart = localDay(monday)
  const monthStart = `${today.slice(0, 7)}-01`
  const mine = localDays()
  const days = [
    ...Object.entries(mine).map(([day, total]) => ({ day, machine: log.MACHINE, ...total })),
    ...sheetRows.filter((row) => row.machine !== log.MACHINE),
  ]
  const sum = (from) => days.filter((row) => row.day >= from && row.day <= today).reduce((total, row) => total + row.usd, 0)
  const trackedDay = days.map((row) => row.day).sort()[0] || today
  // The last 28 days, oldest first, both computers. Days before tracking began are marked as such.
  const series = []
  for (let back = 27; back >= 0; back--) {
    const date = new Date(now)
    date.setDate(now.getDate() - back)
    const day = localDay(date)
    const rows = days.filter((row) => row.day === day)
    series.push({
      day,
      tracked: day >= trackedDay,
      usd: rows.reduce((total, row) => total + row.usd, 0),
      calls: rows.reduce((total, row) => total + (row.calls || 0), 0),
      input: rows.reduce((total, row) => total + (row.input || 0), 0),
      cached: rows.reduce((total, row) => total + (row.cached || 0), 0),
      output: rows.reduce((total, row) => total + (row.output || 0), 0),
    })
  }
  return {
    currency: 'USD',
    today: sum(today),
    week: sum(weekStart),
    month: sum(monthStart),
    days: series,
    trackedSince: firstTracked() || trackedDay,
    computers: [...new Set(days.map((row) => row.machine))].length,
    syncedAt: syncedAt ? new Date(syncedAt).toISOString() : '',
    updatedAt: new Date().toISOString(),
  }
}

module.exports = { totals, sync, startSync, costOf, rateFor }

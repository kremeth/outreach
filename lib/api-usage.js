// What the Gemini API actually cost, in USD, from the token counts Gemini reports with every answer
// (logged per call in data/gemini-usage.jsonl by lib/comment-draft.js), priced at Google's published
// per-token rates. Each computer writes only its own daily totals to the "API Usage" tab of the
// Google Sheet, so the To do card shows both computers together without either overwriting the other.
const fs = require('fs')
const crypto = require('crypto')
const path = require('path')
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

// This computer's tracked calls, per hour (ms of the hour's start -> USD), for the hours Google's
// billing has not reported yet.
function localHours() {
  const hours = new Map()
  if (!fs.existsSync(drafts.USAGE_PATH)) return hours
  for (const line of fs.readFileSync(drafts.USAGE_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const hour = Math.floor(Date.parse(entry.at) / 3600e3) * 3600e3
    hours.set(hour, (hours.get(hour) || 0) + costOf(entry))
  }
  return hours
}

// ---------- Google's own request counts (Cloud Monitoring) ----------
// The Gemini key's Google Cloud project. The sheet's service account has Monitoring Viewer on it, so
// Google's count of every API request (the "Total API Requests" chart in AI Studio) can be read,
// including days before Outreach logged its calls. Google reports requests, not tokens or dollars.
const GEMINI_PROJECT = 'gen-lang-client-0335076369'
const GOOGLE_EVERY_MS = 5 * 60 * 1000
const SERVICE_ACCOUNT = path.join(__dirname, '..', 'data', 'google-service-account.json')
let googleRequests = { at: 0, days: null, error: '' }
let monitoringToken = { value: '', until: 0 }

async function googleAccess() {
  if (monitoringToken.value && Date.now() < monitoringToken.until - 60000) return monitoringToken.value
  const key = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT, 'utf8'))
  const now = Math.floor(Date.now() / 1000)
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/monitoring.read https://www.googleapis.com/auth/bigquery', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url')
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(15000),
  })
  const token = await response.json()
  if (!token.access_token) throw new Error(token.error_description || 'No Monitoring access')
  monitoringToken = { value: token.access_token, until: Date.now() + (token.expires_in || 3600) * 1000 }
  return monitoringToken.value
}

// Requests per local day for the last 29 days, from hourly sums (so days follow this computer's clock).
async function fetchGoogleRequests() {
  const access = await googleAccess()
  const end = new Date()
  const start = new Date(end.getTime() - 29 * 86400e3)
  const filter = 'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.labels.service="generativelanguage.googleapis.com"'
  const params = new URLSearchParams({
    filter,
    'interval.startTime': start.toISOString(),
    'interval.endTime': end.toISOString(),
    'aggregation.alignmentPeriod': '3600s',
    'aggregation.perSeriesAligner': 'ALIGN_SUM',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
  })
  const response = await fetch(`https://monitoring.googleapis.com/v3/projects/${GEMINI_PROJECT}/timeSeries?${params}`, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(20000) })
  const payload = await response.json()
  if (payload.error) throw new Error(payload.error.message)
  const days = {}
  for (const series of payload.timeSeries || []) {
    for (const point of series.points || []) {
      // An hourly bucket belongs to the local day of its start.
      const day = localDay(Date.parse(point.interval.endTime) - 3600e3)
      days[day] = (days[day] || 0) + Number(point.value.int64Value ?? point.value.doubleValue ?? 0)
    }
  }
  return days
}

async function googleDays() {
  if (Date.now() - googleRequests.at > GOOGLE_EVERY_MS) {
    try {
      googleRequests = { at: Date.now(), days: await fetchGoogleRequests(), error: '' }
    } catch (error) {
      googleRequests = { at: Date.now(), days: googleRequests.days, error: error.message }
    }
  }
  return googleRequests
}

// ---------- Google's billing (Cloud Billing export to BigQuery) ----------
// The exact cost Google charged, per hour, from the billing export (Billing -> Billing export ->
// BigQuery, into a dataset in the Gemini project). The export table is found automatically. A
// multi-region dataset also holds the past (back to the start of the previous month). Google fills it
// in a few hours behind, so hours it has not reported yet come from Outreach's own tracked calls.
const BILLING_EVERY_MS = 10 * 60 * 1000
let billing = { at: 0, table: '', hours: null, latest: 0, error: '' }

async function bigquery(method, urlPath, body) {
  const access = await googleAccess()
  const response = await fetch(`https://bigquery.googleapis.com/bigquery/v2/${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  const payload = await response.json().catch(() => ({}))
  if (payload.error) throw new Error(payload.error.message)
  return payload
}

async function findBillingTable() {
  const datasets = (await bigquery('GET', `projects/${GEMINI_PROJECT}/datasets?all=true`)).datasets || []
  for (const dataset of datasets) {
    const id = dataset.datasetReference.datasetId
    const tables = (await bigquery('GET', `projects/${GEMINI_PROJECT}/datasets/${id}/tables?maxResults=1000`)).tables || []
    const table = tables.map((item) => item.tableReference.tableId).find((name) => /^gcp_billing_export_(v1|resource_v1)_/.test(name))
    if (table) return `${GEMINI_PROJECT}.${id}.${table}`
  }
  return ''
}

async function fetchBilling() {
  const table = billing.table || await findBillingTable()
  if (!table) return { table: '', hours: null, latest: 0 }
  // USD per hour: cost plus credits, converted from the billing currency with Google's own rate.
  const query = `
    SELECT UNIX_MILLIS(TIMESTAMP_TRUNC(usage_start_time, HOUR)) AS hour,
           SUM((cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) / IFNULL(NULLIF(currency_conversion_rate, 0), 1)) AS usd
    FROM \`${table}\`
    WHERE project.id = '${GEMINI_PROJECT}' AND usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 40 DAY)
    GROUP BY hour`
  const result = await bigquery('POST', `projects/${GEMINI_PROJECT}/queries`, { query, useLegacySql: false, timeoutMs: 25000 })
  const hours = new Map()
  for (const row of result.rows || []) hours.set(Number(row.f[0].v), Number(row.f[1].v) || 0)
  return { table, hours, latest: Math.max(0, ...hours.keys()) }
}

async function billingHours() {
  if (Date.now() - billing.at > BILLING_EVERY_MS) {
    try {
      billing = { at: Date.now(), ...(await fetchBilling()), error: '' }
    } catch (error) {
      billing = { ...billing, at: Date.now(), error: error.message }
    }
  }
  return billing
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

// Today, this week (from Monday), this month and the last 28 days, in USD. Each hour comes from
// Google's billing when it has reported it, otherwise from the calls Outreach tracked (this computer
// by the hour, the other computer by the day through the sheet).
async function totals() {
  if (!syncedAt) await sync()
  const now = new Date()
  const today = localDay(now)
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
  const weekStart = localDay(monday)
  const monthStart = `${today.slice(0, 7)}-01`
  const [google, bill] = await Promise.all([googleDays(), billingHours()])
  const billed = bill.hours && bill.hours.size ? bill.hours : null
  const cutoff = billed ? bill.latest + 3600e3 : 0

  const perDay = {}
  const add = (day, usd, source) => {
    const row = (perDay[day] ||= { usd: 0, billed: 0, tracked: 0 })
    row.usd += usd
    row[source] += usd
  }
  if (billed) for (const [hour, usd] of billed) add(localDay(hour), usd, 'billed')
  for (const [hour, usd] of localHours()) if (hour >= cutoff) add(localDay(hour), usd, 'tracked')
  const cutoffDay = billed ? localDay(cutoff) : ''
  for (const row of sheetRows) {
    if (row.machine === log.MACHINE) continue
    if (!billed || row.day > cutoffDay) add(row.day, row.usd, 'tracked')
  }
  const mine = localDays()
  const sum = (from) => Object.entries(perDay).filter(([day]) => day >= from && day <= today).reduce((total, [, row]) => total + row.usd, 0)
  const series = []
  for (let back = 27; back >= 0; back--) {
    const date = new Date(now)
    date.setDate(now.getDate() - back)
    const day = localDay(date)
    const row = perDay[day] || { usd: 0, billed: 0, tracked: 0 }
    series.push({
      day,
      usd: row.usd,
      billed: row.billed,
      tracked: row.tracked,
      calls: mine[day]?.calls || 0,
      input: mine[day]?.input || 0,
      output: mine[day]?.output || 0,
      requests: google.days ? google.days[day] || 0 : null,
    })
  }
  return {
    currency: 'USD',
    today: sum(today),
    week: sum(weekStart),
    month: sum(monthStart),
    days: series,
    billing: { connected: Boolean(billed), table: bill.table, through: billed ? new Date(cutoff).toISOString() : '', error: bill.error },
    trackedSince: firstTracked(),
    computers: [...new Set([log.MACHINE, ...sheetRows.map((row) => row.machine)])].length,
    updatedAt: new Date().toISOString(),
  }
}

module.exports = { totals, sync, startSync, costOf, rateFor }

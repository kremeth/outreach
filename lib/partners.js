// Ongoing partnerships: creators we are working with. The deal: a story when the box arrives, then a
// reel once the month is done. Kept on the "Ongoing Partnerships" tab of the Google Sheet (both
// computers see the same), ticked on their own:
//   Story: they mention nutricode.io in their story (seen in the DM inbox), or our own story reposts
//          theirs (read in the Outreach panel). The story's date starts the month.
//   Post (the reel): ticked by hand only (since 15 Oct), when the reel is really done.
// The reel is due one month after the story. Either can also be ticked, unticked or re-dated by hand.
// Since 23 Oct, a schedule from the story's date (columns K to M, kept on the sheet so the dates stay put
// and can be changed by hand):
//   Monthly report: 27 days after the story, on a weekday, the reports spread over Monday to Friday
//     (3 to 4 a week): the weekday closest to day 27 with the fewest reports already (within 3 days).
//   Reel due: a week after the report (they have had the report experience for the reel), spread the
//     same way.
//   Box message: when a partnership is added (the Date column is the day the box went out), "we just
//     sent out your box, it should be with you on <day> or <day>": the first weekday at least 2 days
//     later and the weekday after it (Mon -> Wed/Thu, Wed -> Fri/Mon, Fri -> Mon/Tue). Date in N.
//   Check-in message: 14 days after the story, sent by Outreach ("hope you're getting on well with the
//     supplements, your report is on ..., your reel is pencilled in for ..."); its date goes in M.
const writer = require('./sheet-writer')
const data = require('./data')

const TAB = 'Ongoing Partnerships'
const HEADERS = ['Username', 'Link', 'Date', 'Story', 'Post', 'Story seen', 'Post seen', 'Notes', 'Story date', 'Reel date', 'Report date', 'Reel due', 'Check-in sent', 'Box message sent', 'First name']
const REPORT_AFTER_DAYS = 27
const REEL_AFTER_REPORT_DAYS = 7
const CHECKIN_AFTER_DAYS = 14
const SPREAD_DAYS = 3
const PER_WEEK = 4
// The first ones, given on 13 Oct 2026 (none had posted yet).
const SEED = [
  ['hayleyjconnor', '08/10/2026'],
  ['seansmith_29', '09/10/2026'],
  ['joshua.butson', '10/10/2026'],
  ['sebastian__zajaczkowski', '11/10/2026'],
  ['charlie.williams', '12/10/2026'],
]
const CACHE_MS = 90 * 1000

let cache = { at: 0, rows: [] }

let headersChecked = false
async function ensureTab() {
  await writer.prepare()
  const meta = await writer.api('GET', '?fields=sheets.properties(title,sheetId,gridProperties)')
  const existing = (meta.sheets || []).find((item) => item.properties.title === TAB)
  if (existing) {
    // Tabs made before 15 Oct: the Story date and Reel date columns are added (I and J).
    if (!headersChecked) {
      const columns = existing.properties.gridProperties?.columnCount || 0
      if (columns < HEADERS.length) {
        await writer.api('POST', ':batchUpdate', { requests: [{ appendDimension: { sheetId: existing.properties.sheetId, dimension: 'COLUMNS', length: HEADERS.length - columns } }] })
      }
      const head = ((await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!I1:O1`)}`)).values || [[]])[0] || []
      if (head.join('|') !== HEADERS.slice(8).join('|')) {
        await writer.api('PUT', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!I1:O1`)}?valueInputOption=RAW`, { values: [HEADERS.slice(8)] })
      }
      headersChecked = true
    }
    return
  }
  try {
    await writer.api('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { rowCount: 200, columnCount: HEADERS.length, frozenRowCount: 1 } } } }] })
    const values = [HEADERS, ...SEED.map(([username, date]) => [username, `https://www.instagram.com/${username}/`, date, 'No', 'No', '', '', '', '', ''])]
    await writer.api('PUT', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!A1`)}?valueInputOption=USER_ENTERED`, { values })
  } catch (error) {
    if (!/already exists/i.test(error.message || '')) throw error
  }
}

// dd/mm/yyyy (the sheet's dates) <-> Date.
function parseDate(text) {
  const m = String(text || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) return null
  const date = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
  return Number.isNaN(date.getTime()) ? null : date
}
function formatDate(date) {
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`
}
const iso = (date) => (date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '')

// The reel is due a month after the story (same day next month; 31 Jan -> 28 Feb).
function reelDue(start) {
  const due = new Date(start.getFullYear(), start.getMonth() + 1, start.getDate())
  if (due.getDate() !== start.getDate()) due.setDate(0)
  return due
}

async function list(force = false) {
  if (!force && Date.now() - cache.at < CACHE_MS) return cache.rows
  await ensureTab()
  const values = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!A1:O`)}`)).values || []
  const [header = HEADERS, ...lines] = values
  const at = (name) => header.indexOf(name)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const rows = lines.map((line, index) => {
    const username = data.usernameFrom(line[at('Link')] || '') || String(line[at('Username')] || '').replace(/^@/, '').trim().toLowerCase()
    const story = /^(yes|true|✓|x)$/i.test(String(line[at('Story')] || '').trim())
    const post = /^(yes|true|✓|x)$/i.test(String(line[at('Post')] || '').trim())
    // The month starts with their story: its own date, else (rows from before 15 Oct) the row's date.
    const storyDate = story ? parseDate(at('Story date') >= 0 ? line[at('Story date')] : '') || parseDate(line[at('Date')]) : null
    const reelDate = post ? parseDate(at('Reel date') >= 0 ? line[at('Reel date')] : '') || parseDate(line[at('Post seen')]) : null
    // The schedule (once set): the report, the reel a week later, the check-in two weeks in.
    const reportDate = at('Report date') >= 0 ? parseDate(line[at('Report date')]) : null
    const scheduledReel = at('Reel due') >= 0 ? parseDate(line[at('Reel due')]) : null
    const due = scheduledReel || (storyDate ? reelDue(storyDate) : null)
    const checkinAt = storyDate ? new Date(storyDate.getFullYear(), storyDate.getMonth(), storyDate.getDate() + CHECKIN_AFTER_DAYS) : null
    // The box: sent on the row's date, with them two to three weekdays later.
    const sentDate = parseDate(line[at('Date')])
    const arrives = sentDate ? arrivalDays(sentDate) : []
    return {
      notes: line[at('Notes')] || '',
      // How the messages greet them ("Nick and Lindall"), filled on the sheet.
      firstName: at('First name') >= 0 ? String(line[at('First name')] || '').trim() : '',
      sentDate: iso(sentDate),
      arrives: arrives.map(iso),
      boxMessageSent: at('Box message sent') >= 0 ? String(line[at('Box message sent')] || '').trim() : '',
      reportDate: iso(reportDate),
      reportDaysLeft: reportDate ? Math.round((reportDate - today) / 86400000) : null,
      reelScheduled: Boolean(scheduledReel),
      checkinDue: iso(checkinAt),
      checkinSent: at('Check-in sent') >= 0 ? String(line[at('Check-in sent')] || '').trim() : '',
      row: index + 2,
      username,
      date: line[at('Date')] || '',
      story,
      post,
      storySeen: line[at('Story seen')] || '',
      postSeen: line[at('Post seen')] || '',
      storyDate: iso(storyDate),
      // The story's own date is on the sheet (not the row's date standing in for it).
      storyDated: Boolean(parseDate(at('Story date') >= 0 ? line[at('Story date')] : '')),
      reelDate: iso(reelDate),
      reelDue: iso(due),
      daysLeft: due ? Math.round((due - today) / 86400000) : null,
    }
  }).filter((row) => row.username)
  cache = { at: Date.now(), rows }
  return rows
}

// Ticks (or unticks) Story or Post (the reel) for a creator; "seen" says when and how it was found;
// date (a Date, default today) is the story's or the reel's date. keepDate: a story already dated keeps
// its date (the month started with the first one).
async function mark(username, kind, value, seen = '', date = new Date(), { keepDate = false } = {}) {
  const rows = await list(true)
  const row = rows.find((item) => item.username === String(username).toLowerCase())
  if (!row) return false
  const story = kind === 'story'
  const column = story ? 'D' : 'E'
  const seenColumn = story ? 'F' : 'G'
  const dateColumn = story ? 'I' : 'J'
  const writes = [
    { range: `${writer.quoteTitle(TAB)}!${column}${row.row}`, values: [[value ? 'Yes' : 'No']] },
    { range: `${writer.quoteTitle(TAB)}!${seenColumn}${row.row}`, values: [[value ? seen : '']] },
  ]
  const dated = story ? row.storyDated : row.reelDate
  // A story (un)ticked before the check-in went out: the schedule is worked out again from it.
  if (story && !row.checkinSent) writes.push({ range: `${writer.quoteTitle(TAB)}!K${row.row}:L${row.row}`, values: [['', '']] })
  if (!value) writes.push({ range: `${writer.quoteTitle(TAB)}!${dateColumn}${row.row}`, values: [['']] })
  else if (!(keepDate && dated)) writes.push({ range: `${writer.quoteTitle(TAB)}!${dateColumn}${row.row}`, values: [[formatDate(date)]] })
  await writer.api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: writes })
  cache.at = 0
  return true
}

// A different date for the story or the reel (picked by hand), "yyyy-mm-dd".
async function setDate(username, kind, isoDate) {
  const rows = await list(true)
  const row = rows.find((item) => item.username === String(username).toLowerCase())
  const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!row || !m) return false
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const story = kind === 'story'
  await writer.api('POST', '/values:batchUpdate', {
    valueInputOption: 'RAW',
    data: [
      { range: `${writer.quoteTitle(TAB)}!${story ? 'D' : 'E'}${row.row}`, values: [['Yes']] },
      { range: `${writer.quoteTitle(TAB)}!${story ? 'I' : 'J'}${row.row}`, values: [[formatDate(date)]] },
      // A new story date before the check-in went out: the schedule follows it.
      ...(story && !row.checkinSent ? [{ range: `${writer.quoteTitle(TAB)}!K${row.row}:L${row.row}`, values: [['', '']] }] : []),
    ],
  })
  cache.at = 0
  return true
}

// When a box sent on `sent` arrives: the first weekday at least 2 days later, and the weekday after it.
function arrivalDays(sent) {
  const nextWeekday = (date) => {
    const day = new Date(date)
    while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() + 1)
    return day
  }
  const first = nextWeekday(new Date(sent.getFullYear(), sent.getMonth(), sent.getDate() + 2))
  const second = nextWeekday(new Date(first.getFullYear(), first.getMonth(), first.getDate() + 1))
  return [first, second]
}

// The box message went out (or was queued): its date in column N.
async function boxMessageSent(username, when = new Date()) {
  const rows = await list(true)
  const row = rows.find((item) => item.username === String(username).toLowerCase())
  if (!row) return false
  await writer.api('PUT', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!N${row.row}`)}?valueInputOption=RAW`, { values: [[formatDate(when)]] })
  cache.at = 0
  return true
}

// Monday is the week's first day (for "3 to 4 a week").
const weekOf = (date) => {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7))
  return iso(monday)
}
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
const fromIso = (text) => (text ? new Date(`${text}T00:00:00`) : null)

// The weekday nearest to `target` (within SPREAD_DAYS) with the fewest already on that day, a week
// holding PER_WEEK or more avoided when possible; on a tie, the day closest to target, earlier first.
function spreadDay(target, taken) {
  let best = null
  for (let offset = -SPREAD_DAYS; offset <= SPREAD_DAYS; offset++) {
    const day = addDays(target, offset)
    if (day.getDay() === 0 || day.getDay() === 6) continue
    const sameDay = taken.filter((other) => iso(other) === iso(day)).length
    const sameWeek = taken.filter((other) => weekOf(other) === weekOf(day)).length
    const score = sameDay * 10 + (sameWeek >= PER_WEEK ? 50 : 0) + Math.abs(offset) + (offset > 0 ? 0.1 : 0)
    if (!best || score < best.score) best = { day, score }
  }
  return best.day
}

// Every partner with a story and no schedule yet gets one (written to the sheet). Returns the new ones.
async function schedule() {
  const rows = await list(true)
  const reports = rows.map((row) => fromIso(row.reportDate)).filter(Boolean)
  const reels = rows.filter((row) => row.reelScheduled).map((row) => fromIso(row.reelDue)).filter(Boolean)
  const writes = []
  const added = []
  for (const row of rows) {
    if (!row.story || !row.storyDate || row.reportDate || row.post) continue
    const report = spreadDay(addDays(fromIso(row.storyDate), REPORT_AFTER_DAYS), reports)
    reports.push(report)
    const reel = spreadDay(addDays(report, REEL_AFTER_REPORT_DAYS), reels)
    reels.push(reel)
    writes.push({ range: `${writer.quoteTitle(TAB)}!K${row.row}:L${row.row}`, values: [[formatDate(report), formatDate(reel)]] })
    added.push({ username: row.username, report: iso(report), reel: iso(reel) })
  }
  if (writes.length) {
    await writer.api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: writes })
    cache.at = 0
  }
  return added
}

// The check-in went out (or was queued): its date in column M.
async function checkinSent(username, when = new Date()) {
  const rows = await list(true)
  const row = rows.find((item) => item.username === String(username).toLowerCase())
  if (!row) return false
  await writer.api('PUT', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!M${row.row}`)}?valueInputOption=RAW`, { values: [[formatDate(when)]] })
  cache.at = 0
  return true
}

module.exports = { list, mark, setDate, schedule, checkinSent, boxMessageSent, arrivalDays, TAB }

// Ongoing partnerships: creators we are working with. The deal: a story when the box arrives, then a
// reel once the month is done. Kept on the "Ongoing Partnerships" tab of the Google Sheet (both
// computers see the same), ticked on their own:
//   Story: they mention nutricode.io in their story (seen in the DM inbox), or our own story reposts
//          theirs (read in the Outreach panel). The story's date starts the month.
//   Post (the reel): ticked by hand only (since 15 Oct), when the reel is really done.
// The reel is due one month after the story. Either can also be ticked, unticked or re-dated by hand.
const writer = require('./sheet-writer')
const data = require('./data')

const TAB = 'Ongoing Partnerships'
const HEADERS = ['Username', 'Link', 'Date', 'Story', 'Post', 'Story seen', 'Post seen', 'Notes', 'Story date', 'Reel date']
// The first ones, given on 13 Oct 2026 (none had posted yet).
const SEED = [
  ['hayleyjconnor', '08/10/2026'],
  ['seansmith_29', '09/10/2026'],
  ['joshua.butson', '10/10/2026'],
  ['sebastian__zajaczkowski', '11/10/2026'],
  ['charlie.williams', '12/10/2026'],
]
const CACHE_MS = 2 * 60 * 1000

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
      const head = ((await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!I1:J1`)}`)).values || [[]])[0] || []
      if (head[0] !== 'Story date' || head[1] !== 'Reel date') {
        await writer.api('PUT', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!I1:J1`)}?valueInputOption=RAW`, { values: [['Story date', 'Reel date']] })
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
  const values = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!A1:J`)}`)).values || []
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
    const due = storyDate ? reelDue(storyDate) : null
    return {
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
    ],
  })
  cache.at = 0
  return true
}

module.exports = { list, mark, setDate, TAB }

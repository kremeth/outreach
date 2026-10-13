// Ongoing partnerships: creators we are working with, each with two checkmarks, Story and Post. Kept on
// the "Ongoing Partnerships" tab of the Google Sheet (both computers see the same), ticked on their own:
//   Story: one of nutricode.io's own stories reposts their story (read in the Outreach panel).
//   Post:  one of their latest posts names nutricode in its caption (logged-out preview, background).
// Either can also be ticked or unticked by hand.
const writer = require('./sheet-writer')
const data = require('./data')

const TAB = 'Ongoing Partnerships'
const HEADERS = ['Username', 'Link', 'Date', 'Story', 'Post', 'Story seen', 'Post seen', 'Notes']
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

async function ensureTab() {
  await writer.prepare()
  const meta = await writer.api('GET', '?fields=sheets.properties(title)')
  if ((meta.sheets || []).some((item) => item.properties.title === TAB)) return
  try {
    await writer.api('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { rowCount: 200, columnCount: HEADERS.length, frozenRowCount: 1 } } } }] })
    const values = [HEADERS, ...SEED.map(([username, date]) => [username, `https://www.instagram.com/${username}/`, date, 'No', 'No', '', '', ''])]
    await writer.api('PUT', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!A1`)}?valueInputOption=USER_ENTERED`, { values })
  } catch (error) {
    if (!/already exists/i.test(error.message || '')) throw error
  }
}

async function list(force = false) {
  if (!force && Date.now() - cache.at < CACHE_MS) return cache.rows
  await ensureTab()
  const values = (await writer.api('GET', `/values/${encodeURIComponent(`${writer.quoteTitle(TAB)}!A1:H`)}`)).values || []
  const [header = HEADERS, ...lines] = values
  const at = (name) => header.indexOf(name)
  const rows = lines.map((line, index) => {
    const username = data.usernameFrom(line[at('Link')] || '') || String(line[at('Username')] || '').replace(/^@/, '').trim().toLowerCase()
    return {
      row: index + 2,
      username,
      date: line[at('Date')] || '',
      story: /^(yes|true|✓|x)$/i.test(String(line[at('Story')] || '').trim()),
      post: /^(yes|true|✓|x)$/i.test(String(line[at('Post')] || '').trim()),
      storySeen: line[at('Story seen')] || '',
      postSeen: line[at('Post seen')] || '',
    }
  }).filter((row) => row.username)
  cache = { at: Date.now(), rows }
  return rows
}

// Ticks (or unticks) Story or Post for a creator; "seen" says when and how it was found.
async function mark(username, kind, value, seen = '') {
  const rows = await list(true)
  const row = rows.find((item) => item.username === String(username).toLowerCase())
  if (!row) return false
  const column = kind === 'story' ? 'D' : 'E'
  const seenColumn = kind === 'story' ? 'F' : 'G'
  await writer.api('POST', '/values:batchUpdate', {
    valueInputOption: 'RAW',
    data: [
      { range: `${writer.quoteTitle(TAB)}!${column}${row.row}`, values: [[value ? 'Yes' : 'No']] },
      { range: `${writer.quoteTitle(TAB)}!${seenColumn}${row.row}`, values: [[value ? seen : '']] },
    ],
  })
  cache.at = 0
  return true
}

module.exports = { list, mark, TAB }

// Sets KEEP HUSTLING? = No (+ Date + a cell note) on pending rows the text check judged to be a
// business/brand, organisation/club/media or page. Every change is logged so it can be undone.
//   node fit/apply-auto-no.js --dry     show what would change
//   node fit/apply-auto-no.js           write to the sheet
//   node fit/apply-auto-no.js --undo    put back the previous values and remove the notes
const fs = require('fs')
const path = require('path')
const sheet = require('../lib/sheet')
const data = require('../lib/data')
const writer = require('../lib/sheet-writer')

const DATA = path.join(__dirname, '..', 'data', 'fit')
const JUDGED = path.join(DATA, 'judged.jsonl')
const LOG = path.join(DATA, 'auto-no-applied.jsonl')
const KINDS = new Set(['business or brand', 'organisation, club, team or media', 'page or aggregator'])
const CHUNK = 400

function readLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function columnIndex(letter) {
  let index = 0
  for (const char of String(letter)) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

function sameLink(a, b) {
  const clean = (value) => String(value || '').trim().replace(/\/+$/, '').toLowerCase()
  return clean(a) === clean(b)
}

async function writeNotes(entries) {
  for (let start = 0; start < entries.length; start += CHUNK) {
    const requests = entries.slice(start, start + CHUNK).map(({ sheetRow, column, note }) => ({
      updateCells: {
        range: { sheetId: writer.sheetId, startRowIndex: sheetRow - 1, endRowIndex: sheetRow, startColumnIndex: column, endColumnIndex: column + 1 },
        rows: [{ values: [{ note }] }],
        fields: 'note',
      },
    }))
    await writer.api('POST', ':batchUpdate', { requests })
  }
}

async function writeValues(cells) {
  for (let start = 0; start < cells.length; start += CHUNK) {
    await writer.writeWithRetry(cells.slice(start, start + CHUNK))
  }
}

async function apply(dry) {
  const judged = readLines(JUDGED).filter((item) => !item.fits && KINDS.has(item.kind))
  const already = new Set(readLines(LOG).filter((item) => !item.undone).map((item) => item.sheetRow))
  const pending = new Map((await sheet.loadPending()).rows.map((row) => [row.sheetRow, row]))
  const all = new Map((await sheet.loadAll()).map((row) => [row.sheetRow, row]))
  const today = sheet.todayLabel()
  const plan = []
  const skipped = { notPending: 0, linkChanged: 0, alreadyApplied: 0 }
  for (const item of judged) {
    if (already.has(item.sheetRow)) {
      skipped.alreadyApplied++
      continue
    }
    const row = pending.get(item.sheetRow)
    const current = all.get(item.sheetRow)
    if (!row || !current) {
      skipped.notPending++
      continue
    }
    if (item.username && data.usernameFrom(row['DIRECT LINK']) !== item.username) {
      skipped.linkChanged++
      continue
    }
    plan.push({
      sheetRow: item.sheetRow,
      name: row.NAME,
      link: row['DIRECT LINK'],
      keepColumn: row.keepColumn,
      dateColumn: row.dateColumn,
      previousKeep: current.keep,
      previousDate: current.date,
      kind: item.kind,
      reason: item.reason,
      note: `Auto-No: ${item.kind} (text check, ${today}). ${item.reason}`,
    })
  }
  const byKind = {}
  for (const item of plan) byKind[item.kind] = (byKind[item.kind] || 0) + 1
  console.log(`${plan.length} rows to set to No`, byKind)
  console.log('skipped', skipped)
  for (const item of plan.slice(0, 5)) console.log(`  row ${item.sheetRow} ${item.name} -> No (${item.kind}: ${item.reason})`)
  if (dry || !plan.length) return

  await writer.prepare()
  const log = fs.createWriteStream(LOG, { flags: 'a' })
  for (let start = 0; start < plan.length; start += CHUNK) {
    const batch = plan.slice(start, start + CHUNK)
    const cells = []
    for (const item of batch) {
      cells.push({ cell: `${item.keepColumn}${item.sheetRow}`, value: 'No' })
      if (item.dateColumn) cells.push({ cell: `${item.dateColumn}${item.sheetRow}`, value: today })
    }
    await writeValues(cells)
    await writeNotes(batch.map((item) => ({ sheetRow: item.sheetRow, column: columnIndex(item.keepColumn), note: item.note })))
    const at = new Date().toISOString()
    for (const item of batch) log.write(`${JSON.stringify({ ...item, at })}\n`)
    console.log(`written ${Math.min(start + CHUNK, plan.length)}/${plan.length}`)
  }
  await new Promise((resolve) => log.end(resolve))
  console.log(`Done. Log: ${LOG}`)
}

async function undo() {
  const applied = readLines(LOG).filter((item) => !item.undone)
  if (!applied.length) return console.log('Nothing to undo.')
  await writer.prepare()
  for (let start = 0; start < applied.length; start += CHUNK) {
    const batch = applied.slice(start, start + CHUNK)
    const cells = []
    for (const item of batch) {
      cells.push({ cell: `${item.keepColumn}${item.sheetRow}`, value: item.previousKeep || '' })
      if (item.dateColumn) cells.push({ cell: `${item.dateColumn}${item.sheetRow}`, value: item.previousDate || '' })
    }
    await writeValues(cells)
    await writeNotes(batch.map((item) => ({ sheetRow: item.sheetRow, column: columnIndex(item.keepColumn), note: '' })))
    console.log(`restored ${Math.min(start + CHUNK, applied.length)}/${applied.length}`)
  }
  fs.appendFileSync(LOG, applied.map((item) => JSON.stringify({ ...item, undone: new Date().toISOString() })).join('\n') + '\n')
  console.log('Undone.')
}

const run = process.argv.includes('--undo') ? undo() : apply(process.argv.includes('--dry'))
run.catch((error) => {
  console.error(error.message)
  process.exit(1)
})

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CSV_PATH = path.join(ROOT, 'data', 'influencers.csv')
const STATE_PATH = path.join(ROOT, 'review-state.json')
const YES_PATH = path.join(ROOT, 'voicenote-yes.csv')

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }

  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

function csvEscape(value) {
  const text = String(value ?? '')
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function profileKey(row) {
  return String(row['DIRECT LINK'] || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase()
}

function usernameFrom(link) {
  const match = String(link || '').match(/instagram\.com\/([^/?#]+)/i)
  if (!match || /^(p|reel|reels|stories|explore|tv|accounts|share)$/i.test(match[1])) return ''
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function rankingOf(row) {
  const key = Object.keys(row).find((name) => name.includes('GUT FEEL'))
  return key ? String(row[key] || '').trim() : ''
}

function stamp() {
  const date = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function prettyPath(filePath) {
  const home = os.homedir()
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath
}

function loadRows() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`Missing ${CSV_PATH}`)
  }
  const text = fs.readFileSync(CSV_PATH, 'utf8').replace(/^\uFEFF/, '')
  const table = parseCsv(text)
  if (!table.length) throw new Error('The CSV is empty.')

  const headers = table[0]
  const rows = []
  for (let i = 1; i < table.length; i++) {
    const cells = table[i]
    if (cells.every((cell) => !String(cell).trim())) continue
    const row = {}
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? ''
    })
    if (!String(row.NAME || '').trim() && !String(row['DIRECT LINK'] || '').trim()) continue
    rows.push(row)
  }

  return { headers, rows }
}

function loadDecisions() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    return raw && typeof raw.decisions === 'object' && raw.decisions ? raw.decisions : {}
  } catch {
    return {}
  }
}

function firstUndecided(rows, decisions) {
  const index = rows.findIndex((row) => !decisions[profileKey(row)])
  return index === -1 ? 0 : index
}

function record(decisions, row, choice) {
  return {
    ...decisions,
    [profileKey(row)]: {
      choice,
      at: stamp(),
      name: row.NAME || '',
    },
  }
}

function writeYesFile(headers, rows, decisions) {
  const head = [...headers, 'VOICENOTE', 'DECIDED AT']
  const lines = [head.map(csvEscape).join(',')]

  for (const row of rows) {
    const decision = decisions[profileKey(row)]
    if (!decision || decision.choice !== 'yes') continue
    const cells = headers.map((header) => row[header] ?? '')
    cells.push('Yes', decision.at || '')
    lines.push(cells.map(csvEscape).join(','))
  }

  const tmp = `${YES_PATH}.tmp`
  fs.writeFileSync(tmp, `\uFEFF${lines.join('\n')}\n`)
  fs.renameSync(tmp, YES_PATH)
}

function persist(headers, rows, decisions) {
  const tmp = `${STATE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ decisions }, null, 2))
  fs.renameSync(tmp, STATE_PATH)
  writeYesFile(headers, rows, decisions)
}

module.exports = {
  CSV_PATH,
  STATE_PATH,
  YES_PATH,
  parseCsv,
  profileKey,
  usernameFrom,
  rankingOf,
  prettyPath,
  loadRows,
  loadDecisions,
  firstUndecided,
  record,
  persist,
}

if (require.main === module) {
  const { headers, rows } = loadRows()
  console.log(`rows ${rows.length}`)
  console.log(`headers ${headers.length}`)
  for (const row of rows) {
    console.log(`${row.NAME} | ${usernameFrom(row['DIRECT LINK'])} | ${rankingOf(row)}`)
  }
}

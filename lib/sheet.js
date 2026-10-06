const fs = require('fs')
const https = require('https')
const path = require('path')
const data = require('./data')

const ROOT = path.join(__dirname, '..')
const STATE_PATH = path.join(ROOT, 'sheet-review-state.json')
const SHEET_ID = '1jicsbKZU73g7w5PIbYYebg15KQoVtPhiWqXWjKefMrw'
const GID = '0'
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=${GID}#gid=${GID}`
const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`
const KEEP_HEADER = 'KEEP HUSTLING?'

// The CSV export can also hit Google's temporary errors; retry those for about half a minute.
async function fetchText(url) {
  for (const delay of [1000, 3000, 8000, 15000, null]) {
    try {
      return await fetchOnce(url)
    } catch (error) {
      if (!error.temporary || delay === null) throw error
      await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 1000))
    }
  }
}

function fetchOnce(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        const next = new URL(response.headers.location, url).toString()
        resolve(fetchOnce(next))
        return
      }
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) {
          const temporary = response.statusCode === 429 || response.statusCode >= 500
          reject(Object.assign(new Error(temporary ? `Google Sheets is temporarily unavailable (${response.statusCode}).` : `Sheet download failed (${response.statusCode})`), { temporary }))
          return
        }
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
    })
    request.on('error', (error) => reject(Object.assign(error, { temporary: true })))
  })
}

function columnLetter(index) {
  let number = index + 1
  let letters = ''
  while (number > 0) {
    const remainder = (number - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    number = Math.floor((number - 1) / 26)
  }
  return letters
}

function cell(row, index) {
  return index >= 0 && index < row.length ? String(row[index] ?? '') : ''
}

async function loadPending() {
  const text = await fetchText(`${EXPORT_URL}&cb=${Date.now()}`)
  const table = data.parseCsv(text.replace(/^\uFEFF/, ''))
  const headerIndex = table.findIndex((row) => row.includes(KEEP_HEADER))
  if (headerIndex === -1) throw new Error(`The sheet has no ${KEEP_HEADER} column.`)

  const headers = table[headerIndex]
  const keepIndex = headers.indexOf(KEEP_HEADER)
  const nameIndex = headers.indexOf('NAME')
  const handleIndex = headers.indexOf('IG HANDLE')
  const linkIndex = headers.indexOf('DIRECT LINK')
  const followersIndex = headers.indexOf('FOLLOWERS')
  const emailIndex = headers.indexOf('EMAIL')
  const locationIndex = headers.indexOf('LOCATION')
  const notesIndex = headers.indexOf('NOTES')
  const engagementIndex = headers.indexOf('Engagement Rate')
  const rankingIndex = headers.findIndex((name) => name.includes('GUT FEEL'))
  const dateIndex = headers.indexOf('Date')
  const deviceIndex = headers.findIndex((name) => name.trim().toLowerCase() === 'device')
  const acceptedIndex = headers.findIndex((name) => name.trim().toUpperCase() === 'ACCEPTED?')
  const voiceIndex = headers.findIndex((name) => name.trim().toLowerCase() === 'voice')
  const voiceDateIndex = headers.findIndex((name) => name.trim().toLowerCase() === 'voice date')
  const firstDateIndex = headers.findIndex((name) => /outreach msg #1 date/i.test(name))
  let relaunchIndex = headers.findIndex((name) => /outreach msg #2 date/i.test(name))
  if (relaunchIndex === -1 && firstDateIndex !== -1 && !String(headers[firstDateIndex + 1] || '').trim()) relaunchIndex = firstDateIndex + 1
  const secondIndex = headers.findIndex((name) => /outreach msg #3 date/i.test(name))
  const messageIndex = headers.findIndex((name) => name.trim().toUpperCase() === 'EXACT MESSAGE SENT')
  const rows = []
  const yesRows = []

  for (let index = headerIndex + 1; index < table.length; index++) {
    const source = table[index]
    const keep = cell(source, keepIndex).trim().toLowerCase()
    const name = cell(source, nameIndex).trim()
    const link = cell(source, linkIndex).trim()
    if (keep === 'yes') {
      if (name || link) {
        yesRows.push({
          sheetRow: index + 1,
          name,
          link,
          followers: cell(source, followersIndex).trim(),
          location: cell(source, locationIndex).trim(),
          device: cell(source, deviceIndex).trim(),
          accepted: cell(source, acceptedIndex).trim(),
          voice: cell(source, voiceIndex).trim(),
          voiceDate: cell(source, voiceDateIndex).trim(),
          date: cell(source, dateIndex).trim(),
          notes: cell(source, notesIndex).trim(),
          firstDate: cell(source, firstDateIndex).trim(),
          relaunchDate: cell(source, relaunchIndex).trim(),
          secondDate: cell(source, secondIndex).trim(),
          message: cell(source, messageIndex).trim(),
        })
      }
      continue
    }
    if (keep === 'no') continue
    if (!name && !link) continue
    rows.push({
      sheetRow: index + 1,
      keepColumn: columnLetter(keepIndex),
      linkColumn: columnLetter(linkIndex),
      dateColumn: dateIndex === -1 ? '' : columnLetter(dateIndex),
      deviceColumn: deviceIndex === -1 ? '' : columnLetter(deviceIndex),
      acceptedColumn: acceptedIndex === -1 ? '' : columnLetter(acceptedIndex),
      NAME: name,
      'IG HANDLE': cell(source, handleIndex).trim(),
      'DIRECT LINK': link,
      FOLLOWERS: cell(source, followersIndex).trim(),
      EMAIL: cell(source, emailIndex).trim(),
      LOCATION: cell(source, locationIndex).trim(),
      NOTES: cell(source, notesIndex).trim(),
      'Engagement Rate': cell(source, engagementIndex).trim(),
      ranking: cell(source, rankingIndex).trim(),
    })
  }

  const outreachColumns = {
    relaunch: relaunchIndex === -1 ? '' : columnLetter(relaunchIndex),
    second: secondIndex === -1 ? '' : columnLetter(secondIndex),
    link: columnLetter(linkIndex),
    keep: columnLetter(keepIndex),
    accepted: acceptedIndex === -1 ? '' : columnLetter(acceptedIndex),
  }
  return { rows, yesRows, outreachColumns }
}

async function loadAll() {
  const text = await fetchText(`${EXPORT_URL}&cb=${Date.now()}`)
  const table = data.parseCsv(text.replace(/^\uFEFF/, ''))
  const headerIndex = table.findIndex((row) => row.includes(KEEP_HEADER))
  if (headerIndex === -1) throw new Error(`The sheet has no ${KEEP_HEADER} column.`)
  const headers = table[headerIndex]
  const at = (name) => headers.findIndex((header) => header.trim().toLowerCase() === name.toLowerCase())
  const columns = {
    keep: at(KEEP_HEADER),
    name: at('NAME'),
    handle: at('IG HANDLE'),
    link: at('DIRECT LINK'),
    followers: at('FOLLOWERS'),
    notes: at('NOTES'),
    location: at('LOCATION'),
    date: at('Date'),
    device: at('Device'),
  }
  const rows = []
  for (let index = headerIndex + 1; index < table.length; index++) {
    const source = table[index]
    const name = cell(source, columns.name).trim()
    const link = cell(source, columns.link).trim()
    if (!name && !link) continue
    rows.push({
      sheetRow: index + 1,
      keep: cell(source, columns.keep).trim(),
      name,
      handle: cell(source, columns.handle).trim(),
      link,
      followers: cell(source, columns.followers).trim(),
      notes: cell(source, columns.notes).trim(),
      location: cell(source, columns.location).trim(),
      date: cell(source, columns.date).trim(),
      device: cell(source, columns.device).trim(),
    })
  }
  return rows
}

function loadDecisions() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    return raw && typeof raw.decisions === 'object' && raw.decisions ? raw.decisions : {}
  } catch {
    return {}
  }
}

function savedDecision(decisions, row) {
  const saved = decisions[String(row.sheetRow)]
  if (!saved) return null
  const savedLink = String(saved.link || '').replace(/\/+$/, '').toLowerCase()
  const rowLink = String(row['DIRECT LINK'] || '').replace(/\/+$/, '').toLowerCase()
  if (savedLink && rowLink && savedLink !== rowLink) return null
  return saved
}

function firstUndecided(rows, decisions) {
  const index = rows.findIndex((row) => !savedDecision(decisions, row))
  return index === -1 ? 0 : index
}

function record(decisions, row, choice) {
  return {
    ...decisions,
    [String(row.sheetRow)]: {
      choice,
      at: dataStamp(),
      name: row.NAME || '',
      link: row['DIRECT LINK'] || '',
    },
  }
}

function todayLabel() {
  const date = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}

function dataStamp() {
  const date = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function csvEscape(value) {
  const text = String(value ?? '')
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function persist(rows, decisions) {
  const tmp = `${STATE_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ decisions }, null, 2))
  fs.renameSync(tmp, STATE_PATH)

  const head = ['NAME', 'IG HANDLE', 'DIRECT LINK', 'FOLLOWERS', 'NOTES', 'SHEET ROW', 'KEEP HUSTLING', 'DECIDED AT']
  const lines = [head.join(',')]
  for (const row of rows) {
    const decision = savedDecision(decisions, row)
    if (!decision || decision.choice !== 'yes') continue
    lines.push([
      row.NAME,
      row['IG HANDLE'],
      row['DIRECT LINK'],
      row.FOLLOWERS,
      row.NOTES,
      row.sheetRow,
      'Yes',
      decision.at || '',
    ].map(csvEscape).join(','))
  }
  const yesTmp = `${data.YES_PATH}.tmp`
  fs.writeFileSync(yesTmp, `\uFEFF${lines.join('\n')}\n`)
  fs.renameSync(yesTmp, data.YES_PATH)
}

module.exports = {
  SHEET_ID,
  GID,
  SHEET_URL,
  loadPending,
  loadAll,
  todayLabel,
  loadDecisions,
  savedDecision,
  firstUndecided,
  record,
  persist,
}

const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const path = require('path')
const sheet = require('./sheet')

const KEY_PATH = path.join(__dirname, '..', 'data', 'google-service-account.json')
const SHEET_ID = sheet.SHEET_ID

function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const req = https.request({
      method,
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let payloadJson = null
        try {
          payloadJson = text ? JSON.parse(text) : null
        } catch {
          payloadJson = null
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(payloadJson)
          return
        }
        const error = new Error(payloadJson?.error?.message || text || `Google Sheets returned ${response.statusCode}`)
        error.status = response.statusCode
        reject(error)
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

class SheetWriter {
  constructor() {
    this.queue = Promise.resolve()
    this.accessState = 'unknown'
    this.accessNote = ''
    this.token = ''
    this.tokenExpiry = 0
    this.sheetTitle = ''
    this.sheetId = 0
    this.acceptedColumnIndex = null
    this.acceptedRule = null
    this.key = null
    this.batch = []
    this.flushing = false
  }

  start() {
    this.enqueue(() => this.prepare()).catch((error) => {
      console.error(error)
      this.accessState = 'unavailable'
      this.accessNote = this.explain(error)
    })
  }

  enqueue(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => {}, () => {})
    return run
  }

  setCells(entries) {
    return new Promise((resolve, reject) => {
      this.batch.push({ entries, resolve, reject })
      if (!this.flushing) this.flush()
    })
  }

  async flush() {
    this.flushing = true
    while (this.batch.length) {
      const jobs = this.batch.splice(0)
      const byCell = new Map()
      for (const job of jobs) {
        for (const entry of job.entries) byCell.set(entry.cell, entry)
      }
      try {
        await this.writeWithRetry([...byCell.values()])
        for (const job of jobs) job.resolve()
      } catch (error) {
        for (const job of jobs) job.reject(error)
      }
    }
    this.flushing = false
  }

  async writeWithRetry(entries) {
    try {
      await this.writeCells(entries)
    } catch (error) {
      if (error.status === 403) throw error
      await new Promise((resolve) => setTimeout(resolve, 700))
      await this.writeCells(entries)
    }
  }
  explain(error) {
    const email = this.key?.client_email || 'the service account'
    if (error.status === 403 || /permission/i.test(error.message || '')) {
      return `Share the sheet with ${email} as Editor. Nothing was saved.`
    }
    return error.message || 'Could not update the Google Sheet.'
  }

  loadKey() {
    if (this.key) return this.key
    this.key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'))
    return this.key
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiry - 60000) return this.token
    const key = this.loadKey()
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const claims = Buffer.from(JSON.stringify({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })).toString('base64url')
    const unsigned = `${header}.${claims}`
    const signer = crypto.createSign('RSA-SHA256')
    signer.update(unsigned)
    const signature = signer.sign(key.private_key).toString('base64url')
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }).toString()
    const token = await request('POST', 'https://oauth2.googleapis.com/token', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    })
    this.token = token.access_token
    this.tokenExpiry = Date.now() + (token.expires_in || 3600) * 1000
    return this.token
  }

  async api(method, urlPath, body) {
    const token = await this.accessToken()
    return request(method, `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${urlPath}`, {
      headers: { Authorization: `Bearer ${token}` },
      body,
    })
  }

  async prepare() {
    const meta = await this.api('GET', '?fields=sheets.properties')
    const tab = (meta.sheets || []).find((item) => item.properties && item.properties.sheetId === 0)
    this.sheetTitle = tab ? tab.properties.title : '1. Influencer Contact List'
    this.sheetId = tab ? tab.properties.sheetId : 0
    this.accessState = 'edit'
    this.accessNote = ''
    console.log(`sheet api ready ${this.sheetTitle}`)
  }

  async listDevices(column) {
    if (!column) return []
    if (!this.sheetTitle) await this.prepare()
    const range = `${this.quoteTitle(this.sheetTitle)}!${column}4`
    const meta = await this.api('GET', `?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=sheets.data.rowData.values.dataValidation`)
    const cell = meta.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]
    const values = cell?.dataValidation?.condition?.values || []
    return values.map((item) => item.userEnteredValue).filter(Boolean)
  }

  async loadAcceptedRule(column) {
    if (!column) return
    if (!this.sheetTitle) await this.prepare()
    this.acceptedColumnIndex = columnIndex(column)
    const range = `${this.quoteTitle(this.sheetTitle)}!${column}5029`
    const meta = await this.api('GET', `?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=sheets.data.rowData.values.dataValidation`)
    const cell = meta.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]
    this.acceptedRule = cell?.dataValidation || null
    this.ensureAcceptedOption('Not messaged')
    this.ensureAcceptedOption('Pending')
    this.ensureAcceptedOption('NA')
  }

  ensureAcceptedOption(value) {
    if (!this.acceptedRule?.condition) return
    const values = this.acceptedRule.condition.values || (this.acceptedRule.condition.values = [])
    if (values.some((item) => item.userEnteredValue === value)) return
    values.push({ userEnteredValue: value })
  }

  async setAccepted(sheetRow, value) {
    if (this.acceptedColumnIndex == null) return
    if (!this.sheetTitle) await this.prepare()
    const cell = { userEnteredValue: { stringValue: value || '' } }
    if (value && this.acceptedRule) cell.dataValidation = this.acceptedRule
    await this.api('POST', ':batchUpdate', {
      requests: [{
        updateCells: {
          range: {
            sheetId: this.sheetId,
            startRowIndex: sheetRow - 1,
            endRowIndex: sheetRow,
            startColumnIndex: this.acceptedColumnIndex,
            endColumnIndex: this.acceptedColumnIndex + 1,
          },
          rows: [{ values: [cell] }],
          fields: 'userEnteredValue,dataValidation',
        },
      }],
    })
  }

  // Reads several A1 ranges of the main tab straight from the live sheet (not the cached CSV).
  async getValues(ranges) {
    if (!this.sheetTitle) await this.prepare()
    const title = this.quoteTitle(this.sheetTitle)
    const query = ranges.map((range) => `ranges=${encodeURIComponent(`${title}!${range}`)}`).join('&')
    const result = await this.api('GET', `/values:batchGet?${query}`)
    return (result.valueRanges || []).map((item) => item.values || [])
  }

  quoteTitle(title) {
    return `'${String(title).replace(/'/g, "''")}'`
  }

  async writeCells(entries) {
    if (!entries.length) return
    if (!this.sheetTitle) await this.prepare()
    try {
      await this.api('POST', '/values:batchUpdate', {
        valueInputOption: 'USER_ENTERED',
        data: entries.map((entry) => ({
          range: `${this.quoteTitle(this.sheetTitle)}!${entry.cell}`,
          values: [[entry.value]],
        })),
      })
      this.accessState = 'edit'
      this.accessNote = ''
    } catch (error) {
      this.accessNote = this.explain(error)
      const friendly = new Error(this.accessNote)
      friendly.status = error.status
      throw friendly
    }
  }
}

function columnIndex(letter) {
  let index = 0
  for (const char of String(letter)) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

module.exports = new SheetWriter()

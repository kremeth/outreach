// Screens Instagram profiles for fitness wearables with Gemini. Needs the review server running (npm start / node server.js).
//   node screen.js validate [--limit 150]   check recall on rows already marked Yes
//   node screen.js run [--limit 500]        dry run over undecided rows (writes nothing to the sheet)
//   node screen.js report                   build data/screen/report.html to spot-check proposed auto-Nos
const fs = require('fs')
const path = require('path')
const sheet = require('./lib/sheet')
const data = require('./lib/data')
const wearables = require('./lib/wearables')

const SERVER = 'http://127.0.0.1:8787'
const MEDIA = 'http://127.0.0.1:8788'
const OUT_DIR = path.join(__dirname, 'data', 'screen')
const FILES = {
  validate: path.join(OUT_DIR, 'validate.jsonl'),
  run: path.join(OUT_DIR, 'queue.jsonl'),
  compare: path.join(OUT_DIR, 'compare.jsonl'),
}
const PROFILE_WORKERS = 2
const GEMINI_WORKERS = 4
const PAUSE_AFTER_FAILURES = 6
const PAUSE_MS = 5 * 60 * 1000

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readResults(file) {
  if (!fs.existsSync(file)) return []
  const latest = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const result = JSON.parse(line)
    latest.set(result.sheetRow, result)
  }
  return [...latest.values()]
}

async function loadProfile(username) {
  for (let attempt = 0; ; attempt++) {
    let result
    try {
      const response = await fetch(`${SERVER}/api/preview?u=${encodeURIComponent(username)}`, { signal: AbortSignal.timeout(90000) })
      const payload = await response.json().catch(() => ({}))
      result = response.ok ? { profile: payload } : { error: payload.error || `preview ${response.status}`, kind: payload.kind || 'error' }
    } catch (error) {
      result = { error: error.message, kind: 'network' }
    }
    if (result.profile || attempt >= 2 || !['timeout', 'server', 'network', 'error'].includes(result.kind)) return result
    await sleep(3000 * (attempt + 1))
  }
}

function pool(size, items, work) {
  let next = 0
  const runners = Array.from({ length: size }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await work(item)
    }
  })
  return Promise.all(runners)
}

async function screenRows(rows, file) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const done = new Set(readResults(file).filter((result) => !result.why.startsWith('screening failed')).map((result) => result.sheetRow))
  const todo = rows.filter((row) => !done.has(row.sheetRow))
  console.log(`${rows.length} rows, ${done.size} already screened, ${todo.length} to go`)
  const out = fs.createWriteStream(file, { flags: 'a' })
  const stats = { done: 0, keep: 0, autoNo: 0, failed: 0, tokens: 0, started: Date.now() }
  let failuresInRow = 0
  let pausedUntil = 0
  const ready = []
  let loading = true
  let wake = null

  const loader = pool(PROFILE_WORKERS, todo, async (row) => {
    while (Date.now() < pausedUntil) await sleep(5000)
    const username = data.usernameFrom(row.link)
    const loaded = username ? await loadProfile(username) : { error: 'no username', kind: 'missing' }
    if (loaded.error && ['timeout', 'login', 'server', 'network', 'error'].includes(loaded.kind)) {
      failuresInRow++
      if (failuresInRow >= PAUSE_AFTER_FAILURES) {
        console.log(`Instagram is failing (${loaded.kind}); pausing ${PAUSE_MS / 60000} minutes`)
        pausedUntil = Date.now() + PAUSE_MS
        failuresInRow = 0
      }
    } else {
      failuresInRow = 0
    }
    ready.push({ row, username, ...loaded })
    if (wake) wake()
    while (ready.length > GEMINI_WORKERS * 2) await sleep(200)
  }).then(() => {
    loading = false
    if (wake) wake()
  })

  async function nextReady() {
    while (!ready.length && loading) await new Promise((resolve) => (wake = resolve))
    return ready.shift()
  }

  const screeners = Array.from({ length: GEMINI_WORKERS }, async () => {
    for (let job = await nextReady(); job; job = await nextReady()) {
      const { row, username, profile } = job
      const mention = profile ? wearables.brandMention(profile) : null
      let verdict = null
      let error = job.error || ''
      if (profile && !profile.private && (profile.images || []).length && !mention) {
        try {
          verdict = await wearables.screen(profile, MEDIA)
        } catch (failure) {
          if (failure.fatal) {
            console.error(`\n${failure.message}`)
            process.exit(2)
          }
          error = failure.message
        }
      }
      let decision
      if (job.kind === 'missing' && username) decision = { action: 'auto-no', why: 'account no longer exists' }
      else if (error && !job.error && !verdict) decision = { action: 'keep', why: `screening failed: ${error}` }
      else decision = wearables.decide(profile, verdict, mention)
      const images = profile ? profile.images || [] : []
      const evidence = (verdict?.photos || []).map((photo) => ({ ...photo, src: images[photo.photo - 1]?.src || '' }))
      const record = {
        sheetRow: row.sheetRow,
        name: row.name,
        username,
        sheetKeep: row.keep,
        sheetDevice: row.device,
        action: decision.action,
        why: decision.why,
        verdict: verdict?.verdict || '',
        device: verdict?.device || '',
        confidence: verdict?.confidence ?? null,
        reason: verdict?.reason || '',
        mention: mention?.word || '',
        evidence,
        photos: images.length,
        thumbs: images.slice(0, 12).map((image) => image.src),
        loadError: job.error ? `${job.kind}: ${job.error}` : '',
        error,
        model: verdict?.model || '',
        tokens: verdict?.tokens || 0,
        at: new Date().toISOString(),
      }
      out.write(`${JSON.stringify(record)}\n`)
      stats.done++
      stats.tokens += record.tokens
      if (record.action === 'auto-no') stats.autoNo++
      else stats.keep++
      if (record.loadError || record.error) stats.failed++
      console.log(`  row ${record.sheetRow} @${username}: ${record.action} (${record.why})`)
      if (stats.done % 10 === 0 || stats.done === todo.length) {
        const minutes = (Date.now() - stats.started) / 60000
        console.log(`${stats.done}/${todo.length}  keep ${stats.keep}  auto-no ${stats.autoNo}  failed ${stats.failed}  ${(stats.done / minutes).toFixed(1)}/min  ${Math.round(stats.tokens / Math.max(1, stats.done))} tokens/profile`)
      }
    }
  })

  await Promise.all([loader, ...screeners])
  await new Promise((resolve) => out.end(resolve))
}

function summarizeValidation() {
  const results = readResults(FILES.validate)
  const screened = results.filter((result) => !result.loadError && result.photos && result.why !== 'private account')
  const missed = screened.filter((result) => result.action === 'auto-no')
  console.log(`\nValidation on ${results.length} Yes rows`)
  console.log(`  could not check (load failed, private, no photos): ${results.length - screened.length}`)
  console.log(`  checked: ${screened.length}`)
  console.log(`  kept for manual review: ${screened.length - missed.length}`)
  console.log(`  would have been wrongly auto-No'd: ${missed.length}`)
  if (screened.length) console.log(`  recall: ${(((screened.length - missed.length) / screened.length) * 100).toFixed(1)}%`)
  for (const result of missed.slice(0, 30)) console.log(`   row ${result.sheetRow} @${result.username} (${result.sheetDevice || 'device not recorded'}): ${result.reason}`)
}

function summarizeCompare(from, to) {
  const results = readResults(FILES.compare).filter((result) => result.sheetRow >= from && result.sheetRow <= to)
  const cell = (keep, action) => results.filter((result) => result.sheetKeep.toLowerCase() === keep && result.action === action)
  const yesKeep = cell('yes', 'keep')
  const yesNo = cell('yes', 'auto-no')
  const noKeep = cell('no', 'keep')
  const noNo = cell('no', 'auto-no')
  console.log(`\nRows ${from}-${to}: ${results.length} decided rows screened\n`)
  console.log('                     screener: keep   screener: auto-No')
  console.log(`  sheet says Yes      ${String(yesKeep.length).padStart(6)}   ${String(yesNo.length).padStart(10)}`)
  console.log(`  sheet says No       ${String(noKeep.length).padStart(6)}   ${String(noNo.length).padStart(10)}`)
  console.log('\nYes rows the screener would auto-No (misses):')
  for (const result of yesNo) console.log(`  row ${result.sheetRow} @${result.username} [${result.sheetDevice || 'no device recorded'}]: ${result.why}. ${result.reason}`)
  console.log('\nNo rows the screener would keep (it thinks it saw a wearable, or could not check):')
  for (const result of noKeep) console.log(`  row ${result.sheetRow} @${result.username}: ${result.why}${result.evidence.length ? ` (photos ${result.evidence.map((item) => item.photo).join(', ')})` : ''}`)
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
}

function report() {
  const compared = readResults(FILES.compare).sort((a, b) => a.sheetRow - b.sheetRow)
  const sections = [
    ['Compare: sheet Yes, screener auto-No (misses)', compared.filter((result) => result.sheetKeep.toLowerCase() === 'yes' && result.action === 'auto-no')],
    ['Compare: sheet No, screener keep', compared.filter((result) => result.sheetKeep.toLowerCase() === 'no' && result.action === 'keep')],
    ['Compare: sheet Yes, screener keep', compared.filter((result) => result.sheetKeep.toLowerCase() === 'yes' && result.action === 'keep')],
    ['Compare: sheet No, screener auto-No', compared.filter((result) => result.sheetKeep.toLowerCase() === 'no' && result.action === 'auto-no')],
    ['Validation: Yes rows the screener would wrongly auto-No', readResults(FILES.validate).filter((result) => result.action === 'auto-no')],
    ['Dry run: proposed auto-No', readResults(FILES.run).filter((result) => result.action === 'auto-no')],
    ['Dry run: kept for manual review', readResults(FILES.run).filter((result) => result.action === 'keep')],
  ]
  const media = (src) => `${MEDIA}/media?src=${encodeURIComponent(src)}`
  const card = (result) => `<div class="card"><div class="head"><b>${escapeHtml(result.name)}</b> <a href="https://www.instagram.com/${escapeHtml(result.username)}/" target="_blank">@${escapeHtml(result.username)}</a> · row ${result.sheetRow} · <i>${escapeHtml(result.why)}</i></div><div class="why">${escapeHtml(result.reason || result.loadError || result.error)}</div><div class="thumbs">${result.thumbs.map((src, index) => `<img loading="lazy" class="${result.evidence.some((item) => item.photo === index + 1) ? 'hit' : ''}" src="${media(src)}">`).join('')}</div></div>`
  const html = `<!doctype html><meta charset="utf-8"><title>Wearable screening</title><style>body{font:14px system-ui;background:#111;color:#eee;margin:24px}h2{margin-top:40px}.card{background:#1c1c1c;border-radius:10px;padding:12px;margin:10px 0}.why{color:#aaa;margin:4px 0 8px}.thumbs{display:flex;gap:4px;overflow-x:auto}.thumbs img{height:140px;border-radius:4px;border:3px solid transparent}.thumbs img.hit{border-color:#d7ff5a}a{color:#9cf}</style>${sections.map(([title, list]) => `<h2>${escapeHtml(title)} (${list.length})</h2>${list.slice(0, 300).map(card).join('')}`).join('')}`
  const file = path.join(OUT_DIR, 'report.html')
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(file, html)
  console.log(`Wrote ${file}`)
}

async function main() {
  const command = process.argv[2]
  if (command === 'report') return report()
  const from = Number(option('from', 0))
  const to = Number(option('to', Infinity))
  if (command === 'summary') return summarizeCompare(from, to)
  if (!['validate', 'run', 'compare'].includes(command)) {
    console.log('Usage: node screen.js validate|run|compare|summary|report [--limit N] [--from ROW --to ROW]')
    return
  }
  const health = await fetch(`${SERVER}/api/state`).catch(() => null)
  if (!health || !health.ok) throw new Error('Start the review server first (node server.js).')
  const rows = await sheet.loadAll()
  const limit = Number(option('limit', command === 'validate' ? 150 : 0)) || Infinity
  let selected
  if (command === 'validate') {
    const yes = rows.filter((row) => row.keep.toLowerCase() === 'yes')
    const withDevice = yes.filter((row) => row.device)
    const rest = yes.filter((row) => !row.device)
    const step = Math.max(1, Math.floor(rest.length / Math.max(1, limit - withDevice.length)))
    selected = [...withDevice, ...rest.filter((_, index) => index % step === 0)].slice(0, limit)
  } else if (command === 'compare') {
    selected = rows.filter((row) => row.sheetRow >= from && row.sheetRow <= to && ['yes', 'no'].includes(row.keep.toLowerCase())).slice(0, limit)
  } else {
    selected = rows.filter((row) => !['yes', 'no'].includes(row.keep.toLowerCase())).slice(0, limit)
  }
  await screenRows(selected, FILES[command])
  if (command === 'validate') summarizeValidation()
  if (command === 'compare') {
    summarizeCompare(from, to)
    report()
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})

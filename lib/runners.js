// Keeps the wearable model's two background programs running on this Mac (since 15 Oct): the photo
// downloader (wearable/acquire.js --watch) and the model (python -m wearable.live --watch). They used to
// be started by hand and died with the terminal that started them, which silently stopped Prospecting.
// Checked every 2 minutes; one that is missing is started again, detached (it outlives server restarts)
// and never twice (the process list is checked first). Only on the Mac that has the marker file
// data/wearable/RUN_HERE (the other computer has no model set up).
const fs = require('fs')
const path = require('path')
const { execFile, spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const MARKER = path.join(ROOT, 'data', 'wearable', 'RUN_HERE')
const CHECK_MS = 2 * 60 * 1000

const RUNNERS = [
  {
    name: 'photo downloader',
    match: /wearable\/acquire\.js .*--watch/,
    command: process.execPath,
    args: ['wearable/acquire.js', 'data/wearable/live-list.json', '--watch'],
    log: 'data/wearable/acquire-live.log',
  },
  {
    name: 'wearable model',
    match: /-m wearable\.live .*--watch/,
    command: path.join(ROOT, '.venv', 'bin', 'python'),
    args: ['-m', 'wearable.live', '--budget', '3', '--watch'],
    log: 'data/wearable/live.log',
  },
]

const status = {}

function processList() {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-ax', '-o', 'command='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout)))
  })
}

async function check(log = console.log) {
  if (!fs.existsSync(MARKER)) return
  const list = await processList()
  if (list == null) return // could not read the process list: never risk a second copy
  for (const runner of RUNNERS) {
    if (list.split('\n').some((line) => runner.match.test(line))) {
      status[runner.name] = { running: true, at: Date.now(), startedAt: status[runner.name]?.startedAt || 0 }
      continue
    }
    if (!fs.existsSync(runner.command)) {
      status[runner.name] = { running: false, at: Date.now(), error: `${runner.command} is missing` }
      continue
    }
    // Restarted at most once every 10 minutes (one that keeps crashing does not loop).
    if (Date.now() - (status[runner.name]?.startedAt || 0) < 10 * 60 * 1000) continue
    const out = fs.openSync(path.join(ROOT, runner.log), 'a')
    fs.writeSync(out, `\n--- started by Outreach ${new Date().toLocaleString('en-AU')} ---\n`)
    const child = spawn(runner.command, runner.args, { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: process.env })
    child.unref()
    fs.closeSync(out)
    status[runner.name] = { running: true, at: Date.now(), startedAt: Date.now(), pid: child.pid }
    log(`runners: started the ${runner.name} (pid ${child.pid})`)
  }
}

// Watchdog for the photo downloader: two rounds in a row where every profile failed, or no profile
// saved for 90 minutes during the day (8:00 to 21:00) while there are profiles to fetch: it is restarted
// (and the preview's Chrome reset with it), and the Prospecting card says so.
const health = { message: '', at: 0, restarts: 0 }
function lastLines(file, count) {
  try {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    return text.slice(-6000).split('\n').filter(Boolean).slice(-count)
  } catch {
    return []
  }
}
async function watchdog(log) {
  if (!fs.existsSync(MARKER)) return
  // Only the rounds since it last started (older failures were already dealt with).
  const lines = lastLines('data/wearable/acquire-live.log', 60)
  const since = lines.map((line) => /^--- started by Outreach/.test(line)).lastIndexOf(true)
  const done = lines.slice(since + 1).filter((line) => /^done \{/.test(line)).slice(-2)
  const failing = done.length === 2 && done.every((line) => { try { const counts = JSON.parse(line.slice(5)); return Object.keys(counts).length && Object.keys(counts).every((key) => key === 'error') } catch { return false } })
  let newest = 0
  try { for (const name of fs.readdirSync(path.join(ROOT, 'data', 'wearable', 'profiles'))) newest = Math.max(newest, fs.statSync(path.join(ROOT, 'data', 'wearable', 'profiles', name)).mtimeMs) } catch {}
  const hour = new Date().getHours()
  const startedAt = status['photo downloader']?.startedAt || 0
  const quiet = hour >= 9 && hour < 21 && newest && Date.now() - newest > 90 * 60 * 1000 && Date.now() - startedAt > 90 * 60 * 1000
  if (!failing && !quiet) {
    if (health.message && Date.now() - health.at > 30 * 60 * 1000) health.message = ''
    return
  }
  if (Date.now() - health.at < 20 * 60 * 1000) return // one restart, then give it time
  health.at = Date.now()
  health.restarts++
  health.message = failing ? 'The photo downloader failed every profile, so it was restarted.' : 'No profile was downloaded for 90 minutes, so the downloader was restarted.'
  log(`runners watchdog: ${health.message}`)
  await new Promise((resolve) => execFile('/usr/bin/pkill', ['-f', 'wearable/acquire.js .*--watch'], () => resolve()))
  await new Promise((resolve) => execFile('/usr/bin/pkill', ['-9', '-f', 'remote-debugging-port=9334'], () => resolve()))
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { fs.rmSync(path.join(ROOT, 'data', 'ig-chrome', name), { force: true }) } catch {} }
  status['photo downloader'] = { running: false, at: Date.now(), startedAt: 0 }
  setTimeout(() => check(log).catch(() => {}), 3000)
}

function start(log) {
  setInterval(() => watchdog(log).catch((error) => console.error('runners watchdog', error.message)), 5 * 60 * 1000).unref()
  setTimeout(() => check(log).catch((error) => console.error('runners', error.message)), 15 * 1000).unref()
  setInterval(() => check(log).catch((error) => console.error('runners', error.message)), CHECK_MS).unref()
}

module.exports = { start, check, status, health }

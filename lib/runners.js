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

function start(log) {
  setTimeout(() => check(log).catch((error) => console.error('runners', error.message)), 15 * 1000).unref()
  setInterval(() => check(log).catch((error) => console.error('runners', error.message)), CHECK_MS).unref()
}

module.exports = { start, check, status }

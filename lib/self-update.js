// Keeps the other Mac on the latest version from GitHub without anyone pulling by hand: every 10 minutes
// it looks at origin/main; when there is something new, the checkout is clean and Launch is not in the
// middle of an action, it fast-forwards (never merges or overwrites local changes), installs packages if
// package.json changed, and restarts: the whole app when its window code changed, else only the server.
// Not on the Mac with data/wearable/RUN_HERE (where the code is written and pushed from).
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const ROOT = path.join(__dirname, '..')
const MARKER = path.join(ROOT, 'data', 'wearable', 'RUN_HERE')
const APP_FILES = /^(app-main\.js|main\.js|preload[^/]*\.js|app\/|package\.json)/

function run(command, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: ROOT, timeout, env: { ...process.env, PATH: `${process.env.PATH || ''}:/usr/bin:/usr/local/bin:/opt/homebrew/bin` } }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr || '') }))
      else resolve(String(stdout || '').trim())
    })
  })
}

// busy(): true while Launch is in the middle of an action (then it waits for the next check).
// relaunchApp(): asks the app to restart itself (window code changed).
async function check({ busy = () => false, relaunchApp = async () => false, log = console.log } = {}) {
  if (fs.existsSync(MARKER)) return { skipped: 'working Mac' }
  await run('git', ['fetch', '--quiet', 'origin', 'main'])
  const head = await run('git', ['rev-parse', 'HEAD'])
  const remote = await run('git', ['rev-parse', 'origin/main'])
  if (head === remote) return { upToDate: true }
  // Only a fast-forward: local commits or changes are never touched.
  const behind = await run('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']).then(() => true).catch(() => false)
  if (!behind) return { skipped: 'local commits' }
  if ((await run('git', ['status', '--porcelain', '--untracked-files=no']))) return { skipped: 'local changes' }
  if (busy()) return { skipped: 'Launch busy' }
  const changed = (await run('git', ['diff', '--name-only', head, remote])).split('\n').filter(Boolean)
  await run('git', ['merge', '--ff-only', '--quiet', 'origin/main'])
  log(`self-update: ${changed.length} files from GitHub (${head.slice(0, 7)} -> ${remote.slice(0, 7)})`)
  if (changed.includes('package.json') || changed.includes('package-lock.json')) await run('npm', ['install', '--no-audit', '--no-fund'], 10 * 60 * 1000).catch((error) => log(`self-update: npm install failed: ${error.message}`))
  if (changed.some((file) => APP_FILES.test(file)) && await relaunchApp().catch(() => false)) return { updated: true, relaunched: true }
  // Only the server's code (or the app could not be asked): the server restarts (the app starts it again).
  setTimeout(() => process.exit(0), 1000)
  return { updated: true }
}

module.exports = { check }

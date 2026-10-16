// Wearable detection, step 1: Instagram acquisition (local cache).
//
//   node wearable/acquire.js <usernames.json | username ...> [--pause 2500-5500] [--watch]
//
// --watch: keeps going, re-reading the list files every minute (data/wearable/live-list.json is kept
// ahead of the person prospecting by Outreach).
//
// For each profile: one logged-out profile page load in a separate headless Chrome (never the
// Instagram account in the Outreach panel), then every post image the page shows (usually 12) in grid
// order (pinned posts included: the same view a person sees when labelling), bio, name, followers and
// captions. Images are stored at most 768 px on the long side (more than a grid tile uses), to keep
// disk use to well under 1 MB per profile.
// Saved to data/wearable/profiles/<username>.json and data/wearable/images/<username>/<n>.jpg.
// Resumable (profiles already saved are skipped) and paced: a random pause between profiles, and a
// longer one when Instagram puts up a login wall for logged-out viewing.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DIR = path.join(ROOT, 'data', 'wearable')
process.env.IG_PREVIEW_PORT = process.env.IG_PREVIEW_PORT || '9447'
process.env.IG_PREVIEW_PROFILE = process.env.IG_PREVIEW_PROFILE || path.join(DIR, 'chrome')
process.env.IG_PREVIEW_TABS = '1'
// A Chrome that died leaves its lock behind and no new one can start on that profile: clear it when the
// process it names is gone.
;(() => {
  const lock = path.join(process.env.IG_PREVIEW_PROFILE, 'SingletonLock')
  try {
    const owner = Number(String(fs.readlinkSync(lock)).split('-').pop())
    let alive = false
    try { process.kill(owner, 0); alive = true } catch {}
    if (!alive) for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) fs.rmSync(path.join(process.env.IG_PREVIEW_PROFILE, name), { force: true })
  } catch {}
})()
const preview = require('../lib/ig-preview')
const graph = require('../lib/ig-graph')
const sharp = require('sharp')

const MAX_SIDE = 768
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let watchMode = false
const HOURLY = 25
const QUIET_AFTER_WALL_MS = 10 * 60 * 1000
const loads = []

function args() {
  const list = []
  // Slow on purpose: logged-out profile loads from one internet connection are what make Instagram put
  // up a login wall, and the Prospecting screen needs the same connection.
  let pause = [90000, 150000]
  let watch = false
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--watch') {
      watch = true
    } else if (arg === '--pause') {
      pause = argv[++index].split('-').map(Number)
    } else if (arg.endsWith('.json')) {
      const data = JSON.parse(fs.readFileSync(arg, 'utf8'))
      list.push(...(Array.isArray(data) ? data : [...(data.yes || []), ...(data.no || []), ...(data.usernames || [])]).map((item) => (typeof item === 'string' ? item : item.username)).filter(Boolean))
    } else list.push(arg.replace(/^@/, '').toLowerCase())
  }
  return { list: [...new Set(list)], pause, watch }
}

async function acquire(username) {
  const file = path.join(DIR, 'profiles', `${username}.json`)
  const started = Date.now()
  let record
  try {
    // Meta's official API first (no logged-out page, no walls); a personal account, or the API not set
    // up / out of calls for the hour: the logged-out preview as before.
    // Meta asked to slow down (or this hour's share is used): wait for the API rather than visiting the
    // page. Only accounts the API cannot see (personal ones) are visited.
    let profile = null
    if (graph.available()) {
      for (let attempt = 0; attempt < 30 && !profile; attempt++) {
        try {
          profile = await graph.profile(username)
        } catch (error) {
          if (error.kind === 'rate') {
            const until = graph.pausedUntil()
            const wait = until ? until - Date.now() + 5000 : 5 * 60 * 1000
            console.log(`graph: ${error.message} Waiting ${Math.round(wait / 60000)} min.`)
            await sleep(Math.min(wait, 30 * 60 * 1000))
            continue
          }
          if (error.kind === 'token') console.log(`graph: ${error.message}`)
          break
        }
      }
    }
    if (!profile) {
      // A personal account (the API can't see it): only when a logged-out load can start now; otherwise
      // it is put aside for a later round so the accounts behind it are not held up.
      if (graph.available() && !preview.backgroundRoom()) throw Object.assign(new Error('Logged-out viewing is limited right now; later.'), { kind: 'deferred' })
      preview.forget(username)
      profile = await preview.profile(username, false) // background: inside the shared hourly allowance
    }
    const images = (profile.images || []).filter((image) => image.src)
    const folder = path.join(DIR, 'images', username)
    fs.mkdirSync(folder, { recursive: true })
    // Images come from Instagram's image servers (not the profile page), 8 at a time.
    const saved = new Array(images.length)
    let next = 0
    const worker = async () => {
      while (next < images.length) {
        const index = next++
        const image = images[index]
        try {
          const photo = await preview.downloadImage(image.src)
          const name = `${index + 1}.jpg`
          await sharp(photo.buffer).rotate().resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(path.join(folder, name))
          saved[index] = { index: index + 1, file: `images/${username}/${name}`, code: image.code || '', kind: image.kind || '', caption: image.alt || '', width: image.width, height: image.height }
        } catch (error) {
          saved[index] = { index: index + 1, error: error.message }
        }
      }
    }
    await Promise.all(Array.from({ length: 8 }, worker))
    // The profile picture: how the model recognises the account owner among the people in the photos.
    let avatar = ''
    if (profile.avatar) {
      try {
        const photo = await preview.downloadImage(profile.avatar)
        await sharp(photo.buffer).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(path.join(folder, 'avatar.jpg'))
        avatar = `images/${username}/avatar.jpg`
      } catch {}
    }
    record = {
      username,
      status: profile.private ? 'private' : saved.some((item) => item.file) ? 'ok' : 'no-posts',
      name: profile.name || '',
      bio: profile.bio || '',
      followers: profile.followers || '',
      source: profile.source || 'preview',
      posts: saved,
      postCount: (profile.posts || []).length,
      avatar,
    }
  } catch (error) {
    record = { username, status: error.kind === 'missing' ? 'missing' : error.kind === 'restricted' ? 'restricted' : error.kind === 'login' ? 'login-wall' : error.kind === 'deferred' ? 'deferred' : 'error', error: error.message }
  }
  record.acquiredAt = new Date().toISOString()
  record.seconds = Math.round((Date.now() - started) / 100) / 10
  // A login wall or a failure on our side (no browser...) says nothing about the profile: not saved,
  // so it is retried.
  if (record.status !== 'login-wall' && record.status !== 'error' && record.status !== 'deferred') {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(record, null, 1))
  }
  return record
}

async function main() {
  const { watch } = args()
  watchMode = watch
  do {
    const fetched = await round()
    if (watch && !fetched) await sleep(60000)
  } while (watch)
  process.exit(0)
}

async function round() {
  let list, pause
  try {
    ({ list, pause } = args())
  } catch (error) {
    console.error('list not readable yet:', error.message)
    return 0
  }
  // Saved before profile pictures were kept (no avatar field): fetched again, so the model knows the owner.
  // In list order, so the profiles the person reaches next come first: never fetched, or saved before
  // profile pictures were kept (no avatar field), so the model knows who the owner is.
  const needed = list.filter((username) => {
    const file = path.join(DIR, 'profiles', `${username}.json`)
    if (!fs.existsSync(file)) return true
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      return saved.status === 'ok' && !('avatar' in saved)
    } catch {
      return true
    }
  })
  // A few at a time, so a list that moved on (the person prospecting) is re-read often.
  const todo = needed.slice(0, watchMode ? 15 : Infinity)
  console.log(`${list.length} profiles, ${needed.length} to fetch, ${todo.length} now`)
  const counts = {}
  for (const [index, username] of todo.entries()) {
    // A login wall anywhere on this computer (shared file): wait it out, plus a quiet 10 minutes.
    for (let wall = graph.available() ? 0 : preview.loginWall(); wall; wall = preview.loginWall()) {
      console.log(`login wall: waiting until ${new Date(wall + QUIET_AFTER_WALL_MS).toLocaleTimeString('en-AU')}`)
      await sleep(wall - Date.now() + QUIET_AFTER_WALL_MS)
    }
    // At most HOURLY profile loads in any hour.
    // Logged-out loads only: at most HOURLY in any hour (lookups through Meta's API have their own limit).
    if (!graph.available()) {
      while (loads.filter((at) => Date.now() - at < 3600 * 1000).length >= HOURLY) await sleep(60 * 1000)
    }
    const record = await acquire(username)
    if (record.source !== 'graph') loads.push(Date.now())
    counts[record.status] = (counts[record.status] || 0) + 1
    if (record.status === 'login-wall') todo.push(username)
    if ((index + 1) % 10 === 0 || index === todo.length - 1) console.log(`${index + 1}/${todo.length}`, JSON.stringify(counts))
    // Through the API: about 30 seconds apart (well inside Meta's hourly allowance); logged out: slow.
    if (record.status === 'deferred') await sleep(1000)
    else if (record.source === 'graph') await sleep(20000 + Math.random() * 15000)
    else {
      if (graph.available()) while (loads.filter((at) => Date.now() - at < 3600 * 1000).length >= HOURLY) await sleep(60 * 1000)
      await sleep(pause[0] + Math.random() * (pause[1] - pause[0]))
    }
  }
  if (todo.length) console.log('done', JSON.stringify(counts))
  return todo.length
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

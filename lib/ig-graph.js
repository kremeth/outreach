// Instagram profiles through Meta's official Graph API (Business Discovery), for the wearable model's
// photo downloader: no logged-out page, so no "Instagram is limiting logged-out viewing" walls and
// nothing tied to this internet connection or the Instagram login. Works for creator and business
// accounts; a personal account falls back to the logged-out preview.
// Needs data/meta-token.txt: a long-lived user (or Page) access token (instagram_basic, pages_show_list,
// pages_read_engagement, business_management) for the Facebook Page linked to nutricode.io. Never
// committed. Meta allows about 200 calls an hour; this stays under HOURLY and slows down when Meta's
// own usage headers pass 75%.
const fs = require('fs')
const path = require('path')
const posts = require('./ig-posts')

const DATA = path.join(__dirname, '..', 'data')
const TOKEN_PATH = path.join(DATA, 'meta-token.txt')
const STATE_PATH = path.join(DATA, 'meta-graph.json')
const GRAPH = 'https://graph.facebook.com'
// Meta's hourly allowance (its x-app-usage header): all of it for Prospecting (the photo downloader's
// full profiles) since 17 Oct; the scraper no longer uses the API. Meta's own usage headers still pause
// it past PAUSE_AT.
const HOURLY = { media: 150, lookup: 20 } // lookup: a follower count now and then (DMs, partners)
const PAUSE_AT = 85

function token() {
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim()
  } catch {
    return ''
  }
}

function available() {
  return Boolean(token())
}

// Keeping the token alive: with the app's secret (data/meta-app-secret.txt, never committed), the token
// is swapped for a fresh 60-day one once a day, so it never expires (Meta allows renewing a valid token).
const APP_ID = process.env.META_APP_ID || '2171466746736180'
const SECRET_PATH = path.join(DATA, 'meta-app-secret.txt')
async function renew() {
  let secret = ''
  try { secret = fs.readFileSync(SECRET_PATH, 'utf8').trim() } catch {}
  if (!secret || !token()) return { renewed: false, reason: secret ? 'no token' : 'no app secret' }
  const state = loadState()
  if (state.renewedAt && Date.now() - state.renewedAt < 20 * 3600 * 1000) return { renewed: false, reason: 'renewed recently' }
  const url = `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${encodeURIComponent(secret)}&fb_exchange_token=${encodeURIComponent(token())}`
  const payload = await fetch(url, { signal: AbortSignal.timeout(30000) }).then((response) => response.json()).catch(() => ({}))
  if (!payload.access_token) return { renewed: false, reason: payload.error?.message || 'no token back' }
  fs.writeFileSync(TOKEN_PATH, payload.access_token, { mode: 0o600 })
  const next = loadState()
  next.renewedAt = Date.now()
  next.expiresAt = payload.expires_in ? Date.now() + payload.expires_in * 1000 : 0
  saveState(next)
  await checkAccess().catch(() => {})
  return { renewed: true, expiresAt: next.expiresAt }
}

// Meta's own "data access" window (about 90 days from the last time the token was made in the Graph API
// Explorer): renewing the token does not extend it; making a new token there does.
async function checkAccess() {
  if (!token()) return null
  let secret = ''
  try { secret = fs.readFileSync(SECRET_PATH, 'utf8').trim() } catch {}
  const appToken = secret ? `${APP_ID}|${secret}` : token()
  const payload = await fetch(`${GRAPH}/debug_token?input_token=${encodeURIComponent(token())}&access_token=${encodeURIComponent(appToken)}`, { signal: AbortSignal.timeout(20000) }).then((response) => response.json()).catch(() => ({}))
  const data = payload.data || {}
  const next = loadState()
  next.valid = Boolean(data.is_valid)
  next.dataAccessUntil = data.data_access_expires_at ? data.data_access_expires_at * 1000 : 0
  if (data.expires_at) next.expiresAt = data.expires_at * 1000
  next.checkedAt = Date.now()
  saveState(next)
  return next
}

// What the To do page should say, if anything (nothing while all is well).
function warning() {
  if (!available()) return ''
  const state = loadState()
  if (state.checkedAt && state.valid === false) return "Meta's API token stopped working: make a new one in the Graph API Explorer (same 6 permissions) and save it to data/meta-token.txt. Until then profiles load the slow logged-out way."
  const until = state.dataAccessUntil || 0
  if (until && until - Date.now() < 10 * 86400000) return `Meta's API access needs a refresh by ${new Date(until).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}: in the Graph API Explorer click Generate Access Token once (same app and permissions) and save it to data/meta-token.txt.`
  return ''
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { igUserId: '', calls: [], pausedUntil: 0 }
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1))
}

function fail(message, kind) {
  return Object.assign(new Error(message), { kind })
}

async function call(pathAndQuery, purpose = 'media') {
  const state = loadState()
  const now = Date.now()
  state.calls = (state.calls || []).filter((at) => (typeof at === 'number' ? at : at.at) > now - 3600 * 1000).map((at) => (typeof at === 'number' ? { at, purpose: 'media' } : at))
  if (state.pausedUntil > now) throw fail(`Meta asked to slow down; paused until ${new Date(state.pausedUntil).toLocaleTimeString('en-AU')}.`, 'rate')
  if (state.calls.filter((entry) => entry.purpose === purpose).length >= (HOURLY[purpose] || 50)) throw fail(`This hour's Graph API ${purpose === 'lookup' ? 'checks' : 'lookups'} are used up.`, 'rate')
  state.calls.push({ at: now, purpose })
  saveState(state)
  const separator = pathAndQuery.includes('?') ? '&' : '?'
  const response = await fetch(`${GRAPH}/${pathAndQuery}${separator}access_token=${encodeURIComponent(token())}`, { signal: AbortSignal.timeout(30000) })
  // Meta's usage (percent of the hourly allowance): above 75%, pause for 20 minutes.
  // Meta's own usage figures (percent of its allowance) and, when it gives one, how long until there is
  // room again: paused exactly that long (at least 5 minutes) once a figure passes PAUSE_AT.
  let highest = 0
  let regainMinutes = 0
  for (const header of ['x-app-usage', 'x-business-use-case-usage']) {
    const raw = response.headers.get(header)
    if (!raw) continue
    for (const part of raw.match(/"(call_count|total_cputime|total_time)":\s*(\d+)/g) || []) highest = Math.max(highest, Number(part.split(':')[1]))
    for (const part of raw.match(/"estimated_time_to_regain_access":\s*(\d+)/g) || []) regainMinutes = Math.max(regainMinutes, Number(part.split(':')[1]))
  }
  const usageState = loadState()
  usageState.metaUsage = { highest, at: Date.now() }
  if (highest >= PAUSE_AT || regainMinutes > 0) usageState.pausedUntil = Date.now() + Math.max(5, regainMinutes || 10) * 60 * 1000
  saveState(usageState)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.error) {
    const error = payload.error || {}
    if ([4, 17, 32, 613, 80001, 80002].includes(error.code)) {
      const next = loadState()
      next.pausedUntil = Date.now() + 15 * 60 * 1000
      saveState(next)
      throw fail(`Meta rate limit: ${error.message}`, 'rate')
    }
    if (error.code === 190) { const bad = loadState(); bad.valid = false; bad.checkedAt = Date.now(); saveState(bad) }
    if (error.code === 190) throw fail('The Meta token expired or is invalid: make a new one (data/meta-token.txt).', 'token')
    // A personal (not creator or business) account, or a name Business Discovery can't find.
    if (error.code === 110 || error.code === 100 || /cannot find|invalid user|not.*business/i.test(error.message || '')) throw fail(error.message || 'Not a professional account.', 'not-business')
    throw fail(error.message || `Graph API ${response.status}`, 'error')
  }
  return payload
}

// nutricode.io's own Instagram account id (the one that does the lookups), found once from the token.
async function igUserId() {
  const state = loadState()
  if (state.igUserId) return state.igUserId
  // A user token lists its Pages; a Page token is the Page itself. Either works.
  let page = null
  try {
    const pages = await call('me/accounts?fields=name,instagram_business_account{id,username}')
    // The one that does the lookups is nutricode.io (the Facebook account also manages other Pages).
    const ours = String(process.env.OUR_INSTAGRAM || 'nutricode.io').toLowerCase()
    const linked = (pages.data || []).filter((item) => item.instagram_business_account)
    page = linked.find((item) => String(item.instagram_business_account.username || '').toLowerCase() === ours) || linked[0] || null
  } catch {}
  if (!page) {
    const me = await call('me?fields=name,instagram_business_account{id,username}').catch(() => null)
    if (me?.instagram_business_account) page = me
  }
  if (!page) throw fail('No Instagram professional account is linked to the Page this token is for.', 'token')
  const next = loadState()
  next.igUserId = page.instagram_business_account.id
  next.igUsername = page.instagram_business_account.username
  saveState(next)
  return next.igUserId
}

const shortcodeOf = (permalink) => (String(permalink || '').match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/) || [])[2] || ''

// One creator's profile, in the same shape as the logged-out preview's (lib/ig-preview.js profile()).
async function profile(username) {
  const id = await igUserId()
  const fields = `business_discovery.username(${encodeURIComponent(username)}){username,name,biography,followers_count,media_count,profile_picture_url,media.limit(24){caption,media_type,media_url,thumbnail_url,permalink,timestamp}}`
  const payload = await call(`${id}?fields=${fields}`)
  const found = payload.business_discovery
  if (!found) throw fail('Not a professional account.', 'not-business')
  const images = []
  for (const media of found.media?.data || []) {
    // A carousel's media_url is its first item; a video's picture is its thumbnail.
    const src = media.media_type === 'VIDEO' ? media.thumbnail_url || '' : media.media_url || media.thumbnail_url || ''
    if (!src) continue
    images.push({
      src,
      full: src,
      width: 0,
      height: 0,
      alt: media.caption || '',
      code: shortcodeOf(media.permalink),
      kind: /\/reel\//.test(media.permalink || '') ? 'reel' : 'p',
      at: media.timestamp || '',
    })
  }
  return {
    avatar: found.profile_picture_url || '',
    username: found.username || username,
    name: found.name || '',
    bio: found.biography || '',
    followers: `${Number(found.followers_count || 0).toLocaleString('en-AU')} followers`,
    following: '',
    private: false,
    images,
    // Newest first, with the post id (pk) from the shortcode, as the preview gives them.
    posts: images.filter((image) => image.code).map((image) => ({ code: image.code, pk: posts.pkFromCode(image.code), pinned: false })),
    source: 'graph',
  }
}

// A quick check for the scraper: name, bio and followers only (no posts), on its own hourly share.
async function lookup(username) {
  const id = await igUserId()
  const payload = await call(`${id}?fields=business_discovery.username(${encodeURIComponent(username)}){username,name,biography,followers_count}`, 'lookup')
  const found = payload.business_discovery
  if (!found) throw fail('Not a professional account.', 'not-business')
  return { exists: true, username: found.username || username, fullName: found.name || '', bio: found.biography || '', followers: Number(found.followers_count || 0), source: 'graph' }
}

// When the API has room again (0 = now).
function pausedUntil() {
  return Math.max(0, (loadState().pausedUntil || 0) - Date.now()) ? loadState().pausedUntil : 0
}

function usage() {
  const state = loadState()
  const recent = (state.calls || []).filter((entry) => (typeof entry === 'number' ? entry : entry.at) > Date.now() - 3600 * 1000)
  return { available: available(), expiresAt: state.expiresAt || 0, callsThisHour: recent.length, lookupsThisHour: recent.filter((entry) => entry.purpose === 'lookup').length, hourly: HOURLY, pausedUntil: state.pausedUntil || 0, account: state.igUsername || '' }
}

module.exports = { available, profile, lookup, usage, pausedUntil, igUserId, renew, checkAccess, warning }

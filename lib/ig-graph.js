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
const HOURLY = 150

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
  return { renewed: true, expiresAt: next.expiresAt }
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

async function call(pathAndQuery) {
  const state = loadState()
  const now = Date.now()
  state.calls = (state.calls || []).filter((at) => now - at < 3600 * 1000)
  if (state.pausedUntil > now) throw fail(`Meta asked to slow down; paused until ${new Date(state.pausedUntil).toLocaleTimeString('en-AU')}.`, 'rate')
  if (state.calls.length >= HOURLY) throw fail('This hour\'s Graph API lookups are used up.', 'rate')
  state.calls.push(now)
  saveState(state)
  const separator = pathAndQuery.includes('?') ? '&' : '?'
  const response = await fetch(`${GRAPH}/${pathAndQuery}${separator}access_token=${encodeURIComponent(token())}`, { signal: AbortSignal.timeout(30000) })
  // Meta's usage (percent of the hourly allowance): above 75%, pause for 20 minutes.
  for (const header of ['x-app-usage', 'x-business-use-case-usage']) {
    const raw = response.headers.get(header)
    if (!raw) continue
    const numbers = (raw.match(/"(call_count|total_cputime|total_time)":\s*(\d+)/g) || []).map((part) => Number(part.split(':')[1]))
    if (numbers.some((value) => value >= 75)) {
      const next = loadState()
      next.pausedUntil = Date.now() + 20 * 60 * 1000
      saveState(next)
    }
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.error) {
    const error = payload.error || {}
    if ([4, 17, 32, 613, 80001, 80002].includes(error.code)) {
      const next = loadState()
      next.pausedUntil = Date.now() + 30 * 60 * 1000
      saveState(next)
      throw fail(`Meta rate limit: ${error.message}`, 'rate')
    }
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
  const fields = `business_discovery.username(${encodeURIComponent(username)}){username,name,biography,followers_count,media_count,profile_picture_url,media.limit(30){caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url,thumbnail_url}}}`
  const payload = await call(`${id}?fields=${fields}`)
  const found = payload.business_discovery
  if (!found) throw fail('Not a professional account.', 'not-business')
  const images = []
  for (const media of found.media?.data || []) {
    const first = media.media_type === 'CAROUSEL_ALBUM' ? (media.children?.data || []).find((child) => child.media_url || child.thumbnail_url) : null
    const src = media.media_type === 'VIDEO' ? media.thumbnail_url || '' : first ? (first.media_type === 'VIDEO' ? first.thumbnail_url : first.media_url) : media.media_url
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

function usage() {
  const state = loadState()
  return { available: available(), expiresAt: state.expiresAt || 0, callsThisHour: (state.calls || []).filter((at) => Date.now() - at < 3600 * 1000).length, hourly: HOURLY, pausedUntil: state.pausedUntil || 0, account: state.igUsername || '' }
}

module.exports = { available, profile, usage, igUserId, renew }

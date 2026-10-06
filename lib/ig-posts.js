// Instagram media ids carry their creation time: id >> 23 is milliseconds since Instagram's epoch.
// That lets us find the newest post even when older posts are pinned to the top of the grid.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const EPOCH_MS = 1314220021721

function pkFromCode(code) {
  let id = 0n
  for (const char of String(code || '').slice(0, 11)) {
    const value = ALPHABET.indexOf(char)
    if (value === -1) return ''
    id = id * 64n + BigInt(value)
  }
  return id ? id.toString() : ''
}

function postedAt(pk) {
  try {
    return new Date(Number(BigInt(pk) >> 23n) + EPOCH_MS).toISOString()
  } catch {
    return ''
  }
}

function newer(a, b) {
  return BigInt(a || 0) > BigInt(b || 0)
}

function latestPost(profile) {
  const candidates = (profile.posts || []).map((post) => ({ pk: post.pk, code: post.code }))
  if (!candidates.length) {
    for (const image of profile.images || []) {
      const pk = pkFromCode(image.code)
      if (pk) candidates.push({ pk, code: image.code })
    }
  }
  if (!candidates.length) return null
  const best = candidates.reduce((a, b) => (newer(b.pk, a.pk) ? b : a))
  const image = (profile.images || []).find((item) => item.code === best.code) || null
  return {
    pk: best.pk,
    code: best.code,
    kind: image?.kind === 'reel' ? 'reel' : 'p',
    at: postedAt(best.pk),
    image,
  }
}

// Always the /p/ form: for reels, /reel/ opens the full-screen viewer, which has no comment box.
function permalink(post) {
  return `https://www.instagram.com/p/${post.code}/`
}

module.exports = { latestPost, postedAt, newer, permalink }

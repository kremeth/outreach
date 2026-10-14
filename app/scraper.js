// The scraper account's window, driven the way a person does it (the person's own recording, 14 Oct):
// open a creator's profile, click "following", scroll the list as it loads; open each followed profile
// and read its name, bio and follower count from the page. Instagram's own page makes every request.
// Any warning, block or login page stops it (kind 'blocked' / 'login').
const ig = require('./instagram')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const between = (min, max) => min + Math.random() * (max - min)

function stop(message, kind) {
  return Object.assign(new Error(message), { kind })
}

async function checkPage(wc) {
  const page = await ig.pageProblem(wc)
  if (page.problem === 'blocked') throw stop(`Instagram showed a warning: ${page.warning || 'action blocked'}`, 'blocked')
  if (page.problem === 'login') throw stop('The scraper account is logged out.', 'login')
  return page
}

const READ_PROFILE = (username) => String.raw`(() => {
  const want = ${JSON.stringify(username)}
  const text = (document.querySelector('main') || document.body).innerText || ''
  if (/sorry, this page isn't available|may have been removed/i.test(document.body.innerText || '')) return { exists: false }
  const header = document.querySelector('header')
  if (!header) return { loading: true }
  const number = (raw) => {
    const m = String(raw || '').replace(/,/g, '').match(/([\d.]+)\s*([kKmM])?/)
    if (!m) return 0
    return Math.round(Number(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1000 : 1000000) : 1))
  }
  // Followers: exact from the count's title ("12,834") when there is one, else the shown number.
  const followersLink = header.querySelector('a[href$="/followers/"]') || [...header.querySelectorAll('li, span, a')].find((el) => /followers?$/i.test((el.innerText || '').trim()))
  const titled = followersLink && followersLink.querySelector('[title]')
  const followers = titled ? number(titled.getAttribute('title')) : number(followersLink ? followersLink.innerText : '')
  const followingLink = header.querySelector('a[href$="/following/"]') || [...header.querySelectorAll('li, span, a')].find((el) => /following$/i.test((el.innerText || '').trim()))
  const following = number(followingLink ? followingLink.innerText : '')
  // The header reads: username, full name, the counts, the bio, then the buttons (Follow, Message...)
  // and the story highlights. Name: the line between the username and the counts. Bio: from the counts
  // to the first button, without "Followed by".
  const lines = (header.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const isCount = (line) => /^[\d.,]+\s*[kKmM]?\s*(posts?|followers?|following)$/i.test(line) || /^(posts?|followers?|following)$/i.test(line)
  const isButton = (line) => /^(follow|follow back|following|message|requested|edit profile|view archive|options|contact|email|call|subscribe)$/i.test(line)
  const firstCount = lines.findIndex(isCount)
  const lastCount = lines.reduce((at, line, index) => (isCount(line) ? index : at), -1)
  const nameLines = lines.slice(0, firstCount === -1 ? 0 : firstCount).filter((line) => line.toLowerCase() !== want && !isButton(line))
  const bioLines = []
  for (const line of lines.slice(lastCount + 1)) {
    if (isButton(line)) break
    if (!/^followed by/i.test(line)) bioLines.push(line)
  }
  const after = [nameLines[0] || '', ...bioLines]
  return {
    exists: true,
    username: want,
    fullName: after[0] || '',
    bio: after.slice(1).join(' \n ').slice(0, 1000),
    followers,
    following,
    isPrivate: /this account is private/i.test(text),
  }
})()`

// One profile, read from its page.
async function profile(wc, { username }) {
  await ig.openUrl(wc, `https://www.instagram.com/${encodeURIComponent(username)}/`)
  for (let tries = 0; tries < 20; tries++) {
    await sleep(500)
    await checkPage(wc)
    const value = await ig.run(wc, READ_PROFILE(username)).catch(() => ({ loading: true }))
    if (!value.loading && (value.exists === false || value.followers || value.following || tries >= 10)) return value
  }
  return { exists: true, username, fullName: '', bio: '', followers: 0, following: 0, unreadable: true }
}

// Everyone a creator follows: their profile, "following", then the list scrolled to its end at a
// person's pace (about 1 to 2.5 seconds per scroll). skip: usernames already done (on a later day).
async function following(wc, { username, max = 100000 }) {
  await ig.openUrl(wc, `https://www.instagram.com/${encodeURIComponent(username)}/`)
  await sleep(between(1500, 2500))
  await checkPage(wc)
  // "992 following" in the header: a link on some layouts, a clickable span on others. Found by its
  // text and clicked where a person would click.
  let link = null
  for (let tries = 0; tries < 10 && !link; tries++) {
    link = await ig.run(wc, String.raw`(() => {
      const header = document.querySelector('header') || document.body
      const el = header.querySelector('a[href$="/following/"]') || [...header.querySelectorAll('a, span, div, li, button')]
        .filter((node) => /^[\d.,]+\s*[kKmM]?\s*following$/i.test((node.innerText || '').trim()))
        .sort((a, b) => a.innerText.length - b.innerText.length || a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0]
      if (!el) return null
      const target = el.closest('a, [role="link"], [role="button"]') || el
      const r = target.getBoundingClientRect()
      return r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: target.tagName } : null
    })()`).catch(() => null)
    if (!link) await sleep(500)
  }
  if (!link) throw stop(`@${username}'s following list could not be opened (private or not shown).`, 'unreadable')
  await ig.click(wc, link)
  // The list opens as a dialog.
  let opened = false
  for (let tries = 0; tries < 16 && !opened; tries++) {
    await sleep(500)
    opened = await ig.run(wc, `Boolean([...document.querySelectorAll('[role="dialog"]')].find((d) => /following/i.test(d.innerText || '')))`).catch(() => false)
  }
  if (!opened) throw stop(`@${username}'s following list did not open.`, 'unreadable')
  await sleep(between(800, 1500))
  const seen = new Set()
  const order = []
  let still = 0
  for (let round = 0; round < 3000 && still < 6 && order.length < max; round++) {
    if (round % 10 === 0) await checkPage(wc)
    const batch = await ig.run(wc, String.raw`(() => {
      const owner = ${JSON.stringify(String(username).toLowerCase())}
      const dialog = [...document.querySelectorAll('[role="dialog"]')].pop()
      if (!dialog) return { gone: true }
      const names = []
      for (const a of dialog.querySelectorAll('a[href]')) {
        const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9._]{1,30})\/$/)
        if (m && m[1].toLowerCase() !== owner) names.push(m[1].toLowerCase())
      }
      // Scroll the list (the dialog's scrollable part) one screen further.
      const box = [...dialog.querySelectorAll('div')].find((el) => el.scrollHeight > el.clientHeight + 30 && /auto|scroll/.test(getComputedStyle(el).overflowY))
      let atEnd = true
      if (box) {
        const before = box.scrollTop
        box.scrollTop = before + box.clientHeight * 0.85
        atEnd = box.scrollTop === before
      }
      const loading = Boolean(dialog.querySelector('[role="progressbar"], svg[aria-label="Loading..."]'))
      return { names, atEnd, loading }
    })()`).catch(() => ({ names: [] }))
    if (batch.gone) throw stop(`@${username}'s following list closed.`, 'unreadable')
    const before = order.length
    for (const name of batch.names || []) {
      if (!seen.has(name)) {
        seen.add(name)
        order.push(name)
      }
    }
    still = order.length === before && batch.atEnd && !batch.loading ? still + 1 : 0
    await sleep(between(1000, 2500))
  }
  await ig.key(wc, 'Escape').catch(() => {})
  return { usernames: order.slice(0, max), complete: still >= 6 }
}

module.exports = { profile, following }

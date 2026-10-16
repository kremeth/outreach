// Home (To do) and the task screens: Hustling, Relaunch, 2nd relaunch, Voicenotes.
// Prospecting lives in app.js; this file routes between them and shares its helpers.
const viewHome = document.getElementById('view-home')
const viewProspect = document.getElementById('view-prospect')
const viewTask = document.getElementById('view-task')
const todayEl = document.getElementById('today')
const syncEl = document.getElementById('sync')
const homeWarn = document.getElementById('home-warn')
const tasksEl = document.getElementById('tasks')
const prospectCard = document.getElementById('prospect-card')
const dmsEl = document.getElementById('dms')
const partnersEl = document.getElementById('partners')
const scraperEl = document.getElementById('scraper')
const safetyEl = document.getElementById('safety')
const launchEl = document.getElementById('launch')

let route = ''
let todoData = null
let syncStatus = null
let syncTimer = null
let screen = null

function number(value) {
  return Number(value || 0).toLocaleString('en-AU')
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso)
  if (!iso || Number.isNaN(ms)) return ''
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

function shortDate(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}

function button(label, className, onClick) {
  const node = el('button', className, label)
  node.type = 'button'
  if (onClick) node.addEventListener('click', onClick)
  return node
}

function backLink() {
  const link = el('a', 'back', '← To do')
  link.href = '#/'
  return link
}

// ---------- Router ----------

function go() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/')
  if (screen?.leave) screen.leave()
  screen = null
  if (route === 'prospect' && name !== 'prospect') leaveProspecting()
  route = name || 'home'
  viewHome.hidden = route !== 'home'
  viewProspect.hidden = route !== 'prospect'
  viewTask.hidden = route === 'home' || route === 'prospect'
  if (route === 'prospect') return enterProspecting()
  if (route === 'hustle') screen = hustleScreen()
  else if (route === 'relaunch') screen = relaunchScreen(Number(arg) === 2 ? 2 : 1)
  else if (route === 'voice') screen = voiceScreen()
  else {
    route = 'home'
    viewHome.hidden = false
    viewTask.hidden = true
    openHome()
  }
}

window.addEventListener('hashchange', go)

// When Outreach's code is updated, the window reloads itself, but only on the To do page so a
// task in progress (and anything still saving) is never interrupted.
let loadedVersion = ''
let updateWaiting = false
async function checkVersion() {
  const { version } = await api('/api/version', null, 10000).catch(() => ({}))
  if (!version) return
  if (!loadedVersion) loadedVersion = version
  else if (version !== loadedVersion) updateWaiting = true
  if (updateWaiting && route === 'home') location.reload()
}
setInterval(checkVersion, 30000)
checkVersion()
window.addEventListener('hashchange', () => {
  if (updateWaiting && route === 'home') location.reload()
})

window.addEventListener('keydown', (event) => {
  if (route === 'prospect' || event.defaultPrevented) return
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
  const target = event.target
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  if (event.key === 'Escape') {
    if (typing) target.blur()
    else if (route !== 'home') location.hash = '#/'
    return
  }
  if (!typing && screen?.key) screen.key(event.key.toLowerCase(), event)
})

// ---------- Home ----------

const TASKS = [
  {
    id: 'voice',
    title: 'Voicenotes',
    hint: 'Yeses with a device, sent by Launch',
    count: (data) => data.voice.toSend,
    side: (data) => `${data.voice.sentToday} / ${data.voice.limit} sent today`,
  },
  {
    id: 'hustle',
    title: 'Hustling',
    hint: 'New posts to pick a comment for',
    count: (data) => data.hustle.toDo,
    side: (data) => (data.hustle.auto?.on ? (data.hustle.auto.always || data.hustle.auto.until ? `Auto-commenting · ${number(data.hustle.auto.pickedToday)} today` : `Auto-commenting starts after ${number(data.hustle.auto.waiting)} waiting picks`) : `${number(data.hustle.picked || 0)} picked`),
  },
  {
    id: 'relaunch/1',
    title: 'Relaunch',
    hint: 'No reply 48 hours after the first message, sent by Launch',
    count: (data) => data.relaunch[1].due,
    side: (data) => waitingLine(data.relaunch[1]),
  },
  {
    id: 'relaunch/2',
    title: '2nd relaunch',
    hint: 'No reply 3 days after the relaunch, sent by Launch',
    count: (data) => data.relaunch[2].due,
    side: (data) => waitingLine(data.relaunch[2]),
  },
]

function waitingLine(summary) {
  const bits = []
  if (summary.sentToday) bits.push(`${summary.sentToday} sent today`)
  if (summary.waiting) bits.push(`${summary.waiting} more due from ${shortDate(summary.nextDue)}`)
  return bits.join(' · ')
}

const PROSPECT_TASK = {
  id: 'prospect',
  title: 'Prospecting',
  hint: 'For you to judge',
  count: (data) => data.prospecting.forYou ?? data.prospecting.remaining,
  side: (data) => `${data.prospecting.yesToday} / ${data.prospecting.yesTarget} yes today`,
}

// Under the Prospecting card, one consistent picture of every profile the model has had: what it
// decided on its own (Yes, No), what it left for the person, and what it has not checked yet. The four
// add up; the bar fills with the share already done.
function modelProgressBar(data) {
  const { judging = 0, forYou = 0, auto = 0, modelYes = 0, modelNo = 0, modelToday = {} } = data.prospecting || {}
  const done = modelYes + modelNo + auto + forYou
  const total = done + judging
  if (!total) return null
  const box = el('div', `model-progress${judging ? ' working' : ''}`)
  const bar = el('div', 'meter')
  const fill = el('div', 'meter-fill')
  fill.style.width = `${Math.max(2, Math.round((done / total) * 100))}%`
  bar.append(fill)
  // Of the profiles the model checked today: its own Yes and No (the rest are for you).
  const today = [`${number(modelToday.checked || 0)} checked`, `${number(modelToday.yes || 0)} Yes`, `${number(modelToday.no || 0)} No`, `${number(modelToday.forYou || 0)} for you`]
  const now = [`${number(forYou)} waiting for you`]
  if (judging) now.push(`${number(judging)} still to check`)
  box.append(bar, el('div', 'model-progress-text', `Today: ${today.join(' · ')}`), el('div', 'model-progress-text', `Now: ${now.join(' · ')}`))
  return box
}

// DMs to reply: in the last 100 conversations of the inbox, the ones where they wrote last (read from
// the inbox list every 20 minutes; no conversation is opened). Likes, reactions and Instagram's own
// lines are left out. One compact row each; a click opens it: what they wrote, then one reply box
// (a text, written by you or proposed from the whole chat, or the two Message 2 voicenotes). Rebuilt
// only when the list itself changes, never while you are typing in it.
const DM_TAGS = {
  interested: ['Keen', 'keen'],
  question: ['Question', 'question'],
  paid: ['Wants paid', 'paid'],
  contact: ['Contact details', 'contact'],
  later: ['Not now', 'later'],
  declined: ['Said no', 'declined'],
}
const dmDrafts = new Map()
const dmMessages = new Map()
const dmModes = new Map()
const dmVoices = new Map()
const dmNotes = new Map()
const dmCopilot = new Map()
const dmFullChat = new Map()
const dmReading = new Set()
let dmOpen = ''
let dmShown = ''

function renderDms(force) {
  const dms = todoData?.dms
  const key = JSON.stringify(dms || null)
  if (!force && key === dmShown) return
  if (!force && dmsEl.contains(document.activeElement) && document.activeElement !== document.body) return
  // A conversation open: the list waits (it refreshes once it is closed), so a reply being written or
  // edited is never rebuilt under you.
  if (!force && dmOpen && (todoData?.dms?.toReply || []).some((item) => item.name === dmOpen)) return
  dmShown = key
  dmsEl.replaceChildren()
  if (!dms) return
  const card = el('div', 'side-card dm-card')
  const when = dms.scannedAt ? new Date(dms.scannedAt).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }) : ''
  const head = el('div', 'dm-head')
  const waiting = dms.toReply.length
  head.append(el('strong', '', !dms.scannedAt ? 'Inbox not read yet' : waiting ? `${waiting} waiting on you` : 'All answered'))
  if (dms.outgoing?.length) head.append(el('span', 'dm-outgoing', `${dms.outgoing.length} ${dms.outgoing.length === 1 ? 'reply' : 'replies'} going out`))
  if (dms.scannedAt) head.append(el('span', 'dm-head-note', `checked ${when}`))
  const refresh = button('Check now', 'dm-link', async () => {
    refresh.disabled = true
    refresh.textContent = 'Checking…'
    await api('/api/dms/scan', {}).catch(() => {})
    setTimeout(() => loadTodo(false), 20000)
  })
  head.append(refresh)
  card.append(head)
  const outLine = outgoingLine(dms.outgoing || [], dms.sendingNow)
  if (outLine) {
    const line = el('p', 'dm-out-line', outLine)
    const hour = new Date().getHours()
    if ((hour < 8 || hour >= 21) && !dms.sendingNow) {
      const now = button('Send now', 'dm-link', async () => {
        now.disabled = true
        const result = await api('/api/dms/send-now', {}).catch(() => null)
        if (result?.dms && todoData) todoData.dms = result.dms
        renderDms(true)
      })
      line.append(' ', now)
    }
    card.append(line)
  }
  if (!dms.scannedAt) card.append(el('p', 'side-empty', 'The inbox is read every 20 minutes while Outreach is open.'))
  else if (!dms.toReply.length) card.append(el('p', 'side-empty', `Nothing to reply to in the last ${dms.looked} conversations.`))
  for (const item of dms.toReply) card.append(dmRow(item))
  dmsEl.append(card)
}

// The list follows the inbox on its own (read every 20 minutes, and after each reply sent): checked
// every 30 seconds on the To do page; redrawn only when it changed, never while you are typing.
setInterval(async () => {
  if (route !== 'home' || !todoData) return
  const dms = await api('/api/dms', null, 10000).catch(() => null)
  if (!dms) return
  todoData.dms = dms
  renderDms()
}, 30000)

// When the replies on their way go out: between Launch's actions, 8:00 to 21:00, within the safety
// limits; one waiting on a limit says so.
function outgoingLine(list, sendingNow) {
  if (!list.length) return ''
  const hour = new Date().getHours()
  const time = (at) => new Date(at).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
  const waiting = list.filter((entry) => entry.waitUntil)
  const ready = list.length - waiting.length
  const parts = []
  if (ready) parts.push((hour < 8 || hour >= 21) && !sendingNow ? `${ready} go out from 8:00 tomorrow morning` : `${ready} go out one by one between Launch's actions`)
  const groups = {}
  for (const entry of waiting) {
    const key = `${entry.kind}|${entry.waitReason}|${time(entry.waitUntil)}`
    groups[key] = (groups[key] || 0) + 1
  }
  for (const [key, count] of Object.entries(groups)) {
    const [kind, reason, at] = key.split('|')
    parts.push(`${count} ${kind === 'like' ? (count === 1 ? 'like waits' : 'likes wait') : `${kind === 'voice' ? 'voicenote' : 'text'} ${count === 1 ? 'reply waits' : 'replies wait'}`} until ${at}${reason ? ` (${reason.replace(/\.$/, '')})` : ''}`)
  }
  return parts.join(' · ')
}

// Sent from here: the conversation leaves the list at once (the reply goes out in the background).
function dmAnswered(item, kind) {
  const dms = todoData?.dms
  if (!dms) return
  dms.toReply = dms.toReply.filter((entry) => entry.name !== item.name)
  dms.outgoing = [...(dms.outgoing || []).filter((entry) => entry.name !== item.name), { name: item.name, kind, status: 'queued' }]
  dmOpen = ''
  if (document.activeElement && dmsEl.contains(document.activeElement)) document.activeElement.blur()
  renderDms(true)
}

// The emoji keyboard of the reply box: a click puts the emoji where the cursor is. The first row is
// the ones used most in our replies.
const EMOJI_GROUPS = [
  ['Most used', '😊 🥰 🧡 🙌 🤝 😂 🙏 👏 🔥 💪 ❤️ ✨'],
  ['Faces', '🙂 😁 😄 😅 🤣 😉 😍 🤩 😎 🤗 🫡 🤔 😮 🥲 😭 🙃 😇 🫠 🤯 🥳'],
  ['Hands', '👋 👌 🤙 👊 🤞 ✌️ 👍 🫶 👀 🙏 💯 ✅'],
  ['Hearts', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💕 💖 ❤️‍🔥 💫'],
  ['Active', '🏃 🚴 🏋️ 🧘 🏊 🥾 ⛰️ 🏆 ⌚ 💤 🧠 📈 💊 🥗 ☕ 🌱 ☀️ 🌊 📦 🎉'],
]
let openEmojiPanel = null
document.addEventListener('mousedown', (event) => {
  if (openEmojiPanel && !openEmojiPanel.contains(event.target) && !event.target.closest('.dm-emoji-toggle')) {
    openEmojiPanel.remove()
    openEmojiPanel = null
  }
})
function emojiButton(box, changed) {
  const wrap = el('span', 'dm-emoji')
  const toggle = button('😊', 'dm-emoji-toggle', () => {
    if (openEmojiPanel) {
      const mine = wrap.contains(openEmojiPanel)
      openEmojiPanel.remove()
      openEmojiPanel = null
      if (mine) return
    }
    const panel = el('div', 'dm-emoji-panel')
    for (const [label, list] of EMOJI_GROUPS) {
      panel.append(el('div', 'dm-emoji-label', label))
      const grid = el('div', 'dm-emoji-grid')
      for (const emoji of list.split(' ')) {
        const key = button(emoji, 'dm-emoji-key', () => {
          const start = box.selectionStart ?? box.value.length
          const end = box.selectionEnd ?? start
          box.value = box.value.slice(0, start) + emoji + box.value.slice(end)
          box.focus()
          box.setSelectionRange(start + emoji.length, start + emoji.length)
          changed()
        })
        // Keeps the cursor in the reply while picking.
        key.addEventListener('mousedown', (event) => event.preventDefault())
        grid.append(key)
      }
      panel.append(grid)
    }
    wrap.append(panel)
    openEmojiPanel = panel
  })
  toggle.title = 'Emoji'
  toggle.setAttribute('aria-label', 'Emoji')
  toggle.addEventListener('mousedown', (event) => event.preventDefault())
  wrap.append(toggle)
  return wrap
}

// Types a reply into the box over about `ms` (whole words, so it reads naturally), with a caret.
function typeInto(box, text, ms) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) {
    box.value = text
    return Promise.resolve()
  }
  const tokens = text.match(/\S+\s*|\s+/g) || [text]
  const per = Math.max(8, ms / tokens.length)
  box.value = ''
  return new Promise((resolve) => {
    let at = 0
    const tick = () => {
      box.value += tokens[at++]
      box.style.height = 'auto'
      box.style.height = `${Math.min(320, box.scrollHeight + 2)}px`
      if (at < tokens.length) setTimeout(tick, per)
      else resolve()
    }
    tick()
  })
}

function initials(name) {
  const words = String(name).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length > 2 && words.every((word) => word.length === 1)) return words.slice(0, 2).join('').toUpperCase() // "L A U R I S S A"
  return (words.slice(0, 2).map((word) => word[0]).join('') || '?').toUpperCase()
}

function avatar(name) {
  let hash = 0
  for (const char of String(name)) hash = (hash * 31 + char.codePointAt(0)) % 360
  const node = el('span', 'dm-avatar', initials(name))
  node.style.background = `hsl(${hash} 55% 90%)`
  node.style.color = `hsl(${hash} 45% 30%)`
  return node
}

function dmRow(item) {
  const open = dmOpen === item.name
  const state = item.reply
  const row = el('div', `dm-row${open ? ' open' : ''}${item.unread ? ' unread' : ''}${state && state.status !== 'failed' ? ' answered' : ''}`)
  const summary = el('button', 'dm-summary')
  summary.type = 'button'
  summary.setAttribute('aria-expanded', String(open))
  const text = el('span', 'dm-text')
  const top = el('span', 'dm-top')
  top.append(el('span', 'dm-name', item.name))
  if (state && state.status !== 'failed') {
    const label = { queued: 'Queued', sending: 'Sending…', sent: 'Sent ✓' }[state.status] || state.status
    top.append(el('span', `dm-tag ${state.status === 'sent' ? 'sent' : 'queued'}`, state.kind === 'like' ? (state.status === 'sent' ? 'Liked ❤️' : 'Liking…') : `${state.kind === 'voice' ? '🎙 ' : ''}${label}`))
  } else if (state?.status === 'failed') top.append(el('span', 'dm-tag declined', 'Not sent'))
  else if (DM_TAGS[item.tag]) top.append(el('span', `dm-tag ${DM_TAGS[item.tag][1]}`, DM_TAGS[item.tag][0]))
  top.append(el('span', 'dm-age', item.age || ''))
  if (item.unread) top.append(el('span', 'dm-dot'))
  const preview = /^\d+ new messages?$|^new message$/i.test(item.preview) ? `💬 ${item.preview}` : item.voice && /voice/i.test(item.preview) ? '🎙 Voicenote' : item.preview
  text.append(top)
  if (item.username) text.append(el('span', 'dm-handle-line', `@${item.username}`))
  text.append(el('span', 'dm-preview', preview))
  const pic = avatar(item.name)
  if (item.username) {
    const img = document.createElement('img')
    img.src = `/api/dms/avatar?u=${encodeURIComponent(item.username)}`
    img.alt = ''
    img.addEventListener('load', () => { pic.textContent = ''; pic.style.background = 'none'; pic.append(img) })
  }
  summary.append(pic, text, el('span', 'dm-chevron', '›'))
  summary.addEventListener('click', () => {
    const previous = dmOpen
    dmOpen = open ? '' : item.name
    const rows = [...dmsEl.querySelectorAll('.dm-row')]
    const items = todoData?.dms?.toReply || []
    for (const node of rows) {
      const match = items.find((entry) => entry.name === node.dataset.name)
      if (match && (match.name === previous || match.name === item.name)) node.replaceWith(dmRow(match))
    }
    if (dmOpen) dmsEl.querySelector(`.dm-row.open textarea`)?.focus({ preventScroll: true })
  })
  row.dataset.name = item.name
  row.append(summary)
  if (open) row.append(dmBody(item))
  return row
}

// The opened conversation: their message(s) as chat bubbles, then the reply box.
function dmBody(item) {
  const body = el('div', 'dm-body')
  const redraw = () => {
    const row = [...dmsEl.querySelectorAll('.dm-row')].find((node) => node.dataset.name === item.name)
    if (row) row.replaceWith(dmRow(item))
  }
  // Their side of the chat, with their profile picture; View chat shows the whole conversation.
  const thread = el('div', 'dm-thread')
  const face = () => {
    const pic = el('span', 'dm-face')
    if (item.username) {
      const img = document.createElement('img')
      img.src = `/api/dms/avatar?u=${encodeURIComponent(item.username)}`
      img.alt = ''
      img.addEventListener('error', () => { img.remove(); pic.textContent = initials(item.name) })
      pic.append(img)
    } else pic.textContent = initials(item.name)
    return pic
  }
  const bubbleLine = (message) => {
    const line = el('div', `dm-line ${message.ours ? 'ours' : 'theirs'}`)
    const face = () => document.createDocumentFragment() // the picture is in the row above, not repeated
    const bubble = el('div', `dm-bubble${message.ours ? ' ours' : ''}${message.voice ? ' voice' : ''}`)
    if (message.voice) bubble.append(el('span', 'dm-voice-tag', message.transcribed ? '🎙 Voicenote · transcribed' : '🎙 Voicenote'))
    const words = String(message.text || '').replace(/\d+:\d{2}/, '').replace(/(view|hide) transcription|unable to transcribe,?\s*(try again)?/gi, '').trim()
    bubble.append(el('span', '', words || (message.voice ? (message.ours ? 'Our voicenote' : '(no words)') : '(photo, GIF or attachment)')))
    if (!message.ours) line.append(face())
    line.append(bubble)
    return line
  }
  const full = dmFullChat.get(item.name)
  const shown = dmMessages.get(item.name)
  const hidden = /^\d+ new messages?$|^new message$/i.test(item.preview) || /voice message/i.test(item.preview)
  const needsWords = (messages) => messages.some((message) => message.voice && !String(message.text || '').replace(/\d+:\d{2}/, '').replace(/(view|hide) transcription|unable to transcribe,?\s*(try again)?/gi, '').trim())
  if (full) for (const message of full) thread.append(bubbleLine(message))
  else if (shown) for (const message of shown) thread.append(bubbleLine({ ...message, ours: false }))
  else if (item.recent?.length && !needsWords(item.recent)) for (const message of item.recent) thread.append(bubbleLine(message))
  else if (hidden || item.recent?.length) {
    // Read straight away when opened: every message since our last, voicenotes transcribed.
    const bubble = el('div', 'dm-bubble placeholder')
    bubble.append(el('span', 'dm-reading', /voice/i.test(item.preview) || item.recent?.length ? 'Reading the chat and transcribing the voicenote…' : 'Reading the chat…'))
    thread.append(bubble)
    if (!dmReading.has(item.name)) {
      dmReading.add(item.name)
      api('/api/dms/messages', { name: item.name, username: item.username }, 180000).then((result) => {
        if (result.username && !item.username) item.username = result.username
        dmMessages.set(item.name, result.messages.length ? result.messages : [{ text: '(nothing new from them)' }])
      }).catch((error) => {
        dmMessages.set(item.name, [{ text: `Could not read the chat: ${error.message}` }])
      }).finally(() => { dmReading.delete(item.name); redraw() })
    }
  } else if (false) {
    const line = el('div', 'dm-line theirs')
    const bubble = el('div', 'dm-bubble placeholder')
    const count = item.preview.match(/^\d+/)?.[0]
    const load = button(/voice/i.test(item.preview) ? 'Read the voicenote' : count ? `Read the ${count} messages` : 'Read the message', 'dm-link', async () => {
      load.disabled = true
      load.textContent = /voice/i.test(item.preview) ? 'Reading and transcribing…' : 'Reading the chat…'
      try {
        const result = await api('/api/dms/messages', { name: item.name, username: item.username }, 180000)
        if (result.username && !item.username) item.username = result.username
        dmMessages.set(item.name, result.messages.length ? result.messages : [{ text: '(nothing new from them)' }])
        redraw()
      } catch (error) {
        load.disabled = false
        load.textContent = error.message || 'Could not read the chat. Try again.'
      }
    })
    bubble.append(el('span', '', /voice/i.test(item.preview) ? 'They sent a voicenote. ' : count ? `They sent ${item.preview.toLowerCase()}. ` : 'They wrote last. '), load)
    bubble.append(el('div', 'dm-hint', /voice/i.test(item.preview) ? 'Gemini transcribes it (nothing is played out loud). Instagram marks the chat as read.' : 'Opens the chat, so Instagram marks it as read.'))
    line.append(face(), bubble)
    thread.append(line)
  } else thread.append(bubbleLine({ ours: false, text: item.preview }))
  const view = button(full ? 'Hide full chat' : 'View chat', 'dm-link dm-view', async () => {
    if (full) {
      dmFullChat.delete(item.name)
      redraw()
      return
    }
    view.disabled = true
    view.textContent = 'Loading the chat…'
    try {
      const result = await api('/api/dms/chat', { name: item.name, username: item.username }, 180000)
      if (result.username && !item.username) item.username = result.username
      dmFullChat.set(item.name, (result.messages || []).slice(-30))
      redraw()
    } catch (error) {
      view.disabled = false
      view.textContent = error.message || 'Could not load the chat.'
    }
  })
  thread.append(view)
  body.append(thread)

  const state = item.reply
  if (state && state.status !== 'failed') {
    const parts = state.kind === 'voice' && state.status !== 'sent' && state.sentParts ? ` Part ${state.sentParts} of 2 sent.` : ''
    const text = { queued: 'Your reply goes out as soon as Instagram is free.', sending: 'Sending your reply now…', sent: 'Reply sent. This conversation leaves the list at the next inbox check.' }[state.status] || ''
    body.append(el('div', `dm-done ${state.status}`, `${text}${parts}`))
    return body
  }
  if (state?.status === 'failed') body.append(el('div', 'dm-done failed', `Not sent: ${state.error}`))

  // Text or voicenotes. Someone keen to hear more gets the voicenotes by default.
  const voiceKnown = item.voice || ''
  const mode = dmModes.get(item.name) || (item.tag === 'interested' && !dmDrafts.get(item.name) ? 'voice' : 'text')
  const composer = el('div', 'dm-composer')
  const tabs = el('div', 'dm-tabs')
  for (const [value, label] of [['text', 'Text'], ['voice', '🎙 Voicenotes']]) {
    const tab = button(label, `dm-tab${mode === value ? ' on' : ''}`, () => {
      dmModes.set(item.name, value)
      redraw()
    })
    tabs.append(tab)
  }
  composer.append(tabs)
  const note = el('div', 'dm-note', '')
  if (mode === 'text') {
    // Drafting with GPT, like a chat: its versions of the reply (editable, one picked to send), what you
    // tell it ("we don't have NSF", "shorter"), and a new version each time. An earlier note can be edited:
    // everything after it is written again.
    const entries = dmCopilot.get(item.name) || []
    dmCopilot.set(item.name, entries)
    const selectedIndex = () => {
      const picked = entries.findIndex((entry) => entry.role === 'draft' && entry.picked)
      if (picked >= 0) return picked
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i].role === 'draft') return i
      return -1
    }
    const turnsUpTo = (end) => {
      const turns = []
      for (let i = 0; i < end; i++) {
        if (entries[i].role !== 'me') continue
        const before = [...entries.slice(0, i)].reverse().find((entry) => entry.role === 'draft')
        turns.push({ draft: before ? before.text : '', feedback: entries[i].text })
      }
      return turns
    }
    const pane = el('div', 'dm-copilot')
    const list = el('div', 'dm-copilot-list')
    const send = button('Send reply', 'dm-primary', () => pickAndSend())
    const render = () => {
      list.replaceChildren()
      const chosen = selectedIndex()
      entries.forEach((entry, index) => {
        if (entry.role === 'me') {
          const me = el('div', 'dm-me')
          if (entry.editing) {
            const edit = document.createElement('textarea')
            edit.className = 'dm-me-edit'
            edit.value = entry.text
            edit.rows = 2
            const save = button('Save & rewrite', 'dm-chip on', () => {
              if (!edit.value.trim()) return
              entry.text = edit.value.trim()
              entry.editing = false
              entries.splice(index + 1)
              generate()
            })
            const cancel = button('Cancel', 'dm-chip', () => { entry.editing = false; render() })
            edit.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save.click() } })
            me.append(edit, el('div', 'dm-me-actions'))
            me.lastChild.append(cancel, save)
            requestAnimationFrame(() => edit.focus())
          } else {
            const bubble = el('button', 'dm-me-bubble', entry.text)
            bubble.type = 'button'
            bubble.title = 'Edit this (everything after it is written again)'
            bubble.addEventListener('click', () => { if (!busy) { entry.editing = true; render() } })
            me.append(bubble)
          }
          list.append(me)
          return
        }
        const card = el('div', `dm-draft${index === chosen ? ' chosen' : ''}`)
        const head = el('div', 'dm-draft-head')
        head.append(el('span', 'dm-draft-label', entry.own ? 'Your version' : `Version ${entries.slice(0, index + 1).filter((e) => e.role === 'draft').length}`))
        const pick = button(index === chosen ? '● Will send' : '○ Pick this one', `dm-pick${index === chosen ? ' on' : ''}`, () => {
          entries.forEach((other) => { other.picked = false })
          entry.picked = true
          render()
        })
        head.append(pick)
        const text = document.createElement('textarea')
        text.className = 'dm-draft-text'
        text.value = entry.text
        text.rows = 3
        text.addEventListener('input', () => { entry.text = text.value; fitArea(text); send.disabled = busy || !entries[selectedIndex()]?.text.trim() })
        text.addEventListener('focus', () => { if (selectedIndex() !== index) { entries.forEach((other) => { other.picked = false }); entry.picked = true; card.classList.add('chosen') } lastFocus = text })
        text.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send.click() })
        card.append(head, text)
        list.append(card)
        requestAnimationFrame(() => fitArea(text))
      })
      if (busy) {
        const card = el('div', 'dm-draft writing')
        const skeleton = el('div', 'dm-skeleton')
        for (const width of [92, 78, 86, 54]) {
          const line = el('span', 'dm-skeleton-line')
          line.style.width = `${width}%`
          skeleton.append(line)
        }
        skeleton.append(thinking)
        card.append(skeleton)
        list.append(card)
      } else if (!entries.length) list.append(el('p', 'dm-copilot-empty', 'No reply yet. Ask for one, or write your own.'))
      send.disabled = busy || !entries[selectedIndex()]?.text.trim()
      list.scrollTop = list.scrollHeight
    }
    const fitArea = (area) => {
      area.style.height = 'auto'
      area.style.height = `${Math.min(360, area.scrollHeight + 2)}px`
    }
    const thinking = el('div', 'dm-thinking', '')
    let busy = false
    let lastFocus = null
    const generate = async ({ fresh = false } = {}) => {
      busy = true
      note.textContent = ''
      const steps = ['Reading the chat…', 'Remembering how you write…', 'Finding the right words…', 'Polishing…']
      let step = 0
      thinking.textContent = steps[0]
      const ticker = setInterval(() => { step = Math.min(step + 1, steps.length - 1); thinking.textContent = steps[step] }, 1600)
      render()
      try {
        const turns = turnsUpTo(entries.length)
        const result = await api('/api/dms/draft', { name: item.name, username: item.username, fresh: fresh || turns.length > 0 || entries.length > 0, turns }, 180000)
        if (result.username && !item.username) item.username = result.username
        entries.forEach((other) => { other.picked = false })
        // Kept first, then typed in (only the look).
        entries.push({ role: 'draft', text: result.reply })
        busy = false
        render()
        const area = [...list.querySelectorAll('.dm-draft-text')].pop()
        if (area && body.isConnected) await typeInto(area, result.reply, result.instant ? 450 : 800)
      } catch (error) {
        note.textContent = error.message || 'Could not write a reply.'
      }
      clearInterval(ticker)
      busy = false
      if (body.isConnected) render()
      else redraw()
    }
    // Your note to GPT.
    const ask = document.createElement('textarea')
    ask.className = 'dm-ask'
    ask.rows = 1
    ask.placeholder = "Tell GPT what to change… e.g. we don't have NSF, make it shorter"
    ask.value = dmNotes.get(item.name) || ''
    ask.addEventListener('input', () => { dmNotes.set(item.name, ask.value); fitArea(ask) })
    const askSend = button('↑', 'dm-ask-send', () => {
      const text = ask.value.trim()
      if (!text || busy) return
      entries.push({ role: 'me', text })
      ask.value = ''
      dmNotes.delete(item.name)
      generate()
    })
    askSend.title = 'Send to GPT (Enter)'
    ask.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); askSend.click() } })
    const askRow = el('div', 'dm-ask-row')
    askRow.append(ask, askSend)
    const again = button('↻ Another version', 'dm-ghost', () => { if (!busy) generate({ fresh: true }) })
    const own = button('✍️ Write my own', 'dm-ghost', () => {
      entries.forEach((other) => { other.picked = false })
      entries.push({ role: 'draft', text: '', own: true, picked: true })
      render()
      requestAnimationFrame(() => [...list.querySelectorAll('.dm-draft-text')].pop()?.focus())
    })
    const emoji = emojiButton({ get selectionStart() { return (lastFocus || [...list.querySelectorAll('.dm-draft-text')].pop())?.selectionStart }, get selectionEnd() { return (lastFocus || [...list.querySelectorAll('.dm-draft-text')].pop())?.selectionEnd }, get value() { return (lastFocus || [...list.querySelectorAll('.dm-draft-text')].pop())?.value || '' }, set value(v) { const area = lastFocus || [...list.querySelectorAll('.dm-draft-text')].pop(); if (area) { area.value = v; area.dispatchEvent(new Event('input')) } }, focus() { (lastFocus || [...list.querySelectorAll('.dm-draft-text')].pop())?.focus() }, setSelectionRange(a, b) { (lastFocus || [...list.querySelectorAll('.dm-draft-text')].pop())?.setSelectionRange(a, b) } }, () => {})
    // Send: the picked version is clearly the one that goes out (a short highlight), then it is queued.
    const pickAndSend = async () => {
      const index = selectedIndex()
      const entry = entries[index]
      if (!entry || !entry.text.trim() || busy) return
      send.disabled = true
      const cards = [...list.querySelectorAll('.dm-draft')]
      const card = cards[entries.slice(0, index + 1).filter((e) => e.role === 'draft').length - 1]
      pane.classList.add('sending')
      card?.classList.add('picked')
      card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      await new Promise((resolve) => setTimeout(resolve, 900))
      try {
        await api('/api/dms/send', { name: item.name, username: item.username, kind: 'text', text: entry.text })
        dmCopilot.delete(item.name)
        dmAnswered(item, 'text')
      } catch (error) {
        pane.classList.remove('sending')
        card?.classList.remove('picked')
        note.textContent = error.message
        send.disabled = false
      }
    }
    const bar = el('div', 'dm-bar')
    bar.append(again, own, emoji, el('span', 'dm-keys', '⌘↩ to send'), send)
    pane.append(list, askRow, bar)
    composer.append(pane)
    render()
    // The first version straight away (instant when it was written ahead).
    if (!entries.length) generate()
  } else {
    const voice = voiceKnown || dmVoices.get(item.name) || ''
    const who = el('div', 'dm-who')
    if (voiceKnown) who.append(el('span', '', `From ${voiceKnown}, who sent them the first voicenote.`))
    else {
      who.append(el('span', '', 'Who sent the first voicenote?'))
      for (const name of ['Mathieu', 'Romain']) {
        who.append(button(name, `dm-chip${voice === name ? ' on' : ''}`, () => { dmVoices.set(item.name, name); redraw() }))
      }
    }
    composer.append(who)
    if (voice) {
      const clips = el('div', 'dm-clips')
      for (const part of [1, 2]) {
        const clip = el('div', 'dm-clip')
        const audio = document.createElement('audio')
        audio.controls = true
        audio.preload = 'none'
        audio.src = `/api/dms/clip?voice=${voice}&part=${part}`
        clip.append(el('span', 'dm-clip-label', `Part ${part}`), audio)
        clips.append(clip)
      }
      composer.append(clips)
    }
    const send = button(voice ? `Send ${voice}'s 2 voicenotes` : 'Send the 2 voicenotes', 'dm-primary', async () => {
      send.disabled = true
      send.textContent = 'Queuing…'
      try {
        await api('/api/dms/send', { name: item.name, username: item.username, kind: 'voice', voice })
        dmAnswered(item, 'voice')
      } catch (error) {
        note.textContent = error.message
        send.disabled = false
      }
    })
    send.disabled = !voice
    const bar = el('div', 'dm-bar')
    bar.append(el('span', 'dm-keys', 'Message 2: part 1, then part 2'), send)
    composer.append(bar)
  }
  composer.append(note)
  body.append(composer)

  const foot = el('div', 'dm-foot')
  foot.append(el('span', 'dm-hint', 'Sends as soon as Instagram is free (Launch keeps going).'))
  const skip = button('No reply needed', 'dm-link', async () => {
    skip.disabled = true
    try {
      const result = await api('/api/dms/dismiss', { name: item.name, username: item.username, preview: item.rawPreview ?? item.preview, unread: Boolean(item.unread) })
      if (todoData && result.dms) todoData.dms = result.dms
      dmOpen = ''
      renderDms(true)
    } catch (error) {
      note.textContent = error.message
      skip.disabled = false
    }
  })
  const like = button('Like message ❤️', 'dm-link', async () => {
    like.disabled = true
    try {
      await api('/api/dms/send', { name: item.name, username: item.username, kind: 'like' })
      dmAnswered(item, 'like')
    } catch (error) {
      note.textContent = error.message
      like.disabled = false
    }
  })
  foot.append(like, skip)
  if (item.username) {
    const link = el('a', 'dm-link', 'Open on Instagram ↗')
    link.href = `https://ig.me/m/${item.username}`
    link.target = '_blank'
    link.rel = 'noopener'
    foot.append(link)
  }
  body.append(foot)
  return body
}

// Ongoing partnerships: the deal is a story when the box arrives, then a reel once the month is done.
// Each creator: the story (its date starts the month), a timeline to the reel's due date (a month later)
// with today on it, and a countdown. The story ticks on its own when they mention us in their story (DM
// inbox) or our story reposts theirs; the reel when one of their posts names nutricode. Anything can be
// ticked, unticked or re-dated by hand. Kept on the "Ongoing Partnerships" tab of the sheet.

function partnerState(partner) {
  if (partner.post) return { rank: 3, tone: 'done', label: partner.reelDate ? `Reel posted ${shortDate(partner.reelDate)}` : 'Reel posted' }
  if (!partner.story) return { rank: 2, tone: 'waiting', label: 'Waiting for their story' }
  const days = partner.daysLeft
  if (days < 0) return { rank: 0, tone: 'late', label: `Reel ${-days} ${-days === 1 ? 'day' : 'days'} late` }
  if (days === 0) return { rank: 0, tone: 'soon', label: 'Reel due today' }
  if (days === 1) return { rank: 1, tone: 'soon', label: 'Reel due tomorrow' }
  return { rank: 1, tone: days <= 7 ? 'soon' : 'running', label: `Reel in ${days} days` }
}

// A date picked by hand: a native date picker, opened from the date itself.
function datePicker(partner, kind, current, onPicked) {
  const input = document.createElement('input')
  input.type = 'date'
  input.className = 'partner-date-input'
  input.value = current || new Date().toISOString().slice(0, 10)
  input.max = new Date().toISOString().slice(0, 10)
  input.addEventListener('change', async () => {
    if (!input.value) return
    const result = await api('/api/partners/date', { username: partner.username, kind, date: input.value }).catch(() => null)
    onPicked(result)
  })
  return input
}

function renderPartners() {
  partnersEl.replaceChildren()
  const list = todoData?.partners
  if (!list) return
  const card = el('div', 'side-card partner-card')
  if (!list.length) card.append(el('p', 'side-empty', 'No ongoing partnerships (add them on the "Ongoing Partnerships" tab).'))
  const refresh = (result) => {
    if (result?.partners && todoData) todoData.partners = result.partners
    renderPartners()
  }
  const sorted = [...list].map((partner) => ({ partner, state: partnerState(partner) }))
    .sort((a, b) => a.state.rank - b.state.rank || (a.partner.daysLeft ?? 99) - (b.partner.daysLeft ?? 99))
  for (const { partner, state } of sorted) {
    const row = el('div', `partner-row ${state.tone}`)
    const head = el('div', 'partner-head')
    const who = el('a', 'partner-name', `@${partner.username}`)
    who.href = `https://www.instagram.com/${partner.username}/`
    who.target = '_blank'
    who.rel = 'noopener'
    head.append(avatar(partner.username), who, el('span', `partner-pill ${state.tone}`, state.label))
    row.append(head)

    // The month: story -> today -> reel due.
    const line = el('div', 'partner-line')
    const storyStep = el('div', `partner-step${partner.story ? ' on' : ''}`)
    const storyTick = button(partner.story ? '✓' : '', 'partner-tick', async () => {
      storyTick.disabled = true
      refresh(await api('/api/partners/mark', { username: partner.username, kind: 'story', value: !partner.story }).catch(() => null))
    })
    storyTick.title = partner.story ? `Story: ${partner.storySeen || 'ticked'} (click to untick)` : 'Mark the story as posted today'
    const storyText = el('div', 'partner-step-text')
    storyText.append(el('span', 'partner-step-label', 'Story'))
    if (partner.story) {
      const when = el('label', 'partner-when', shortDate(partner.storyDate) || 'date?')
      when.title = 'Change the story date'
      when.append(datePicker(partner, 'story', partner.storyDate, refresh))
      storyText.append(when)
    } else storyText.append(el('span', 'partner-when muted', 'not yet'))
    storyStep.append(storyTick, storyText)

    const track = el('div', 'partner-track')
    const fill = el('div', 'partner-fill')
    if (partner.post) fill.style.width = '100%'
    else if (partner.story && partner.storyDate && partner.reelDue) {
      const start = new Date(`${partner.storyDate}T00:00:00`).getTime()
      const due = new Date(`${partner.reelDue}T00:00:00`).getTime()
      const now = Date.now()
      fill.style.width = `${Math.max(3, Math.min(100, ((now - start) / (due - start)) * 100))}%`
    } else fill.style.width = '0%'
    track.append(fill)

    const reelStep = el('div', `partner-step reel${partner.post ? ' on' : ''}`)
    const reelTick = button(partner.post ? '✓' : '', 'partner-tick', async () => {
      reelTick.disabled = true
      refresh(await api('/api/partners/mark', { username: partner.username, kind: 'post', value: !partner.post }).catch(() => null))
    })
    reelTick.title = partner.post ? `Reel: ${partner.postSeen || 'ticked'} (click to untick)` : 'Mark the reel as posted today'
    const reelText = el('div', 'partner-step-text')
    reelText.append(el('span', 'partner-step-label', 'Reel'))
    if (partner.post) {
      const when = el('label', 'partner-when', shortDate(partner.reelDate) || 'posted')
      when.title = 'Change the reel date'
      when.append(datePicker(partner, 'post', partner.reelDate, refresh))
      reelText.append(when)
    } else reelText.append(el('span', 'partner-when muted', partner.reelDue ? `due ${shortDate(partner.reelDue)}` : 'a month after the story'))
    reelStep.append(reelText, reelTick)

    line.append(storyStep, track, reelStep)
    row.append(line)
    card.append(row)
  }
  partnersEl.append(card)
}

// Finding new creators: the scraper account reads the following lists of the creators on the list;
// today's progress, what was added where, and the creator in progress.
function renderScraper() {
  scraperEl.replaceChildren()
  const scraper = todoData?.scraper
  if (!scraper) return
  const card = el('div', 'side-card scraper-card')
  const t = scraper.today || {}
  const head = el('div', 'scraper-head')
  const label = { running: 'Running', 'needs login': 'Needs you: log in', 'needs check': 'Needs you', 'done for today': 'Done for today', stopped: 'Stopped for today', idle: 'Waiting' }[scraper.status] || scraper.status
  head.append(el('strong', '', `${number(t.scraped || 0)} / ${number(scraper.daily)} scraped today`), el('span', `scraper-state ${String(scraper.status).replace(/\s/g, '-')}`, label))
  const bar = el('div', 'meter')
  const fill = el('div', 'meter-fill')
  fill.style.width = `${Math.max(1, Math.min(100, Math.round(((t.scraped || 0) / scraper.daily) * 100)))}%`
  bar.append(fill)
  const lines = el('div', 'scraper-lines')
  lines.append(el('div', '', `${number(t.contacts || 0)} added to 1. Influencer Contact List · ${number(t.reach || 0)} added to Customer Reach Out · ${number(t.discarded || 0)} not in Australia`))
  if (scraper.current) lines.append(el('div', '', `Now: @${scraper.current.username}'s following, ${number(scraper.current.done)} of ${number(scraper.current.following)}`))
  if (t.creators) lines.append(el('div', '', `${number(t.creators)} creators finished today (added to Scraped)`))
  const needsYou = scraper.status === 'needs check' || scraper.status === 'needs login'
  if (scraper.message && !needsYou) lines.append(el('div', 'scraper-message', scraper.message))
  const buttons = el('div', 'dm-buttons')
  const resume = async (node) => {
    node.disabled = true
    node.textContent = 'Resuming…'
    await api('/api/scraper/resume', {}).catch(() => {})
    setTimeout(() => loadTodo(false), 4000)
  }
  if (needsYou) {
    // Instagram wants the scraper account checked (confirm you're human, a code...) or logged in again:
    // done by the person in the scraper's own window, then resumed from here.
    const alert = el('div', 'scraper-alert')
    alert.append(
      el('strong', '', scraper.status === 'needs login' ? 'The scraper account is logged out' : 'Instagram wants to check the scraper account'),
      el('span', '', scraper.status === 'needs login'
        ? 'Open its window, log in (and any code Instagram asks for), then resume.'
        : `Open its window and do what Instagram asks (confirm you're human, a code by email or text), then resume.${scraper.message ? ` Instagram said: "${scraper.message.replace(/^Instagram showed a warning:\s*/, '').slice(0, 140)}"` : ''}`),
    )
    lines.append(alert)
    buttons.append(button(scraper.status === 'needs login' ? 'Log in to the scraper account' : 'Verify the scraper account', 'small', () => api('/api/scraper/login', {}).catch(() => {})))
    const done = button("Done, resume", 'ghost small', () => resume(done))
    buttons.append(done)
  } else {
    buttons.append(button('Scraper window', 'ghost small', () => api('/api/scraper/login', {}).catch(() => {})))
    if (scraper.status !== 'running') buttons.append(button('Start now', 'ghost small', async () => { await api('/api/scraper/start', {}).catch(() => {}); setTimeout(() => loadTodo(false), 3000) }))
  }
  card.append(head, bar, lines, buttons)
  scraperEl.append(card)
}

function renderTasks() {
  renderScraper()
  renderDms()
  renderPartners()
  tasksEl.replaceChildren()
  prospectCard.replaceChildren()
  if (!todoData) {
    prospectCard.append(el('div', 'task loading'))
    for (let index = 0; index < TASKS.length; index++) tasksEl.append(el('div', 'task loading'))
    return
  }
  for (const task of [PROSPECT_TASK, ...TASKS]) {
    const count = task.count(todoData) || 0
    const syncing = task.id === 'hustle' && syncStatus?.running
    const link = el('a', count || syncing ? 'task' : 'task done')
    link.href = `#/${task.id}`
    const value = el('div', 'task-count', count ? number(count) : (syncing ? '…' : '✓'))
    if (syncing) value.classList.add('live')
    const copy = el('div', 'task-copy')
    copy.append(el('strong', '', task.title), el('span', '', count || syncing ? task.hint : 'Nothing to do'))
    const side = el('div', 'task-side')
    const sideText = syncing ? 'Checking for new posts…' : task.side(todoData)
    if (sideText) side.append(el('span', '', sideText))
    side.append(el('span', 'chev', '→'))
    link.append(value, copy, side)
    if (task === PROSPECT_TASK) {
      link.classList.add('hero')
      prospectCard.append(link)
      const progress = modelProgressBar(todoData)
      if (progress) link.append(progress)
    } else {
      tasksEl.append(link)
    }
  }
}

function untilLabel(ms) {
  return new Date(ms).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

function renderSafety() {
  safetyEl.replaceChildren()
  safetyEl.className = 'safety'
  const guard = todoData?.guard
  if (!guard) return
  if (!guard.app) {
    safetyEl.append(el('span', '', 'Instagram actions need the Outreach app. Open it with Start Review.command.'))
    return
  }
  if (guard.blocked) {
    safetyEl.classList.add('stopped')
    safetyEl.append(el('strong', '', `Instagram actions stopped until ${untilLabel(guard.blocked.until)}`))
    safetyEl.append(el('span', '', `Instagram showed a warning${guard.blocked.machine ? ` on ${guard.blocked.machine}` : ''}: ${guard.blocked.reason}. Every computer has stopped all Instagram actions so the account can recover.`))
    return
  }
  if (!guard.loggedIn) {
    safetyEl.classList.add('stopped')
    safetyEl.append(el('strong', '', 'Instagram is not logged in'), el('span', '', 'Log in inside the Instagram panel on the right.'))
    return
  }
  const kinds = guard.kinds
  safetyEl.append(el('span', '', `Instagram today · ${kinds.comment.today} / ${kinds.comment.limit} comments · ${kinds.dm.today} / ${kinds.dm.limit} DMs · ${kinds.voice.today} / ${kinds.voice.limit} voicenotes${kinds.unfollow ? ` · ${kinds.unfollow.today} / ${kinds.unfollow.limit} unfollows` : ''}${kinds.answer ? ` · ${kinds.answer.today + (kinds.answerVoice?.today || 0)} / ${kinds.answer.limit + (kinds.answerVoice?.limit || 0)} replies` : ''}`))
}

function renderSync() {
  syncEl.replaceChildren()
  const status = syncStatus
  if (!status) return
  if (status.running) {
    const total = status.total || 0
    const bar = el('div', 'meter')
    const fill = el('div', 'meter-fill')
    fill.style.width = total ? `${Math.round((status.done / total) * 100)}%` : '4%'
    bar.append(fill)
    const label = total ? `Checking Instagram for new posts · ${number(status.done)} / ${number(total)}` : (status.message || 'Starting the Instagram sync…')
    syncEl.append(el('div', 'sync-line', label), bar)
    syncEl.classList.add('on')
    return
  }
  syncEl.classList.remove('on')
  const line = el('div', 'sync-line')
  const bits = []
  if (status.finishedAt) bits.push(`Instagram checked ${ago(status.finishedAt)}`)
  if (status.unreadable) bits.push(`${status.unreadable} profile${status.unreadable === 1 ? '' : 's'} couldn’t be read`)
  line.append(document.createTextNode(bits.join(' · ') || 'Instagram not checked yet'))
  line.append(button('Sync now', 'link', () => startSync(true)))
  syncEl.append(line)
  if (status.message) syncEl.append(el('div', 'warn', status.message))
}

function renderHomeWarn() {
  homeWarn.replaceChildren()
  for (const text of todoData?.warnings || []) homeWarn.append(el('div', 'warn', text))
}

// ---------- Launch ----------

let launchData = null
let launchTimer = null
const launchTasks = { voice: true, comment: true, relaunch1: true, relaunch2: true, unfollow: true, reply: true }

function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
}

// "Next comment at 7:58 pm", "Resumes tomorrow at 8:00 am". The time is only ever added here.
function waitingLabel(data) {
  const label = data.waitingFor || 'Next action'
  if (!data.nextAt || /^Waiting/.test(label)) return data.nextAt ? label : 'Working…'
  const day = (ms) => new Date(ms).toDateString()
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const when = day(data.nextAt) === day(Date.now()) ? ''
    : day(data.nextAt) === day(tomorrow.getTime()) ? 'tomorrow '
    : `${new Date(data.nextAt).toLocaleDateString('en-AU', { weekday: 'long' })} `
  return `${label} ${when}at ${timeLabel(data.nextAt)}`
}

function launchPlan(data) {
  const { counts, left, windowStart, windowEnd, now } = data.preview
  const dmWanted = (launchTasks.relaunch1 ? counts.relaunch1 : 0) + (launchTasks.relaunch2 ? counts.relaunch2 : 0)
  const first = launchTasks.relaunch1 ? Math.min(counts.relaunch1, left ? left.relaunch1 : 20) : 0
  const second = launchTasks.relaunch2 ? Math.min(counts.relaunch2, left ? left.relaunch2 : 10) : 0
  const today = {
    voice: launchTasks.voice ? Math.min(counts.voice, left ? left.voice : counts.voice) : 0,
    comment: launchTasks.comment ? Math.min(counts.comment, left ? left.comment : counts.comment) : 0,
    dm: Math.min(first + second, left ? left.dm : first + second),
    unfollow: launchTasks.unfollow ? Math.min(counts.unfollow || 0, left ? left.unfollow : 20) : 0,
  }
  const total = today.voice + today.comment + today.dm + today.unfollow
  const startAt = Math.max(now, windowStart)
  const minutes = total ? Math.round((windowEnd - startAt) / total / 60000) : 0
  return { today, dmWanted, total, startAt, windowEnd, minutes, later: startAt > now + 60000 }
}

function unfollowNote(counts) {
  const declined = counts.unfollowDeclined || 0
  const quiet = (counts.unfollow || 0) - declined
  const parts = []
  if (quiet) parts.push(`${number(quiet)} no reply 3 days after the 2nd relaunch`)
  if (declined) parts.push(`${number(declined)} said no`)
  return parts.length ? `${parts.join(', ')} · the chat is checked first` : 'no reply 3 days after the 2nd relaunch, or said no'
}

// Reply relaunches (ongoing conversations that went quiet): how far the checks are.
function repliesNote(replies) {
  if (!replies) return ''
  return `${number(replies.checked)} of ${number(replies.conversations)} Replied chats checked · ${number(replies.waitingOnThem)} waiting on them · ${number(replies.sentToday)} / ${number(replies.limit)} reply relaunches today`
}

function launchCheckbox(key, label, count, extra) {
  const row = el('label', 'launch-task')
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = launchTasks[key]
  box.addEventListener('change', () => {
    launchTasks[key] = box.checked
    renderLaunch()
  })
  row.append(box, el('span', 'launch-count', number(count)), el('span', '', label))
  if (extra) row.append(el('span', 'launch-extra', extra))
  return row
}

function renderLaunch() {
  launchEl.replaceChildren()
  const data = launchData
  if (!data) return
  const card = el('div', 'launch-card')
  launchEl.append(card)
  if (data.running) {
    card.classList.add('on')
    const head = el('div', 'launch-head')
    head.append(el('span', 'launch-pill', 'Running'), el('strong', '', data.current || waitingLabel(data)))
    card.append(head)
    card.append(el('p', 'launch-line', `Sent so far: ${data.sent.voice} voicenotes · ${data.sent.comment} comments · ${data.sent.dm} relaunches · ${data.sent.unfollow || 0} unfollows. Runs until ${data.window.endHour}:00, then continues tomorrow.`))
    const replies = repliesNote(data.preview?.replies)
    if (replies) card.append(el('p', 'launch-line', `Quiet conversations: ${replies}`))
    const stop = button('Stop', 'ghost small', async () => {
      stop.disabled = true
      launchData = { ...launchData, ...(await api('/api/autopilot/stop', {}).catch(() => ({}))) }
      renderLaunch()
    })
    card.append(stop)
  } else {
    const plan = launchPlan(data)
    const counts = data.preview.counts
    const head = el('div', 'launch-head')
    head.append(el('strong', '', 'Launch the daily tasks'))
    card.append(head)
    if (data.stopReason) card.append(el('p', `launch-line ${data.events[0]?.tone === 'bad' ? 'bad' : ''}`, data.stopReason))
    const list = el('div', 'launch-tasks')
    list.append(
      launchCheckbox('voice', 'voicenotes', counts.voice),
      launchCheckbox('comment', 'picked comments, each with a like', counts.comment, counts.comment ? '' : 'pick them in Hustling'),
      launchCheckbox('relaunch1', 'relaunches', counts.relaunch1),
      launchCheckbox('relaunch2', '2nd relaunches', counts.relaunch2),
      launchCheckbox('unfollow', 'unfollows', counts.unfollow || 0, unfollowNote(counts)),
      launchCheckbox('reply', 'quiet conversations to check (reply relaunches)', counts.reply || 0, repliesNote(data.preview.replies)),
    )
    card.append(list)
    let summary = 'Nothing to send right now.'
    if (plan.total) {
      const when = plan.later ? `from ${timeLabel(plan.startAt)}` : 'from now'
      summary = `Today: ${plan.today.voice} voicenotes, ${plan.today.comment} comments, ${plan.today.dm} relaunch DMs, ${plan.today.unfollow} unfollows, spread ${when} until ${timeLabel(plan.windowEnd)}, about one every ${plan.minutes} min.`
      if ((counts.unfollow || 0) > plan.today.unfollow && launchTasks.unfollow) summary += ` Unfollows go out at most 40 a day; the other ${number(counts.unfollow - plan.today.unfollow)} follow on the next days.`
      if (plan.dmWanted > plan.today.dm) summary += ` Relaunches go out at 30 first and 30 second relaunches a day, so the other ${number(plan.dmWanted - plan.today.dm)} follow on the next days.`
    }
    card.append(el('p', 'launch-line', summary))
    const blocked = data.guard?.blocked || !data.guard?.app || !data.guard?.loggedIn
    const go = button('Launch', 'launch-go', async () => {
      go.disabled = true
      launchData = { ...launchData, ...(await api('/api/autopilot/start', { tasks: launchTasks }).catch((error) => ({ stopReason: error.message }))) }
      renderLaunch()
      pollLaunch()
    })
    go.disabled = !plan.total || blocked
    card.append(go)
  }
  if (data.events?.length) {
    const events = el('div', 'launch-events')
    for (const item of data.events.slice(0, 5)) {
      events.append(el('div', `launch-event ${item.tone || ''}`, `${timeLabel(item.at)} · ${item.text}`))
    }
    card.append(events)
  }
}

// Keeps the To do page live for both computers: Launch, the "Instagram today" line, and the
// Prospecting card's yes today / profiles left.
async function pollLaunch() {
  clearTimeout(launchTimer)
  try {
    const [autopilot, latest, scraper] = await Promise.all([api('/api/autopilot', null, 30000), api('/api/counts', null, 15000), api('/api/scraper', null, 10000).catch(() => null)])
    launchData = autopilot
    // The scraper card follows the scraper live.
    if (todoData && scraper && JSON.stringify(scraper) !== JSON.stringify(todoData.scraper)) {
      todoData.scraper = scraper
      if (route === 'home') renderScraper()
    }
    if (todoData) {
      todoData.guard = autopilot.guard
      todoData.prospecting = { ...todoData.prospecting, ...(latest.model || {}), remaining: latest.remaining, yesToday: latest.yesToday, yesTarget: latest.yesTarget }
    }
    if (route === 'home') {
      renderLaunch()
      renderSafety()
      renderTasks()
      renderHomeWarn()
    }
  } catch {}
  if (route === 'home') launchTimer = setTimeout(pollLaunch, 5000)
}

// A failed load (server busy or restarting) shows "Reconnecting" and retries on its own; the
// message disappears as soon as the server answers again.
let todoRetry = null
async function loadTodo(refresh) {
  clearTimeout(todoRetry)
  try {
    todoData = await api(`/api/todo${refresh ? '?refresh=1' : ''}`, null, 60000)
    syncStatus = todoData.hustle
  } catch (error) {
    homeWarn.replaceChildren(el('div', 'warn', error.kind === 'network' ? 'Reconnecting to Outreach…' : (error.message || 'Could not load the to do list.')))
    if (route === 'home') todoRetry = setTimeout(() => loadTodo(refresh), 5000)
    return
  }
  if (route !== 'home') return
  renderTasks()
  renderSync()
  renderSafety()
  renderHomeWarn()
  if (syncStatus.running) pollSync()
}

async function startSync(force) {
  try {
    syncStatus = await api('/api/hustle/sync', { force: Boolean(force) })
  } catch {
    return
  }
  if (route === 'home') {
    renderSync()
    renderTasks()
  }
  pollSync()
}

function pollSync() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(async () => {
    try {
      const wasRunning = syncStatus?.running
      syncStatus = await api('/api/hustle/status')
      if (todoData) todoData.hustle = syncStatus
      if (route === 'home') {
        renderSync()
        renderTasks()
      }
      if (syncStatus.running) pollSync()
      else if (wasRunning && route === 'home') loadTodo(false)
    } catch {
      pollSync()
    }
  }, 1500)
}

// ---------- API costs card ----------
// Built once, at its final size, the moment the page loads (with shimmering placeholders), then
// filled in place: values fade in, bars grow from the bottom, and later updates glide to the new
// heights. Nothing is ever re-created, so the page never jumps.

const usageEl = document.getElementById('usage')
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const requestCount = new Intl.NumberFormat('en-US')
const USAGE_DAYS = 28
let usageTimer = null

function money(value) {
  if (!Number.isFinite(value)) return '—'
  if (value > 0 && value < 0.005) return '<$0.01'
  return usd.format(value)
}

function niceMax(value) {
  if (value <= 0) return 0.1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  return [1, 2, 2.5, 5, 10].map((step) => step * magnitude).find((step) => step >= value)
}

function localDayString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dayLabel(day, style = 'short') {
  const date = new Date(`${day}T00:00:00`)
  return style === 'long'
    ? date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
    : date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}

// Gemini and OpenAI lines for a day or a total ({ gemini, openai }).
function providerLines(part) {
  const box = el('div', 'usage-tip-split')
  // Anything not marked OpenAI is Gemini (so a total never shows as $0.00 on both).
  const openai = Number(part.openai) || 0
  const values = { openai, gemini: Number.isFinite(part.gemini) ? part.gemini : Math.max(0, (part.usd || 0) - openai) }
  for (const [name, key] of [['Gemini', 'gemini'], ['OpenAI', 'openai']]) {
    const line = el('div', 'usage-tip-line')
    line.append(el('i', key), el('span', '', name), el('b', '', money(values[key])))
    box.append(line)
  }
  return box
}

const usageCard = (() => {
  usageEl.classList.add('loading')
  const value = (className) => el('span', `${className} usage-value`, '')
  const today = value('usage-today')
  const week = value('usage-stat-value')
  const month = value('usage-stat-value')
  const head = el('div', 'usage-head')
  const primary = el('div', 'usage-primary')
  primary.append(el('span', 'usage-label', 'API costs today'), today)
  const stat = (label, node) => {
    const box = el('div', 'usage-stat')
    box.append(el('span', 'usage-stat-label', label), node)
    return box
  }
  const side = el('div', 'usage-side')
  side.append(stat('This week', week), el('span', 'usage-divider'), stat('This month', month))
  head.append(primary, side)
  // Hovering a total shows where it comes from: Gemini and OpenAI.
  const headTip = el('div', 'usage-tip usage-head-tip')
  headTip.hidden = true
  let split = null
  const hoverable = [[primary, 'today', 'Today'], [side.children[0], 'week', 'This week'], [side.children[2], 'month', 'This month']]
  for (const [node, key, label] of hoverable) {
    node.classList.add('usage-hoverable')
    node.tabIndex = 0
    const show = () => {
      if (!split) return
      const part = split[key]
      headTip.replaceChildren(el('div', 'usage-tip-date', label), el('div', 'usage-tip-value', money(part.usd)), providerLines(part))
      headTip.hidden = false
      const box = node.getBoundingClientRect()
      const area = usageEl.getBoundingClientRect()
      headTip.style.top = `${box.bottom - area.top + 6}px`
      if (key === 'today') {
        headTip.style.right = ''
        headTip.style.left = `${box.left - area.left}px`
      } else {
        headTip.style.left = ''
        headTip.style.right = `${area.right - box.right}px`
      }
    }
    const hide = () => { headTip.hidden = true }
    node.addEventListener('mouseenter', show)
    node.addEventListener('focus', show)
    node.addEventListener('mouseleave', hide)
    node.addEventListener('blur', hide)
  }

  const chart = el('div', 'usage-chart')
  const plot = el('div', 'usage-plot')
  const gridLabels = [1, 0.5, 0].map((fraction) => {
    const line = el('div', 'usage-grid')
    line.style.bottom = `${fraction * 100}%`
    const label = el('span', 'usage-grid-label', '')
    line.append(label)
    plot.append(line)
    return { fraction, label }
  })
  const bars = el('div', 'usage-bars')
  const tip = el('div', 'usage-tip')
  tip.hidden = true
  const columns = []
  let days = []
  let hovered = -1

  const now = new Date()
  const axis = el('div', 'usage-axis')
  for (let index = 0; index < USAGE_DAYS; index++) {
    const date = new Date(now)
    date.setDate(now.getDate() - (USAGE_DAYS - 1 - index))
    const column = el('div', `usage-col${index === USAGE_DAYS - 1 ? ' today' : ''}`)
    column.tabIndex = 0
    column.setAttribute('role', 'img')
    const bar = el('div', 'usage-bar')
    // Placeholder heights while loading, gently varied so the shimmer reads as a chart.
    bar.style.height = `${12 + ((index * 37) % 23)}%`
    bar.style.transitionDelay = `${index * 14}ms`
    // The OpenAI share, stacked on top of Gemini's.
    const top = el('div', 'usage-bar-openai')
    top.style.height = '0%'
    bar.append(top)
    column.append(bar)
    column.addEventListener('mouseenter', () => showTip(index))
    column.addEventListener('focus', () => showTip(index))
    column.addEventListener('mouseleave', hideTip)
    column.addEventListener('blur', hideTip)
    bars.append(column)
    columns.push({ column, bar, top })
    axis.append(el('span', '', index === USAGE_DAYS - 1 ? 'Today' : index % 7 === 0 ? dayLabel(localDayString(date)) : ''))
  }
  plot.append(bars)
  chart.append(plot, axis, tip)
  const note = el('p', 'usage-note', '')
  usageEl.replaceChildren(head, chart, note, headTip)

  function showTip(index) {
    const day = days[index]
    if (!day) return
    hovered = index
    tip.replaceChildren(el('div', 'usage-tip-date', dayLabel(day.day, 'long')), el('div', 'usage-tip-value', money(day.usd)), providerLines(day))
    const source = day.billed && day.tracked ? 'Google billing, plus the latest hours tracked live'
      : day.billed ? 'From Google billing'
      : day.tracked ? 'Tracked live by Outreach'
      : billingConnected ? 'No spend' : 'Before Outreach tracked calls; appears once Google billing is connected'
    tip.append(el('div', 'usage-tip-meta', source))
    if (day.requests != null) tip.append(el('div', 'usage-tip-meta', `${requestCount.format(day.requests)} API requests`))
    tip.hidden = false
    for (const [other, { column }] of columns.entries()) column.classList.toggle('hover', other === index)
    const box = columns[index].column.getBoundingClientRect()
    const area = chart.getBoundingClientRect()
    const center = box.left - area.left + box.width / 2
    if (center > area.width / 2) {
      tip.style.left = ''
      tip.style.right = `${area.width - center + box.width / 2 + 8}px`
    } else {
      tip.style.right = ''
      tip.style.left = `${center + box.width / 2 + 8}px`
    }
  }

  function hideTip() {
    hovered = -1
    tip.hidden = true
    for (const { column } of columns) column.classList.remove('hover')
  }

  let billingConnected = false

  function update(data) {
    days = (data.days || []).slice(-USAGE_DAYS)
    split = data.split || null
    billingConnected = Boolean(data.billing?.connected)
    today.textContent = money(data.today)
    week.textContent = money(data.week)
    month.textContent = money(data.month)
    const top = niceMax(Math.max(0, ...days.map((day) => day.usd)))
    for (const { fraction, label } of gridLabels) label.textContent = money(top * fraction)
    days.forEach((day, index) => {
      const slot = columns[index]
      if (!slot) return
      slot.bar.style.height = day.usd > 0 ? `max(3px, ${(day.usd / top) * 100}%)` : '0%'
      slot.top.style.height = day.usd > 0 && day.openai > 0 ? `max(2px, ${(day.openai / day.usd) * 100}%)` : '0%'
      slot.column.setAttribute('aria-label', `${dayLabel(day.day, 'long')}: ${money(day.usd)} (Gemini ${money(day.gemini || 0)}, OpenAI ${money(day.openai || 0)})`)
    })
    const since = billingConnected ? 'from Google billing' : 'Google billing not connected yet, so days before tracking show only live-tracked spend'
    const legend = (name, className) => {
      const item = el('span', 'usage-legend')
      item.append(el('i', className), document.createTextNode(name))
      return item
    }
    note.replaceChildren(el('span', 'usage-live', 'Live'), legend('Gemini', 'gemini'), legend('OpenAI', 'openai'), document.createTextNode(`· ${data.computers > 1 ? 'both Macs' : 'this Mac'} · ${since}`))
    if (usageEl.classList.contains('loading')) {
      usageEl.classList.remove('loading')
      // After the first fill, updates move without the stagger.
      setTimeout(() => { for (const { bar } of columns) bar.style.transitionDelay = '0ms' }, 1200)
    }
    if (hovered >= 0) showTip(hovered)
  }

  return { update }
})()

async function pollUsage() {
  clearTimeout(usageTimer)
  try {
    usageCard.update(await api('/api/usage-cost', null, 30000))
  } catch {}
  if (route === 'home') usageTimer = setTimeout(pollUsage, 15000)
}

function openHome() {
  pollUsage()
  pollLaunch()
  todayEl.textContent = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })
  renderTasks()
  renderSync()
  loadTodo(false).then(() => loadTodo(true))
}

// ---------- Shared task screen shell ----------

function shell({ kicker, title, meta, corner }) {
  const header = el('header')
  header.append(backLink())
  const top = el('div', 'top-row')
  const who = el('div', 'who')
  who.append(el('div', 'kicker', kicker || ''))
  who.append(el('h1', '', title || ''))
  if (meta) who.append(el('p', 'meta', meta))
  const cornerEl = el('div', 'status task-corner')
  if (corner) for (const line of [].concat(corner)) cornerEl.append(line instanceof Node ? line : el('div', '', line))
  top.append(who, cornerEl)
  header.append(top)
  const main = el('main', 'task-main')
  const footer = el('footer')
  viewTask.replaceChildren(header, main, footer)
  return { header, main, footer, who, corner: cornerEl }
}

function emptyState(main, footer, title, text) {
  const box = el('div', 'empty')
  box.append(el('h2', '', title), el('p', '', text))
  main.append(box)
  const actions = el('div', 'actions')
  const home = el('a', 'primary-link', 'Back to To do')
  home.href = '#/'
  actions.append(home)
  footer.append(actions)
}

// ---------- Pick predictor ----------

// Light green (unlikely) to deep green (likely), by each comment's share of the most likely one. The
// light end still clears 2:1 against the white surface (checked with the dataviz palette validator).
const LOW = [150, 182, 88]
const HIGH = [61, 110, 0]
function chanceColor(value, top) {
  const t = top ? Math.min(1, value / top) : 0
  return `rgb(${LOW.map((low, index) => Math.round(low + (HIGH[index] - low) * t)).join(',')})`
}

function pendingChance() {
  const chance = el('span', 'option-chance pending')
  chance.title = 'Predicting how likely you are to pick this one…'
  const meter = el('span', 'option-meter')
  meter.append(el('i', ''))
  chance.append(meter, el('span', 'option-chance-value', '…'))
  return chance
}

// Each option shows its own chance, the most likely one highlighted.
function markChances(options, percent) {
  const top = Math.max(...percent)
  options.forEach((option, index) => {
    option.querySelector('.option-chance')?.remove()
    const chance = el('span', 'option-chance')
    const meter = el('span', 'option-meter')
    const fill = el('i', '')
    fill.style.width = `${percent[index]}%`
    fill.style.background = chanceColor(percent[index], top)
    meter.append(fill)
    chance.title = `${percent[index]}% likely you pick this one`
    chance.append(meter, el('span', 'option-chance-value', `${percent[index]}%`))
    option.append(chance)
    if (percent[index] === top) option.classList.add('likely')
  })
}

// What the comments are based on: the whole reel (and what is said in it), every carousel slide, or the photo.
function postRead(drafted) {
  const box = el('div', 'post-read')
  const what = drafted.format === 'video' ? `Reel · watched in full${drafted.transcript ? ', with what they say' : ''}`
    : drafted.format === 'carousel' ? `Carousel · all ${drafted.slides} slides`
    : 'Photo'
  box.append(el('div', 'post-format', what))
  if (drafted.readNote) box.append(el('p', 'warn post-note', drafted.readNote))
  if (drafted.description) box.append(el('p', 'post-description', drafted.description))
  if (drafted.transcript) {
    const said = document.createElement('details')
    said.className = 'post-transcript'
    said.append(el('summary', '', 'What they say'), el('p', '', drafted.transcript))
    box.append(said)
  }
  return box
}

function postCard(image, full, caption, alt) {
  const card = el('div', 'post-card')
  if (image) {
    const holder = button('', 'post-image')
    const img = document.createElement('img')
    img.alt = alt || ''
    img.src = mediaUrl(image)
    holder.append(img)
    holder.addEventListener('click', () => openZoom(mediaUrl(full || image), alt, img.src))
    card.append(holder)
  }
  if (caption) card.append(el('p', 'post-caption', caption))
  return card
}

// ---------- Hustling ----------

const DAILY_COMMENTS = 50
const REWRITE_CHIPS = ['Shorter', 'More casual', 'More specific', 'Funnier', 'Add emojis']

function hustleScreen() {
  let queue = []
  let index = 0
  let busy = false
  let note = ''
  let left = false
  let picked = 0
  let lastPick = null
  const draftCache = new Map()
  const scoreCache = new Map()

  // Training data: every round of 5 suggestions and what was done with it goes to the
  // "HUSTLING Training Data" tab. A round starts when its comments appear on screen.
  function track(item, outcome, extra = {}) {
    const drafted = item.drafted || {}
    const seconds = item.shownAt ? (Date.now() - item.shownAt) / 1000 : ''
    fetch('/api/hustle/training', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        username: item.username,
        name: drafted.name || item.name,
        followers: drafted.followers || item.followers,
        bio: drafted.bio || item.notes || '',
        pk: drafted.pk || item.latest?.pk || '',
        code: drafted.code || item.latest?.code || '',
        caption: drafted.caption || '',
        description: drafted.description || '',
        transcript: drafted.transcript || '',
        format: drafted.format || '',
        predicted: scoreCache.get(scoreKey(drafted))?.done || null,
        judge: scoreCache.get(scoreKey(drafted))?.judge || null,
        round: item.round || 1,
        guidance: item.roundGuidance || '',
        comments: drafted.comments || [],
        outcome,
        seconds,
        ...extra,
      }),
    }).catch(() => {})
  }

  function shown(item) {
    if (!item.shownAt) item.shownAt = Date.now()
  }
  const saving = new Map()

  function draftsFor(item) {
    if (!draftCache.has(item.username)) {
      const promise = api('/api/comment-drafts', { username: item.username }, 300000)
      promise.catch(() => draftCache.delete(item.username))
      draftCache.set(item.username, promise)
    }
    return draftCache.get(item.username)
  }

  // Drafting takes a few seconds, so the next three creators are always being prepared, photos
  // and pick predictions included.
  function prefetch() {
    for (const next of queue.slice(index + 1, index + 4)) {
      draftsFor(next).then((drafted) => {
        new Image().src = mediaUrl(drafted.image)
        scoresFor(drafted).catch(() => {})
      }).catch(() => {})
    }
  }

  const scoreKey = (drafted) => (drafted.comments || []).join('\n')

  // The pick model's chance (whole percent, adding to 100) for each of the 5 comments shown. Usually
  // it came back with the comments; otherwise it is asked for.
  function scoresFor(drafted) {
    const key = scoreKey(drafted)
    if (!scoreCache.has(key) && Array.isArray(drafted.scores) && drafted.scores.length === 5) {
      scoreCache.set(key, { done: drafted.scores, judge: drafted.judge || null, promise: Promise.resolve({ percent: drafted.scores, judge: drafted.judge }) })
    }
    if (!scoreCache.has(key)) {
      const entry = {}
      entry.promise = api('/api/comment-scores', {
        comments: drafted.comments,
        description: drafted.description || '',
        caption: drafted.caption || '',
        transcript: drafted.transcript || '',
      }, 90000).then((result) => {
        entry.done = result.percent
        entry.judge = result.judge || null
        return result
      })
      entry.promise.catch(() => scoreCache.delete(key))
      scoreCache.set(key, entry)
    }
    return scoreCache.get(key).promise
  }

  // Five fresh options for the same post: text only, reusing the description and transcript, so it is quick.
  // The photo and current options stay on screen meanwhile. Avoids everything already rejected.
  async function reload(item, guidance = '') {
    if (busy || !item.drafted || item.rewriting) return
    const drafted = item.drafted
    track(item, 'reloaded')
    item.rejected = [...(item.rejected || []), ...drafted.comments]
    item.guidance = guidance.trim()
    item.round = (item.round || 1) + 1
    item.roundGuidance = item.guidance
    item.shownAt = 0
    item.rewriting = true
    showRewriting(item)
    try {
      const result = await api('/api/comment-rewrite', {
        username: item.username,
        name: item.name,
        bio: item.notes || '',
        caption: drafted.caption,
        description: drafted.description,
        transcript: drafted.transcript || '',
        avoid: item.rejected,
        guidance: item.guidance,
      }, 60000)
      item.drafted = { ...drafted, comments: result.comments, scores: result.scores || null, judge: result.judge || null }
      shown(item)
      draftCache.set(item.username, Promise.resolve(item.drafted))
    } catch (error) {
      note = error.message || 'Could not write new comments.'
    }
    item.rewriting = false
    if (queue[index] === item) render()
  }

  function showRewriting(item) {
    const picker = viewTask.querySelector('.picker')
    if (!picker || queue[index] !== item) return
    picker.classList.add('rewriting')
    for (const node of picker.querySelectorAll('button, input')) node.disabled = true
    const status = picker.querySelector('.rewrite-status')
    if (status) status.textContent = item.guidance ? `Writing 5 new ones: ${item.guidance}…` : 'Writing 5 new ones…'
  }

  function advance(removeCurrent) {
    if (removeCurrent) queue.splice(index, 1)
    else index++
    if (index >= queue.length) index = 0
    busy = false
    render()
  }

  function render() {
    if (left) return
    const item = queue[index]
    const corner = [`${picked} / ${DAILY_COMMENTS} picked`]
    if (note) corner.push(note)
    // Auto-commenting: the pick model picks the top comment on its own; one click stops it.
    const auto = todoData?.hustle?.auto
    if (auto?.on) {
      const until = auto.always ? 'on' : auto.until ? `until ${new Date(auto.until).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : `for ${auto.hours} h from its first pick (after the ${auto.waiting} picks waiting)`
      const stop = button(`Auto-commenting ${until} · ${auto.pickedToday} picked today · Stop`, 'ghost', async () => {
        await api('/api/hustle/auto', { hours: 0 }).catch(() => {})
        if (todoData?.hustle?.auto) todoData.hustle.auto.on = false
        render()
      })
      corner.push(stop)
    }
    const parts = shell({
      kicker: item ? `Hustling · ${index + 1} of ${queue.length}` : 'Hustling',
      title: item ? item.name : (picked ? `${picked} comments picked` : 'All caught up'),
      meta: item ? [`@${item.username}`, item.followers && `${item.followers} followers`, item.latest?.at && `posted ${ago(item.latest.at)}`].filter(Boolean).join(' · ') : '',
      corner,
    })
    if (!item) {
      emptyState(parts.main, parts.footer, picked ? 'Ready to launch' : 'No new posts to comment on', picked
        ? 'Go back to To do and press Launch. Comments are posted with a like, spread out over the day.'
        : 'Creators show up here when they post something new after your last comment. The list updates every time the app loads.')
      return
    }
    if (item.notes) parts.who.append(el('p', 'notes', item.notes))
    const layout = el('div', 'split')
    const postSide = el('div', 'split-left')
    const right = el('div', 'split-right')
    layout.append(postSide, right)
    parts.main.append(layout)
    postSide.append(el('div', 'post-card loading-card'))
    right.append(el('p', 'saved-lead', 'Reading the newest post and writing 5 comments…'))

    const footerRow = el('div', 'actions')
    footerRow.append(button('Skip this post', 'ghost', () => skipCurrent(item)), button('Later', 'ghost', () => later(item)))
    if (lastPick) footerRow.append(button('Undo last pick', 'ghost', undoPick))
    parts.footer.append(footerRow)
    const sub = el('div', 'sub')
    const open = el('a', '', 'Open on Instagram')
    open.href = `https://www.instagram.com/${item.username}/`
    open.target = '_blank'
    open.rel = 'noreferrer'
    sub.append(el('span', '', '1–5 pick · R 5 new ones · S skip · → later · Esc to do'), open)
    parts.footer.append(sub)

    draftsFor(item)
      .then((drafted) => {
        if (left || queue[index] !== item) return
        item.drafted = drafted
        shown(item)
        postSide.replaceChildren(postCard(drafted.image, drafted.full, drafted.caption, drafted.description))
        right.replaceChildren(commentPicker(item, drafted))
        prefetch()
      })
      .catch((error) => {
        if (left || queue[index] !== item) return
        // The other computer has this creator, or the post is already done: move on.
        if (error.kind === 'taken') {
          note = error.message
          queue.splice(index, 1)
          if (index >= queue.length) index = 0
          render()
          return
        }
        postSide.replaceChildren()
        const box = el('div', 'problem-box')
        box.append(el('p', 'warn', error.message || 'Could not draft comments.'))
        box.append(button('Try again', 'ghost small', () => render()))
        right.replaceChildren(box)
      })
  }

  function commentPicker(item, drafted) {
    const wrap = el('div', 'picker')
    wrap.append(postRead(drafted))
    wrap.append(el('div', 'section-label', 'Pick one · Launch posts it later, with a like'))
    const options = drafted.comments.map((text, position) => {
      const option = button('', 'comment-option', () => choose(item, drafted, text, option))
      option.append(el('span', 'option-key', String(position + 1)), el('span', 'option-text', text))
      option.dataset.text = text
      wrap.append(option)
      return option
    })
    // Each option shows its chance right away when it came with the comments; otherwise a loading
    // meter until the pick predictor answers.
    const scoring = scoresFor(drafted)
    const cached = scoreCache.get(scoreKey(drafted))?.done
    if (cached) markChances(options, cached)
    else {
      for (const option of options) option.append(pendingChance())
      scoring
        .then((result) => {
          if (!wrap.isConnected) return
          if (result.percent) markChances(options, result.percent)
          else for (const node of wrap.querySelectorAll('.option-chance.pending')) node.remove()
        })
        .catch(() => { for (const node of wrap.querySelectorAll('.option-chance.pending')) node.remove() })
    }
    const own = el('form', 'own-comment')
    const input = document.createElement('input')
    input.type = 'text'
    input.maxLength = 300
    input.placeholder = 'Or write your own and press Enter'
    own.append(input)
    own.addEventListener('submit', (event) => {
      event.preventDefault()
      const text = input.value.trim()
      if (text) choose(item, drafted, text, null)
    })
    wrap.append(own, rewriteBox(item))
    return wrap
  }

  // "Not feeling these?": one button for 5 new ones as they are, chips to push them a direction, or
  // a line of your own.
  function rewriteBox(item) {
    const box = el('div', 'rewrite')
    const head = el('div', 'rewrite-head')
    head.append(el('span', 'rewrite-title', 'Not feeling these?'), button('↻ 5 new ones', 'rewrite-new', () => reload(item)))
    const chips = el('div', 'rewrite-chips')
    chips.append(el('span', 'rewrite-label', 'Or make them'))
    for (const label of REWRITE_CHIPS) {
      chips.append(button(label, item.guidance === label.toLowerCase() ? 'chip on' : 'chip', () => reload(item, label.toLowerCase())))
    }
    const form = el('form', 'rewrite-field')
    const input = document.createElement('input')
    input.type = 'text'
    input.maxLength = 200
    input.placeholder = 'Or describe what you want, e.g. mention their race'
    if (item.guidance && !REWRITE_CHIPS.some((label) => label.toLowerCase() === item.guidance)) input.value = item.guidance
    const go = el('button', 'rewrite-go', 'Rewrite')
    go.type = 'submit'
    form.append(input, go)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      reload(item, input.value)
    })
    box.append(head, chips, form, el('div', 'rewrite-status'))
    return box
  }

  // Saves in the background so the next creator shows instantly. Retries quietly; if it really fails,
  // the creator comes back into the list with a note, so no pick is ever lost silently.
  async function savePick(item, drafted, text) {
    const body = { username: item.username, pk: drafted.pk, code: drafted.code, text }
    for (let attempt = 0; ; attempt++) {
      try {
        return await api('/api/hustle/pick', body)
      } catch (error) {
        if (error.kind === 'taken' || attempt >= 3) throw error
        await wait(1000 * (attempt + 1))
      }
    }
  }

  function later(item) {
    if (item.drafted) track(item, 'later')
    item.shownAt = 0
    advance(false)
  }

  function choose(item, drafted, text, option) {
    if (busy) return
    const position = option ? [...viewTask.querySelectorAll('.comment-option')].indexOf(option) + 1 : 0
    track(item, position ? 'picked' : 'own comment', { pickedIndex: position || '', pickedText: text })
    if (option) option.classList.add('sending')
    picked++
    lastPick = { item, pk: drafted.pk, text }
    note = `Picked for @${item.username}`
    const pending = savePick(item, drafted, text)
      .catch((error) => {
        picked = Math.max(0, picked - 1)
        if (lastPick?.item === item) lastPick = null
        if (error.kind !== 'taken') queue.splice(Math.min(index, queue.length), 0, item)
        note = error.kind === 'taken' ? error.message : `The pick for @${item.username} did not save, so they are back in the list.`
        if (!left) render()
        throw error
      })
      .finally(() => saving.delete(item.username))
    saving.set(item.username, pending)
    advance(true)
  }

  async function undoPick() {
    if (busy || !lastPick) return
    busy = true
    const { item, pk } = lastPick
    try {
      await saving.get(item.username)
      await api('/api/hustle/unpick', { username: item.username, pk })
      track(item, 'undo pick', { pickedText: lastPick.text || '' })
      item.shownAt = 0
      picked = Math.max(0, picked - 1)
      lastPick = null
      queue.splice(index, 0, item)
      note = `Pick for @${item.username} undone`
    } catch (error) {
      note = error.message || 'Could not undo.'
    }
    busy = false
    render()
  }

  async function skipCurrent(item) {
    if (busy) return
    busy = true
    const pk = item.drafted?.pk || item.latest?.pk
    try {
      await api('/api/hustle/skip', { username: item.username, pk })
      track(item, 'skipped')
      note = `Skipped @${item.username}’s post`
      advance(true)
    } catch (error) {
      busy = false
      note = error.message || 'Could not skip.'
      render()
    }
  }

  shell({ kicker: 'Hustling', title: 'Loading…' })
  ready.then(() => Promise.all([api('/api/hustle/queue'), api('/api/hustle/picks')])).then(([payload, current]) => {
    queue = payload.queue || []
    picked = (current.picks || []).length
    if (payload.status?.running) note = `Sync still running · ${payload.status.done} / ${payload.status.total} checked`
    render()
  }).catch((error) => {
    const parts = shell({ kicker: 'Hustling', title: 'Could not load' })
    parts.main.append(el('p', 'warn', error.message))
  })

  return {
    leave() { left = true },
    key(key) {
      const item = queue[index]
      if (!item || busy) return
      if (key === 's') skipCurrent(item)
      if (key === 'r') reload(item)
      if (key === 'arrowright') later(item)
      if (/^[1-5]$/.test(key) && item.drafted) {
        const option = viewTask.querySelectorAll('.comment-option')[Number(key) - 1]
        if (option) choose(item, item.drafted, option.dataset.text, option)
      }
    },
  }
}

// ---------- Relaunch ----------

// Relaunches are sent exactly as written, never with a name.
function fillTemplate(template) {
  return String(template || '').replace(/\s*\{first\}/g, '').replace(/^\s+/, '')
}

function relaunchScreen(stage) {
  let queue = []
  let index = 0
  let template = ''
  let label = stage === 2 ? '2nd relaunch' : 'Relaunch'
  let summary = null
  let busy = false
  let note = ''
  let warn = ''
  let editing = false
  let left = false

  function previousLine(item) {
    if (!item.previousDate) return stage === 1 ? 'First message date not on record' : 'Relaunch date not on record'
    const what = stage === 1 ? 'First message' : 'Relaunched'
    return `${what} ${shortDate(item.previousDate)} (${ago(item.previousDate)})`
  }

  function render() {
    if (left) return
    const item = queue[index]
    const corner = []
    if (summary) corner.push(`${summary.sentToday} sent today`)
    if (note) corner.push(note)
    const parts = shell({
      kicker: item ? `${label} · ${index + 1} of ${queue.length}` : label,
      title: item ? item.name : 'All caught up',
      meta: item ? [`@${item.username}`, item.followers && `${item.followers} followers`, item.device].filter(Boolean).join(' · ') : '',
      corner,
    })
    if (warn) parts.corner.append(el('div', 'warn', warn))
    if (!item) {
      const later = summary?.waiting ? ` ${summary.waiting} more will be due from ${shortDate(summary.nextDue)}.` : ''
      emptyState(parts.main, parts.footer, `No ${label.toLowerCase()}s due`, `Nobody is waiting for a ${label.toLowerCase()} right now.${later}`)
      return
    }

    const layout = el('div', 'split')
    const feedSide = el('div', 'split-left')
    const right = el('div', 'split-right')
    layout.append(feedSide, right)
    parts.main.append(layout)

    const card = el('div', 'feed-card small')
    const scroller = el('div', 'preview-scroll')
    card.append(scroller)
    feedSide.append(card)
    scroller.append(skeleton())
    loadProfile(item.username, true)
      .then((profile) => { if (scroller.isConnected) scroller.replaceChildren(feed(profile, item.username)) })
      .catch((error) => { if (scroller.isConnected) scroller.replaceChildren(problem(error.message || 'Could not load this profile.', item.username)) })
    const next = queue[index + 1]
    if (next) loadProfile(next.username, false).then(preloadImages).catch(() => {})

    right.append(el('p', 'launch-note', `Launch sends this automatically. Leave someone out if they shouldn't get a ${label.toLowerCase()}.`))
    const context = el('div', 'context')
    context.append(el('div', 'section-label', 'Last contact'))
    context.append(el('p', 'context-line', previousLine(item)))
    if (item.voice) context.append(el('p', 'context-line muted', `Voicenote · ${item.voice}${item.device ? ` · ${item.device}` : ''}`))
    if (item.message) {
      const original = el('details', 'original')
      original.append(el('summary', '', 'First message they got'), el('p', '', item.message))
      context.append(original)
    }
    if (item.notes) context.append(el('p', 'context-line muted', item.notes))
    right.append(context)

    right.append(el('div', 'section-label', 'Message they will get'))
    right.append(el('p', 'message-preview', item.relaunchText || fillTemplate(template)))
    const templateRow = el('div', 'template-row')
    templateRow.append(button(editing ? 'Close template' : 'Edit template', 'link', () => { editing = !editing; render() }))
    right.append(templateRow)
    if (editing) right.append(templateEditor())

    const actions = el('div', 'actions')
    actions.append(
      button('Leave out', 'ghost', () => leaveOut(item)),
      button('Next', 'ghost', () => { index = (index + 1) % queue.length; note = ''; render() }),
    )
    parts.footer.append(actions)
    const sub = el('div', 'sub')
    sub.append(el('span', '', 'L leave out · → next · Esc to do'))
    const open = el('a', '', 'Open DM on Instagram')
    open.href = `https://ig.me/m/${item.username}`
    open.target = '_blank'
    open.rel = 'noreferrer'
    sub.append(open)
    parts.footer.append(sub)
  }

  function templateEditor() {
    const box = el('div', 'template-box')
    box.append(el('p', 'saved-lead', 'Sent exactly as written to everyone (no names are added). Used for every ' + label.toLowerCase() + ' Launch sends.'))
    const area = document.createElement('textarea')
    area.className = 'message'
    area.rows = 3
    area.value = template
    box.append(area)
    box.append(button('Save template', 'ghost small', async () => {
      try {
        const saved = await api('/api/relaunch/template', { stage, text: area.value })
        template = saved.template
        editing = false
        note = 'Template saved'
        render()
      } catch (error) {
        warn = error.message
        render()
      }
    }))
    return box
  }

  async function leaveOut(item) {
    if (busy) return
    busy = true
    try {
      await api('/api/relaunch/skip', { stage, sheetRow: item.sheetRow })
      queue.splice(index, 1)
      if (index >= queue.length) index = 0
      note = `@${item.username} left out`
    } catch (error) {
      warn = error.message || 'Could not leave them out.'
    }
    busy = false
    render()
  }

  shell({ kicker: label, title: 'Loading…' })
  ready.then(() => api(`/api/relaunch?stage=${stage}`, null, 60000)).then((payload) => {
    queue = payload.queue || []
    template = payload.template || ''
    label = payload.label || label
    summary = payload.summary
    if (payload.writeNote) warn = payload.writeNote
    render()
  }).catch((error) => {
    const parts = shell({ kicker: label, title: 'Could not load' })
    parts.main.append(el('p', 'warn', error.message))
  })

  return {
    leave() { left = true },
    key(key) {
      if (busy || !queue.length) return
      if (key === 'l') leaveOut(queue[index])
      if (key === 'arrowright') {
        index = (index + 1) % queue.length
        note = ''
        render()
      }
    },
  }
}

// ---------- Voicenotes ----------

function voiceScreen() {
  let left = false
  let timer = null
  let parts = null
  let nowLine = null

  async function poll() {
    clearTimeout(timer)
    if (left) return
    try {
      const state = await api('/api/voice/status', null, 8000)
      if (nowLine) {
        nowLine.textContent = !state.app ? (state.error || 'Open the Outreach app to send voicenotes.')
          : state.phase && state.phase !== 'idle' ? `Now: ${state.text}` : ''
      }
    } catch {}
    timer = setTimeout(poll, 3000)
  }

  function render(payload) {
    if (left) return
    const people = payload.people || []
    parts = shell({
      kicker: 'Voicenotes',
      title: people.length ? `${people.length} to send` : 'All sent',
      meta: 'Launch sends these: it follows each creator, plays the clip for their device and marks them Pending, spread out over the day.',
      corner: [`${payload.sentToday} / ${payload.limit} sent today`],
    })
    nowLine = el('div', 'guard-line')
    parts.corner.append(nowLine)
    if (!people.length) {
      emptyState(parts.main, parts.footer, 'No voicenotes waiting', 'Mark a profile Yes with a device in Prospecting and it shows up here.')
      return
    }
    const list = el('div', 'list')
    for (const person of people) {
      const row = el('a', 'person')
      row.href = person.link || `https://www.instagram.com/${person.username}/`
      row.target = '_blank'
      row.rel = 'noreferrer'
      const top = el('div', 'person-top')
      top.append(el('strong', '', person.name))
      if (person.device) top.append(el('span', 'pill to-send', person.device))
      row.append(top)
      row.append(el('span', 'line', [`@${person.username}`, person.followers && `${person.followers} followers`].filter(Boolean).join(' · ')))
      list.append(row)
    }
    parts.main.append(list)
    const actions = el('div', 'actions')
    const home = el('a', 'primary-link', 'Back to To do to launch')
    home.href = '#/'
    actions.append(home)
    parts.footer.append(actions)
  }

  shell({ kicker: 'Voicenotes', title: 'Loading…' })
  ready.then(() => api('/api/voice', null, 60000)).then((payload) => {
    render(payload)
    poll()
  }).catch((error) => {
    const failed = shell({ kicker: 'Voicenotes', title: 'Could not load' })
    failed.main.append(el('p', 'warn', error.message))
  })
  return {
    leave() {
      left = true
      clearTimeout(timer)
    },
  }
}

// ---------- Start ----------

startSync(false)
go()

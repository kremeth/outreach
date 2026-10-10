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
    side: (data) => `${number(data.hustle.picked || 0)} picked`,
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
  hint: 'Profiles left to answer Yes or No',
  count: (data) => data.prospecting.remaining,
  side: (data) => `${data.prospecting.yesToday} / ${data.prospecting.yesTarget} yes today`,
}

function renderTasks() {
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
  safetyEl.append(el('span', '', `Instagram today · ${kinds.comment.today} / ${kinds.comment.limit} comments · ${kinds.dm.today} / ${kinds.dm.limit} DMs · ${kinds.voice.today} / ${kinds.voice.limit} voicenotes${kinds.unfollow ? ` · ${kinds.unfollow.today} / ${kinds.unfollow.limit} unfollows` : ''}`))
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
const launchTasks = { voice: true, comment: true, relaunch1: true, relaunch2: true, unfollow: true }

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
    )
    card.append(list)
    let summary = 'Nothing to send right now.'
    if (plan.total) {
      const when = plan.later ? `from ${timeLabel(plan.startAt)}` : 'from now'
      summary = `Today: ${plan.today.voice} voicenotes, ${plan.today.comment} comments, ${plan.today.dm} relaunch DMs, ${plan.today.unfollow} unfollows, spread ${when} until ${timeLabel(plan.windowEnd)}, about one every ${plan.minutes} min.`
      if ((counts.unfollow || 0) > plan.today.unfollow && launchTasks.unfollow) summary += ` Unfollows go out at most 20 a day; the other ${number(counts.unfollow - plan.today.unfollow)} follow on the next days.`
      if (plan.dmWanted > plan.today.dm) summary += ` Relaunches go out at 20 first and 10 second relaunches a day, so the other ${number(plan.dmWanted - plan.today.dm)} follow on the next days.`
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
    const [autopilot, latest] = await Promise.all([api('/api/autopilot', null, 30000), api('/api/counts', null, 15000)])
    launchData = autopilot
    if (todoData) {
      todoData.guard = autopilot.guard
      todoData.prospecting = { ...todoData.prospecting, remaining: latest.remaining, yesToday: latest.yesToday, yesTarget: latest.yesTarget }
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

function openHome() {
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
  if (corner) for (const line of [].concat(corner)) cornerEl.append(el('div', '', line))
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

// ---------- Pick predictor gauge ----------

// Light green (unlikely) to deep green (likely), by each comment's share of the most likely one. The
// light end still clears 2:1 against the white surface (checked with the dataviz palette validator).
const LOW = [150, 182, 88]
const HIGH = [61, 110, 0]
function chanceColor(value, top) {
  const t = top ? Math.min(1, value / top) : 0
  const rgb = LOW.map((low, index) => Math.round(low + (HIGH[index] - low) * t))
  return { background: `rgb(${rgb.join(',')})`, ink: t > 0.7 ? '#ffffff' : 'var(--ink)' }
}

function percentLabel(value) {
  return `${Math.round(value * 100)}%`
}

// One bar, split into the 5 comments' chances (adding to 100), in comment order, with the most
// likely one named above it and how good the model has been underneath.
function pickGauge(percent, model) {
  const top = Math.max(...percent)
  const best = percent.indexOf(top)
  const box = el('div', 'predict')
  const head = el('div', 'predict-head')
  head.append(el('span', 'predict-label', 'Most likely pick'), el('strong', 'predict-top', `#${best + 1}`), el('span', 'predict-top-value', `${top}%`))
  box.append(head)
  const bar = el('div', 'predict-bar')
  bar.setAttribute('role', 'img')
  bar.setAttribute('aria-label', `Chance of each comment being picked: ${percent.map((value, index) => `#${index + 1} ${value}%`).join(', ')}`)
  percent.forEach((value, index) => {
    if (!value) return
    const color = chanceColor(value, top)
    const segment = el('div', `predict-seg${index === best ? ' best' : ''}`)
    segment.style.flex = `${value} 1 0`
    segment.style.background = color.background
    segment.style.color = color.ink
    segment.title = `Comment ${index + 1}: ${value}% likely`
    if (value >= 9) segment.append(el('span', 'predict-seg-key', `#${index + 1}`), el('span', 'predict-seg-value', String(value)))
    else if (value >= 5) segment.append(el('span', 'predict-seg-value', String(value)))
    bar.append(segment)
  })
  box.append(bar)
  const scale = el('div', 'predict-scale')
  scale.append(el('span', '', '0'), el('span', '', '100'))
  box.append(scale)
  box.append(el('p', 'predict-note', modelLine(model)))
  return box
}

function modelLine(model) {
  if (!model?.ready) return ''
  const mine = model.cv?.byMachine?.[model.machine]
  const right = mine?.rounds ? `${percentLabel(mine.correct / mine.rounds)} on your past picks` : percentLabel(model.cv.accuracy)
  return `Right first guess ${right} (random guessing: 20%) · learned from ${model.rounds} rounds · retrains itself as you pick`
}

// Each option shows its own chance, the most likely one highlighted.
function markChances(options, percent) {
  const top = Math.max(...percent)
  options.forEach((option, index) => {
    const chance = el('span', 'option-chance')
    const meter = el('span', 'option-meter')
    const fill = el('i', '')
    fill.style.width = `${percent[index]}%`
    fill.style.background = chanceColor(percent[index], top).background
    meter.append(fill)
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

const DAILY_COMMENTS = 60
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

  // The pick model's chance (whole percent, adding to 100) for each of the 5 comments shown.
  function scoresFor(drafted) {
    const key = scoreKey(drafted)
    if (!scoreCache.has(key)) {
      const entry = {}
      entry.promise = api('/api/comment-scores', {
        comments: drafted.comments,
        description: drafted.description || '',
        caption: drafted.caption || '',
        transcript: drafted.transcript || '',
      }, 90000).then((result) => {
        entry.done = result.percent
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
      item.drafted = { ...drafted, comments: result.comments }
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
    const gauge = el('div', 'predict loading')
    gauge.append(el('div', 'predict-head', 'Predicting your pick…'), el('div', 'predict-bar'))
    wrap.append(gauge)
    wrap.append(el('div', 'section-label', 'Pick one · Launch posts it later, with a like'))
    const options = drafted.comments.map((text, position) => {
      const option = button('', 'comment-option', () => choose(item, drafted, text, option))
      option.append(el('span', 'option-key', String(position + 1)), el('span', 'option-text', text))
      option.dataset.text = text
      wrap.append(option)
      return option
    })
    scoresFor(drafted)
      .then((result) => {
        if (!gauge.isConnected) return
        if (!result.percent) {
          gauge.replaceWith(el('p', 'predict-note', result.model?.ready ? 'No prediction for these.' : 'The pick predictor is still learning (it needs more picks).'))
          return
        }
        gauge.replaceWith(pickGauge(result.percent, result.model))
        markChances(options, result.percent)
      })
      .catch(() => gauge.isConnected && gauge.replaceWith(el('p', 'predict-note', 'The pick predictor did not answer for these.')))
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
    right.append(el('p', 'message-preview', fillTemplate(template)))
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

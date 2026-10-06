const track = document.getElementById('track')
const kicker = document.getElementById('kicker')
const nameEl = document.getElementById('name')
const meta = document.getElementById('meta')
const notes = document.getElementById('notes')
const status = document.getElementById('status')
const loading = document.getElementById('loading')
const saved = document.getElementById('saved')
const question = document.getElementById('q')
const reviewActions = document.getElementById('review-actions')
const savedActions = document.getElementById('saved-actions')
const noButton = document.getElementById('no')
const yesButton = document.getElementById('yes')
const prevButton = document.getElementById('prev')
const reloadButton = document.getElementById('reload')
const externalButton = document.getElementById('external')
const fileButton = document.getElementById('fileline')
const keys = document.getElementById('keys')

let latest = null
let busy = false

function pillClass(ranking) {
  const value = String(ranking || '').toLowerCase()
  if (value === 'good') return 'pill good'
  if (value === 'fair') return 'pill fair'
  return 'pill'
}

function renderMeta(current) {
  meta.replaceChildren()
  const bits = []
  if (current.username) bits.push(`@${current.username}`)
  if (current.followers) bits.push(`${current.followers} followers`)
  if (current.location) bits.push(current.location)
  if (current.engagement) bits.push(current.engagement)
  if (current.email) bits.push(current.email)
  meta.append(document.createTextNode(bits.join(' · ')))
  if (current.ranking) {
    const pill = document.createElement('span')
    pill.className = pillClass(current.ranking)
    pill.textContent = current.ranking
    meta.append(pill)
  }
}

function renderTrack(state) {
  track.replaceChildren()
  state.track.forEach((choice, itemIndex) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'seg'
    if (choice) button.classList.add(choice)
    if (itemIndex === state.index && state.mode === 'review') button.classList.add('current')
    button.title = choice ? `${itemIndex + 1}: ${choice}` : `Open ${itemIndex + 1}`
    button.addEventListener('click', () => jump(itemIndex))
    track.append(button)
  })
}

function renderStatus(state) {
  status.replaceChildren()
  const count = document.createElement('div')
  if (state.allDone) count.textContent = 'All reviewed'
  else count.textContent = `${state.remaining} left`
  status.append(count)

  const openSaved = document.createElement('button')
  openSaved.type = 'button'
  openSaved.textContent = state.yesCount === 1 ? '1 yes' : `${state.yesCount} yes`
  openSaved.addEventListener('click', () => window.review.setMode('saved'))
  status.append(openSaved)

  if (state.needsLogin) {
    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = 'Sign in once. It stays signed in.'
    status.append(hint)
  } else if (state.offProfile) {
    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = 'Not on their profile.'
    status.append(hint)
  }
}

function renderSaved(state) {
  saved.replaceChildren()
  const lead = document.createElement('p')
  lead.className = 'saved-lead'
  if (!state.yesList.length) {
    lead.textContent = 'No yeses yet. They’ll land in voicenote-yes.csv.'
    saved.append(lead)
    return
  }
  lead.textContent = `${state.yesList.length} ${state.yesList.length === 1 ? 'person' : 'people'} to send a voicenote · ${state.yesPath}`
  saved.append(lead)

  for (const person of state.yesList) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'person'
    const title = document.createElement('strong')
    title.textContent = person.name
    const line = document.createElement('span')
    line.className = 'line'
    line.textContent = [person.username ? `@${person.username}` : '', person.followers, person.location]
      .filter(Boolean)
      .join(' · ')
    button.append(title, line)
    if (person.notes) {
      const note = document.createElement('span')
      note.className = 'note'
      note.textContent = person.notes
      button.append(note)
    }
    button.addEventListener('click', () => jump(person.index))
    saved.append(button)
  }
}

function render(state) {
  if (!state) return
  latest = state
  const current = state.current

  renderTrack(state)
  renderStatus(state)
  renderSaved(state)

  question.textContent = state.mode === 'saved' ? 'Saved for voicenotes' : 'Send a voicenote?'
  reviewActions.hidden = state.mode !== 'review'
  savedActions.hidden = state.mode !== 'saved'
  prevButton.hidden = state.mode !== 'review'
  reloadButton.hidden = state.mode !== 'review'
  externalButton.hidden = state.mode !== 'review'
  keys.hidden = state.mode !== 'review'
  saved.hidden = state.mode !== 'saved'
  fileButton.textContent = state.yesCount === 1 ? '1 saved' : `${state.yesCount} saved`

  if (!current) {
    kicker.textContent = 'Voicenote'
    nameEl.textContent = 'No profiles in the sheet'
    meta.replaceChildren()
    notes.textContent = ''
    loading.hidden = false
    loading.textContent = 'The CSV has no rows.'
    return
  }

  kicker.textContent = `Voicenote · ${state.index + 1} of ${state.total}`
  nameEl.textContent = current.name
  renderMeta(current)
  notes.textContent = current.notes
  notes.title = current.notes

  noButton.classList.toggle('picked', state.decision === 'no')
  yesButton.classList.toggle('picked', state.decision === 'yes')
  noButton.disabled = busy
  yesButton.disabled = busy
  prevButton.disabled = state.index === 0

  if (state.mode !== 'review') {
    loading.hidden = true
    return
  }

  if (state.loadError) {
    loading.hidden = false
    loading.textContent = state.loadError
  } else if (!state.profileLoaded) {
    loading.hidden = false
    loading.textContent = 'Loading profile…'
  } else {
    loading.hidden = true
  }
}

async function choose(choice) {
  if (busy || !latest || latest.mode !== 'review') return
  busy = true
  noButton.disabled = true
  yesButton.disabled = true
  try {
    render(await window.review.decide(choice))
  } finally {
    busy = false
    if (latest) {
      noButton.disabled = false
      yesButton.disabled = false
    }
  }
}

async function jump(nextIndex) {
  render(await window.review.jump(nextIndex))
}

noButton.addEventListener('click', () => choose('no'))
yesButton.addEventListener('click', () => choose('yes'))
prevButton.addEventListener('click', () => window.review.prev().then(render))
reloadButton.addEventListener('click', () => window.review.retry().then(render))
externalButton.addEventListener('click', () => window.review.openExternal())
fileButton.addEventListener('click', () => window.review.showYesFile())
document.getElementById('back').addEventListener('click', () => {
  window.review.setMode('review').then(render)
})

window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
  const key = event.key.toLowerCase()
  if (key === 'escape' && latest?.mode === 'saved') {
    window.review.setMode('review').then(render)
    return
  }
  if (!latest || latest.mode !== 'review') return
  if (key === 'y') choose('yes')
  if (key === 'n') choose('no')
})

window.review.onState(render)
window.review.getState().then(render).catch((error) => {
  nameEl.textContent = 'Could not open the sheet'
  notes.textContent = String(error)
})

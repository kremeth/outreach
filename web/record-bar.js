const recordButton = document.getElementById('record')
const cancelButton = document.getElementById('cancel')
const skipButton = document.getElementById('skip')
const retryButton = document.getElementById('retry')
const pauseButton = document.getElementById('pause')
const titleEl = document.getElementById('title')
const statusEl = document.getElementById('status')
const metaEl = document.getElementById('meta')

let phase = 'loading'

function render(status) {
  phase = status.phase
  titleEl.textContent = status.title || 'Voicenote send'
  statusEl.textContent = status.text || ''
  statusEl.title = status.detail || ''
  metaEl.textContent = `${status.sentToday || 0}/${status.dailyLimit || 20} today · ${status.remaining || 0} left`
  const busy = phase === 'starting' || phase === 'sending' || phase === 'preparing' || phase === 'loading'
  const recording = phase === 'recording'
  const waiting = phase === 'waiting'
  const canSend = phase === 'ready'
  const canSkip = !busy && !recording && ['ready', 'error', 'paused', 'waiting'].includes(phase)
  recordButton.disabled = !canSend
  recordButton.classList.toggle('recording', recording)
  recordButton.textContent = recording ? 'Recording…' : waiting ? 'Waiting…' : 'Send now'
  cancelButton.hidden = !recording && phase !== 'starting'
  skipButton.disabled = !canSkip
  retryButton.hidden = !['error', 'blocked'].includes(phase)
  pauseButton.textContent = phase === 'paused' || phase === 'blocked' ? 'Resume' : 'Pause'
  pauseButton.disabled = busy || recording
}

recordButton.addEventListener('click', () => window.recorder.record())
cancelButton.addEventListener('click', () => window.recorder.cancel())
skipButton.addEventListener('click', () => window.recorder.skip())
retryButton.addEventListener('click', () => window.recorder.retry())
pauseButton.addEventListener('click', () => window.recorder.pause())
window.recorder.onStatus(render)

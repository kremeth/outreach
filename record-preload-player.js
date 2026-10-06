const { ipcRenderer } = require('electron')

function watch() {
  const clip = document.getElementById('v')
  if (!clip || clip.dataset.watched) return
  clip.dataset.watched = '1'
  clip.addEventListener('ended', () => ipcRenderer.send('note-ended'))
}

watch()
document.addEventListener('DOMContentLoaded', watch)
window.addEventListener('load', watch)

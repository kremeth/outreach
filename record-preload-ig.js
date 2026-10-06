const { ipcRenderer } = require('electron')
const fs = require('fs')
const path = require('path')

function injectHook() {
  const parent = document.documentElement || document.head
  if (!parent || parent.dataset.voiceHookInjected) return
  const code = fs.readFileSync(path.join(__dirname, 'record-ig-hook.js'), 'utf8')
  const script = document.createElement('script')
  script.textContent = code
  parent.appendChild(script)
  script.remove()
  parent.dataset.voiceHookInjected = '1'
}

function watchVoiceState() {
  const root = document.documentElement
  if (!root) return
  let last = ''
  const publish = () => {
    const state = root.dataset.voiceState || ''
    if (!state || state === last) return
    last = state
    ipcRenderer.send('voice-state', state)
  }
  new MutationObserver(publish).observe(root, {
    attributes: true,
    attributeFilter: ['data-voice-state'],
  })
  publish()
}

injectHook()
watchVoiceState()
document.addEventListener('DOMContentLoaded', () => {
  injectHook()
  watchVoiceState()
})

const { ipcRenderer } = require('electron')

document.addEventListener(
  'keydown',
  (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
    const key = event.key.toLowerCase()
    if (key !== 'y' && key !== 'n') return

    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    const typing = path.some((el) => {
      if (!el || !el.tagName) return false
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
    })
    if (typing) return

    event.preventDefault()
    event.stopPropagation()
    ipcRenderer.send('shortcut', key)
  },
  true,
)

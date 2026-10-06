const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('review', {
  getState: () => ipcRenderer.invoke('get-state'),
  decide: (choice) => ipcRenderer.invoke('decide', choice),
  jump: (index) => ipcRenderer.invoke('jump', index),
  prev: () => ipcRenderer.invoke('prev'),
  retry: () => ipcRenderer.invoke('retry'),
  openExternal: () => ipcRenderer.invoke('open-external'),
  showYesFile: () => ipcRenderer.invoke('show-yes-file'),
  setMode: (mode) => ipcRenderer.invoke('set-mode', mode),
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('state', listener)
  },
})

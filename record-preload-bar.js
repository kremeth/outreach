const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('recorder', {
  record: () => ipcRenderer.invoke('record'),
  cancel: () => ipcRenderer.invoke('cancel'),
  skip: () => ipcRenderer.invoke('skip'),
  retry: () => ipcRenderer.invoke('retry'),
  pause: () => ipcRenderer.invoke('pause'),
  onStatus: (callback) => {
    ipcRenderer.on('status', (_event, status) => callback(status))
  },
})

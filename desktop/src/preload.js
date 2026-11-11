const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freedom', {
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  togglePanel: () => ipcRenderer.send('toggle-panel'),
  collapse: () => ipcRenderer.send('collapse'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  contextMenu: () => ipcRenderer.send('context-menu'),
  setAuto: (on) => ipcRenderer.send('set-auto', on),
  ask: (question) => ipcRenderer.send('ask', question),
  clear: () => ipcRenderer.send('clear'),
  saveSettings: (s) => ipcRenderer.send('save-settings', s),
  quit: () => ipcRenderer.send('quit'),
});

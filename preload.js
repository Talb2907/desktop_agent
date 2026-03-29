const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  run: (message, history) => ipcRenderer.invoke('agent:run', { message, history }),
  confirm: (approved) => ipcRenderer.invoke('agent:confirm', { approved }),
  stop: () => ipcRenderer.invoke('agent:stop'),
  onStep: (callback) => {
    const handler = (_event, step) => callback(step);
    ipcRenderer.on('agent:step', handler);
    return () => ipcRenderer.removeListener('agent:step', handler);
  },
});

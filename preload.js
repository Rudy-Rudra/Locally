const { contextBridge, ipcRenderer } = require('electron');
const call = name => arg => ipcRenderer.invoke(name, arg);
contextBridge.exposeInMainWorld('api', {
  state: call('state'), pick: call('pick'), start: call('start'),
  pause: call('pause'), resume: call('resume'), stop: call('stop'),
  copy: call('copy'), open: call('open'),
  onState: cb => ipcRenderer.on('state', (_e, st) => cb(st)),
});

// Password gate for the lock window. Nothing of the app is loaded until the
// correct password is entered.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lockAPI', {
  submit: (password) => ipcRenderer.invoke('lock:submit', String(password == null ? '' : password)),
  open: () => ipcRenderer.invoke('lock:open')
});

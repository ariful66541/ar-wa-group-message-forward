const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startWhatsApp: () => ipcRenderer.invoke('wa:start'),
  stopWhatsApp: () => ipcRenderer.invoke('wa:stop'),
  waState: () => ipcRenderer.invoke('wa:state'),
  groups: () => ipcRenderer.invoke('wa:groups'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  setCampaign: (id, enabled) => ipcRenderer.invoke('campaign:set', id, enabled),
  sendCampaignNow: (id) => ipcRenderer.invoke('campaign:sendNow', id),

  clearHistory: () => ipcRenderer.invoke('history:clear'),
  resetStats: () => ipcRenderer.invoke('stats:reset'),
  testSend: (text) => ipcRenderer.invoke('test:send', text),

  debugCheck: () => ipcRenderer.invoke('debug:check'),
  openLog: () => ipcRenderer.invoke('open:log'),
  openFolder: () => ipcRenderer.invoke('open:folder'),
  appInfo: () => ipcRenderer.invoke('app:info'),

  on: (channel, cb) => {
    const allowed = ['wa-state', 'log', 'settings', 'history', 'stats', 'tick', 'loading', 'incoming'];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});

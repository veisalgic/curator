const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('docpicker', {
  // Credentials
  getAllCreds: () => ipcRenderer.invoke('creds:get-all'),
  saveCred: (key, value) => ipcRenderer.invoke('creds:save', { key, value }),
  clearTraktAuth: () => ipcRenderer.invoke('creds:clear-trakt'),

  // Trakt
  startTraktOAuth: () => ipcRenderer.invoke('trakt:start-oauth'),
  exchangeTraktCode: (code) => ipcRenderer.invoke('trakt:exchange-code', code),
  fetchTraktHistory: () => ipcRenderer.invoke('trakt:fetch-history'),

  // Claude
  getRecommendation: (prompt) => ipcRenderer.invoke('claude:recommend', { prompt }),
});

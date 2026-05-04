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
  traktLookup: (params) => ipcRenderer.invoke('trakt:lookup', params),
  traktAddWatchlist: (params) => ipcRenderer.invoke('trakt:add-watchlist', params),

  // History
  getHistory: () => ipcRenderer.invoke('history:get'),
  addHistory: (entry) => ipcRenderer.invoke('history:add', entry),
  setFeedback: (params) => ipcRenderer.invoke('history:set-feedback', params),
  setWatchlisted: (params) => ipcRenderer.invoke('history:set-watchlisted', params),

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // Claude
  getRecommendation: (prompt) => ipcRenderer.invoke('claude:recommend', { prompt }),
});

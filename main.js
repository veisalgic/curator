const { app, BrowserWindow, ipcMain, shell, safeStorage, Menu, MenuItem, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

// ── Secure credential storage via safeStorage + encrypted local file ──────────
function credsPath() {
  return path.join(app.getPath('userData'), 'credentials.enc');
}

function loadCredsFile() {
  try {
    const raw = fs.readFileSync(credsPath(), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveCredsFile(data) {
  fs.writeFileSync(credsPath(), JSON.stringify(data), 'utf8');
}

async function storeCredential(key, value) {
  const data = loadCredsFile();
  if (safeStorage.isEncryptionAvailable()) {
    data[key] = safeStorage.encryptString(value).toString('base64');
  } else {
    data[key] = Buffer.from(value).toString('base64');
    data[key + '_plain'] = true;
  }
  saveCredsFile(data);
}

async function getCredential(key) {
  const data = loadCredsFile();
  if (!data[key]) return null;
  try {
    if (data[key + '_plain']) {
      return Buffer.from(data[key], 'base64').toString('utf8');
    }
    return safeStorage.decryptString(Buffer.from(data[key], 'base64'));
  } catch (e) {
    return null;
  }
}

async function deleteCredential(key) {
  const data = loadCredsFile();
  delete data[key];
  delete data[key + '_plain'];
  saveCredsFile(data);
}

// ── Recommendation history (JSON file in userData) ────────────────────────────
function historyPath() {
  return path.join(app.getPath('userData'), 'history.json');
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveHistory(history) {
  fs.writeFileSync(historyPath(), JSON.stringify(history), 'utf8');
}

// ── Trakt OAuth ────────────────────────────────────────────────────────────────
const TRAKT_REDIRECT_PORT = 47821;
const TRAKT_REDIRECT_URI = `http://localhost:${TRAKT_REDIRECT_PORT}/callback`;

const SPOTIFY_REDIRECT_PORT = 47822;
const SPOTIFY_REDIRECT_URI = `http://localhost:${SPOTIFY_REDIRECT_PORT}/callback`;

let oauthServer = null;
let spotifyOAuthServer = null;

function startOAuthServer() {
  return new Promise((resolve, reject) => {
    oauthServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${TRAKT_REDIRECT_PORT}`);
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="background:#0a0a0a;color:#e8e4dc;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center"><div style="font-size:48px;margin-bottom:16px">${error ? '✗' : '✓'}</div><div style="font-size:18px;color:#e8c547">${error ? 'Authorization failed' : 'Authorization successful'}</div><div style="margin-top:12px;color:#666;font-size:13px">${error ? error : 'You can close this window and return to Curator.'}</div></div></body></html>`);
        if (oauthServer) { oauthServer.close(); oauthServer = null; }
        if (code) resolve(code);
        else reject(new Error(error || 'No code returned'));
      }
    });
    oauthServer.listen(TRAKT_REDIRECT_PORT, 'localhost', () => {});
    oauthServer.on('error', reject);
    setTimeout(() => {
      if (oauthServer) { oauthServer.close(); oauthServer = null; }
      reject(new Error('OAuth timed out'));
    }, 5 * 60 * 1000);
  });
}

function startSpotifyOAuthServer() {
  return new Promise((resolve, reject) => {
    spotifyOAuthServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${SPOTIFY_REDIRECT_PORT}`);
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="background:#0a0a0a;color:#e8e4dc;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center"><div style="font-size:48px;margin-bottom:16px">${error ? '✗' : '✓'}</div><div style="font-size:18px;color:#1DB954">${error ? 'Authorization failed' : 'Spotify connected'}</div><div style="margin-top:12px;color:#666;font-size:13px">${error ? error : 'You can close this window and return to Curator.'}</div></div></body></html>`);
        if (spotifyOAuthServer) { spotifyOAuthServer.close(); spotifyOAuthServer = null; }
        if (code) resolve(code);
        else reject(new Error(error || 'No code returned'));
      }
    });
    spotifyOAuthServer.listen(SPOTIFY_REDIRECT_PORT, 'localhost', () => {});
    spotifyOAuthServer.on('error', reject);
    setTimeout(() => {
      if (spotifyOAuthServer) { spotifyOAuthServer.close(); spotifyOAuthServer = null; }
      reject(new Error('OAuth timed out'));
    }, 5 * 60 * 1000);
  });
}

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function traktHeaders(accessToken, clientId) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'trakt-api-version': '2',
    'trakt-api-key': clientId,
    'Content-Type': 'application/json',
    'User-Agent': 'Curator/1.0.0',
  };
}

// Silently refresh the Trakt access token using the stored refresh token
async function refreshTraktToken() {
  const clientId = await getCredential('traktClientId');
  const clientSecret = await getCredential('traktClientSecret');
  const refreshToken = await getCredential('traktRefreshToken');
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('Trakt token expired — please reconnect');
  }
  const body = JSON.stringify({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: TRAKT_REDIRECT_URI,
    grant_type: 'refresh_token',
  });
  const result = await httpsRequest({
    hostname: 'api.trakt.tv',
    path: '/oauth/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'Curator/1.0.0',
    },
  }, body);
  if (result.status !== 200) throw new Error('Trakt token expired — please reconnect');
  await storeCredential('traktAccessToken', result.body.access_token);
  await storeCredential('traktRefreshToken', result.body.refresh_token);
  return result.body.access_token;
}

async function fetchTraktPaged(accessToken, clientId, traktPath) {
  const items = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    const result = await httpsRequest({
      hostname: 'api.trakt.tv',
      path: `${traktPath}?page=${page}&limit=${perPage}`,
      method: 'GET',
      headers: traktHeaders(accessToken, clientId),
    });
    if (result.status === 401) {
      accessToken = await refreshTraktToken();
      const retry = await httpsRequest({
        hostname: 'api.trakt.tv',
        path: `${traktPath}?page=${page}&limit=${perPage}`,
        method: 'GET',
        headers: traktHeaders(accessToken, clientId),
      });
      if (retry.status === 401) throw new Error('Trakt token expired — please reconnect');
      if (retry.status !== 200) throw new Error('Trakt API error: ' + retry.status);
      if (!Array.isArray(retry.body) || retry.body.length === 0) break;
      items.push(...retry.body);
      if (retry.body.length < perPage) break;
      page++;
      continue;
    }
    if (result.status !== 200) throw new Error('Trakt API error: ' + result.status);
    if (!Array.isArray(result.body) || result.body.length === 0) break;
    items.push(...result.body);
    if (result.body.length < perPage) break;
    page++;
  }
  return items;
}

async function traktGet(accessToken, clientId, traktPath) {
  let result = await httpsRequest({
    hostname: 'api.trakt.tv',
    path: traktPath,
    method: 'GET',
    headers: traktHeaders(accessToken, clientId),
  });
  if (result.status === 401) {
    accessToken = await refreshTraktToken();
    result = await httpsRequest({
      hostname: 'api.trakt.tv',
      path: traktPath,
      method: 'GET',
      headers: traktHeaders(accessToken, clientId),
    });
  }
  return result;
}

async function traktPost(accessToken, clientId, traktPath, bodyObj) {
  const bodyStr = JSON.stringify(bodyObj);
  const headers = { ...traktHeaders(accessToken, clientId), 'Content-Length': Buffer.byteLength(bodyStr) };
  let result = await httpsRequest({ hostname: 'api.trakt.tv', path: traktPath, method: 'POST', headers }, bodyStr);
  if (result.status === 401) {
    accessToken = await refreshTraktToken();
    const headers2 = { ...traktHeaders(accessToken, clientId), 'Content-Length': Buffer.byteLength(bodyStr) };
    result = await httpsRequest({ hostname: 'api.trakt.tv', path: traktPath, method: 'POST', headers: headers2 }, bodyStr);
  }
  return result;
}

// ── Spotify helpers ───────────────────────────────────────────────────────────
async function refreshSpotifyToken() {
  const clientId = await getCredential('spotifyClientId');
  const clientSecret = await getCredential('spotifyClientSecret');
  const refreshToken = await getCredential('spotifyRefreshToken');
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('Spotify session expired — please reconnect');
  }
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const result = await httpsRequest({
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (result.status !== 200) throw new Error('Spotify token expired — please reconnect');
  await storeCredential('spotifyAccessToken', result.body.access_token);
  if (result.body.refresh_token) {
    await storeCredential('spotifyRefreshToken', result.body.refresh_token);
  }
  return result.body.access_token;
}

async function spotifyGet(path) {
  let accessToken = await getCredential('spotifyAccessToken');
  let result = await httpsRequest({
    hostname: 'api.spotify.com',
    path,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (result.status === 401) {
    accessToken = await refreshSpotifyToken();
    result = await httpsRequest({
      hostname: 'api.spotify.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
  }
  return result;
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('creds:get-all', async () => {
  const anthropic = await getCredential('anthropic');
  const traktClientId = await getCredential('traktClientId');
  const traktClientSecret = await getCredential('traktClientSecret');
  const traktAccessToken = await getCredential('traktAccessToken');
  const embyUrl = await getCredential('embyUrl');
  const spotifyClientId = await getCredential('spotifyClientId');
  const spotifyClientSecret = await getCredential('spotifyClientSecret');
  const spotifyAccessToken = await getCredential('spotifyAccessToken');
  return {
    hasAnthropic: !!anthropic,
    hasTraktClientId: !!traktClientId,
    hasTraktClientSecret: !!traktClientSecret,
    hasTraktToken: !!traktAccessToken,
    anthropic,
    traktClientId,
    traktClientSecret,
    embyUrl,
    hasSpotifyClientId: !!spotifyClientId,
    hasSpotifyClientSecret: !!spotifyClientSecret,
    hasSpotifyToken: !!spotifyAccessToken,
  };
});

ipcMain.handle('creds:save', async (_, { key, value }) => {
  await storeCredential(key, value);
  return true;
});

ipcMain.handle('creds:clear-trakt', async () => {
  await deleteCredential('traktAccessToken');
  await deleteCredential('traktRefreshToken');
  return true;
});

ipcMain.handle('creds:clear-spotify', async () => {
  await deleteCredential('spotifyAccessToken');
  await deleteCredential('spotifyRefreshToken');
  return true;
});

// History
ipcMain.handle('history:get', async () => loadHistory());

ipcMain.handle('history:add', async (_, entry) => {
  const history = loadHistory();
  history.unshift(entry);
  if (history.length > 500) history.splice(500);
  saveHistory(history);
  return true;
});

ipcMain.handle('history:set-feedback', async (_, { timestamp, feedback }) => {
  const history = loadHistory();
  const entry = history.find(e => e.timestamp === timestamp);
  if (entry) entry.feedback = feedback;
  saveHistory(history);
  return true;
});

ipcMain.handle('history:set-watchlisted', async (_, { timestamp }) => {
  const history = loadHistory();
  const entry = history.find(e => e.timestamp === timestamp);
  if (entry) entry.addedToWatchlist = true;
  saveHistory(history);
  return true;
});

// Trakt OAuth
ipcMain.handle('trakt:start-oauth', async () => {
  const clientId = await getCredential('traktClientId');
  if (!clientId) throw new Error('Trakt Client ID not configured');
  const codePromise = startOAuthServer();
  const authUrl = `https://trakt.tv/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(TRAKT_REDIRECT_URI)}`;
  shell.openExternal(authUrl);
  return codePromise;
});

ipcMain.handle('trakt:exchange-code', async (_, code) => {
  const clientId = await getCredential('traktClientId');
  const clientSecret = await getCredential('traktClientSecret');
  const body = JSON.stringify({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: TRAKT_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const result = await httpsRequest({
    hostname: 'api.trakt.tv',
    path: '/oauth/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'Curator/1.0.0',
    },
  }, body);
  if (result.status !== 200) throw new Error('Token exchange failed: ' + JSON.stringify(result.body));
  await storeCredential('traktAccessToken', result.body.access_token);
  await storeCredential('traktRefreshToken', result.body.refresh_token);
  return true;
});

ipcMain.handle('trakt:fetch-history', async () => {
  const accessToken = await getCredential('traktAccessToken');
  const clientId = await getCredential('traktClientId');
  if (!accessToken) throw new Error('Not authenticated with Trakt');
  const [movies, shows] = await Promise.all([
    fetchTraktPaged(accessToken, clientId, '/users/me/watched/movies'),
    fetchTraktPaged(accessToken, clientId, '/users/me/watched/shows'),
  ]);
  const movieTitles = movies.map(item => item.movie?.title).filter(Boolean);
  const showTitles = shows.map(item => item.show?.title).filter(Boolean);
  return { movieTitles, showTitles, total: movieTitles.length + showTitles.length };
});

// Look up a recommended title on Trakt for verified rating + IDs
ipcMain.handle('trakt:lookup', async (_, { title, mode }) => {
  const accessToken = await getCredential('traktAccessToken');
  const clientId = await getCredential('traktClientId');
  if (!accessToken || !clientId) return null;
  try {
    const searchType = mode === 'shows' ? 'show' : 'movie';
    const result = await traktGet(accessToken, clientId,
      `/search/${searchType}?query=${encodeURIComponent(title)}&limit=3`);
    if (result.status !== 200 || !Array.isArray(result.body) || result.body.length === 0) return null;
    const titleLower = title.toLowerCase();
    const match = result.body.find(r => (r.movie || r.show)?.title?.toLowerCase() === titleLower) || result.body[0];
    const media = match.movie || match.show;
    return {
      traktId: media.ids?.trakt,
      slug: media.ids?.slug,
      imdbId: media.ids?.imdb,
      rating: media.rating ? parseFloat(media.rating.toFixed(1)) : null,
      votes: media.votes || 0,
    };
  } catch (e) {
    return null;
  }
});

// Mark a title as watched in Trakt history
ipcMain.handle('trakt:mark-seen', async (_, { traktId, title, year, mode }) => {
  const accessToken = await getCredential('traktAccessToken');
  const clientId = await getCredential('traktClientId');
  if (!accessToken || !clientId) throw new Error('Not connected to Trakt');
  const isShow = mode === 'shows';
  const listKey = isShow ? 'shows' : 'movies';
  const itemKey = isShow ? 'show' : 'movie';
  const ids = traktId ? { trakt: traktId } : {};
  const item = { ids, title, year: parseInt(year) || undefined };
  const result = await traktPost(accessToken, clientId, '/sync/history', {
    [listKey]: [{ [itemKey]: item, watched_at: new Date().toISOString() }]
  });
  if (result.status !== 200 && result.status !== 201) {
    throw new Error('Mark seen on Trakt failed: ' + result.status);
  }
  return true;
});

// Add a title to the user's Trakt watchlist
ipcMain.handle('trakt:add-watchlist', async (_, { traktId, title, year, mode }) => {
  const accessToken = await getCredential('traktAccessToken');
  const clientId = await getCredential('traktClientId');
  if (!accessToken || !clientId) throw new Error('Not connected to Trakt');
  const isShow = mode === 'shows';
  const listKey = isShow ? 'shows' : 'movies';
  const itemKey = isShow ? 'show' : 'movie';
  const ids = traktId ? { trakt: traktId } : {};
  const item = { ids, title, year: parseInt(year) || undefined };
  const result = await traktPost(accessToken, clientId, '/sync/watchlist', { [listKey]: [{ [itemKey]: item }] });
  if (result.status !== 200 && result.status !== 201) {
    throw new Error('Watchlist add failed: ' + result.status);
  }
  return true;
});

// ── Spotify IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('spotify:start-oauth', async () => {
  const clientId = await getCredential('spotifyClientId');
  if (!clientId) throw new Error('Spotify Client ID not configured');
  const codePromise = startSpotifyOAuthServer();
  const scopes = 'user-top-read user-read-recently-played playlist-read-private';
  const authUrl = `https://accounts.spotify.com/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`;
  shell.openExternal(authUrl);
  return codePromise;
});

ipcMain.handle('spotify:exchange-code', async (_, code) => {
  const clientId = await getCredential('spotifyClientId');
  const clientSecret = await getCredential('spotifyClientSecret');
  const body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT_URI)}`;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const result = await httpsRequest({
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (result.status !== 200) throw new Error('Token exchange failed: ' + JSON.stringify(result.body));
  await storeCredential('spotifyAccessToken', result.body.access_token);
  await storeCredential('spotifyRefreshToken', result.body.refresh_token);
  return true;
});

ipcMain.handle('spotify:search-album', async (_, { title, artist }) => {
  try {
    const q = artist ? `album:${title} artist:${artist}` : title;
    const result = await spotifyGet(`/v1/search?q=${encodeURIComponent(q)}&type=album&limit=5`);
    if (result.status !== 200) return null;
    const albums = result.body?.albums?.items || [];
    const match = albums.find(a => a.name.toLowerCase() === title.toLowerCase()) || albums[0];
    return match?.images?.[1]?.url || match?.images?.[0]?.url || null;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('spotify:fetch-data', async () => {
  const [topArtistsRes, topTracksRes, recentRes, playlistsRes] = await Promise.all([
    spotifyGet('/v1/me/top/artists?time_range=medium_term&limit=20'),
    spotifyGet('/v1/me/top/tracks?time_range=medium_term&limit=20'),
    spotifyGet('/v1/me/player/recently-played?limit=20'),
    spotifyGet('/v1/me/playlists?limit=20'),
  ]);

  const topArtists = (topArtistsRes.body?.items || []).map(a => ({
    name: a.name,
    genres: a.genres || [],
  }));

  const topTracks = (topTracksRes.body?.items || []).map(t => ({
    name: t.name,
    artist: t.artists?.[0]?.name || '',
  }));

  const recentTracks = (recentRes.body?.items || []).map(i => ({
    name: i.track?.name || '',
    artist: i.track?.artists?.[0]?.name || '',
  }));

  const playlists = (playlistsRes.body?.items || [])
    .map(p => p.name)
    .filter(Boolean);

  return { topArtists, topTracks, recentTracks, playlists };
});

// Open URL in system browser
ipcMain.handle('shell:open-external', (_, url) => {
  shell.openExternal(url);
  return true;
});

// Claude API proxy (avoids any renderer network restrictions)
ipcMain.handle('claude:recommend', async (_, { prompt }) => {
  const apiKey = await getCredential('anthropic');
  if (!apiKey) throw new Error('Anthropic API key not configured');
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });
  const result = await httpsRequest({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (result.status !== 200) {
    throw new Error(result.body?.error?.message || `API error ${result.status}`);
  }
  return result.body.content[0].text.trim();
});

// ── Auto-updater ──────────────────────────────────────────────────────────────
let manualUpdateCheck = false;

function setupUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: `Curator ${info.version} is available`,
      detail: 'Downloading now in the background...',
      buttons: ['OK'],
    });
  });

  autoUpdater.on('update-not-available', () => {
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Up to Date',
        message: `You're running the latest version of Curator.`,
        detail: `Version ${app.getVersion()}`,
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready to Install',
      message: `Curator ${info.version} has been downloaded`,
      detail: 'Open the installer to complete the update.',
      buttons: ['Install Now', 'Later'],
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall(false, true);
    });
  });

  autoUpdater.on('error', (err) => {
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Update Check Failed',
        message: 'Could not check for updates.',
        detail: err.message,
        buttons: ['OK'],
      });
    }
  });

  // Check on startup after a short delay
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: () => {
            manualUpdateCheck = true;
            autoUpdater.checkForUpdates().catch((err) => {
              manualUpdateCheck = false;
              dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Update Check Failed',
                message: 'Could not check for updates.',
                detail: err.message,
                buttons: ['OK'],
              });
            });
          },
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 900,
    minWidth: 720,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.on('context-menu', (event, params) => {
    const menu = new Menu();
    if (params.isEditable) {
      if (params.selectionText) {
        menu.append(new MenuItem({ label: 'Cut', role: 'cut' }));
        menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
        menu.append(new MenuItem({ type: 'separator' }));
      }
      menu.append(new MenuItem({ label: 'Paste', role: 'paste' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Select All', role: 'selectAll' }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
    }
    if (menu.items.length > 0) menu.popup({ window: mainWindow });
  });
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  setupUpdater();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

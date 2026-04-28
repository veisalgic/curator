const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

// ── Secure credential storage via safeStorage + encrypted local file ──────────
// safeStorage uses the OS keychain (macOS Keychain) to encrypt/decrypt,
// and we persist the ciphertext in a JSON file in the user data directory.

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
    // Fallback: base64 only (no encryption — uncommon on macOS)
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

// ── Trakt OAuth ────────────────────────────────────────────────────────────────
const TRAKT_REDIRECT_PORT = 47821;
const TRAKT_REDIRECT_URI = `http://localhost:${TRAKT_REDIRECT_PORT}/callback`;

let oauthServer = null;

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

    // Timeout after 5 minutes
    setTimeout(() => {
      if (oauthServer) { oauthServer.close(); oauthServer = null; }
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

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('creds:get-all', async () => {
  const anthropic = await getCredential('anthropic');
  const traktClientId = await getCredential('traktClientId');
  const traktClientSecret = await getCredential('traktClientSecret');
  const traktAccessToken = await getCredential('traktAccessToken');
  return {
    hasAnthropic: !!anthropic,
    hasTraktClientId: !!traktClientId,
    hasTraktClientSecret: !!traktClientSecret,
    hasTraktToken: !!traktAccessToken,
    anthropic,
    traktClientId,
    traktClientSecret,
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

async function fetchTraktPaged(accessToken, clientId, path) {
  const items = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    const result = await httpsRequest({
      hostname: 'api.trakt.tv',
      path: `${path}?page=${page}&limit=${perPage}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'trakt-api-version': '2',
        'trakt-api-key': clientId,
        'Content-Type': 'application/json',
        'User-Agent': 'Curator/1.0.0',
      },
    });
    if (result.status === 401) throw new Error('Trakt token expired — please reconnect');
    if (result.status !== 200) throw new Error('Trakt API error: ' + result.status);
    if (!Array.isArray(result.body) || result.body.length === 0) break;
    items.push(...result.body);
    if (result.body.length < perPage) break;
    page++;
  }
  return items;
}

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

  return {
    movieTitles,
    showTitles,
    total: movieTitles.length + showTitles.length,
  };
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

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// Curator renderer — talks to main process via window.docpicker (preload bridge)

const api = window.docpicker;

// ── State ─────────────────────────────────────────────────────────────────────
let watchedMovieTitles = new Set();
let watchedShowTitles = new Set();
let seenThisSession = new Set();
let traktConnected = false;
let lastRec = null;
let moreLikeSeed = null;  // { title, year } set by "More Like This"
let currentMode = 'documentaries'; // 'documentaries' | 'movies' | 'shows' | 'music'
let embyUrl = '';        // configured Emby server URL
let preferEnglishAudio = false;

// Spotify state
let spotifyConnected = false;
let spotifyData = null; // { topArtists, topTracks, recentTracks, playlists }

// ── Mode Toggle ───────────────────────────────────────────────────────────────
const taglines = {
  documentaries: 'Personalized documentary recommendations',
  movies: 'Personalized movie recommendations',
  shows: 'Personalized TV show recommendations',
  music: 'Personalized album recommendations',
};

const mainBtnLabels = {
  documentaries: '▶  Pick a Documentary',
  movies: '▶  Pick a Movie',
  shows: '▶  Pick a Show',
  music: '▶  Discover an Album',
};

const nextLabels = {
  documentaries: 'Next Documentary →',
  movies: 'Next Movie →',
  shows: 'Next Show →',
  music: 'Next Album →',
};

function setMode(btn) {
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentMode = btn.dataset.mode;
  moreLikeSeed = null;
  document.getElementById('tagline').textContent = taglines[currentMode];
  const mainBtn = document.getElementById('mainBtn');
  if (!mainBtn.disabled) mainBtn.textContent = mainBtnLabels[currentMode];
  document.getElementById('resultCard').style.display = 'none';
  seenThisSession.clear();
  setStatus('');
  showError('');

  // Toggle music vs film mood chips
  const isMusic = currentMode === 'music';
  document.getElementById('filmMoodOptions').style.display = isMusic ? 'none' : 'block';
  document.getElementById('musicMoodOptions').style.display = isMusic ? 'block' : 'none';
  // Deactivate chips from the hidden set
  document.querySelectorAll('.chip.active').forEach(c => c.classList.remove('active'));
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const creds = await api.getAllCreds();

  if (creds.hasAnthropic && creds.anthropic) {
    document.getElementById('apiKey').value = creds.anthropic;
  }

  if (creds.hasTraktClientId && creds.hasTraktClientSecret) {
    showTraktAuthSection();
    if (creds.hasTraktToken) {
      setTraktConnected(true);
    }
  }

  if (creds.hasTraktToken) {
    await loadTraktHistory();
  }

  if (creds.hasSpotifyClientId && creds.hasSpotifyClientSecret) {
    showSpotifyAuthSection();
    if (creds.hasSpotifyToken) {
      setSpotifyConnected(true);
    }
  }

  if (creds.hasSpotifyToken) {
    await loadSpotifyData();
  }

  if (creds.hasAnthropic && creds.hasTraktToken) {
    collapseSetup();
  }

  // Load Emby URL
  if (creds.embyUrl) {
    embyUrl = creds.embyUrl;
    const embyEl = document.getElementById('embyUrl');
    if (embyEl) embyEl.value = creds.embyUrl;
  }

  await renderHistory();
}

function collapseSetup() {
  const body = document.getElementById('setupBody');
  const icon = document.querySelector('#setupHeader .toggle-icon');
  body.classList.remove('open');
  icon.classList.remove('open');
  document.querySelector('#setupHeader .panel-label').textContent = 'Configuration  ✓';
}

// ── Credentials ───────────────────────────────────────────────────────────────
async function saveApiKey() {
  const val = document.getElementById('apiKey').value.trim();
  if (!val) return;
  await api.saveCred('anthropic', val);
  const el = document.getElementById('apiKeySaved');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
  const creds = await api.getAllCreds();
  if (creds.hasTraktToken) collapseSetup();
}

async function saveTraktCreds() {
  const clientId = document.getElementById('traktClientId').value.trim();
  const clientSecret = document.getElementById('traktClientSecret').value.trim();
  if (!clientId || !clientSecret) {
    showError('Enter both Trakt Client ID and Client Secret.');
    return;
  }
  await api.saveCred('traktClientId', clientId);
  await api.saveCred('traktClientSecret', clientSecret);
  const el = document.getElementById('traktCredsSaved');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
  showTraktAuthSection();
}

function showTraktAuthSection() {
  document.getElementById('traktCredsForm').style.display = 'none';
  document.getElementById('traktAuthSection').style.display = 'block';
}

function resetTraktCreds() {
  document.getElementById('traktCredsForm').style.display = 'block';
  document.getElementById('traktAuthSection').style.display = 'none';
  document.getElementById('traktClientId').value = '';
  document.getElementById('traktClientSecret').value = '';
}

function setTraktConnected(connected) {
  traktConnected = connected;
  const dot = document.getElementById('traktDot');
  const title = document.getElementById('traktStatusTitle');
  const sub = document.getElementById('traktStatusSub');
  const connectBtn = document.getElementById('traktConnectBtn');
  const disconnectBtn = document.getElementById('traktDisconnectBtn');

  if (connected) {
    dot.className = 'trakt-dot connected';
    title.textContent = 'Connected';
    sub.textContent = 'Watch history loaded — Claude will avoid your seen titles';
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'inline-block';
  } else {
    dot.className = 'trakt-dot';
    title.textContent = 'Not connected';
    sub.textContent = 'Click below to authorize with your Trakt account';
    connectBtn.style.display = 'inline-block';
    disconnectBtn.style.display = 'none';
  }

}

// ── Trakt OAuth Flow ──────────────────────────────────────────────────────────
async function connectTrakt() {
  const btn = document.getElementById('traktConnectBtn');
  btn.textContent = 'Opening browser...';
  btn.disabled = true;
  showError('');

  try {
    setStatus('Waiting for Trakt authorization in browser...');
    const code = await api.startTraktOAuth();
    setStatus('Exchanging authorization code...');
    await api.exchangeTraktCode(code);
    setTraktConnected(true);
    await loadTraktHistory();
    setStatus('');
    const creds = await api.getAllCreds();
    if (creds.hasAnthropic) collapseSetup();
  } catch (err) {
    showError('Trakt auth failed: ' + err.message);
    setStatus('');
    setTraktConnected(false);
  } finally {
    btn.textContent = 'Connect Trakt →';
    btn.disabled = false;
  }
}

async function disconnectTrakt() {
  await api.clearTraktAuth();
  setTraktConnected(false);
  watchedMovieTitles.clear();
  watchedShowTitles.clear();
  document.getElementById('historyCount').textContent = '';
}

async function loadTraktHistory() {
  setStatus('Fetching your Trakt watch history...');
  try {
    const result = await api.fetchTraktHistory();
    watchedMovieTitles = new Set(result.movieTitles.map(t => t.toLowerCase()));
    watchedShowTitles = new Set(result.showTitles.map(t => t.toLowerCase()));
    document.getElementById('historyCount').textContent =
      `✓ ${result.movieTitles.length} movies + ${result.showTitles.length} shows loaded from Trakt`;
    setStatus('');
    return true;
  } catch (err) {
    if (err.message.includes('expired')) {
      setTraktConnected(false);
      showError('Trakt session expired. Please reconnect.');
    } else {
      showError('Could not load Trakt history: ' + err.message);
    }
    setStatus('');
    return false;
  }
}

// ── Spotify OAuth Flow ────────────────────────────────────────────────────────
async function saveSpotifyCreds() {
  const clientId = document.getElementById('spotifyClientId').value.trim();
  const clientSecret = document.getElementById('spotifyClientSecret').value.trim();
  if (!clientId || !clientSecret) {
    showError('Enter both Spotify Client ID and Client Secret.');
    return;
  }
  await api.saveCred('spotifyClientId', clientId);
  await api.saveCred('spotifyClientSecret', clientSecret);
  const el = document.getElementById('spotifyCredsSaved');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
  showSpotifyAuthSection();
}

function showSpotifyAuthSection() {
  document.getElementById('spotifyCredsForm').style.display = 'none';
  document.getElementById('spotifyAuthSection').style.display = 'block';
}

function resetSpotifyCreds() {
  document.getElementById('spotifyCredsForm').style.display = 'block';
  document.getElementById('spotifyAuthSection').style.display = 'none';
  document.getElementById('spotifyClientId').value = '';
  document.getElementById('spotifyClientSecret').value = '';
}

function setSpotifyConnected(connected) {
  spotifyConnected = connected;
  const dot = document.getElementById('spotifyDot');
  const title = document.getElementById('spotifyStatusTitle');
  const sub = document.getElementById('spotifyStatusSub');
  const connectBtn = document.getElementById('spotifyConnectBtn');
  const disconnectBtn = document.getElementById('spotifyDisconnectBtn');

  if (connected) {
    dot.className = 'trakt-dot connected';
    title.textContent = 'Connected';
    sub.textContent = 'Listening history loaded — Claude will use your taste profile';
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'inline-block';
  } else {
    dot.className = 'trakt-dot';
    title.textContent = 'Not connected';
    sub.textContent = 'Click below to authorize with your Spotify account';
    connectBtn.style.display = 'inline-block';
    disconnectBtn.style.display = 'none';
  }
}

async function connectSpotify() {
  const btn = document.getElementById('spotifyConnectBtn');
  btn.textContent = 'Opening browser...';
  btn.disabled = true;
  showError('');

  try {
    setStatus('Waiting for Spotify authorization in browser...');
    const code = await api.startSpotifyOAuth();
    setStatus('Exchanging authorization code...');
    await api.exchangeSpotifyCode(code);
    setSpotifyConnected(true);
    await loadSpotifyData();
    setStatus('');
  } catch (err) {
    showError('Spotify auth failed: ' + err.message);
    setStatus('');
    setSpotifyConnected(false);
  } finally {
    btn.textContent = 'Connect Spotify →';
    btn.disabled = false;
  }
}

async function disconnectSpotify() {
  await api.clearSpotifyAuth();
  setSpotifyConnected(false);
  spotifyData = null;
}

async function loadSpotifyData() {
  setStatus('Fetching your Spotify listening history...');
  try {
    spotifyData = await api.fetchSpotifyData();
    setStatus('');
    return true;
  } catch (err) {
    if (err.message.includes('expired')) {
      setSpotifyConnected(false);
      showError('Spotify session expired. Please reconnect.');
    } else {
      showError('Could not load Spotify data: ' + err.message);
    }
    setStatus('');
    return false;
  }
}

function copySpotifyUri(el) {
  navigator.clipboard.writeText('http://localhost:47822/callback').then(() => {
    const orig = el.textContent;
    el.textContent = 'Copied!';
    setTimeout(() => { el.textContent = orig; }, 1500);
  });
}

// ── CSV Fallback ──────────────────────────────────────────────────────────────
document.getElementById('csvFile').addEventListener('change', function(e) {
  handleFile(e.target.files[0]);
});

const fileDrop = document.getElementById('fileDrop');
fileDrop.addEventListener('dragover', e => { e.preventDefault(); fileDrop.classList.add('drag-over'); });
fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('drag-over'));
fileDrop.addEventListener('drop', e => {
  e.preventDefault();
  fileDrop.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
  if (!file || !file.name.endsWith('.csv')) return;
  const reader = new FileReader();
  reader.onload = e => parseCSV(e.target.result);
  reader.readAsText(file);
}

function parseCSV(text) {
  const lines = text.split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const titleIdx = headers.indexOf('title');
  const genreIdx = headers.indexOf('genres');
  const typeIdx = headers.indexOf('type');
  let docCount = 0;
  watchedMovieTitles.clear();

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVRow(lines[i]);
    if (!row || row.length < 3) continue;
    const type = row[typeIdx]?.toLowerCase();
    const genre = row[genreIdx]?.toLowerCase() || '';
    const title = row[titleIdx]?.trim();
    if (title) watchedMovieTitles.add(title.toLowerCase());
    if (type === 'movie' && genre.includes('documentary')) docCount++;
  }

  const status = document.getElementById('fileStatus');
  status.textContent = `✓ Loaded — ${watchedMovieTitles.size} titles, ~${docCount} documentaries`;
  status.style.display = 'block';
  document.getElementById('historyCount').textContent = 'Claude will avoid recommending anything in your history';
}

function parseCSVRow(row) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '"') { inQuotes = !inQuotes; continue; }
    if (row[i] === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
    current += row[i];
  }
  result.push(current.trim());
  return result;
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function toggleChip(el) { el.classList.toggle('active'); }

function toggleCollapse(header) {
  const icon = header.querySelector('.toggle-icon');
  const body = header.nextElementSibling;
  icon.classList.toggle('open');
  body.classList.toggle('open');
}

function getActiveMoods() {
  const chipContainer = currentMode === 'music' ? '#musicMoodChips' : '#moodChips';
  const active = [...document.querySelectorAll(`${chipContainer} .chip.active`)].map(c => c.textContent);
  const custom = document.getElementById('customMood').value.trim();
  return { chips: active, custom };
}

function setLoading(loading) {
  document.getElementById('loadingBar').classList.toggle('active', loading);
  const btn = document.getElementById('mainBtn');
  btn.disabled = loading;
  btn.textContent = loading ? '⟳  Thinking...' : mainBtnLabels[currentMode];
}

function setStatus(msg) {
  document.getElementById('statusText').textContent = msg;
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

// ── Prompts per mode ──────────────────────────────────────────────────────────
function buildPrompt(mode, watchedList, seenList, moodText, seed, likedTitles, englishAudio) {
  const avoidBlock = watchedList
    ? `Their watch history includes these titles (do NOT recommend any of these):\n${watchedList}\n`
    : '(No watch history provided — treat as a blank slate)\n';

  const seenBlock = seenList
    ? `Also do NOT recommend these (already suggested this session): ${seenList}\n`
    : '';

  const seedBlock = seed
    ? `\nThe user wants something similar to: ${seed.title} (${seed.year}). Prioritize similar themes, tone, or subject matter.\n`
    : '';

  const likedBlock = likedTitles && likedTitles.length > 0
    ? `\nTitles this user has responded positively to: ${likedTitles.join(', ')} — use these as taste signals.\n`
    : '';

  const audioBlock = englishAudio
    ? `\nIMPORTANT: Only recommend titles where English audio is available (either originally in English or with a quality English dub). Do not recommend foreign-language titles that lack English audio.\n`
    : '';

  const jsonFormat = mode === 'shows'
    ? `{
  "title": "Show Title",
  "year": "2019",
  "runtime": "6 seasons / 8 episodes",
  "genres": ["Crime", "Drama"],
  "synopsis": "2-3 sentence synopsis of the show.",
  "why": "1-2 sentences on why this specific viewer will love it based on their taste."
}`
    : `{
  "title": "Film Title",
  "year": "2019",
  "runtime": "94 min",
  "genres": ["Crime", "Politics"],
  "synopsis": "2-3 sentence synopsis of the film.",
  "why": "1-2 sentences on why this specific viewer will love it based on their taste."
}`;

  if (mode === 'documentaries') {
    return `You are a documentary recommendation engine for a very experienced documentary viewer who has seen over 1,000 documentaries.

${avoidBlock}
${seenBlock}
${seedBlock}
${likedBlock}
${audioBlock}
${moodText}

Their taste profile:
- Loves: crime/justice, corporate corruption, cults/extremism, politics/power, character studies
- Prefers English-language (no subtitles needed)
- Appreciates deep cuts and underseen films, not just mainstream hits
- Values intellectual rigor and films that reveal systemic truths
- Dislikes celebrity biopics unless exceptionally compelling
- Has seen most major award-winning docs, so go deeper

Recommend ONE documentary film. Respond ONLY in this exact JSON format with no other text:
${jsonFormat}`;
  }

  if (mode === 'movies') {
    return `You are a film recommendation engine for an experienced cinephile who has seen hundreds of movies across many genres.

${avoidBlock}
${seenBlock}
${seedBlock}
${likedBlock}
${audioBlock}
${moodText}

Their taste profile:
- Drawn to complex narratives, morally ambiguous characters, and films with something to say
- Appreciates both mainstream hits and underseen gems
- Open to any era or country of origin
- Values strong direction, writing, and performances
- Enjoys thrillers, crime, drama, dark comedy, and prestige films

Recommend ONE movie (any genre except documentary). Respond ONLY in this exact JSON format with no other text:
${jsonFormat}`;
  }

  // shows
  return `You are a TV show recommendation engine for an experienced viewer who has seen hundreds of series across many genres.

${avoidBlock}
${seenBlock}
${seedBlock}
${likedBlock}
${audioBlock}
${moodText}

Their taste profile:
- Drawn to complex narratives, compelling characters, and shows with real depth
- Loves prestige drama, crime, limited series, and smart genre television
- Open to any era or country of origin
- Values tight writing and strong performances over spectacle
- Not interested in reality TV or pure procedurals

Recommend ONE TV show or limited series. Respond ONLY in this exact JSON format with no other text:
${jsonFormat}`;
}

function buildMusicPrompt(spotifyData, seenList, moodText, seed, likedTitles) {
  let contextBlock = '(No Spotify history available — treat as a blank slate)\n';

  if (spotifyData) {
    const allGenres = [...new Set(
      spotifyData.topArtists.flatMap(a => a.genres)
    )].slice(0, 20);

    const topArtistNames = spotifyData.topArtists.slice(0, 15).map(a => a.name);
    const recentStr = spotifyData.recentTracks.slice(0, 10)
      .map(t => `${t.artist} — ${t.name}`).join(', ');
    const playlistStr = spotifyData.playlists.slice(0, 10).join(', ');

    contextBlock = `Their Spotify listening profile:
- Top genres: ${allGenres.join(', ') || 'varied'}
- Top artists: ${topArtistNames.join(', ')}
- Recently played: ${recentStr || 'not available'}
- Playlist names (taste signals): ${playlistStr || 'not available'}
`;
  }

  const seenBlock = seenList
    ? `Do NOT recommend these (already suggested this session): ${seenList}\n`
    : '';

  const seedBlock = seed
    ? `\nThe user wants something similar to: ${seed.title}${seed.artist ? ' by ' + seed.artist : ''}. Prioritize similar sound, mood, or era.\n`
    : '';

  const likedBlock = likedTitles && likedTitles.length > 0
    ? `\nAlbums this user responded positively to: ${likedTitles.join(', ')} — use these as taste signals.\n`
    : '';

  return `You are a music recommendation engine with encyclopedic knowledge of albums across all genres and eras.

${contextBlock}
${seenBlock}
${seedBlock}
${likedBlock}
${moodText}

Recommend ONE album the user hasn't heard. Prioritize depth and quality over popularity — include both well-known classics and underseen gems. Respond ONLY in this exact JSON format with no other text:
{
  "album": "Album Title",
  "artist": "Artist Name",
  "year": "1997",
  "genres": ["Post-Rock", "Ambient"],
  "synopsis": "2-3 sentences describing the album's sound, feel, and what makes it distinctive.",
  "why": "1-2 sentences on why this specific listener will connect with it based on their taste."
}`;
}

// ── Recommendation ────────────────────────────────────────────────────────────
async function getRecommendation() {
  let apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) {
    const creds = await api.getAllCreds();
    apiKey = creds.anthropic;
  }
  if (!apiKey) {
    showError('Please enter your Anthropic API key.');
    return;
  }

  const stored = (await api.getAllCreds()).anthropic;
  if (apiKey !== stored) {
    await api.saveCred('anthropic', apiKey);
  }

  showError('');
  setLoading(true);

  // Capture and reset the seed before the async call
  const seedToUse = moreLikeSeed;
  moreLikeSeed = null;

  setStatus(seedToUse ? `Finding something like "${seedToUse.title}"...` : 'Consulting your watch history...');

  const { chips, custom } = getActiveMoods();
  const moodText = chips.length > 0 || custom
    ? `Mood filters: ${chips.join(', ')}${custom ? '. Additional context: ' + custom : ''}`
    : 'No specific mood — just pick something great.';

  const seenList = [...seenThisSession].join(', ');

  // Pull liked titles from history as taste signals
  let likedTitles = [];
  try {
    const history = await api.getHistory();
    likedTitles = history
      .filter(e => e.feedback === 'liked' && e.mode === currentMode)
      .slice(0, 5)
      .map(e => e.mode === 'music' ? `${e.artist ? e.artist + ' — ' : ''}${e.title}` : e.title);
  } catch (e) { /* non-fatal */ }

  let prompt;
  if (currentMode === 'music') {
    prompt = buildMusicPrompt(spotifyData, seenList, moodText, seedToUse, likedTitles);
  } else {
    const isShows = currentMode === 'shows';
    const relevantTitles = isShows ? watchedShowTitles : watchedMovieTitles;
    const watchedList = [...relevantTitles].slice(0, 800).join(', ');
    prompt = buildPrompt(currentMode, watchedList, seenList, moodText, seedToUse, likedTitles, preferEnglishAudio);
  }

  try {
    const text = await api.getRecommendation(prompt);
    const clean = text.replace(/```json|```/g, '').trim();
    const raw = JSON.parse(clean);

    // Normalize music vs film shape
    let rec;
    if (currentMode === 'music') {
      rec = {
        title: raw.album || raw.title,
        artist: raw.artist,
        year: raw.year,
        genres: raw.genres,
        synopsis: raw.synopsis,
        why: raw.why,
      };
    } else {
      rec = raw;
    }

    const timestamp = new Date().toISOString();
    lastRec = { ...rec, timestamp };
    const sessionKey = currentMode === 'music'
      ? `${(rec.artist || '').toLowerCase()} — ${rec.title.toLowerCase()}`
      : rec.title.toLowerCase();
    seenThisSession.add(sessionKey);
    displayResult(rec);
    setLoading(false);
    setStatus('');

    // Save to history (non-blocking)
    api.addHistory({ ...rec, mode: currentMode, timestamp, feedback: null, addedToWatchlist: false }).catch(() => {});
    renderHistory().catch(() => {});

    if (currentMode === 'music') lookupSpotifyArt(rec.title, rec.artist);
    else lookupTrakt(rec.title);
  } catch (err) {
    setLoading(false);
    setStatus('');
    showError('Error: ' + err.message);
  }
}

function displayResult(rec) {
  const isMusic = currentMode === 'music';

  // Reset album art
  const artImg = document.getElementById('resAlbumArt');
  artImg.style.display = 'none';
  artImg.src = '';

  document.getElementById('resYear').textContent = rec.year;

  // Artist row (music only)
  const artistEl = document.getElementById('resArtist');
  if (isMusic && rec.artist) {
    artistEl.textContent = rec.artist;
    artistEl.style.display = 'block';
  } else {
    artistEl.style.display = 'none';
  }

  document.getElementById('resTitle').textContent = rec.title;
  document.getElementById('resSynopsis').textContent = rec.synopsis;
  document.getElementById('resWhy').textContent = rec.why;

  const meta = document.getElementById('resMeta');
  meta.innerHTML = '';
  if (rec.runtime) meta.innerHTML += `<span class="meta-tag">${rec.runtime}</span>`;
  (rec.genres || []).forEach(g => meta.innerHTML += `<span class="meta-tag">${g}</span>`);

  // Reset action buttons
  document.getElementById('nextPickBtn').textContent = nextLabels[currentMode];
  const wlBtn = document.getElementById('watchlistBtn');
  wlBtn.style.display = isMusic ? 'none' : 'inline-block';
  wlBtn.textContent = '+ Watchlist';
  wlBtn.disabled = false;
  wlBtn.style.color = '';
  wlBtn.style.borderColor = '';
  document.getElementById('likeBtn').style.color = '';
  document.getElementById('likeBtn').style.borderColor = '';
  document.getElementById('dislikeBtn').style.color = '';
  document.getElementById('dislikeBtn').style.borderColor = '';

  // Media player buttons
  document.getElementById('playerActions').style.display = 'flex';
  document.getElementById('embySearchBtn').style.display = isMusic ? 'none' : 'inline-block';
  document.getElementById('infuseSearchBtn').style.display = isMusic ? 'none' : 'inline-block';
  document.getElementById('spotifySearchBtn').style.display = isMusic ? 'inline-block' : 'none';

  // Trakt/streaming section
  const traktRow = document.getElementById('resTraktRow');
  if (isMusic) {
    traktRow.style.display = 'none';
  } else {
    traktRow.style.display = 'block';
    document.getElementById('resTraktSection').innerHTML = traktConnected
      ? '<span class="trakt-loading">Looking up on Trakt...</span>'
      : '<span style="color:var(--text-dim);font-size:11px">Connect Trakt to see rating</span>';
  }

  const card = document.getElementById('resultCard');
  card.style.display = 'block';
  card.style.animation = 'none';
  card.offsetHeight;
  card.style.animation = 'fadeUp 0.4s ease forwards';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Trakt lookup (post-recommendation) ───────────────────────────────────────
async function lookupTrakt(title) {
  if (!traktConnected) return;
  try {
    const data = await api.traktLookup({ title, mode: currentMode });
    if (lastRec) lastRec.traktData = data;

    if (!data) {
      document.getElementById('resTraktSection').innerHTML =
        '<span style="color:var(--text-dim);font-size:11px">Not found on Trakt</span>';
      return;
    }

    const ratingHtml = data.rating
      ? `<span class="trakt-rating">★ ${data.rating}/10</span><span class="trakt-votes">(${(data.votes || 0).toLocaleString()} votes)</span>`
      : '<span style="color:var(--text-dim);font-size:11px">No rating yet</span>';

    const linkHtml = data.slug
      ? `<button class="btn-small trakt-link-btn" onclick="openTraktPage()">View on Trakt →</button>`
      : '';

    document.getElementById('resTraktSection').innerHTML =
      `<div class="trakt-result-row">${ratingHtml}${linkHtml}</div>`;
  } catch (e) {
    document.getElementById('resTraktSection').innerHTML =
      '<span style="color:var(--text-dim);font-size:11px">Trakt lookup failed</span>';
  }
}

function openTraktPage() {
  if (!lastRec?.traktData?.slug) return;
  const type = currentMode === 'shows' ? 'shows' : 'movies';
  api.openExternal(`https://trakt.tv/${type}/${lastRec.traktData.slug}`);
}

// ── More Like This ────────────────────────────────────────────────────────────
function moreLikeThis() {
  if (!lastRec) return;
  moreLikeSeed = { title: lastRec.title, year: lastRec.year, artist: lastRec.artist };
  getRecommendation();
}

// ── Add to Trakt Watchlist ────────────────────────────────────────────────────
async function addToWatchlist() {
  if (!lastRec) return;
  const btn = document.getElementById('watchlistBtn');
  btn.disabled = true;
  btn.textContent = 'Adding...';
  try {
    await api.traktAddWatchlist({
      traktId: lastRec.traktData?.traktId,
      title: lastRec.title,
      year: lastRec.year,
      mode: currentMode,
    });
    btn.textContent = '✓ Watchlisted';
    btn.style.color = 'var(--success)';
    btn.style.borderColor = 'var(--success)';
    if (lastRec.timestamp) {
      api.setWatchlisted({ timestamp: lastRec.timestamp }).catch(() => {});
      renderHistory().catch(() => {});
    }
  } catch (e) {
    btn.textContent = '+ Watchlist';
    btn.disabled = false;
    showError('Watchlist error: ' + e.message);
  }
}

// ── Feedback ──────────────────────────────────────────────────────────────────
function setFeedback(type) {
  if (!lastRec?.timestamp) return;
  const likeBtn = document.getElementById('likeBtn');
  const dislikeBtn = document.getElementById('dislikeBtn');
  if (type === 'liked') {
    likeBtn.style.color = 'var(--accent)';
    likeBtn.style.borderColor = 'var(--accent)';
    dislikeBtn.style.color = '';
    dislikeBtn.style.borderColor = '';
  } else {
    dislikeBtn.style.color = 'var(--danger)';
    dislikeBtn.style.borderColor = 'var(--danger)';
    likeBtn.style.color = '';
    likeBtn.style.borderColor = '';
  }
  api.setFeedback({ timestamp: lastRec.timestamp, feedback: type }).catch(() => {});
}

// ── Mark Seen ─────────────────────────────────────────────────────────────────
async function markSeen() {
  if (!lastRec) return;
  seenThisSession.add(lastRec.title.toLowerCase());
  if (currentMode === 'shows') {
    watchedShowTitles.add(lastRec.title.toLowerCase());
  } else {
    watchedMovieTitles.add(lastRec.title.toLowerCase());
  }
  document.getElementById('resultCard').style.display = 'none';
  setStatus(`Marked "${lastRec.title}" as seen.`);

  // Sync to Trakt if connected
  if (traktConnected) {
    try {
      await api.traktMarkSeen({
        traktId: lastRec.traktData?.traktId,
        title: lastRec.title,
        year: lastRec.year,
        mode: currentMode,
      });
      setStatus(`Marked "${lastRec.title}" as seen and synced to Trakt.`);
    } catch (e) {
      setStatus(`Marked "${lastRec.title}" as seen (Trakt sync failed: ${e.message})`);
    }
  }
}

function toggleEnglishAudio() {
  preferEnglishAudio = !preferEnglishAudio;
  const btn = document.getElementById('englishAudioBtn');
  btn.classList.toggle('active', preferEnglishAudio);
}

// ── History Panel ─────────────────────────────────────────────────────────────
async function renderHistory() {
  let history = [];
  try {
    history = await api.getHistory();
  } catch (e) {
    return;
  }

  const panel = document.getElementById('historyPanel');
  if (history.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  const list = document.getElementById('historyList');
  const modeShortMap = { documentaries: 'doc', movies: 'film', shows: 'show', music: 'alb' };
  list.innerHTML = history.slice(0, 30).map(entry => {
    const date = new Date(entry.timestamp);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const modeShort = modeShortMap[entry.mode] || entry.mode;
    const feedbackIcon = entry.feedback === 'liked' ? ' 👍' : entry.feedback === 'disliked' ? ' 👎' : '';
    const watchlistBadge = entry.addedToWatchlist
      ? ' <span class="history-watchlist">✓ list</span>'
      : '';
    const displayTitle = entry.mode === 'music' && entry.artist
      ? `${entry.artist} — ${entry.title}`
      : entry.title;
    return `<div class="history-item">
      <span class="history-mode">${modeShort}</span>
      <span class="history-title">${displayTitle}${feedbackIcon}</span>
      <span class="history-year">${entry.year}</span>
      <span class="history-date">${dateStr}${watchlistBadge}</span>
    </div>`;
  }).join('');
}

// ── Media Player Search ───────────────────────────────────────────────────────
async function saveEmbyUrl() {
  const val = document.getElementById('embyUrl').value.trim().replace(/\/$/, '');
  if (!val) return;
  embyUrl = val;
  document.getElementById('embyUrl').value = val;
  await api.saveCred('embyUrl', val);
  const el = document.getElementById('embyUrlSaved');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
  // Show Emby button on current result card if one is showing
  if (lastRec) document.getElementById('embySearchBtn').style.display = 'inline-block';
}

function searchEmby() {
  if (!lastRec) return;
  navigator.clipboard.writeText(lastRec.title).then(() => {
    const btn = document.getElementById('embySearchBtn');
    const orig = btn.textContent;
    btn.textContent = 'Title copied — paste to search';
    api.openExternal('emby://');
    setTimeout(() => { btn.textContent = orig; }, 3000);
  });
}

function searchInfuse() {
  if (!lastRec) return;
  navigator.clipboard.writeText(lastRec.title).then(() => {
    const btn = document.getElementById('infuseSearchBtn');
    const orig = btn.textContent;
    btn.textContent = 'Title copied — paste to search';
    api.openExternal('infuse7://');
    setTimeout(() => { btn.textContent = orig; }, 3000);
  });
}

function searchSpotify() {
  if (!lastRec) return;
  const query = lastRec.artist
    ? `${lastRec.artist} ${lastRec.title}`
    : lastRec.title;
  api.openExternal(`spotify:search:${encodeURIComponent(query)}`);
}

async function lookupSpotifyArt(title, artist) {
  if (!spotifyConnected) return;
  try {
    const imgUrl = await api.spotifySearchAlbum({ title, artist });
    if (imgUrl) {
      const img = document.getElementById('resAlbumArt');
      img.src = imgUrl;
      img.style.display = 'block';
    }
  } catch (e) { /* non-fatal */ }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function copyRedirectUri(el) {
  navigator.clipboard.writeText('http://localhost:47821/callback').then(() => {
    const orig = el.textContent;
    el.textContent = 'Copied!';
    setTimeout(() => { el.textContent = orig; }, 1500);
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init().catch(console.error);

// DocPicker renderer — talks to main process via window.docpicker (preload bridge)

const api = window.docpicker;

// ── State ─────────────────────────────────────────────────────────────────────
let watchedMovieTitles = new Set();  // from Trakt or CSV
let watchedShowTitles = new Set();
let seenThisSession = new Set();
let traktConnected = false;
let lastRec = null;
let currentMode = 'documentaries'; // 'documentaries' | 'movies' | 'shows'

// ── Mode Toggle ───────────────────────────────────────────────────────────────
const taglines = {
  documentaries: 'Personalized documentary recommendations',
  movies: 'Personalized movie recommendations',
  shows: 'Personalized TV show recommendations',
};

const mainBtnLabels = {
  documentaries: '▶  Pick a Documentary',
  movies: '▶  Pick a Movie',
  shows: '▶  Pick a Show',
};

function setMode(btn) {
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentMode = btn.dataset.mode;
  document.getElementById('tagline').textContent = taglines[currentMode];
  const mainBtn = document.getElementById('mainBtn');
  if (!mainBtn.disabled) mainBtn.textContent = mainBtnLabels[currentMode];
  // Clear previous result when switching modes
  document.getElementById('resultCard').style.display = 'none';
  seenThisSession.clear();
  setStatus('');
  showError('');
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

  // Auto-collapse setup if fully configured
  if (creds.hasAnthropic && creds.hasTraktToken) {
    collapseSetup();
  }
}

function collapseSetup() {
  const body = document.getElementById('setupBody');
  const icon = document.querySelector('#setupHeader .toggle-icon');
  body.classList.remove('open');
  icon.classList.remove('open');
  // Update label to show configured state
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
    // Collapse setup now that everything is configured
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
  const active = [...document.querySelectorAll('.chip.active')].map(c => c.textContent);
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
function buildPrompt(mode, watchedList, seenList, moodText) {
  const avoidBlock = watchedList
    ? `Their watch history includes these titles (do NOT recommend any of these):\n${watchedList}\n`
    : '(No watch history provided — treat as a blank slate)\n';

  const seenBlock = seenList
    ? `Also do NOT recommend these (already suggested this session): ${seenList}\n`
    : '';

  if (mode === 'documentaries') {
    return `You are a documentary recommendation engine for a very experienced documentary viewer who has seen over 1,000 documentaries.

${avoidBlock}
${seenBlock}
${moodText}

Their taste profile:
- Loves: crime/justice, corporate corruption, cults/extremism, politics/power, character studies
- Prefers English-language (no subtitles needed)
- Appreciates deep cuts and underseen films, not just mainstream hits
- Values intellectual rigor and films that reveal systemic truths
- Dislikes celebrity biopics unless exceptionally compelling
- Has seen most major award-winning docs, so go deeper

Recommend ONE documentary film. Respond ONLY in this exact JSON format with no other text:
{
  "title": "Film Title",
  "year": "2019",
  "runtime": "94 min",
  "genres": ["Crime", "Politics"],
  "synopsis": "2-3 sentence synopsis of the film.",
  "why": "1-2 sentences on why this specific viewer will love it based on their taste.",
  "where": "Where to stream or find it (Netflix, HBO, Amazon, YouTube, etc.)"
}`;
  }

  if (mode === 'movies') {
    return `You are a film recommendation engine for an experienced cinephile who has seen hundreds of movies across many genres.

${avoidBlock}
${seenBlock}
${moodText}

Their taste profile:
- Drawn to complex narratives, morally ambiguous characters, and films with something to say
- Appreciates both mainstream hits and underseen gems
- Open to any era or country of origin
- Values strong direction, writing, and performances
- Enjoys thrillers, crime, drama, dark comedy, and prestige films

Recommend ONE movie (any genre except documentary). Respond ONLY in this exact JSON format with no other text:
{
  "title": "Film Title",
  "year": "2019",
  "runtime": "118 min",
  "genres": ["Thriller", "Drama"],
  "synopsis": "2-3 sentence synopsis of the film.",
  "why": "1-2 sentences on why this specific viewer will love it based on their taste.",
  "where": "Where to stream or find it (Netflix, HBO, Amazon, etc.)"
}`;
  }

  // shows
  return `You are a TV show recommendation engine for an experienced viewer who has seen hundreds of series across many genres.

${avoidBlock}
${seenBlock}
${moodText}

Their taste profile:
- Drawn to complex narratives, compelling characters, and shows with real depth
- Loves prestige drama, crime, limited series, and smart genre television
- Open to any era or country of origin
- Values tight writing and strong performances over spectacle
- Not interested in reality TV or pure procedurals

Recommend ONE TV show or limited series. Respond ONLY in this exact JSON format with no other text:
{
  "title": "Show Title",
  "year": "2019",
  "runtime": "6 seasons / 8 episodes",
  "genres": ["Crime", "Drama"],
  "synopsis": "2-3 sentence synopsis of the show.",
  "why": "1-2 sentences on why this specific viewer will love it based on their taste.",
  "where": "Where to stream or find it (Netflix, HBO, Amazon, etc.)"
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
  setStatus('Consulting your watch history...');

  const { chips, custom } = getActiveMoods();
  const moodText = chips.length > 0 || custom
    ? `Mood filters: ${chips.join(', ')}${custom ? '. Additional context: ' + custom : ''}`
    : 'No specific mood — just pick something great.';

  // Pick the right watched list based on mode
  const isShows = currentMode === 'shows';
  const relevantTitles = isShows ? watchedShowTitles : watchedMovieTitles;
  const watchedList = [...relevantTitles].slice(0, 800).join(', ');
  const seenList = [...seenThisSession].join(', ');

  const prompt = buildPrompt(currentMode, watchedList, seenList, moodText);

  try {
    const text = await api.getRecommendation(prompt);
    const clean = text.replace(/```json|```/g, '').trim();
    const rec = JSON.parse(clean);
    lastRec = rec;
    seenThisSession.add(rec.title.toLowerCase());
    displayResult(rec);
    setLoading(false);
    setStatus('');
  } catch (err) {
    setLoading(false);
    setStatus('');
    showError('Error: ' + err.message);
  }
}

function displayResult(rec) {
  document.getElementById('resYear').textContent = rec.year;
  document.getElementById('resTitle').textContent = rec.title;
  document.getElementById('resSynopsis').textContent = rec.synopsis;
  document.getElementById('resWhy').textContent = rec.why;
  document.getElementById('resWhere').textContent = rec.where;

  const meta = document.getElementById('resMeta');
  meta.innerHTML = '';
  if (rec.runtime) meta.innerHTML += `<span class="meta-tag">${rec.runtime}</span>`;
  (rec.genres || []).forEach(g => meta.innerHTML += `<span class="meta-tag">${g}</span>`);

  const card = document.getElementById('resultCard');
  card.style.display = 'block';
  card.style.animation = 'none';
  card.offsetHeight;
  card.style.animation = 'fadeUp 0.4s ease forwards';

  const nextLabel = { documentaries: 'Next Documentary →', movies: 'Next Movie →', shows: 'Next Show →' };
  card.querySelector('.result-actions .btn-primary').textContent = nextLabel[currentMode];

  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function markSeen() {
  if (lastRec) {
    seenThisSession.add(lastRec.title.toLowerCase());
    if (currentMode === 'shows') {
      watchedShowTitles.add(lastRec.title.toLowerCase());
    } else {
      watchedMovieTitles.add(lastRec.title.toLowerCase());
    }
    document.getElementById('resultCard').style.display = 'none';
    setStatus(`Marked "${lastRec.title}" as seen. Click Pick to get a new recommendation.`);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init().catch(console.error);

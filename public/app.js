/* =====================================================================
   SinepilStream — frontend
   History & Wishlist: localStorage (per-browser, no account needed)
   Player: resolved server-side at scrape time; finalUrl baked into each
   player object (direct embed, or /api/proxy when CSP blocks direct framing).
   ===================================================================== */

/* ---- localStorage helpers ---- */
const LS = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

const HISTORY_KEY        = 'spilstream_history';
const WISHLIST_KEY       = 'spilstream_wishlist';
const RECENT_SEARCH_KEY  = 'spilstream_recent_searches'; // per-browser only, never synced
const SYNC_TOKEN_KEY     = 'spilstream_sync_token';   // auth — opaque 64-hex string
const SYNC_CODE_KEY      = 'spilstream_sync_code';    // display only — may expire
const SYNC_EXP_KEY       = 'spilstream_sync_code_expires_at';
const RECENT_SEARCH_MAX  = 10;

// Hook called after any History/Wishlist mutation. Wired up by Sync below;
// guarded with try/catch so calls before Sync init don't throw (TDZ).
function notifyStateChange() {
  try { if (Sync && Sync.token) Sync.pushDebounced(); } catch {}
}

/* ---- History (localStorage) ---- */
const History = {
  all: () => LS.get(HISTORY_KEY),
  has: (slug) => LS.get(HISTORY_KEY).some(m => m.slug === slug),
  upsert: (movie) => {
    let list = LS.get(HISTORY_KEY).filter(m => m.slug !== movie.slug);
    list.unshift({ ...movie, watched_at: new Date().toISOString() });
    if (list.length > 200) list = list.slice(0, 200); // keep latest 200
    LS.set(HISTORY_KEY, list);
    notifyStateChange();
  },
  remove: (slug) => {
    LS.set(HISTORY_KEY, LS.get(HISTORY_KEY).filter(m => m.slug !== slug));
    notifyStateChange();
  },
  clear:  () => { LS.set(HISTORY_KEY, []); notifyStateChange(); },
};

/* ---- Wishlist (localStorage) ---- */
const Wishlist = {
  all: () => LS.get(WISHLIST_KEY),
  has: (slug) => LS.get(WISHLIST_KEY).some(m => m.slug === slug),
  add: (movie) => {
    if (Wishlist.has(movie.slug)) return;
    const list = LS.get(WISHLIST_KEY);
    list.unshift({ ...movie, added_at: new Date().toISOString() });
    LS.set(WISHLIST_KEY, list);
    notifyStateChange();
  },
  remove: (slug) => {
    LS.set(WISHLIST_KEY, LS.get(WISHLIST_KEY).filter(m => m.slug !== slug));
    notifyStateChange();
  },
  toggle: (movie) => {
    if (Wishlist.has(movie.slug)) { Wishlist.remove(movie.slug); return false; }
    Wishlist.add(movie); return true;
  },
};

/* ---- Recent searches (per-browser only, never synced) ----
   Stored as an array of query strings, newest first. Dedupes case-insensitively
   on add and caps at RECENT_SEARCH_MAX. Distinct from watch history so a user
   who searches but never clicks still gets a re-runnable trail. */
const RecentSearches = {
  all: () => LS.get(RECENT_SEARCH_KEY),
  add: (q) => {
    const v = String(q || '').trim();
    if (!v) return;
    const lc = v.toLowerCase();
    const list = LS.get(RECENT_SEARCH_KEY).filter(x => x.toLowerCase() !== lc);
    list.unshift(v);
    LS.set(RECENT_SEARCH_KEY, list.slice(0, RECENT_SEARCH_MAX));
  },
  remove: (q) => {
    const lc = String(q || '').toLowerCase();
    LS.set(RECENT_SEARCH_KEY, LS.get(RECENT_SEARCH_KEY).filter(x => x.toLowerCase() !== lc));
  },
  clear: () => LS.set(RECENT_SEARCH_KEY, []),
};

/* ---- Cross-device sync ----
   Auth model:
     - token  → 64-hex device credential. Long-lived. Used for every push/pull.
     - code   → 6-char pairing PIN. Short-lived (24h). Only used to bring a new
                device onto an existing slot. Expires independently of token.
     - expiry → ISO timestamp; used purely for UI display.
   Anyone with a valid (unexpired) code can pair. Any device with a token has
   full access until disconnected. Server merges per-slug LWW on push.
*/
const Sync = {
  get token()      { return localStorage.getItem(SYNC_TOKEN_KEY) || ''; },
  set token(t)     { t ? localStorage.setItem(SYNC_TOKEN_KEY, t) : localStorage.removeItem(SYNC_TOKEN_KEY); },
  get code()       { return localStorage.getItem(SYNC_CODE_KEY) || ''; },
  set code(c)      { c ? localStorage.setItem(SYNC_CODE_KEY, c) : localStorage.removeItem(SYNC_CODE_KEY); },
  get codeExpires(){ return localStorage.getItem(SYNC_EXP_KEY) || ''; },
  set codeExpires(e){ e ? localStorage.setItem(SYNC_EXP_KEY, e) : localStorage.removeItem(SYNC_EXP_KEY); },

  isCodeActive() {
    return Sync.code && Sync.codeExpires && Sync.codeExpires > new Date().toISOString();
  },

  _saveCreds({ token, code, code_expires_at }) {
    if (token)            Sync.token       = token;
    if (code)             Sync.code        = code;
    if (code_expires_at)  Sync.codeExpires = code_expires_at;
    try { refreshSyncIndicator(); } catch {}
  },

  _clearCreds() {
    Sync.token       = '';
    Sync.code        = '';
    Sync.codeExpires = '';
    try { refreshSyncIndicator(); } catch {}
  },

  async _post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      const e = new Error(data.error || `Request failed (${r.status})`);
      e.status = r.status;
      throw e;
    }
    return r.status === 204 ? null : r.json();
  },

  async createNew() {
    const data = await Sync._post('/api/sync/create');
    Sync._saveCreds(data);
    await Sync.push();          // seed the new slot with this device's state
    return data;
  },

  async pair(rawCode) {
    const code = String(rawCode || '').toUpperCase().trim();
    const data = await Sync._post('/api/sync/pair', { code });
    Sync.token = data.token;
    // We have the code in hand already; store it for display. Expiry unknown
    // post-pair (server doesn't surface it here) — user can regenerate if needed.
    Sync.code = code;
    Sync.codeExpires = '';
    try { refreshSyncIndicator(); } catch {}
    // Merge — must NOT replace, or we'd nuke this device's pre-pair history.
    Sync._mergeIntoLocal(data.payload || {});
    Sync._refreshUI();
    // Push the union. Server merges idempotently and returns canonical state.
    await Sync.push();
  },

  // Server returns a fully-merged blob; replace local with it.
  _applyServerPayload(payload) {
    const h = Array.isArray(payload.history)  ? payload.history  : [];
    const w = Array.isArray(payload.wishlist) ? payload.wishlist : [];
    LS.set(HISTORY_KEY,  h);
    LS.set(WISHLIST_KEY, w);
  },

  async push() {
    if (!Sync.token) return;
    try {
      const data = await Sync._post('/api/sync/push', {
        token:   Sync.token,
        payload: { v: 1, history: History.all(), wishlist: Wishlist.all() },
      });
      // Authoritative merged result from the server — adopt it. May contain entries
      // a sibling device pushed while we were offline.
      const before = JSON.stringify({ h: History.all(), w: Wishlist.all() });
      Sync._applyServerPayload(data.payload || {});
      const after  = JSON.stringify({ h: History.all(), w: Wishlist.all() });
      if (before !== after) Sync._refreshUI();
    } catch (e) {
      // Token revoked from another device — clear locally so the user can re-pair.
      if (e.status === 401) Sync._clearCreds();
    }
  },

  pushDebounced() {
    clearTimeout(Sync._t);
    Sync._t = setTimeout(() => Sync.push(), 1500);
  },

  async syncOnLoad() {
    if (!Sync.token) return;
    try {
      const data = await Sync._pull();
      // Merge remote into local, push the union, server returns the canonical merged blob.
      Sync._mergeIntoLocal(data.payload || {});
      Sync._refreshUI();
      Sync.push();
    } catch (e) {
      if (e.status === 401) Sync._clearCreds();
    }
  },

  // Lightweight pull when the tab becomes visible — picks up sibling-device
  // changes without requiring a full reload. No push back: nothing changed
  // locally, so there's nothing for the server to learn from us.
  async pullIfVisible() {
    if (!Sync.token) return;
    const now = Date.now();
    if (now - (Sync._lastPull || 0) < 2000) return;  // debounce rapid focus toggles
    Sync._lastPull = now;
    try {
      const data = await Sync._pull();
      Sync._mergeIntoLocal(data.payload || {});
      Sync._refreshUI();
    } catch (e) {
      if (e.status === 401) Sync._clearCreds();
    }
  },

  _mergeIntoLocal(remote) {
    const remoteH = Array.isArray(remote.history)  ? remote.history  : [];
    const remoteW = Array.isArray(remote.wishlist) ? remote.wishlist : [];
    LS.set(HISTORY_KEY,  mergeByTimestamp(LS.get(HISTORY_KEY),  remoteH, 'watched_at'));
    LS.set(WISHLIST_KEY, mergeByTimestamp(LS.get(WISHLIST_KEY), remoteW, 'added_at'));
  },

  _refreshUI() {
    renderContinueWatching('movie');
    renderContinueWatching('series');
    if (document.getElementById('sec-history')?.classList.contains('active')) renderHistory();
    if (document.getElementById('sec-wishlist')?.classList.contains('active')) renderWishlist();
  },

  // /pull is a GET; token goes in Authorization header (NOT the query string —
  // query strings leak into access logs, browser history, and Referer headers).
  async _pull() {
    const r = await fetch('/api/sync/pull', {
      headers: { Authorization: 'Bearer ' + Sync.token },
    });
    if (!r.ok) {
      const e = new Error('Pull failed'); e.status = r.status; throw e;
    }
    return r.json();
  },

  async regenerateCode() {
    const data = await Sync._post('/api/sync/regenerate', { token: Sync.token });
    Sync.code        = data.code;
    Sync.codeExpires = data.code_expires_at;
    return data;
  },

  async disconnect() {
    const t = Sync.token;
    Sync._clearCreds();
    if (t) {
      try { await Sync._post('/api/sync/disconnect', { token: t }); } catch {}
    }
  },
};

// Merge two slug-keyed lists, keeping the newer record per slug.
// ISO-8601 timestamps compare correctly with string comparison.
function mergeByTimestamp(local, remote, tsKey) {
  const map = new Map();
  for (const item of local)  if (item?.slug) map.set(item.slug, item);
  for (const item of remote) {
    if (!item?.slug) continue;
    const existing = map.get(item.slug);
    if (!existing || (item[tsKey] || '') > (existing[tsKey] || '')) {
      map.set(item.slug, item);
    }
  }
  return [...map.values()].sort((a, b) =>
    String(b[tsKey] || '').localeCompare(String(a[tsKey] || ''))
  );
}

/* ---- State ---- */
let currentMovie   = null;      // Movie OR series record currently open in modal
let currentPlayers = [];
let descExpanded   = false;
let currentKind    = 'movie';   // 'movie' | 'series'
let currentSeries  = null;      // full series record (with seasons) when kind === 'series'
let currentEpisode = null;      // { season, episode } when a series episode is loaded

/* ---- Migration: older localStorage entries have no `kind` — default to movie ---- */
(function migrateKinds() {
  for (const k of [HISTORY_KEY, WISHLIST_KEY]) {
    const list = LS.get(k);
    let changed = false;
    for (const item of list) {
      if (!item.kind) { item.kind = 'movie'; changed = true; }
    }
    if (changed) LS.set(k, list);
  }
})();

/* ---- Tab switching ---- */
let activeTab = 'browse';
function showTab(name) {
  activeTab = name;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('sec-' + name)?.classList.add('active');
  // 'search' has no nav-tab anymore — typing in the bar drives navigation directly.
  document.getElementById('tab-' + name)?.classList.add('active');
  document.getElementById('browse-bar').style.display        = (name === 'browse') ? 'flex' : 'none';
  document.getElementById('series-filter-bar').style.display = (name === 'series') ? 'flex' : 'none';
  if (name === 'browse')   renderContinueWatching('movie');
  if (name === 'series')   renderContinueWatching('series');
  if (name === 'history')  renderHistory();
  if (name === 'wishlist') renderWishlist();
  if (name === 'series' && !document.getElementById('series-rails').dataset.loaded) {
    loadHomeRails('series-rails', 'series');
    document.getElementById('series-rails').dataset.loaded = '1';
  }
  updateTabChrome(name);
}

// Update placeholders/labels so the search + watch-by-url bars reflect the
// currently active tab. Purely cosmetic — search/URL endpoints themselves
// accept either kind.
function updateTabChrome(name) {
  const searchInput = document.getElementById('search-input');
  const urlInput    = document.getElementById('url-input');
  const urlLabel    = document.querySelector('.url-bar-label');

  if (name === 'series') {
    searchInput.placeholder = 'Search series…';
    urlInput.placeholder = 'Paste a nontondrama.my series or episode link to watch…';
    if (urlLabel) urlLabel.innerHTML = '&#128279; Watch series by URL:';
  } else if (name === 'browse') {
    searchInput.placeholder = 'Search movies…';
    urlInput.placeholder = 'Paste a lk21official.cc link here to watch without ads…';
    if (urlLabel) urlLabel.innerHTML = '&#128279; Watch movie by URL:';
  } else {
    // history / wishlist / search — keep generic wording
    searchInput.placeholder = 'Search movies or series…';
    urlInput.placeholder = 'Paste any lk21 movie or nontondrama series link…';
    if (urlLabel) urlLabel.innerHTML = '&#128279; Watch by URL:';
  }
}

/* ---- Browse / Filter ----
   No filter → show the home rails (Latest / Action / Drama / ...).
   Any filter → hide rails, show a single flat grid for that filter. */
function applyFilter() {
  const genre   = document.getElementById('filter-genre').value;
  const country = document.getElementById('filter-country').value;
  const year    = document.getElementById('filter-year').value;
  const path    = genre || country || year || '';

  const railsEl    = document.getElementById('home-rails');
  const filteredEl = document.getElementById('browse-filtered');
  const clearBtn   = document.querySelector('#browse-bar .filter-clear');

  if (!path) {
    railsEl.style.display = '';
    filteredEl.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
    loadHomeRails('home-rails', 'movie');
    return;
  }

  railsEl.style.display = 'none';
  filteredEl.style.display = '';
  if (clearBtn) clearBtn.style.display = '';
  const label = path.split('/').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  document.getElementById('browse-title').textContent = label;
  loadGrid('browse-grid', `/api/browse?path=${encodeURIComponent(path)}`);
}

function clearMovieFilter() {
  ['filter-genre', 'filter-country', 'filter-year'].forEach(id => {
    document.getElementById(id).value = '';
  });
  applyFilter();
}

function applySeriesFilter() {
  const genre = document.getElementById('series-filter-genre').value;
  const year  = document.getElementById('series-filter-year').value;
  const path  = genre || year || '';

  const railsEl    = document.getElementById('series-rails');
  const filteredEl = document.getElementById('series-filtered');
  const clearBtn   = document.querySelector('#series-filter-bar .filter-clear');

  if (!path) {
    railsEl.style.display = '';
    filteredEl.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
    // Rails for series are loaded on first tab switch (cached in dataset.loaded)
    return;
  }

  railsEl.style.display = 'none';
  filteredEl.style.display = '';
  if (clearBtn) clearBtn.style.display = '';
  const label = path.split('/').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  document.getElementById('series-title').textContent = label;
  loadGrid('series-grid', `/api/browse/series?path=${encodeURIComponent(path)}`);
}

function clearSeriesFilter() {
  ['series-filter-genre', 'series-filter-year'].forEach(id => {
    document.getElementById(id).value = '';
  });
  applySeriesFilter();
}

/* ---- Search (always covers both movies + series, regardless of active tab) ---- */
async function doSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;
  RecentSearches.add(q);   // only save committed (Enter/click) searches, not every keystroke
  hideSearchHistory();
  showTab('search');
  loadGrid('search-grid', `/api/search?q=${encodeURIComponent(q)}`, 'search-count');
}

/* ---- Recent-search dropdown ---- */
function renderSearchHistory() {
  const panel = document.getElementById('search-history');
  if (!panel) return;
  const items = RecentSearches.all();
  if (items.length === 0) { panel.innerHTML = ''; panel.classList.remove('open'); return; }
  panel.innerHTML = `
    <div class="sh-header">
      <span>Recent searches</span>
      <button type="button" class="sh-clear" data-action="clearRecentSearches">Clear all</button>
    </div>
    <ul class="sh-list">
      ${items.map(q => `
        <li class="sh-item">
          <button type="button" class="sh-run" data-action="runRecentSearch" data-q="${esc(q)}">
            <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="9" cy="9" r="6"/><line x1="14" y1="14" x2="18" y2="18"/>
            </svg>
            <span>${esc(q)}</span>
          </button>
          <button type="button" class="sh-x" data-action="removeRecentSearch" data-q="${esc(q)}" aria-label="Remove">&#x2715;</button>
        </li>
      `).join('')}
    </ul>`;
}
function showSearchHistory() {
  const panel = document.getElementById('search-history');
  if (!panel) return;
  renderSearchHistory();
  if (RecentSearches.all().length > 0) panel.classList.add('open');
}
function hideSearchHistory() {
  document.getElementById('search-history')?.classList.remove('open');
}
function runRecentSearch(q) {
  const input = document.getElementById('search-input');
  if (!input) return;
  input.value = q;
  doSearch();
}
function removeRecentSearch(q) {
  RecentSearches.remove(q);
  renderSearchHistory();
  // If panel emptied, also close it
  if (RecentSearches.all().length === 0) hideSearchHistory();
}
function clearRecentSearches() {
  RecentSearches.clear();
  hideSearchHistory();
}

// Debounced live search. Every keystroke cancels the previous timer + any
// in-flight fetch, so we only hit the API once the user pauses typing.
let _searchDebounceT = null;
let _searchAbortCtl  = null;
const SEARCH_DEBOUNCE_MS = 300;
function liveSearch() {
  const q = document.getElementById('search-input').value.trim();
  clearTimeout(_searchDebounceT);
  if (_searchAbortCtl) _searchAbortCtl.abort();

  if (!q) {
    // Cleared the box — if the user is on the search tab, send them back.
    if (activeTab === 'search') showTab('browse');
    return;
  }
  if (q.length < 2) return;   // one char is noise; wait for 2+

  _searchDebounceT = setTimeout(async () => {
    showTab('search');
    const grid  = document.getElementById('search-grid');
    const badge = document.getElementById('search-count');
    grid.innerHTML = Array(12).fill(SKELETON_CARD).join('');
    badge.textContent = '';
    _searchAbortCtl = new AbortController();
    try {
      const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: _searchAbortCtl.signal });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      badge.textContent = data.length || '';
      grid.innerHTML = data.length
        ? data.map(m => cardHTML(m)).join('')
        : emptyHTML('No results found — try adding a year (e.g. "batman 2012") or browse by genre instead');
      attachCardEvents(grid);
    } catch (e) {
      if (e.name === 'AbortError') return;  // superseded by a newer keystroke
      grid.innerHTML = emptyHTML('Failed to search: ' + e.message);
    }
  }, SEARCH_DEBOUNCE_MS);
}

/* ---- Watch by URL (accepts source movie URLs + source series/episode URLs) ---- */
async function watchByUrl() {
  const input = document.getElementById('url-input');
  const url = input.value.trim();
  if (!url) return;
  const res = await fetch(`/api/slug-from-url?url=${encodeURIComponent(url)}`);
  const data = await res.json();
  if (res.ok && data.slug) {
    input.value = '';
    if (data.kind === 'series') {
      openSeries(data.slug, data.episode ? { autoEpisode: { season: data.season, episode: data.episode } } : {});
    } else {
      openMovie(data.slug);
    }
    return;
  }
  toast('URL not recognised — must be a lk21 movie or nontondrama series link');
}

/* ---- Skeleton card placeholder ---- */
const SKELETON_CARD = `
  <div class="card card-skeleton" aria-hidden="true">
    <div class="card-img-wrap"></div>
    <div class="card-body">
      <div class="skeleton-line"></div>
      <div class="skeleton-line skeleton-line--short"></div>
    </div>
  </div>`;

/* ---- Client-side recommendations ----
   Cheap genre-overlap ranker. Reads History from localStorage, tallies
   genre frequencies, then picks unwatched items from the rails that match
   the user's top genres. Stays on the client — no server impact. */
const RECS_MIN_HISTORY   = 3;
const RECS_MAX_ITEMS     = 20;
const RECS_TOP_N_GENRES  = 3;

function parseGenres(s) {
  return (s || '').split(',').map(g => g.trim().toLowerCase()).filter(Boolean);
}

function topGenresFromHistory(kind) {
  const counts = new Map();
  History.all()
    .filter(h => (h.kind || 'movie') === kind)
    .forEach(h => parseGenres(h.genre).forEach(g => counts.set(g, (counts.get(g) || 0) + 1)));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, RECS_TOP_N_GENRES)
    .map(([g]) => g);
}

// Given all items that appear anywhere in the rails, score each by how many
// of its genres are in the user's top genres. Excludes things they've opened.
function buildRecommendations(rails, kind) {
  const history = History.all().filter(h => (h.kind || 'movie') === kind);
  if (history.length < RECS_MIN_HISTORY) return null;

  const topGenres = topGenresFromHistory(kind);
  if (topGenres.length === 0) return null;

  const seenSlugs = new Set(history.map(h => h.slug));
  const bySlug = new Map();
  for (const rail of rails) {
    for (const item of rail.items) {
      if (seenSlugs.has(item.slug)) continue;
      if (bySlug.has(item.slug)) continue;
      const genres = parseGenres(item.genre);
      const score  = genres.filter(g => topGenres.includes(g)).length;
      if (score > 0) bySlug.set(item.slug, { item, score });
    }
  }

  const ranked = [...bySlug.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, RECS_MAX_ITEMS)
    .map(r => r.item);

  if (ranked.length === 0) return null;
  return { id: 'recs', title: 'For You', items: ranked };
}

/* ---- Home rails (Phase 6): stacked horizontal-scroll rows ---- */
const RAIL_SKELETON_COUNT = 6;

function railSkeletonHTML(title) {
  const cards = Array(RAIL_SKELETON_COUNT).fill(SKELETON_CARD).join('');
  return `
    <div class="home-rail">
      <div class="section-header">
        <span class="section-title">${esc(title)}</span>
      </div>
      <div class="rail-scroll">${cards}</div>
    </div>`;
}

async function loadHomeRails(containerId, kind) {
  const el = document.getElementById(containerId);
  if (!el) return;

  // Show placeholder rails immediately so the layout doesn't jump in.
  el.innerHTML = ['Latest', 'Action', 'Drama', 'Released 2026']
    .map(railSkeletonHTML).join('');

  try {
    const res   = await fetch(`/api/home?kind=${encodeURIComponent(kind)}`);
    const rails = await res.json();
    if (!Array.isArray(rails) || rails.length === 0) {
      el.innerHTML = emptyHTML('Nothing to show yet — try a genre filter.');
      return;
    }

    // Client-side recommendation rail — stitched in at the top if the user
    // has enough watch history to make the ranking meaningful.
    const recs = buildRecommendations(rails, kind);
    const allRails = recs ? [recs, ...rails] : rails;

    el.innerHTML = allRails.map(rail => `
      <div class="home-rail" data-rail-id="${esc(rail.id)}">
        <div class="section-header">
          <span class="section-title">${esc(rail.title)}</span>
        </div>
        <div class="rail-wrap">
          <button class="rail-arrow rail-arrow-left"  aria-label="Scroll left"  data-action="railScroll" data-dir="-1">&lsaquo;</button>
          <div class="rail-scroll">${rail.items.map(m => cardHTML(m)).join('')}</div>
          <button class="rail-arrow rail-arrow-right" aria-label="Scroll right" data-action="railScroll" data-dir="1">&rsaquo;</button>
        </div>
      </div>
    `).join('');
    el.querySelectorAll('.rail-scroll').forEach(attachCardEvents);
    el.querySelectorAll('.rail-wrap').forEach(updateRailArrows);
  } catch (e) {
    el.innerHTML = emptyHTML('Failed to load home: ' + e.message);
  }
}

// Scroll handler for the arrow buttons (wired via data-action="railScroll").
function syncRailArrows(wrap) {
  const strip = wrap.querySelector('.rail-scroll');
  const left  = wrap.querySelector('.rail-arrow-left');
  const right = wrap.querySelector('.rail-arrow-right');
  if (!strip || !left || !right) return;
  const maxScroll = strip.scrollWidth - strip.clientWidth;
  const atStart = strip.scrollLeft <= 2;
  const atEnd   = strip.scrollLeft >= maxScroll - 2;
  left.classList.toggle('rail-arrow-hidden', atStart);
  right.classList.toggle('rail-arrow-hidden', atEnd);
  // Defence-in-depth: even if a stale CSS cache leaves the button visible,
  // the `disabled` attribute makes the click a no-op (no bounce).
  left.disabled  = atStart;
  right.disabled = atEnd;
}

function railScroll(btn) {
  const dir   = parseInt(btn.dataset.dir, 10) || 1;
  const wrap  = btn.closest('.rail-wrap');
  const strip = wrap?.querySelector('.rail-scroll');
  if (!strip) return;
  // Belt-and-suspenders: bail out if we're already at the boundary, so a
  // misaligned arrow visibility can't produce the "slides then bounces back" UX.
  const maxScroll = strip.scrollWidth - strip.clientWidth;
  if (dir < 0 && strip.scrollLeft <= 2)             return;
  if (dir > 0 && strip.scrollLeft >= maxScroll - 2) return;
  // Scroll by ~85% of the visible width so the user sees a fresh batch
  // without losing context.
  const delta = strip.clientWidth * 0.85 * dir;
  strip.scrollBy({ left: delta, behavior: 'smooth' });
}

// Show/hide each arrow depending on whether there's more to scroll that way.
function updateRailArrows(wrap) {
  const strip = wrap.querySelector('.rail-scroll');
  if (!strip) return;
  const sync = () => syncRailArrows(wrap);
  sync();
  // Belt-and-suspenders: scrollWidth can be stale before the first paint;
  // re-sync on the next animation frame + after lazy images settle.
  requestAnimationFrame(sync);
  strip.addEventListener('scroll', sync, { passive: true });
  setTimeout(sync, 400);
  window.addEventListener('resize', sync);
}

/* ---- Generic grid loader ---- */
async function loadGrid(gridId, apiUrl, badgeId) {
  const grid = document.getElementById(gridId);
  grid.innerHTML = Array(12).fill(SKELETON_CARD).join('');
  if (badgeId) document.getElementById(badgeId).textContent = '';
  try {
    const res  = await fetch(apiUrl);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (badgeId) document.getElementById(badgeId).textContent = data.length || '';
    grid.innerHTML = data.length
      ? data.map(m => cardHTML(m)).join('')
      : emptyHTML('No results found — try adding a year (e.g. "batman 2012") or browse by genre/year instead');
    attachCardEvents(grid);
  } catch (e) {
    grid.innerHTML = emptyHTML('Failed to load: ' + e.message);
  }
}

/* ---- History rendering ---- */
function renderHistory() {
  const grid = document.getElementById('history-grid');
  const data  = History.all();
  grid.innerHTML = data.length
    ? data.map(m => cardHTML(m, { showDelete: true, ctx: 'history' })).join('')
    : emptyHTML('No watch history yet');
  attachCardEvents(grid, 'history');
}

/* ---- Recently Watched rail (filtered by kind to match the active tab) ---- */
const RECENTLY_WATCHED_MAX = 12;
function renderContinueWatching(kind = 'movie') {
  // Each tab has its own rail; we render into the one matching `kind`.
  const wrapId = kind === 'series' ? 'continue-watching-series' : 'continue-watching';
  const gridId = wrapId + '-grid';
  const wrap = document.getElementById(wrapId);
  const grid = document.getElementById(gridId);
  if (!wrap || !grid) return;

  const items = History.all()
    .filter(m => (m.kind || 'movie') === kind)
    .slice(0, RECENTLY_WATCHED_MAX);

  if (items.length === 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  // Every card here is watched by definition — hide the tick to avoid noise.
  // For series with a resume point, surface "S2 E5" so users know where they'll pick up.
  grid.innerHTML = items.map(m => {
    const ls = parseInt(m.lastSeason, 10);
    const le = parseInt(m.lastEpisode, 10);
    const progressBadge = (m.kind === 'series' && ls > 0 && le > 0)
      ? `S${ls} E${le}`
      : null;
    return cardHTML(m, { hideWatchedBadge: true, progressBadge });
  }).join('');
  attachCardEvents(grid);
}

async function clearHistory() {
  if (!confirm('Clear all watch history?')) return;
  History.clear();
  renderHistory();
  renderContinueWatching('movie');
  renderContinueWatching('series');
  toast('History cleared');
}

/* ---- Wishlist rendering ---- */
function renderWishlist() {
  const grid  = document.getElementById('wishlist-grid');
  const badge = document.getElementById('wishlist-count');
  const data  = Wishlist.all();
  badge.textContent = data.length || '';
  grid.innerHTML = data.length
    ? data.map(m => cardHTML(m, { showDelete: true, ctx: 'wishlist' })).join('')
    : emptyHTML('Your wishlist is empty');
  attachCardEvents(grid, 'wishlist');
}

/* ---- Card HTML ---- */
function cardHTML(m, opts = {}) {
  const kind = m.kind === 'series' ? 'series' : 'movie';
  // Source gives us `total_seasons` + `total_episodes` where `total_episodes`
  // is actually "latest episode in the latest season" — misleading for
  // multi-season shows. Prefer the seasons count when > 1.
  // For series in Recently Watched (opts.progressBadge), show resume point
  // ("S2 E5") instead of the static SEASONS/EPS count — tells the user where
  // they'll pick up at a glance.
  // Numeric coercion + esc guards against poisoned sync payloads / scraped values
  const totalSeasons  = parseInt(m.total_seasons, 10)  || 0;
  const totalEpisodes = parseInt(m.total_episodes, 10) || 0;
  const seriesBadgeText = opts.progressBadge
    || (totalSeasons > 1
      ? `${totalSeasons} SEASONS`
      : totalEpisodes
        ? `EPS ${totalEpisodes}`
        : 'SERIES');
  const kindBadge = kind === 'series'
    ? `<span class="card-kind">${esc(seriesBadgeText)}</span>`
    : '';
  const watchedBadge = (!opts.hideWatchedBadge && History.has(m.slug))
    ? '<span class="card-watched" title="Watched">&#10003;</span>' : '';
  // load / error listeners wired up in attachCardEvents — inline event
  // handlers would violate our CSP (script-src-attr 'none').
  // Watched badge nests inside the image wrapper so it sits on the poster,
  // not under the card title block.
  const poster = m.poster
    ? `<div class="card-img-wrap">
         <img class="card-img" src="${esc(m.poster)}" alt="${esc(m.title)}" loading="lazy">
         ${watchedBadge}
       </div>`
    : '';
  const placeholder = `<div class="card-img-placeholder" ${m.poster ? 'style="display:none"' : ''}>&#127916;</div>`;
  // Fallback: no poster → render badge directly on the card
  const looseBadge = !m.poster ? watchedBadge : '';
  const stars = m.rating ? `<span class="card-rating">&#9733; ${esc(m.rating)}</span>` : '';
  const year  = m.year   ? `<span class="card-year">${esc(m.year)}</span>` : '';

  let actions = '';
  if (opts.showDelete) {
    actions = `
      <div class="card-actions">
        <button class="card-btn" title="Remove"
          data-action="remove" data-ctx="${esc(opts.ctx || '')}" data-slug="${esc(m.slug)}">&#x2715;</button>
      </div>`;
  } else {
    // Use data-* attribute (HTML-safe for any character) to carry the movie JSON.
    // Embedding JSON in onclick="…" breaks for titles containing apostrophes
    // because esc() turns ' into &#x27; which the browser decodes back to ' BEFORE
    // the JS parser sees it, terminating the string literal early.
    const isWl = Wishlist.has(m.slug);
    actions = `
      <div class="card-actions">
        <button class="card-btn${isWl ? ' active' : ''}" title="Wishlist"
          data-action="wishlist" data-movie="${esc(JSON.stringify(m))}">${isWl ? '&#9829;' : '&#9825;'}</button>
      </div>`;
  }

  return `
    <div class="card" role="button" tabindex="0"
         title="${esc(m.title)}"
         aria-label="${esc(m.title)}"
         data-slug="${esc(m.slug)}" data-kind="${esc(kind)}">
      ${poster}${placeholder}
      ${kindBadge}
      ${looseBadge}
      ${actions}
      <div class="card-body">
        <div class="card-title">${esc(m.title)}</div>
        <div class="card-meta">${stars}${year}</div>
      </div>
    </div>`;
}

function attachCardEvents(grid) {
  // Wire up load / error handlers on each freshly-rendered image and also
  // handle the cached case (load event fired before the listener attached →
  // we detect with `complete && naturalWidth`).
  grid.querySelectorAll('img.card-img').forEach(img => {
    const markLoaded = () => {
      img.classList.add('loaded');
      img.parentElement?.classList.add('loaded');
    };
    const markError = () => {
      const wrap = img.parentElement;
      if (wrap) wrap.style.display = 'none';
      wrap?.nextElementSibling?.style.setProperty('display', 'flex');
    };
    if (img.complete && img.naturalWidth > 0) markLoaded();
    else if (img.complete) markError();
    else {
      img.addEventListener('load', markLoaded, { once: true });
      img.addEventListener('error', markError, { once: true });
    }
  });

  grid.querySelectorAll('.card').forEach(card => {
    const activate = (e) => {
      // Action buttons inside the card carry data-action; let them handle
      // the click/key and DON'T open the modal in that case.
      const btn = e.target.closest('[data-action]');
      if (btn) {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'wishlist') {
          try { quickWishlist(btn, JSON.parse(btn.dataset.movie)); }
          catch (err) { console.error('wishlist parse error', err); }
        } else if (action === 'remove') {
          removeItem(btn.dataset.ctx, btn.dataset.slug);
        }
        return;
      }
      openItem(card.dataset.slug, card.dataset.kind || 'movie');
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate(e);
      }
    });
  });
}

function openItem(slug, kind) {
  if (kind === 'series') return openSeries(slug);
  return openMovie(slug);
}

/* ---- Remove from history/wishlist ---- */
function removeItem(ctx, slug) {
  if (ctx === 'wishlist') { Wishlist.remove(slug); renderWishlist(); toast('Removed from wishlist'); }
  else                    { History.remove(slug);  renderHistory();  renderContinueWatching('movie');  renderContinueWatching('series');  toast('Removed from history'); }
}

/* ---- Quick wishlist toggle from card ---- */
function quickWishlist(btn, movie) {
  // Accept either a parsed object (new code path) or a JSON string (legacy callers).
  if (typeof movie === 'string') {
    try { movie = JSON.parse(movie); } catch { return; }
  }
  if (!movie?.slug) return;
  const added = Wishlist.toggle(movie);
  btn.classList.toggle('active', added);
  // Swap outline ♡ → filled ♥ to match the convention everyone knows from
  // Twitter / Instagram / Pinterest / Apple Music.
  btn.innerHTML = added ? '&#9829;' : '&#9825;';
  toast(added ? `Added "${movie.title}" to wishlist` : 'Removed from wishlist');
}

/* ---- Reset modal to a neutral state before loading a new item ---- */
function resetModalChrome() {
  currentMovie   = null;
  currentSeries  = null;
  currentEpisode = null;
  currentPlayers = [];
  descExpanded   = false;

  document.getElementById('modal-overlay').classList.add('open');
  document.body.classList.add('modal-open');
  resetPlayer('Loading…');
  document.getElementById('player-tabs').innerHTML = '';
  const picker = document.getElementById('episode-picker');
  if (picker) picker.style.display = 'none';

  // Show skeleton shimmer in the info pane while scraper fetches upstream.
  // Title/meta/desc/cast get replaced wholesale by renderModal on success,
  // so we don't need to manage a separate teardown.
  document.getElementById('modal-title').innerHTML = '<span class="skeleton-line skeleton-line--title"></span>';
  document.getElementById('modal-meta').innerHTML  = `
    <span class="pill skeleton-pill"></span>
    <span class="pill skeleton-pill"></span>
    <span class="pill skeleton-pill"></span>`;
  document.getElementById('modal-desc').innerHTML  = `
    <span class="skeleton-line"></span>
    <span class="skeleton-line"></span>
    <span class="skeleton-line skeleton-line--short"></span>`;
  document.getElementById('modal-cast').innerHTML  = '';

  const _mp = document.getElementById('modal-poster');
  _mp.classList.remove('loaded');
  _mp.removeAttribute('src');
  document.getElementById('read-more-btn').style.display = 'none';
}

/* ---- Open series modal ---- */
async function openSeries(slug, { pushHistory = true, autoEpisode } = {}) {
  currentKind = 'series';
  if (pushHistory) {
    history.pushState({ slug, kind: 'series' }, '', '/series/' + encodeURIComponent(slug));
  }
  resetModalChrome();

  try {
    const res  = await fetch(`/api/series/${encodeURIComponent(slug)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    currentSeries = data;
    currentMovie  = { ...data, kind: 'series' };

    renderModal({ ...data, duration: '' });

    // Save to history (without episode until the user plays one)
    const existing = History.all().find(m => m.slug === data.slug);
    History.upsert({
      slug: data.slug, title: data.title, poster: data.poster,
      year: data.year, rating: data.rating, genre: data.genre,
      kind: 'series',
      lastSeason: existing?.lastSeason || 0,
      lastEpisode: existing?.lastEpisode || 0,
    });

    renderSeasonSelect(data);

    // Resume strategy:
    //   1. Deep-link autoEpisode wins.
    //   2. Else, if there's history → jump to the *next* episode after last-played
    //      ("Continue from where you left"). If already at the latest, replay it.
    //   3. Else, autoplay S1E1 (TV/remote users can't easily scroll to a picker).
    let startSeason  = autoEpisode?.season  || data.seasons[0]?.season;
    let startEpisode = autoEpisode?.episode || data.seasons[0]?.episodes?.[0]?.episode || null;
    let continuing   = false;
    if (!autoEpisode && existing?.lastSeason && existing?.lastEpisode) {
      const next = nextEpisodeAfter(data.seasons, existing.lastSeason, existing.lastEpisode);
      if (next) {
        startSeason  = next.season;
        startEpisode = next.episode;
        continuing   = true;
      } else {
        // At the end — replay the last one rather than dropping the user back to S1
        startSeason  = existing.lastSeason;
        startEpisode = existing.lastEpisode;
      }
    }
    if (startSeason) {
      document.getElementById('season-select').value = String(startSeason);
      renderEpisodeList();
      if (startEpisode) {
        if (continuing) toast(`Continuing from S${startSeason} E${startEpisode}`, 3000);
        loadEpisode(startSeason, startEpisode);
      } else {
        resetPlayer('Select an episode to start watching');
      }
    } else {
      resetPlayer('No episodes available');
    }
  } catch (e) {
    document.getElementById('modal-title').textContent = 'Error loading series';
    resetPlayer('Error: ' + e.message);
  }
}

function renderSeasonSelect(data) {
  const picker = document.getElementById('episode-picker');
  picker.style.display = 'block';
  const sel = document.getElementById('season-select');
  sel.innerHTML = data.seasons.map(s =>
    `<option value="${s.season}">Season ${s.season} (${s.episodes.length} eps)</option>`
  ).join('');
}

function renderEpisodeList() {
  if (!currentSeries) return;
  const season = parseInt(document.getElementById('season-select').value, 10);
  const s = currentSeries.seasons.find(x => x.season === season);
  const list = document.getElementById('episode-list');
  if (!s) { list.innerHTML = ''; return; }
  list.innerHTML = s.episodes.map(e => {
    const active = currentEpisode?.season === s.season && currentEpisode?.episode === e.episode ? ' active' : '';
    return `<button class="episode-btn${active}"
      data-action="loadEpisode"
      data-season="${s.season}" data-episode="${e.episode}"
      title="${esc(e.title || `Episode ${e.episode}`)}">EP ${e.episode}</button>`;
  }).join('');
}

async function loadEpisode(season, episode) {
  if (!currentSeries) return;
  const status = document.getElementById('episode-status');
  status.textContent = `Loading S${season} E${episode}…`;
  resetPlayer('Loading…');
  document.getElementById('player-tabs').innerHTML = '';

  try {
    const res  = await fetch(`/api/episode/${encodeURIComponent(currentSeries.slug)}/${season}/${episode}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    currentEpisode = { season, episode };
    currentPlayers = sortPlayers(data.players || []);

    // Update history with resume point
    History.upsert({
      slug: currentSeries.slug, title: currentSeries.title, poster: currentSeries.poster,
      year: currentSeries.year, rating: currentSeries.rating, genre: currentSeries.genre,
      kind: 'series', lastSeason: season, lastEpisode: episode,
    });

    renderPlayerTabs();
    renderEpisodeList();      // refresh active highlight
    renderNextEpisodeBtn();
    status.textContent = `S${season} E${episode}`;

    if (currentPlayers.length > 0) loadPlayer(0);
    else resetPlayer('No player sources found for this episode');
  } catch (e) {
    status.textContent = '';
    resetPlayer('Error: ' + e.message);
  }
}

// Find the next episode after (season, episode) in the given seasons array.
// Returns null when there's nothing after — i.e. user is at the latest episode.
function nextEpisodeAfter(seasons, season, episode) {
  if (!seasons || !season || !episode) return null;
  const sIdx = seasons.findIndex(s => s.season === season);
  if (sIdx === -1) return null;

  const eps = seasons[sIdx].episodes;
  const eIdx = eps.findIndex(e => e.episode === episode);
  if (eIdx === -1) return null;

  if (eIdx + 1 < eps.length) {
    return { season, episode: eps[eIdx + 1].episode };
  }
  const nextSeason = seasons[sIdx + 1];
  if (nextSeason && nextSeason.episodes[0]) {
    return { season: nextSeason.season, episode: nextSeason.episodes[0].episode };
  }
  return null;
}

function findNextEpisode() {
  if (!currentSeries || !currentEpisode) return null;
  return nextEpisodeAfter(currentSeries.seasons, currentEpisode.season, currentEpisode.episode);
}

function renderNextEpisodeBtn() {
  const btn = document.getElementById('next-episode-btn');
  if (!btn) return;
  const next = findNextEpisode();
  if (!next) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  btn.innerHTML = `Next &rarr; EP ${next.episode}${next.season !== currentEpisode.season ? ` (S${next.season})` : ''}`;
}

function loadNextEpisode() {
  const next = findNextEpisode();
  if (next) loadEpisode(next.season, next.episode);
}

/* ---- Shared: sort players by reliability ---- */
// StreamWish-family hosts enforce per-file uploader-controlled domain allowlists,
// so they reliably block embedding on sinepil.lori.my.id. Demote any player whose
// resolved URL points at one of these so the default-loaded player (index 0) on
// TV/remote setups isn't a guaranteed "Embedding blocked" page.
const RESTRICTIVE_HOST_RE = /(?:^|\.)(?:streamwish|embedwish|hlswish|playerwish|weneverbeenfree|ajmidyadfihayh)\.[a-z]+$/i;
function isRestrictiveHost(url) {
  try { return RESTRICTIVE_HOST_RE.test(new URL(url).hostname); }
  catch { return false; }
}

function sortPlayers(players) {
  const PRIORITY = ['HYDRAX', 'TURBOVIP', 'CAST'];
  return players.slice().sort((a, b) => {
    const ar = isRestrictiveHost(a.finalUrl || '') ? 1 : 0;
    const br = isRestrictiveHost(b.finalUrl || '') ? 1 : 0;
    if (ar !== br) return ar - br;
    const ai = PRIORITY.indexOf((a.label || '').toUpperCase());
    const bi = PRIORITY.indexOf((b.label || '').toUpperCase());
    return (ai === -1 ? PRIORITY.length : ai) - (bi === -1 ? PRIORITY.length : bi);
  });
}

function renderPlayerTabs() {
  const tabsEl = document.getElementById('player-tabs');
  if (currentPlayers.length === 0) {
    tabsEl.innerHTML = '<span style="color:var(--muted);font-size:12px">No player sources found.</span>';
  } else {
    tabsEl.innerHTML = currentPlayers.map((p, i) =>
      `<button class="ptab${i===0?' active':''}" data-action="loadPlayer" data-index="${i}">${esc(p.label || `Player ${i+1}`)}</button>`
    ).join('');
  }
}

/* ---- Open movie modal ---- */
async function openMovie(slug, { pushHistory = true } = {}) {
  currentKind = 'movie';
  if (pushHistory) {
    history.pushState({ slug, kind: 'movie' }, '', '/movie/' + encodeURIComponent(slug));
  }
  resetModalChrome();

  try {
    const res  = await fetch(`/api/movie/${encodeURIComponent(slug)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (data.isSeries) {
      // Source classified it as a series — hand off to series flow
      return openSeries(slug, { pushHistory: false });
    }

    currentMovie = data;
    currentPlayers = sortPlayers(data.players || []);

    renderModal(data);
    renderPlayerTabs();
    if (currentPlayers.length > 0) loadPlayer(0);

    History.upsert({
      slug: data.slug, title: data.title, poster: data.poster,
      year: data.year, rating: data.rating, genre: data.genre,
      kind: 'movie',
    });
  } catch (e) {
    document.getElementById('modal-title').textContent = 'Error loading movie';
    resetPlayer('Error: ' + e.message);
  }
}

function renderModal(data) {
  const posterEl = document.getElementById('modal-poster');
  // Wire handlers BEFORE setting src so we never miss a synchronous fire.
  posterEl.classList.remove('loaded');
  posterEl.onload  = () => posterEl.classList.add('loaded');
  posterEl.onerror = () => posterEl.classList.add('loaded'); // hide shimmer even on error
  const url = data.poster || '';
  if (url) {
    posterEl.src = url;
    // Edge case: setting src to a value that's already loaded (cached or
    // identical to the previous src) doesn't fire a 'load' event in any
    // browser. Detect that and mark loaded ourselves so the image becomes
    // visible instead of staying at opacity:0 forever.
    if (posterEl.complete && posterEl.naturalWidth > 0) {
      posterEl.classList.add('loaded');
    }
  } else {
    posterEl.removeAttribute('src');
    posterEl.classList.add('loaded'); // no poster → just stop the shimmer
  }

  document.getElementById('modal-title').textContent = data.title || 'Unknown';

  const meta = [];
  if (data.year)     meta.push(`<span class="pill">${esc(data.year)}</span>`);
  if (data.rating)   meta.push(`<span class="pill rating">&#9733; ${esc(data.rating)}</span>`);
  if (data.duration) meta.push(`<span class="pill">${esc(formatDuration(data.duration))}</span>`);
  if (data.genre)    String(data.genre).split(',').slice(0, 3).forEach(g =>
    meta.push(`<span class="pill">${esc(g.trim())}</span>`)
  );
  document.getElementById('modal-meta').innerHTML = meta.join('');

  const desc = data.description || '';
  document.getElementById('modal-desc').textContent = desc;
  document.getElementById('read-more-btn').style.display = desc.length > 180 ? 'inline' : 'none';

  const parts = [];
  if (data.director) parts.push(`<strong>Director:</strong> ${esc(data.director)}`);
  if (data.cast)     parts.push(`<strong>Cast:</strong> ${esc(data.cast)}`);
  document.getElementById('modal-cast').innerHTML = parts.join('<br>');

  // Show native Share button only on devices that support it (mobile)
  document.getElementById('btn-share-native').style.display = navigator.share ? '' : 'none';

  const wBtn = document.getElementById('btn-wishlist');
  const inWL = Wishlist.has(data.slug);
  wBtn.classList.toggle('added', inWL);
  wBtn.innerHTML = inWL ? '&#9829; In Wishlist' : '&#9825; Wishlist';
}

/* ---- Load player (finalUrl pre-resolved during movie scrape — instant) ---- */
let playerLoadTimer = null;

function loadPlayer(index) {
  const p = currentPlayers[index];
  if (!p) return;

  document.querySelectorAll('.ptab').forEach((t, i) => t.classList.toggle('active', i === index));

  const wrap = document.getElementById('player-wrap');

  // finalUrl is already resolved by the server at scrape time — no extra round-trip
  const playerUrl = p.finalUrl || p.src;

  if (!playerUrl) {
    wrap.innerHTML = playerErrorHTML('No URL available for this player', index);
    return;
  }

  // For series with a next episode, overlay a "Next →" button on the player.
  // The picker below the iframe is unreachable on TV/remote setups (cross-origin
  // iframe captures pointer events), so this overlay is the only way to advance
  // without leaving the player.
  const nextEp = (currentKind === 'series') ? findNextEpisode() : null;
  const nextEpBtnHTML = nextEp
    ? `<button class="player-next-ep-btn" id="player-next-ep-btn"
               data-action="loadNextEpisode" title="Next episode" style="display:flex">
         Next &rarr; EP ${nextEp.episode}${nextEp.season !== currentEpisode.season ? ` (S${nextEp.season})` : ''}
       </button>`
    : '';

  // Same TV/remote rationale as nextEp: the player-tabs row below the iframe
  // is unreachable once the cross-origin iframe captures input, so users stuck
  // on a blocked/broken player need an in-overlay way to cycle sources.
  const nextSrcIdx = currentPlayers.length > 1 ? (index + 1) % currentPlayers.length : -1;
  const nextSrcBtnHTML = nextSrcIdx >= 0
    ? `<button class="player-next-src-btn" id="player-next-src-btn"
               data-action="loadPlayer" data-index="${nextSrcIdx}"
               title="Try next player" style="display:flex">
         Try ${esc(currentPlayers[nextSrcIdx].label || `Player ${nextSrcIdx + 1}`)}
       </button>`
    : '';

  // Proxied players come from our origin (`/api/proxy?...`), so without sandbox
  // they'd be same-origin with this page and could read `parent.localStorage`
  // (sync token, history) from any hostile script that survives our regex strip.
  // Sandbox without `allow-same-origin` forces a unique opaque origin; the
  // player still runs JS and can go fullscreen, but can't reach us.
  // Direct cross-origin embeds (emturbovid.com etc.) are already isolated by SOP.
  const sandboxAttr = p.proxied
    ? 'sandbox="allow-scripts allow-presentation allow-popups allow-forms"'
    : '';

  wrap.innerHTML = `<iframe
    id="player-iframe"
    src="${esc(playerUrl)}"
    allowfullscreen
    allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write"
    referrerpolicy="no-referrer"
    ${sandboxAttr}
  ></iframe>
  <button class="player-fullscreen-btn" id="player-fullscreen-btn"
          data-action="fullscreenPlayer" title="Fullscreen" style="display:flex">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
      <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
    </svg>
  </button>
  ${nextSrcBtnHTML}
  ${nextEpBtnHTML}`;

  // Detect network-level load failures: if the iframe never fires `load`
  // within the timeout window, surface the "try next player" fallback.
  // (Can't detect broken embed contents cross-origin — only total failure.)
  if (playerLoadTimer) clearTimeout(playerLoadTimer);
  const iframe = document.getElementById('player-iframe');
  let loaded = false;
  iframe?.addEventListener('load', () => {
    loaded = true;
    if (playerLoadTimer) { clearTimeout(playerLoadTimer); playerLoadTimer = null; }
  }, { once: true });
  playerLoadTimer = setTimeout(() => {
    if (!loaded) {
      wrap.innerHTML = playerErrorHTML('This player is taking too long to load', index);
    }
  }, 15000);

  // Once the iframe is in place, fade the modal-close like a video control overlay.
  document.querySelector('.modal-close')?.classList.add('auto-hide');
  showFsBtn(); // show briefly when player loads, then auto-hides after 3s
}

function playerErrorHTML(msg, currentIndex) {
  const nextIndex = currentIndex + 1;
  const hasNext   = nextIndex < currentPlayers.length;
  return `<div class="player-placeholder">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="42" height="42">
      <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
    </svg>
    <span style="font-size:13px;color:#e55;max-width:360px;text-align:center">${esc(msg)}</span>
    ${hasNext
      ? `<button class="btn btn-outline" style="margin-top:10px;font-size:12px" data-action="loadPlayer" data-index="${nextIndex}">
           Try ${esc(currentPlayers[nextIndex]?.label || 'Next Player')}
         </button>`
      : '<span style="font-size:12px;color:var(--muted)">No more players available</span>'
    }
  </div>`;
}

/* ---- Current item URL path (movie vs series) ---- */
function currentItemPath() {
  if (!currentMovie) return '/';
  const base = currentKind === 'series' ? '/series/' : '/movie/';
  return base + encodeURIComponent(currentMovie.slug);
}

/* ---- Wishlist toggle (modal) ---- */
function toggleWishlist() {
  if (!currentMovie) return;
  const entry = {
    slug: currentMovie.slug, title: currentMovie.title, poster: currentMovie.poster,
    year: currentMovie.year, rating: currentMovie.rating, genre: currentMovie.genre,
    kind: currentKind,
  };
  const added = Wishlist.toggle(entry);
  const wBtn  = document.getElementById('btn-wishlist');
  wBtn.classList.toggle('added', added);
  wBtn.innerHTML = added ? '&#9829; In Wishlist' : '&#9825; Wishlist';
  toast(added ? 'Added to wishlist' : 'Removed from wishlist');
}

/* ---- Modal close ---- */
function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').classList.remove('open');
  document.body.classList.remove('modal-open');
  document.querySelector('.modal-close')?.classList.remove('auto-hide', 'visible');
  resetPlayer();
  currentMovie   = null;
  currentSeries  = null;
  currentEpisode = null;
  currentPlayers = [];
  // Restore URL to home (only if we're currently on a /movie/ or /series/ path)
  if (/^\/(movie|series)\//.test(location.pathname)) {
    history.pushState({}, '', '/');
  }
}

/* ---- Share ---- */
function copyMovieLink() {
  if (!currentMovie) return;
  const url = location.origin + currentItemPath();
  const btn = document.getElementById('btn-copy-link');
  navigator.clipboard.writeText(url).then(() => {
    const prev = btn.innerHTML;
    btn.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
      <polyline points="4 10 8 14 16 6"/>
    </svg> Copied!`;
    btn.style.cssText += 'border-color:var(--accent2);color:var(--accent2)';
    setTimeout(() => { btn.innerHTML = prev; btn.style.cssText = ''; }, 2200);
  }).catch(() => toast('Copy: ' + url));
}

function nativeShare() {
  if (!currentMovie || !navigator.share) return;
  const kindLabel = currentKind === 'series' ? 'series' : 'movie';
  navigator.share({
    title: currentMovie.title,
    text: `Watch the ${kindLabel} "${currentMovie.title}" on SinepilStream`,
    url: location.origin + currentItemPath(),
  }).catch(() => {});
}

function resetPlayer(msg) {
  if (playerLoadTimer) { clearTimeout(playerLoadTimer); playerLoadTimer = null; }
  document.getElementById('player-wrap').innerHTML = `
    <div class="player-placeholder" id="player-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
        <circle cx="12" cy="12" r="10"/><polygon points="10,8 16,12 10,16"/>
      </svg>
      <span>${msg || 'Select a player below to start watching'}</span>
    </div>
    <button class="player-fullscreen-btn" id="player-fullscreen-btn"
            data-action="fullscreenPlayer" title="Fullscreen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
        <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
      </svg>
    </button>`;
}

/* ---- Fullscreen + close button idle-show/hide ---- */
let _fsIdleTimer = null;

function showFsBtn() {
  const btn   = document.getElementById('player-fullscreen-btn');
  const close = document.querySelector('.modal-close');
  const next  = document.getElementById('player-next-ep-btn');
  const src   = document.getElementById('player-next-src-btn');
  if (btn && btn.style.display === 'flex') btn.classList.add('visible');
  if (close && close.classList.contains('auto-hide')) close.classList.add('visible');
  if (next && next.style.display === 'flex') next.classList.add('visible');
  if (src && src.style.display === 'flex') src.classList.add('visible');
  clearTimeout(_fsIdleTimer);
  _fsIdleTimer = setTimeout(() => {
    document.getElementById('player-fullscreen-btn')?.classList.remove('visible');
    document.querySelector('.modal-close')?.classList.remove('visible');
    document.getElementById('player-next-ep-btn')?.classList.remove('visible');
    document.getElementById('player-next-src-btn')?.classList.remove('visible');
  }, 3000);
}

// Show on any user activity inside the modal (mousemove for desktop, touchstart for mobile)
const _modal = document.getElementById('modal');
_modal?.addEventListener('mousemove', showFsBtn);
_modal?.addEventListener('touchstart', showFsBtn, { passive: true });
// Show on any keypress (useful in fullscreen where mouse events are inside iframe)
document.addEventListener('keydown', showFsBtn);
// Cross-origin iframes swallow mousemove/touchstart, so the listeners above
// never fire once the cursor (or finger) is over the video. Two extra signals
// that DO cross the boundary:
//   - `mouseenter` on the wrap fires when the cursor crosses into the player
//     area at all (desktop / trackpad).
//   - `window blur` fires when the iframe steals focus on click/tap. Filter to
//     iframe focus only so alt-tabbing to another window doesn't trigger it.
document.getElementById('player-wrap')?.addEventListener('mouseenter', showFsBtn);
window.addEventListener('blur', () => {
  if (document.activeElement?.tagName === 'IFRAME') showFsBtn();
});

/* ---- Fullscreen the player wrap (not the iframe) so our button can overlay the video ---- */
function fullscreenPlayer() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
    return;
  }
  const wrap = document.getElementById('player-wrap');
  if (!wrap || !wrap.querySelector('iframe')) return;
  (wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.mozRequestFullScreen)?.call(wrap);
}

// Sync button icon with fullscreen state and show button briefly on transition
function _onFullscreenChange() {
  const btn = document.getElementById('player-fullscreen-btn');
  if (!btn) return;
  const isFs = !!document.fullscreenElement;
  btn.title = isFs ? 'Exit fullscreen' : 'Fullscreen';
  btn.querySelector('svg').innerHTML = isFs
    ? '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>'
    : '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>';
  showFsBtn(); // always show briefly on fullscreen enter/exit
}
document.addEventListener('fullscreenchange', _onFullscreenChange);
document.addEventListener('webkitfullscreenchange', _onFullscreenChange);

/* ---- Toggle description ---- */
function toggleDesc() {
  descExpanded = !descExpanded;
  document.getElementById('modal-desc').classList.toggle('expanded', descExpanded);
  document.getElementById('read-more-btn').textContent = descExpanded ? 'Show less' : 'Read more';
}

/* ---- Toast ---- */
function toast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), duration);
}

/* ---- Helpers ---- */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
function emptyHTML(msg) { return `<div class="empty">${msg}</div>`; }
function formatDuration(iso) {
  const s = String(iso);
  const m = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  // Always return a controlled-shape string. Untrusted input falls back to s
  // verbatim, and the call site is responsible for esc()-ing it before HTML
  // interpolation.
  if (!m) return s;
  return ((m[1] ? m[1] + 'h ' : '') + (m[2] ? m[2] + 'm' : '')).trim() || s;
}

/* ---- Keyboard ---- */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (e.key === '/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    document.getElementById('search-input').focus();
  }
});

/* ---- Browser back/forward ---- */
window.addEventListener('popstate', (e) => {
  if (e.state?.slug) {
    openItem(e.state.slug, e.state.kind || 'movie');
  } else {
    if (document.getElementById('modal-overlay').classList.contains('open')) {
      document.getElementById('modal-overlay').classList.remove('open');
      document.body.classList.remove('modal-open');
      resetPlayer();
      currentMovie   = null;
      currentSeries  = null;
      currentEpisode = null;
      currentPlayers = [];
    }
  }
});

/* ---- Global event delegation ----
   All `data-action="foo"` elements dispatch here. Replaces inline
   onclick="…" handlers that our CSP (script-src-attr 'none') blocks.
   Card-internal actions (wishlist/remove) are still handled inside
   attachCardEvents because they need to stopPropagation before the card's
   own click handler fires. */
/* ---- Sync overlay UI ---- */
function openSyncOverlay() {
  document.getElementById('sync-overlay').classList.add('open');
  renderSyncBody();
}

function closeSyncOverlay() {
  document.getElementById('sync-overlay').classList.remove('open');
}

// Show/hide the green paired-dot in the nav button. Cheap, runs on init
// + after pair/disconnect/regenerate.
function refreshSyncIndicator() {
  const dot = document.getElementById('nav-sync-dot');
  if (!dot) return;
  dot.hidden = !Sync.token;
}

function renderSyncBody() {
  const body = document.getElementById('sync-body');
  if (!body) return;
  if (Sync.token) {
    // Already paired on this device
    const codeActive = Sync.isCodeActive();
    const codeBlock = codeActive
      ? `<div class="sync-desc" style="margin:0">Pair another device with:</div>
         <div class="sync-code-display">${esc(Sync.code)}</div>
         <div class="sync-desc" style="font-size:11px;margin:0">Expires ${esc(formatExpiry(Sync.codeExpires))}. Then mint a new one to pair more devices.</div>`
      : `<div class="sync-desc" style="margin:0">No active pairing code.</div>
         <button class="btn btn-primary" data-action="regenerateSyncCode">Generate code to pair another device</button>`;
    body.innerHTML = `
      <div class="sync-status">Synced on this device</div>
      ${codeBlock}
      <div class="sync-actions" style="margin-top:14px">
        <button class="btn btn-outline" data-action="disconnectSync">Disconnect this device</button>
      </div>
    `;
  } else {
    body.innerHTML = `
      <div class="sync-actions">
        <button class="btn btn-primary" data-action="generateSyncCode">Generate new code</button>
        <div class="sync-or">— or pair with existing —</div>
        <input id="sync-code-input" class="sync-input" placeholder="ABCDEF" maxlength="6"
               inputmode="text" autocapitalize="characters" autocomplete="off"
               aria-label="6-character sync code" />
        <button class="btn btn-outline" data-action="enterSyncCode">Pair</button>
      </div>
    `;
    setTimeout(() => document.getElementById('sync-code-input')?.focus(), 50);
  }
}

// "Expires <relative time>" helper for the pairing code display.
function formatExpiry(iso) {
  if (!iso) return 'soon';
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'now';
  const hrs = Math.floor(ms / 3600000);
  const min = Math.floor((ms % 3600000) / 60000);
  if (hrs > 0)  return `in ${hrs}h ${min}m`;
  return `in ${min}m`;
}

async function generateSyncCode() {
  try {
    const { code } = await Sync.createNew();
    const body = document.getElementById('sync-body');
    body.innerHTML = `
      <div class="sync-desc" style="margin:0">Enter this code on your other device within 24 hours:</div>
      <div class="sync-code-display">${esc(code)}</div>
      <div class="sync-row">
        <button class="btn btn-outline" data-action="closeSync">Done</button>
      </div>
      <p class="sync-desc" style="margin:0;font-size:11px">Anyone with this code can pair to your slot — don't share it publicly.</p>
    `;
  } catch (e) {
    toast('Could not generate code: ' + e.message);
  }
}

async function regenerateSyncCode() {
  try {
    const { code } = await Sync.regenerateCode();
    toast('New code: ' + code);
    renderSyncBody();
  } catch (e) {
    toast('Could not regenerate: ' + e.message);
  }
}

async function enterSyncCode() {
  const input = document.getElementById('sync-code-input');
  const code  = (input?.value || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{6}$/.test(code)) { toast('Enter a 6-character code'); return; }
  try {
    await Sync.pair(code);
    // Refresh anything that may now show merged data
    renderContinueWatching('movie');
    renderContinueWatching('series');
    if (document.getElementById('sec-history')?.classList.contains('active')) renderHistory();
    if (document.getElementById('sec-wishlist')?.classList.contains('active')) renderWishlist();
    toast('Paired — history & wishlist synced');
    renderSyncBody();
  } catch (e) {
    toast(e.message || 'Pairing failed');
  }
}

async function disconnectSync() {
  await Sync.disconnect();
  renderSyncBody();
  toast('Disconnected from sync');
}

const CLICK_ACTIONS = {
  showTab:            (el) => showTab(el.dataset.arg),
  doSearch:           () => doSearch(),
  watchByUrl:         () => watchByUrl(),
  applyFilter:         () => applyFilter(),
  clearMovieFilter:    () => clearMovieFilter(),
  applySeriesFilter:   () => applySeriesFilter(),
  clearSeriesFilter:   () => clearSeriesFilter(),
  railScroll:          (el) => railScroll(el),
  clearHistory:       () => clearHistory(),
  closeModal:         () => closeModal(),
  closeModalOverlay:  (el, e) => closeModal(e),
  fullscreenPlayer:   () => fullscreenPlayer(),
  toggleDesc:         () => toggleDesc(),
  toggleWishlist:     () => toggleWishlist(),
  copyMovieLink:      () => copyMovieLink(),
  nativeShare:        () => nativeShare(),
  loadPlayer:         (el) => loadPlayer(parseInt(el.dataset.index, 10)),
  loadEpisode:        (el) => loadEpisode(
    parseInt(el.dataset.season,  10),
    parseInt(el.dataset.episode, 10),
  ),
  loadNextEpisode:    () => loadNextEpisode(),
  dismissNotice:      (el) => {
    const target = document.getElementById(el.dataset.target);
    if (target) target.style.display = 'none';
  },
  openSync:           () => openSyncOverlay(),
  closeSync:          () => closeSyncOverlay(),
  closeSyncOverlay:   (el, e) => {
    // Mirror modal-overlay behavior: clicking the backdrop closes, clicks inside don't.
    if (e.target.id === 'sync-overlay' || el.classList.contains('modal-close')) closeSyncOverlay();
  },
  generateSyncCode:   () => generateSyncCode(),
  enterSyncCode:      () => enterSyncCode(),
  regenerateSyncCode: () => regenerateSyncCode(),
  disconnectSync:     () => disconnectSync(),
  runRecentSearch:    (el) => runRecentSearch(el.dataset.q || ''),
  removeRecentSearch: (el) => removeRecentSearch(el.dataset.q || ''),
  clearRecentSearches:() => clearRecentSearches(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  // Cards have their own listener that handles wishlist/remove inside
  // attachCardEvents — leave those alone here.
  if (el.dataset.action === 'wishlist' || el.dataset.action === 'remove') return;
  const fn = CLICK_ACTIONS[el.dataset.action];
  if (fn) fn(el, e);
});

// Filter selects + season-select all dispatch 'change' to the same registry.
document.addEventListener('change', (e) => {
  const id = e.target.id;
  if (id === 'season-select') renderEpisodeList();
  else if (id === 'filter-genre' || id === 'filter-country' || id === 'filter-year') applyFilter();
  else if (id === 'series-filter-genre' || id === 'series-filter-year') applySeriesFilter();
});

// Enter submits immediately; typing kicks off the debounced liveSearch.
document.getElementById('search-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
  else if (e.key === 'Escape') hideSearchHistory();
});
document.getElementById('search-input')?.addEventListener('input', () => {
  hideSearchHistory();   // typing replaces the suggestion list
  liveSearch();
});
document.getElementById('search-input')?.addEventListener('focus', showSearchHistory);
// `focus` only fires on focus transitions; add `click` so an already-focused
// input still reopens the panel after we hide it (e.g. just ran a search).
document.getElementById('search-input')?.addEventListener('click', showSearchHistory);
// Close the panel when focus moves elsewhere. Delay so a click on a panel item
// fires before the panel hides itself.
document.addEventListener('mousedown', (e) => {
  const panel = document.getElementById('search-history');
  if (!panel?.classList.contains('open')) return;
  if (e.target.closest('.search-wrap')) return;
  hideSearchHistory();
});
document.getElementById('url-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') watchByUrl();
});
// Enter on the dynamically-rendered sync code input submits the pairing form
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target?.id === 'sync-code-input') enterSyncCode();
  if (e.key === 'Escape' && document.getElementById('sync-overlay').classList.contains('open')) {
    closeSyncOverlay();
  }
});

// Pull on tab focus so a device sitting idle picks up changes another device
// pushed (e.g. you watched something on phone, then return to the TV tab).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') Sync.pullIfVisible();
});

/* ---- Init ---- */
(function init() {
  document.getElementById('browse-bar').style.display = 'flex';
  renderContinueWatching('movie');  // Recently Watched on first paint (movies tab)
  loadHomeRails('home-rails', 'movie');
  updateTabChrome('browse');

  // Pull remote state if this device is paired — fire-and-forget.
  refreshSyncIndicator();
  Sync.syncOnLoad();

  const m = location.pathname.match(/^\/movie\/([^/]+)$/);
  const s = location.pathname.match(/^\/series\/([^/]+)$/);
  if (m) openMovie(decodeURIComponent(m[1]), { pushHistory: false });
  else if (s) openSeries(decodeURIComponent(s[1]), { pushHistory: false });
})();

const { axios, cheerio, DEFAULT_HEADERS, fetchHtml, pMap } = require('../http');
const { movieStmts, indexMovies, indexSeries } = require('../db');
const { resolvePlayers } = require('../resolver');
const { discoverUpstreamScriptsFromPage } = require('../decrypt');
const { scrubSourceNames } = require('./scrub');
const host = require('./movies-host');

// BASE / SOURCE_REFERER / SOURCE_ORIGIN are dynamic — they read the currently
// selected host from ./movies-host. Do NOT cache their return values across
// request boundaries; always call the getter fresh so failover works.
const POSTER_BASE = 'https://static-jpg.lk21.party/wp-content/uploads/';

// Series detection signals — exclude from movie results
const SERIES_SLUG_RE = /\b(season|episode|eps|ep-?\d+|s\d{1,2}e\d{1,2})\b/i;
const SERIES_HOST_RE = /nontondrama|drakor|myasian|dramaqu/i;

function parseJsonLd($) {
  let result = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const d = JSON.parse($(el).html().trim());
      if (['Movie', 'TVSeries', 'VideoObject'].includes(d['@type'])) {
        result = { ...result, ...d };
      }
    } catch (_) {}
  });
  return result;
}

function extractCards($) {
  const movies = [];
  const seen = new Set();

  $('article').each((_, el) => {
    const $el = $(el);
    const linkEl = $el.find('a[itemprop="url"]').first();
    const href = linkEl.attr('href') || '';
    const titleAttr = (linkEl.attr('title') || '').toLowerCase();
    if (!href) return;

    if (titleAttr.includes('nonton series')) return;
    if ($el.find('span.episode').length > 0) return;
    if (SERIES_HOST_RE.test(href)) return;

    const slug = href.replace(/^\//, '').replace(/\/$/, '');
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    if (SERIES_SLUG_RE.test(slug)) return;

    const imgEl = $el.find('img[itemprop="image"], img').first();
    let title = imgEl.attr('alt') || imgEl.attr('title') || '';
    title = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    if (!title) return;

    const poster = imgEl.attr('src') ||
                   $el.find('source[type="image/jpeg"]').first().attr('srcset') || '';
    const rating = $el.find('span[itemprop="ratingValue"]').first().text().trim();
    const year   = $el.find('span.year, span[itemprop="datePublished"]').first().text().trim();
    const genre  = $el.find('meta[itemprop="genre"]').attr('content') || '';

    movies.push({ title, slug, poster, rating, year, genre });
  });

  return movies;
}

// Wrap a source fetch with a single retry against the next candidate host
// when the current host is unreachable. 404 / 4xx pass through unchanged —
// those are real "not found" signals, not host outages.
async function fetchWithFailover(pathFromBase, axiosOpts) {
  try {
    return await axios.get(`${host.getBase()}${pathFromBase}`, axiosOpts);
  } catch (e) {
    const isNet = !e.response || e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND'
               || e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET';
    if (!isNet) throw e;
    host.rotateAfterFailure();
    return axios.get(`${host.getBase()}${pathFromBase}`, axiosOpts);
  }
}

async function getMovie(slug) {
  const pathFromBase = `/${slug}/`;

  let res;
  try {
    res = await fetchWithFailover(pathFromBase, {
      headers: DEFAULT_HEADERS,
      timeout: 20000,
      maxRedirects: 5,
    });
  } catch (e) {
    if (e.response?.status === 404) {
      movieStmts.delete.run(slug);
      const err = new Error('Movie not found on source site');
      err.status = 404;
      throw err;
    }
    throw e;
  }

  const $ = cheerio.load(res.data);

  const finalUrl = res.request?.res?.responseUrl || `${host.getBase()}${pathFromBase}`;
  const finalHost = (() => { try { return new URL(finalUrl).hostname; } catch { return ''; } })();
  const baseHost  = host.currentHost();
  if (finalHost && baseHost && finalHost !== baseHost) {
    movieStmts.delete.run(slug);
    return { isSeries: true, slug };
  }

  if ($('#openNow').length > 0 || $('main.card').length > 0) {
    movieStmts.delete.run(slug);
    return { isSeries: true, slug };
  }

  const ld = parseJsonLd($);
  if (ld['@type'] === 'TVSeries') {
    movieStmts.delete.run(slug);
    return { isSeries: true, slug, title: ld.name || slug };
  }

  let title = ld.name ||
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text().trim() || slug;
  title = scrubSourceNames(title
    .replace(/^Lk21\s+Nonton\s+/i, '')
    .replace(/\s+Sub Indo.*$/i, '')
    .replace(/\s*\|\s*Streaming.*$/i, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .trim());

  const poster      = ld.image?.url || ld.image || $('meta[property="og:image"]').attr('content') || '';
  const description = scrubSourceNames(ld.description || $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '');
  const genre       = Array.isArray(ld.genre) ? ld.genre.join(', ') : (ld.genre || '');
  const year        = String(ld.datePublished || '').slice(0, 4) || '';
  const rating      = String(ld.aggregateRating?.ratingValue || '');
  const duration    = ld.duration || '';
  const director    = Array.isArray(ld.director) ? ld.director.map(d => d.name).join(', ') : (ld.director?.name || '');
  const cast        = (ld.actor || []).slice(0, 8).map(a => a.name).join(', ');

  // Upstream switched data-url from plain playeriframe.sbs URLs to AES-encrypted
  // base64 tokens (Nov 2026). We accept either — the resolver routes encrypted
  // tokens through headless Chromium and plain URLs through the legacy HTTP path.
  const rawPlayers = [];
  $('#player-list li a, .player-options #player-list li a').each((_, el) => {
    const src = $(el).attr('data-url') || '';
    const server = $(el).attr('data-server') || '';
    if (src && server) rawPlayers.push({ label: server.toUpperCase(), src });
  });

  if (rawPlayers.length === 0) {
    $('#player-select option, .player-options select option').each((_, el) => {
      const src = $(el).attr('value') || '';
      const server = $(el).attr('data-server') || $(el).text().replace(/GANTI PLAYER\s*/i, '').trim();
      if (src && server) rawPlayers.push({ label: server.toUpperCase(), src });
    });
  }

  if (rawPlayers.length === 0) {
    const src = $('#main-player iframe, .main-player iframe').first().attr('src') || '';
    if (src) rawPlayers.push({ label: 'Player', src });
  }

  // Dedup by src (the same token appears in both the <ul> and the <select>)
  {
    const seen = new Set();
    for (let i = rawPlayers.length - 1; i >= 0; i--) {
      if (seen.has(rawPlayers[i].src)) rawPlayers.splice(i, 1);
      else seen.add(rawPlayers[i].src);
    }
  }

  // Learn the live player.js / script.js URLs from this page before resolving,
  // so a CDN-host or version rotation upstream is auto-tracked without code.
  discoverUpstreamScriptsFromPage($);

  const players = await resolvePlayers(rawPlayers, {
    referer: host.getReferer(),
    origin:  host.getOrigin(),
  });

  return {
    kind: 'movie',
    slug, title, poster, description, genre, year, rating, duration,
    director, cast, players,
    url: `${host.getBase()}${pathFromBase}`,
  };
}

// --- Search ---
// The upstream autocomplete API is shared across the movie site and the
// series site — both are operated by the same team and use identical slugs.
// We split the results so movies and series each surface through the right
// source.

async function searchSource(query) {
  try {
    const res = await axios.get('https://gudangvape.com/search.php', {
      params: { s: query },
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        Referer: host.getReferer(),
        Accept: 'application/json',
      },
      timeout: 8000,
    });
    const items = Array.isArray(res.data?.data) ? res.data.data : [];
    return items.filter(m => m?.slug);
  } catch {
    return [];
  }
}

function cleanTitle(s) {
  return String(s || '')
    .replace(/\s*-\s*Series\s*$/i, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .trim();
}

function toMovieCard(m) {
  return {
    slug: m.slug,
    title: cleanTitle(m.title),
    poster: m.poster ? POSTER_BASE + m.poster : '',
    year: String(m.year || ''),
    rating: String(m.rating || ''),
    genre: '',
  };
}

function toSeriesCard(m) {
  return {
    slug: m.slug,
    title: cleanTitle(m.title),
    poster: m.poster ? POSTER_BASE + m.poster : '',
    year: String(m.year || ''),
    rating: String(m.rating || ''),
    genre: '',
    total_seasons:  parseInt(m.season, 10)  || 0,
    total_episodes: parseInt(m.episode, 10) || 0,
  };
}

async function search(query) {
  const q = query.trim();
  if (!q) return [];

  const fromSource = (await searchSource(q))
    .filter(m => m.type === 'movie')
    .map(toMovieCard);

  if (fromSource.length > 0) {
    indexMovies(fromSource);
    return fromSource.map(m => ({ ...m, kind: 'movie' }));
  }

  const titlePart = q.replace(/\b(19|20)\d{2}\b/, '').trim();
  const searchKey = (titlePart || q).toLowerCase();
  const like = `%${searchKey.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  const cached = movieStmts.searchLike.all(like, like);
  return cached.map(m => ({ ...m, kind: 'movie' }));
}

// Server-side series search via the shared autocomplete. Slugs are identical
// to the ones nontondrama uses, so results plug straight into /api/series/:slug.
async function searchSeries(query) {
  const q = query.trim();
  if (!q) return [];

  const items = (await searchSource(q))
    .filter(m => m.type === 'series')
    .map(toSeriesCard);

  if (items.length > 0) indexSeries(items);
  return items.map(m => ({ ...m, kind: 'series' }));
}

// --- Browse ---

async function getRating(slug) {
  try {
    const { $ } = await fetchHtml(`${host.getBase()}/${slug}/`);
    const ld = parseJsonLd($);
    const v = ld.aggregateRating?.ratingValue;
    return v != null ? String(v) : '';
  } catch {
    return '';
  }
}

// Bumped from 14d → 60d. Ratings rarely appear retroactively, and enrichment
// is an N+1 burst on every cold browse — longer TTL = fewer upstream hits.
const RATING_TTL_DAYS = 60;

async function enrichMissingRatings(movies) {
  const missing = movies.filter(m => !m.rating);
  if (missing.length === 0) return;

  const slugsJson = JSON.stringify(missing.map(m => m.slug));
  const cached = movieStmts.getCachedRatings.all(slugsJson);
  const cacheBySlug = new Map(cached.map(r => [r.slug, r]));
  const ttlCutoff = Math.floor(Date.now() / 1000) - RATING_TTL_DAYS * 86400;

  const stillMissing = [];
  for (const m of missing) {
    const c = cacheBySlug.get(m.slug);
    if (c?.rating) m.rating = c.rating;
    else if (c && c.rating_fetched_at > ttlCutoff) { /* skip */ }
    else stillMissing.push(m);
  }
  if (stillMissing.length === 0) return;

  await pMap(stillMissing, async (m) => {
    const rating = await getRating(m.slug);
    m.rating = rating;
    movieStmts.setRating.run({ slug: m.slug, rating });
  }, 8);
}

async function browse(path = '') {
  const base = host.getBase();
  const url = path ? `${base}/${path}/`.replace(/\/\/$/, '/') : base;
  const { $ } = await fetchHtml(url);
  const movies = extractCards($);
  indexMovies(movies);
  await enrichMissingRatings(movies);
  return movies.map(m => ({ ...m, kind: 'movie' }));
}

async function seedIndex() {
  // Probe active host first so all subsequent requests hit a live mirror.
  await host.selectActiveHost().catch(() => {});

  const thisYear = new Date().getFullYear();
  const seedPages = ['', `year/${thisYear}`, `year/${thisYear - 1}`, `year/${thisYear - 2}`, `year/${thisYear - 3}`];
  for (const p of seedPages) {
    try {
      const base = host.getBase();
      const url = p ? `${base}/${p}/` : base;
      const { $ } = await fetchHtml(url);
      indexMovies(extractCards($));
      await new Promise(r => setTimeout(r, 300));
    } catch {}
  }
}

function slugFromSourceUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    if (!/(?:^|\.)lk21(?:official\.(?:cc|love)|\.(?:de|party|cc|my\.id)|official)?(?:$|\.)/i.test(hostname)) return null;
    const slug = pathname.replace(/^\/|\/$/g, '');
    return slug || null;
  } catch {
    return null;
  }
}

module.exports = {
  getBase: host.getBase,
  getReferer: host.getReferer,
  getOrigin: host.getOrigin,
  getMovie, search, searchSeries, browse, seedIndex, slugFromSourceUrl,
};

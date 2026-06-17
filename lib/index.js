const movieSource  = require('./sources/movies');
const seriesSource = require('./sources/series');
const { cached, invalidate } = require('./cache');

// Slug validation for any user-supplied slug before hitting a source site.
// Rejects path traversal, schemes, query strings, whitespace, etc.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/i;
function isSafeSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

// Cache TTLs (seconds). Detail pages are slow to refresh (new subs added,
// rating nudged) — 30 min is a good compromise between freshness and load.
// Browse pages rotate more (new releases) but users tolerate slight staleness.
const TTL = {
  movie:         30 * 60,   // 30 min
  series:        30 * 60,   // 30 min
  episode:       10 * 60,   // 10 min — player URLs can rotate
  browseMovies:  10 * 60,
  browseSeries:  10 * 60,
};

async function getMovie(slug) {
  if (!isSafeSlug(slug)) {
    const err = new Error('Invalid slug');
    err.status = 400;
    throw err;
  }
  return cached(`movie:${slug}`, TTL.movie, () => movieSource.getMovie(slug));
}

async function getSeries(slug) {
  if (!isSafeSlug(slug)) {
    const err = new Error('Invalid slug');
    err.status = 400;
    throw err;
  }
  return cached(`series:${slug}`, TTL.series, async () => {
    try {
      return await seriesSource.getSeries(slug);
    } catch (e) {
      if (e.status !== 404) throw e;
      const movie = await movieSource.getMovie(slug).catch(() => null);
      if (movie && !movie.isSeries) return { isMovie: true, slug };
      throw e;
    }
  });
}

async function getEpisode(slug, season, episode) {
  if (!isSafeSlug(slug)) {
    const err = new Error('Invalid slug');
    err.status = 400;
    throw err;
  }
  const s = parseInt(season, 10);
  const e = parseInt(episode, 10);
  return cached(
    `episode:${slug}:${s}:${e}`,
    TTL.episode,
    () => seriesSource.getEpisode(slug, s, e),
  );
}

async function browse(path = '') {
  return cached(
    `browse:movies:${path}`,
    TTL.browseMovies,
    () => movieSource.browse(path),
    { staleWhileRevalidate: true },
  );
}

async function browseSeries(path = '') {
  return cached(
    `browse:series:${path}`,
    TTL.browseSeries,
    () => seriesSource.browse(path),
    { staleWhileRevalidate: true },
  );
}

// Rails shown on the Movies home view — genre/year slices that each reuse
// the cached browse() so hitting the homepage is one DB lookup per rail
// (not N upstream fetches).
const MOVIE_HOME_RAILS = [
  { id: 'latest', title: 'Latest',        path: '' },
  { id: 'action', title: 'Action',        path: 'genre/action' },
  { id: 'drama',  title: 'Drama',         path: 'genre/drama' },
  { id: 'comedy', title: 'Comedy',        path: 'genre/comedy' },
  { id: 'horror', title: 'Horror',        path: 'genre/horror' },
  { id: 'sf',     title: 'Sci-Fi',        path: 'genre/science-fiction' },
  { id: 'yNow',   title: 'Released 2026', path: 'year/2026' },
  { id: 'yPrev',  title: 'Released 2025', path: 'year/2025' },
];

const SERIES_HOME_RAILS = [
  { id: 'latest',  title: 'Latest',        path: '' },
  { id: 'drama',   title: 'Drama',         path: 'genre/drama' },
  { id: 'romance', title: 'Romance',       path: 'genre/romance' },
  { id: 'action',  title: 'Action',        path: 'genre/action' },
  { id: 'comedy',  title: 'Comedy',        path: 'genre/comedy' },
  { id: 'yNow',   title: 'Released 2026', path: 'year/2026' },
  { id: 'yPrev',  title: 'Released 2025', path: 'year/2025' },
];

async function homeRails(kind = 'movie') {
  const rails  = kind === 'series' ? SERIES_HOME_RAILS : MOVIE_HOME_RAILS;
  const fetch  = kind === 'series' ? browseSeries : browse;
  // Parallel, but each call is individually cached — no thundering herd.
  const results = await Promise.all(
    rails.map(r => fetch(r.path).catch(() => [])),
  );
  return rails.map((r, i) => ({
    id: r.id,
    title: r.title,
    path: r.path,
    // Cap each rail at 20 cards so the payload stays reasonable and the
    // horizontal scroll has a natural end.
    items: results[i].slice(0, 20),
  })).filter(r => r.items.length > 0);
}

// Merge two result arrays, preferring the first occurrence of each slug.
// Upstream autocomplete results are authoritative (fresh, server-side); the
// local DB fallback fills in anything the autocomplete misses.
function mergeBySlug(primary, fallback) {
  const seen = new Set(primary.map(r => r.slug));
  const extras = fallback.filter(r => !seen.has(r.slug));
  return [...primary, ...extras];
}

// Unified search. `kind`: 'all' | 'movie' | 'series'
// Series search combines the upstream autocomplete (true server-side search)
// with the local SQLite index (populated by browse + past detail views).
async function search(query, kind = 'all') {
  const q = (query || '').trim();
  if (!q) return [];

  const searchMovies = async () => movieSource.search(q);
  const searchSeriesAll = async () => {
    const [upstream, local] = await Promise.all([
      movieSource.searchSeries(q),
      seriesSource.search(q),
    ]);
    return mergeBySlug(upstream, local);
  };

  if (kind === 'movie')  return searchMovies();
  if (kind === 'series') return searchSeriesAll();

  const [movies, series] = await Promise.all([searchMovies(), searchSeriesAll()]);
  return [...movies, ...series];
}

// Recognise a source URL from either site. Returns a structured result the
// server/frontend can route on.
function fromSourceUrl(url) {
  const movieSlug = movieSource.slugFromSourceUrl(url);
  if (movieSlug) return { kind: 'movie', slug: movieSlug };

  const series = seriesSource.parseSourceUrl(url);
  if (series) return { kind: 'series', ...series };

  return null;
}

// Legacy name kept for backwards compat
function slugFromSourceUrl(url) {
  return movieSource.slugFromSourceUrl(url);
}

// Kick off background seeding. Deferred so the server can boot first.
function startSeeding() {
  setTimeout(() => movieSource.seedIndex()
    .then(() => seriesSource.seedIndex())
    .catch(() => {}), 2000);
}

module.exports = {
  getMovie, getSeries, getEpisode,
  browse, browseSeries, homeRails,
  search,
  slugFromSourceUrl, fromSourceUrl,
  isSafeSlug,
  startSeeding,
  invalidateCache: invalidate,
};

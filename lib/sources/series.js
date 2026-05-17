const { axios, cheerio, DEFAULT_HEADERS, fetchHtml } = require('../http');
const { seriesStmts, indexSeries } = require('../db');
const { resolvePlayers } = require('../resolver');
const { scrubSourceNames } = require('./scrub');

const BASE = 'https://tv4.nontondrama.my';
const SOURCE_REFERER = `${BASE}/`;
const SOURCE_ORIGIN  = BASE;

// Series slug on this source does not contain season/episode markers — those
// live in the episode slug. Reject anything suspicious to avoid confusing
// detail routes with episode routes.
function isSeriesSlug(slug) {
  return typeof slug === 'string' &&
         /^[a-z0-9-]+$/.test(slug) &&
         !/\bseason-\d+-episode-\d+/.test(slug);
}

function isEpisodeSlug(slug) {
  return typeof slug === 'string' &&
         /^[a-z0-9-]+-season-\d+-episode-\d+-\d{4}$/.test(slug);
}

function extractCards($) {
  const list = [];
  const seen = new Set();

  $('article[itemtype="https://schema.org/Movie"]').each((_, el) => {
    const $el = $(el);
    const href = $el.find('a[itemprop="url"]').first().attr('href') || '';
    if (!href) return;

    const slug = href.replace(/^\//, '').replace(/\/$/, '').split('/')[0];
    if (!slug || seen.has(slug)) return;
    if (!isSeriesSlug(slug)) return;
    seen.add(slug);

    const imgEl = $el.find('img[itemprop="image"], img').first();
    let title = $el.find('h3.poster-title').first().text().trim() ||
                imgEl.attr('alt') || imgEl.attr('title') || '';
    title = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    if (!title) return;

    const poster = imgEl.attr('src') ||
                   $el.find('source[type="image/webp"]').first().attr('srcset') ||
                   $el.find('source[type="image/jpeg"]').first().attr('srcset') || '';
    const rating = $el.find('span[itemprop="ratingValue"]').first().text().trim();
    const year   = $el.find('span.year, span[itemprop="datePublished"]').first().text().trim();
    const genre  = $el.find('meta[itemprop="genre"]').attr('content') || '';

    // Listing cards also expose latest episode count + season count badges
    const epsRaw = $el.find('span.episode strong').first().text().trim();
    const seasonRaw = ($el.find('span.duration').first().text().trim().match(/S\.?(\d+)/i) || [])[1] || '';

    list.push({
      slug, title, poster, rating, year, genre,
      total_episodes: parseInt(epsRaw, 10) || 0,
      total_seasons:  parseInt(seasonRaw, 10) || 0,
    });
  });

  return list;
}

// --- Detail page ---

function parseJsonScriptById($, id) {
  const raw = $(`script#${id}`).first().contents().text().trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Source encodes apostrophes/quotes as HTML entities inside JSON string values
// (e.g. "Yumi&#039;s Cells"). JSON.parse preserves those literal bytes, so we
// need to decode common entities after parsing. Limited set — we're decoding
// scraped titles only, not rendering arbitrary HTML.
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  if (typeof s !== 'string' || s.indexOf('&') === -1) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

function parseJsonLdTvSeries($) {
  let out = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const d = JSON.parse($(el).html().trim());
      const graph = Array.isArray(d['@graph']) ? d['@graph'] : [d];
      for (const n of graph) {
        if (n && n['@type'] === 'TVSeries') out = { ...out, ...n };
      }
    } catch (_) {}
  });
  return out;
}

async function getSeries(slug) {
  if (!isSeriesSlug(slug)) {
    const err = new Error('Invalid series slug');
    err.status = 400;
    throw err;
  }

  const url = `${BASE}/${slug}`;

  let res;
  try {
    res = await axios.get(url, {
      headers: DEFAULT_HEADERS,
      timeout: 20000,
      maxRedirects: 5,
    });
  } catch (e) {
    if (e.response?.status === 404) {
      seriesStmts.delete.run(slug);
      const err = new Error('Series not found');
      err.status = 404;
      throw err;
    }
    throw e;
  }

  const $ = cheerio.load(res.data);

  const meta = parseJsonScriptById($, 'watch-history-data') || {};
  const seasonData = parseJsonScriptById($, 'season-data') || {};
  const ld = parseJsonLdTvSeries($);

  const rawTitle = decodeEntities((meta.title || ld.name || slug).toString().trim());
  const cleanTitle = scrubSourceNames(rawTitle
    .replace(/^Lk21\s+Nonton\s+/i, '')
    .replace(/\s+Series\s+Sub\s+Indo.*$/i, '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .trim()) || rawTitle;

  const seasons = Object.keys(seasonData)
    .map(k => ({
      season: parseInt(k, 10),
      episodes: (Array.isArray(seasonData[k]) ? seasonData[k] : [])
        .map(e => ({
          season: parseInt(e.s, 10) || parseInt(k, 10),
          episode: parseInt(e.episode_no, 10) || 0,
          title: decodeEntities(String(e.title || '')).replace(/^[^-]+-\s*/, '').replace(/\s*\(\d{4}\)\s*$/, '').trim(),
          slug: String(e.slug || ''),
        }))
        .filter(e => e.episode > 0 && isEpisodeSlug(e.slug))
        .sort((a, b) => a.episode - b.episode),
    }))
    .filter(s => !Number.isNaN(s.season) && s.episodes.length > 0)
    .sort((a, b) => a.season - b.season);

  const totalEpisodes = seasons.reduce((n, s) => n + s.episodes.length, 0);

  indexSeries([{
    slug,
    title: cleanTitle,
    poster: meta.poster || ld.image?.url || ld.image || '',
    rating: String(meta.rating || ld.aggregateRating?.ratingValue || ''),
    year: String(meta.year || ld.datePublished || '').slice(0, 4),
    genre: decodeEntities(Array.isArray(ld.genre) ? ld.genre.join(', ') : (ld.genre || '')),
    total_seasons: seasons.length || parseInt(meta.total_season, 10) || 0,
    total_episodes: totalEpisodes || parseInt(meta.total_eps, 10) || 0,
  }]);

  return {
    kind: 'series',
    slug,
    title: cleanTitle,
    poster: meta.poster || ld.image?.url || ld.image || $('meta[property="og:image"]').attr('content') || '',
    description: scrubSourceNames(decodeEntities(ld.description || $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '')),
    genre: decodeEntities(Array.isArray(ld.genre) ? ld.genre.join(', ') : (ld.genre || '')),
    year: String(meta.year || ld.datePublished || '').slice(0, 4),
    rating: String(meta.rating || ld.aggregateRating?.ratingValue || ''),
    director: decodeEntities(Array.isArray(ld.director) ? ld.director.map(d => d.name).join(', ') : (ld.director?.name || '')),
    cast: decodeEntities((ld.actor || []).slice(0, 8).map(a => a.name).join(', ')),
    seasons,
    totalSeasons: seasons.length,
    totalEpisodes,
    url,
  };
}

// --- Episode page → resolved players ---

async function getEpisode(seriesSlug, season, episode) {
  if (!isSeriesSlug(seriesSlug)) {
    const err = new Error('Invalid series slug');
    err.status = 400;
    throw err;
  }
  const s = parseInt(season, 10);
  const e = parseInt(episode, 10);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 1 || e < 1 || s > 99 || e > 999) {
    const err = new Error('Invalid season/episode');
    err.status = 400;
    throw err;
  }

  // Look up episode slug from the series page — the slug includes the year
  // which we don't store, so always ask the source.
  const series = await getSeries(seriesSlug);
  const ep = series.seasons
    .find(x => x.season === s)?.episodes
    .find(x => x.episode === e);

  if (!ep || !isEpisodeSlug(ep.slug)) {
    const err = new Error('Episode not found');
    err.status = 404;
    throw err;
  }

  const url = `${BASE}/${ep.slug}`;
  const res = await axios.get(url, {
    headers: DEFAULT_HEADERS,
    timeout: 20000,
    maxRedirects: 5,
  });
  const $ = cheerio.load(res.data);

  // Upstream switched data-url from plain playeriframe.sbs URLs to AES-encrypted
  // base64 tokens (Nov 2026). Resolver routes encrypted tokens through headless
  // Chromium and plain URLs through the legacy HTTP path.
  const rawPlayers = [];
  $('#player-list li a, .player-options #player-list li a, a[data-url][data-server]').each((_, el) => {
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
    const src = $('#main-player').attr('src') || $('#main-player iframe').first().attr('src') || '';
    if (src) rawPlayers.push({ label: 'Player', src });
  }

  // Dedup by src (site lists servers twice: grid + select)
  const seen = new Set();
  const deduped = rawPlayers.filter(p => {
    if (seen.has(p.src)) return false;
    seen.add(p.src);
    return true;
  });

  const players = await resolvePlayers(deduped, {
    referer: SOURCE_REFERER,
    origin:  SOURCE_ORIGIN,
  });

  return {
    kind: 'episode',
    seriesSlug, season: s, episode: e,
    title: ep.title,
    players,
    url,
  };
}

// --- Browse / search ---

async function browse(path = '') {
  const url = path ? `${BASE}/${path.replace(/^\/|\/$/g, '')}/` : `${BASE}/`;
  const { $ } = await fetchHtml(url);
  const list = extractCards($);
  indexSeries(list);
  return list.map(s => ({ ...s, kind: 'series' }));
}

async function search(query) {
  const q = query.trim();
  if (!q) return [];
  // Source has no server-side search — rely on the local index (populated by
  // prior browse/getSeries calls). Index grows as users explore.
  const like = `%${q.toLowerCase().replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  return seriesStmts.searchLike.all(like, like).map(s => ({ ...s, kind: 'series' }));
}

async function seedIndex() {
  const thisYear = new Date().getFullYear();
  const paths = ['', `year/${thisYear}`, `year/${thisYear - 1}`, `year/${thisYear - 2}`];
  for (const p of paths) {
    try {
      const { $ } = await fetchHtml(p ? `${BASE}/${p}/` : `${BASE}/`);
      indexSeries(extractCards($));
      await new Promise(r => setTimeout(r, 300));
    } catch {}
  }
}

// Parse a nontondrama series or episode URL into { slug, season?, episode? }.
// Returns null for anything we can't confidently classify.
function parseSourceUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  // Match any nontondrama.* subdomain — site rotates tv1/tv3/etc
  if (!/(?:^|\.)nontondrama\./i.test(u.hostname)) return null;

  const path = u.pathname.replace(/^\/|\/$/g, '');
  if (!path) return null;

  // Episode URL: {series-slug}-season-{s}-episode-{e}-{year}
  const epMatch = path.match(/^([a-z0-9-]+?)-season-(\d{1,2})-episode-(\d{1,3})-(\d{4})$/i);
  if (epMatch) {
    const [, baseSlug, s, e, year] = epMatch;
    return {
      slug: `${baseSlug}-${year}`,
      season: parseInt(s, 10),
      episode: parseInt(e, 10),
    };
  }

  // Series URL: straight slug. Must not contain episode markers.
  if (isSeriesSlug(path)) return { slug: path };
  return null;
}

module.exports = {
  BASE, SOURCE_REFERER, SOURCE_ORIGIN,
  getSeries, getEpisode, browse, search, seedIndex,
  isSeriesSlug, isEpisodeSlug, parseSourceUrl,
};

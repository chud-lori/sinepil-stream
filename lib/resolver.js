const { axios, cheerio, DEFAULT_HEADERS } = require('./http');
const { decryptTokens } = require('./decrypt');
const { readCache, writeCache } = require('./cache');

const PLAYER_HOST = 'https://playeriframe.sbs/';
const TOKEN_CACHE_TTL = 12 * 3600; // seconds

// Upstream ships two flavours of player srcs:
//   1. Plain URLs (https://playeriframe.sbs/...) — resolvable via HTTP.
//   2. Opaque tokens — XOR-decoded client-side (see lib/decrypt.js) to a
//      playeriframe.sbs wrapper URL, then resolved via HTTP just like #1.
function isEncryptedToken(src) {
  return typeof src === 'string' && src && !/^https?:\/\//i.test(src);
}

function isSupportedPlayerUrl(url) {
  return typeof url === 'string' && url.startsWith(PLAYER_HOST);
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ''; }
}

// Several inner player hosts gate startup/embedding on the source wrapper as
// their referrer. If we embed those inner URLs directly from our domain, Cast
// shows an "embedding blocked" page and Turbo can sit on an endless loader.
// Keep using the playeriframe wrapper for those managed sources so the nested
// iframe receives the expected referrer.
function needsWrapperReferrer(player) {
  const label = String(player.label || '').toUpperCase();
  const host = hostnameOf(player.finalUrl || '');
  if (['CAST', 'HYDRAX', 'TURBOVIP'].includes(label)) return true;
  return /(?:^|\.)(?:abyssplayer\.com|emturbovid\.com|turbovidhls\.com)$/.test(host)
      || /(?:^|\.)sb[a-z0-9-]*\.[a-z]+$/i.test(host);
}

// --- Legacy HTTP resolver (kept for any direct playeriframe.sbs URLs) ---
async function resolveInnerUrl(playerUrl, { referer, origin } = {}) {
  try {
    const res = await axios.get(playerUrl, {
      headers: {
        ...DEFAULT_HEADERS,
        ...(referer ? { Referer: referer } : {}),
        ...(origin  ? { Origin:  origin  } : {}),
      },
      timeout: 8000,
      maxRedirects: 3,
    });
    const $ = cheerio.load(res.data);
    let innerUrl = '';
    $('iframe').each((_, el) => {
      const src = $(el).attr('src') || '';
      const h = parseInt($(el).attr('height') || '200', 10);
      const w = parseInt($(el).attr('width') || '200', 10);
      if (src && h > 1 && w > 1) { innerUrl = src; return false; }
    });
    if (!innerUrl) innerUrl = $('.embed-container iframe').first().attr('src') || '';
    return innerUrl || null;
  } catch {
    return null;
  }
}

// Resolve opaque tokens with per-token cache. Two-step: XOR-decode the token
// to a `playeriframe.sbs/iframe/...` wrapper URL (see ./decrypt.js), then
// HTTP-fetch that wrapper to extract the deeper embed iframe inside it.
async function resolveEncrypted(tokens, { referer, origin }) {
  const hits = tokens.map((t) => readCache(`player:${t.src}`));
  const misses = tokens.filter((_, i) => !hits[i]);

  let wrappers = [];
  if (misses.length) {
    try {
      wrappers = decryptTokens(misses.map((t) => t.src));
    } catch (e) {
      console.warn('[resolver] token decode failed:', e.message);
      wrappers = misses.map(() => null);
    }
  }

  // Step 2: resolve each wrapper URL to the deeper inner iframe.
  const innerResults = await Promise.all(misses.map(async (t, i) => {
    const wrapper = wrappers[i];
    if (!wrapper) return [t.src, null];
    const inner = isSupportedPlayerUrl(wrapper)
      ? await resolveInnerUrl(wrapper, { referer, origin })
      : wrapper; // Some tokens resolve to non-playeriframe URLs — pass through
    return [t.src, { finalUrl: inner, wrapperUrl: wrapper }];
  }));

  for (const [src, resolved] of innerResults) {
    if (resolved?.finalUrl) writeCache(`player:${src}`, resolved, TOKEN_CACHE_TTL);
  }
  const freshByToken = Object.fromEntries(innerResults);

  return tokens.map((t, i) => ({
    ...t,
    finalUrl: typeof hits[i]?.value === 'string'
      ? hits[i].value
      : (hits[i]?.value?.finalUrl || freshByToken[t.src]?.finalUrl || null),
    wrapperUrl: typeof hits[i]?.value === 'object'
      ? hits[i].value.wrapperUrl
      : (freshByToken[t.src]?.wrapperUrl || null),
  }));
}

// Given raw {label, src} players, resolve each to a finalUrl the frontend can
// embed. Routes opaque tokens through the XOR decoder, plain URLs through the
// HTTP wrapper resolver.
async function resolvePlayers(rawPlayers, { referer, origin } = {}) {
  const encrypted = rawPlayers.filter((p) => isEncryptedToken(p.src));
  const legacy    = rawPlayers.filter((p) => !isEncryptedToken(p.src));

  const [encResolved, legacyResults] = await Promise.all([
    encrypted.length ? resolveEncrypted(encrypted, { referer, origin }) : Promise.resolve([]),
    legacy.length
      ? Promise.allSettled(legacy.map((p) => resolveInnerUrl(p.src, { referer, origin })))
      : Promise.resolve([]),
  ]);

  const legacyResolved = legacy.map((p, i) => ({
    ...p,
    finalUrl: legacyResults[i]?.status === 'fulfilled' ? legacyResults[i].value : null,
    wrapperUrl: p.src,
  }));

  // Preserve original order (encrypted/legacy can be interleaved in rawPlayers)
  const byKey = new Map();
  for (const r of [...encResolved, ...legacyResolved]) byKey.set(r.src, r);

  return rawPlayers.map((raw) => {
    const r = byKey.get(raw.src);
    if (!r) return null;
    // P2P (cloud.hownetwork.xyz) can't be embedded directly — drop silently
    if (/cloud\.hownetwork\.xyz/i.test(r.finalUrl || r.src)) return null;
    if (!r.finalUrl) {
      // For legacy plain-URL srcs we can still proxy through the SSRF-guarded
      // /api/proxy. For opaque encrypted tokens there is nothing to proxy —
      // dropping the player is better than rendering an "Invalid URL" iframe.
      if (/^https?:\/\//i.test(r.src)) {
        return { ...r, finalUrl: `/api/proxy?url=${encodeURIComponent(r.src)}`, proxied: true };
      }
      return null;
    }
    const embedUrl = needsWrapperReferrer(r) && /^https?:\/\//i.test(r.wrapperUrl || '')
      ? r.wrapperUrl
      : r.finalUrl;
    return { ...r, finalUrl: embedUrl, proxied: false, innerUrl: r.finalUrl };
  }).filter(Boolean);
}

module.exports = { PLAYER_HOST, isSupportedPlayerUrl, resolveInnerUrl, resolvePlayers };

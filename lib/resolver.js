const { axios, cheerio, DEFAULT_HEADERS } = require('./http');
const { decryptTokens } = require('./decrypt');
const { readCache, writeCache } = require('./cache');

const PLAYER_HOST = 'https://playeriframe.sbs/';
const TOKEN_CACHE_TTL = 12 * 3600; // seconds

// Upstream ships two flavours of player srcs:
//   1. Plain URLs (https://playeriframe.sbs/...) — resolvable via HTTP.
//   2. Opaque tokens — resolved by upstream's sinta.{root} PoW challenge
//      service (see lib/decrypt.js).
function isEncryptedToken(src) {
  return typeof src === 'string' && src && !/^https?:\/\//i.test(src);
}

function isSupportedPlayerUrl(url) {
  return typeof url === 'string' && url.startsWith(PLAYER_HOST);
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

// Resolve opaque tokens with per-token cache. Two-step: ask upstream to
// resolve the token to a `playeriframe.sbs/iframe/...` wrapper URL (via the
// PoW challenge flow in ./decrypt.js), then HTTP-fetch that wrapper to
// extract the deeper embed iframe inside it.
async function resolveEncrypted(tokens, { referer, origin }) {
  const hits = tokens.map((t) => readCache(`player:${t.src}`));
  const misses = tokens.filter((_, i) => !hits[i]);

  let wrappers = [];
  if (misses.length) {
    try {
      wrappers = await decryptTokens(misses.map((t) => t.src), { referer });
    } catch (e) {
      console.warn('[resolver] token resolve failed:', e.message);
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
    return [t.src, inner];
  }));

  for (const [src, finalUrl] of innerResults) {
    if (finalUrl) writeCache(`player:${src}`, finalUrl, TOKEN_CACHE_TTL);
  }
  const freshByToken = Object.fromEntries(innerResults);

  return tokens.map((t, i) => ({
    ...t,
    finalUrl: hits[i]?.value || freshByToken[t.src] || null,
  }));
}

// Given raw {label, src} players, resolve each to a finalUrl the frontend can
// embed. Routes opaque tokens through the sinta PoW resolver, plain URLs
// through the HTTP wrapper resolver.
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
    return { ...r, proxied: false, innerUrl: r.finalUrl };
  }).filter(Boolean);
}

module.exports = { PLAYER_HOST, isSupportedPlayerUrl, resolveInnerUrl, resolvePlayers };

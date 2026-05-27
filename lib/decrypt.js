// Resolve player tokens to their wrapper iframe URL.
//
// Upstream used to encrypt tokens with AES and require running their
// obfuscated player.js in jsdom to decrypt. They've since replaced that with
// a server-side proof-of-work challenge: GET sinta.{root}/challenge.php?id=,
// solve SHA-256 hashcash, POST sinta.{root}/verify.php to receive the wrapper
// URL. No browser/jsdom needed anymore — this is pure Node crypto + HTTP.
//
// Public API:
//   decryptTokens(tokens, { referer }) → Promise<(string|null)[]>
//     tokens: opaque ids scraped from <option data-server=... value=ID>
//     referer: a page URL on the upstream (used to derive the sinta. host)
//     returns: same-length array of wrapper URLs (playeriframe.sbs/...) or null

const crypto = require('crypto');
const { URL } = require('url');
const { axios, DEFAULT_HEADERS, USER_AGENT } = require('./http');

const HTTP_TIMEOUT_MS    = 8000;
// Difficulty 4 ≈ 35k hashes (~70ms). Cap at ~16M to bound worst-case wall
// time around 30s even if upstream raises difficulty to 6.
const POW_MAX_ITERATIONS = 16_000_000;
const FALLBACK_ROOT      = 'lk21official.cc';

// Server reads but doesn't strictly validate the fingerprint — it must be a
// non-empty string with the right shape. Mirror what the in-browser
// getFingerprint() would produce so it looks like a real client.
const FINGERPRINT = [USER_AGENT, 'MacIntel', '1920x1080', -420, 8].join('|');

function rootDomainFromReferer(referer) {
  try {
    const host = new URL(referer).hostname;
    return host.split('.').slice(-2).join('.');
  } catch {
    return FALLBACK_ROOT;
  }
}

function solvePow(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty);
  for (let nonce = 0; nonce < POW_MAX_ITERATIONS; nonce++) {
    const h = crypto.createHash('sha256').update(challenge + nonce).digest('hex');
    if (h.startsWith(prefix)) return nonce;
  }
  return null;
}

async function resolveOneToken(token, sintaBase, referer, origin) {
  let challengeRes;
  try {
    challengeRes = await axios.get(`${sintaBase}/challenge.php`, {
      params:  { id: token },
      headers: { ...DEFAULT_HEADERS, Referer: referer, Origin: origin },
      timeout: HTTP_TIMEOUT_MS,
    });
  } catch { return null; }

  const data = challengeRes.data || {};
  if (!data.success) return null;
  // Some tokens come back pre-trusted with no PoW required.
  if (data.trusted && data.url) return data.url;
  if (!data.challenge || !data.difficulty) return null;

  const nonce = solvePow(data.challenge, data.difficulty);
  if (nonce === null) return null;

  try {
    const verifyRes = await axios.post(
      `${sintaBase}/verify.php`,
      { challenge: data.challenge, nonce, id: token, fp: FINGERPRINT },
      {
        headers: {
          ...DEFAULT_HEADERS,
          'Content-Type': 'application/json',
          Referer: referer,
          Origin:  origin,
        },
        timeout: HTTP_TIMEOUT_MS,
      },
    );
    const v = verifyRes.data || {};
    return v.success && v.url ? v.url : null;
  } catch { return null; }
}

async function decryptTokens(tokens, { referer } = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  const root      = rootDomainFromReferer(referer);
  const sintaBase = `https://sinta.${root}`;
  const ref       = referer || `https://${root}/`;
  const origin    = new URL(ref).origin;
  return Promise.all(tokens.map((t) => resolveOneToken(t, sintaBase, ref, origin)));
}

module.exports = { decryptTokens };

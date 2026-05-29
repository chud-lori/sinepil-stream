// Resolve opaque player tokens to their wrapper iframe URL by mirroring the
// in-browser decode in upstream's player.js (function doChallengeAndLoad —
// the name is a leftover from an older protocol; it does no network call,
// just an XOR-decode of a base64 payload):
//
//   atob(token) ^ KEY repeating  →  https://playeriframe.sbs/iframe/<vendor>/<id>
//
// Public API:
//   decryptTokens(tokens) → (string|null)[]
//     tokens: opaque ids scraped from <a data-url="..."> or <option value="...">
//     returns: same-length array of wrapper URLs or null on bad input.

// Literal XOR key from upstream's player.js. Required verbatim for protocol
// interop — any change here breaks token decoding for every player. The
// "Lk21" substring is upstream's branding, not ours.
const XOR_KEY = 'Lk21SuksesSelaluJayaJayaJaya!';

function decryptOne(token) {
  if (typeof token !== 'string' || !token) return null;
  let raw;
  try { raw = Buffer.from(token, 'base64'); } catch { return null; }
  if (!raw.length) return null;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    out += String.fromCharCode(raw[i] ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
  }
  // Guard against malformed tokens producing junk strings.
  return /^https?:\/\//i.test(out) ? out : null;
}

function decryptTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  return tokens.map(decryptOne);
}

module.exports = { decryptTokens };

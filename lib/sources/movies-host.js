const { axios, DEFAULT_HEADERS } = require('../http');

// Candidate movie-source hosts. The site rotates subdomains and TLDs — when
// one stops responding we silently fall back to the next. Order = preference
// (primary, then known mirrors).
//
// Deliberately excluded (verified 09 Aug 2026):
//   lk21official.cc   — bare domain no longer resolves (subdomains still do)
//   lk21official.love — answers 200 with a FingerprintJS redirect interstitial
//                       on every path; zero cards, but never an HTTP error, so
//                       it poisons browse() instead of failing over
const CANDIDATES = [
  'tv10.lk21official.cc',
  'tv11.lk21official.cc',
  'tv12.lk21official.cc',
  'tv13.lk21official.cc',
  'lk21.party',
];

let activeHost = CANDIDATES[0];
let probing = null;

function normalizeHost(rawHost) {
  return String(rawHost || '').toLowerCase().replace(/^www\./, '');
}

function isKnownMovieHost(rawHost) {
  const h = normalizeHost(rawHost);
  return CANDIDATES.includes(h) ||
         /(?:^|\.)lk21(?:official\.cc|\.(?:de|party|cc|my\.id)|official)?$/i.test(h);
}

function adoptHost(rawHost) {
  const h = normalizeHost(rawHost);
  if (!isKnownMovieHost(h)) return false;
  if (h !== activeHost) console.log(`[movie-source] redirect: ${activeHost} → ${h}`);
  activeHost = h;
  return true;
}

// A host counts as healthy only if it serves a real listing page. Status alone
// is not enough: Cloudflare answers 403 to a non-browser UA (so the default
// axios UA made every host look "up"), and dead mirrors answer 200 with a
// redirect interstitial. Both used to pass, then browse() silently got 0 cards.
async function probeHost(host) {
  try {
    const res = await axios.get(`https://${host}/`, {
      headers: DEFAULT_HEADERS,
      timeout: 8000,
      maxRedirects: 3,
      validateStatus: () => true,
    });
    if (res.status >= 400) return false;
    return typeof res.data === 'string' && res.data.includes('<article');
  } catch {
    return false;
  }
}

// Sequentially probe candidates until one responds. Runs at most once at a
// time — subsequent callers await the same in-flight probe.
async function selectActiveHost() {
  if (probing) return probing;
  probing = (async () => {
    // Probe the host we already adopted first — it is usually the live one the
    // mirrors redirect to, and it may not even be in CANDIDATES.
    const order = [activeHost, ...CANDIDATES.filter(h => h !== activeHost)];
    for (const host of order) {
      if (await probeHost(host)) {
        if (host !== activeHost) console.log(`[movie-source] failover: ${activeHost} → ${host}`);
        activeHost = host;
        return host;
      }
    }
    console.warn('[movie-source] no candidate responded; keeping', activeHost);
    return activeHost;
  })().finally(() => { probing = null; });
  return probing;
}

function currentHost() { return activeHost; }
function getBase()     { return `https://${activeHost}`; }
function getReferer()  { return `https://${activeHost}/`; }
function getOrigin()   { return `https://${activeHost}`; }

// Pick a next-best host immediately (no HTTP probe) so the caller can retry
// with a different URL in-request without waiting. A full probe runs in
// background to set a healthier pick for subsequent requests.
function rotateAfterFailure() {
  const idx = CANDIDATES.indexOf(activeHost);
  const next = CANDIDATES[(idx + 1) % CANDIDATES.length];
  activeHost = next;
  selectActiveHost().catch(() => {});
}

module.exports = {
  selectActiveHost, rotateAfterFailure,
  isKnownMovieHost, adoptHost,
  currentHost, getBase, getReferer, getOrigin,
};

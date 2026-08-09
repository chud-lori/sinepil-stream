const { axios, DEFAULT_HEADERS } = require('../http');

// The bare `nontondrama.my` is gone from DNS (verified 09 Aug 2026) — only the
// tvN subdomains resolve, and they all redirect to the current live one, which
// `adoptHost` picks up.
const CANDIDATES = [
  'tv4.nontondrama.my',
  'tv3.nontondrama.my',
  'tv2.nontondrama.my',
  'tv1.nontondrama.my',
];

let activeHost = CANDIDATES[0];
let probing = null;

function normalizeHost(rawHost) {
  return String(rawHost || '').toLowerCase().replace(/^www\./, '');
}

function isKnownSeriesHost(rawHost) {
  const h = normalizeHost(rawHost);
  return CANDIDATES.includes(h) || /(?:^|\.)nontondrama\./i.test(h);
}

function adoptHost(rawHost) {
  const h = normalizeHost(rawHost);
  if (!isKnownSeriesHost(h)) return false;
  if (h !== activeHost) console.log(`[series-source] redirect: ${activeHost} -> ${h}`);
  activeHost = h;
  return true;
}

// Healthy = serves a real listing page, not merely "answers HTTP". A HEAD with
// the default axios UA gets a 403 from Cloudflare, which used to count as up.
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

async function selectActiveHost() {
  if (probing) return probing;
  probing = (async () => {
    // Probe the currently adopted host first — after a redirect it is the live
    // one and may not appear in CANDIDATES.
    const order = [activeHost, ...CANDIDATES.filter(h => h !== activeHost)];
    for (const host of order) {
      if (await probeHost(host)) {
        if (host !== activeHost) console.log(`[series-source] failover: ${activeHost} -> ${host}`);
        activeHost = host;
        return host;
      }
    }
    console.warn('[series-source] no candidate responded; keeping', activeHost);
    return activeHost;
  })().finally(() => { probing = null; });
  return probing;
}

function currentHost() { return activeHost; }
function getBase()     { return `https://${activeHost}`; }
function getReferer()  { return `${getBase()}/`; }
function getOrigin()   { return getBase(); }

function rotateAfterFailure() {
  const idx = CANDIDATES.indexOf(activeHost);
  const next = CANDIDATES[(idx + 1) % CANDIDATES.length];
  activeHost = next;
  selectActiveHost().catch(() => {});
}

module.exports = {
  selectActiveHost, rotateAfterFailure,
  isKnownSeriesHost, adoptHost,
  currentHost, getBase, getReferer, getOrigin,
};

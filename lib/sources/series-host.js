const { axios } = require('../http');

const CANDIDATES = [
  'tv4.nontondrama.my',
  'tv3.nontondrama.my',
  'tv2.nontondrama.my',
  'tv1.nontondrama.my',
  'nontondrama.my',
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

async function probeHost(host) {
  try {
    const res = await axios.head(`https://${host}/`, {
      timeout: 4000,
      maxRedirects: 3,
      validateStatus: () => true,
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function selectActiveHost() {
  if (probing) return probing;
  probing = (async () => {
    for (const host of CANDIDATES) {
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

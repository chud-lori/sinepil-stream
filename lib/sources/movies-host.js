const { axios } = require('../http');

// Candidate movie-source hosts. The site rotates subdomains and TLDs — when
// one stops responding we silently fall back to the next. Order = preference
// (primary, then known mirrors).
const CANDIDATES = [
  'tv10.lk21official.cc',
  'tv11.lk21official.cc',
  'tv12.lk21official.cc',
  'tv13.lk21official.cc',
  'lk21official.cc',
  'lk21official.love',
  'lk21.party',
];

let activeHost = CANDIDATES[0];
let probing = null;

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

// Sequentially probe candidates until one responds. Runs at most once at a
// time — subsequent callers await the same in-flight probe.
async function selectActiveHost() {
  if (probing) return probing;
  probing = (async () => {
    for (const host of CANDIDATES) {
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
  currentHost, getBase, getReferer, getOrigin,
};

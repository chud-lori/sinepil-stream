const dns = require('dns').promises;
const net = require('net');

// Hosts we're willing to proxy. Anything else is rejected. Subdomain-safe:
// `playeriframe.sbs` matches `a.playeriframe.sbs`. Add sparingly.
const EMBED_HOST_ALLOWLIST = [
  'playeriframe.sbs',
  'emturbovid.com',
  'f16px.com',
  'short.icu',
  'abyssplayer.com', // Hydrax landing — embeds direct today; allowlisted for proxy fallback
  'abysscdn.com',    // Hydrax CDN — abyssplayer.com 302s here, so the redirect must survive re-validation
];

function isAllowedEmbedHost(hostname) {
  const h = (hostname || '').toLowerCase();
  return EMBED_HOST_ALLOWLIST.some(allowed => h === allowed || h.endsWith('.' + allowed));
}

// Reject addresses in any private/loopback/link-local/multicast range.
// Covers IPv4 + IPv6 so SSRF can't reach the host loopback, Docker network,
// cloud metadata (169.254.169.254), or the link-local block generally.
function isPrivateAddress(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;                     // loopback
    if (a === 0) return true;                       // "this network"
    if (a === 169 && b === 254) return true;        // link-local + AWS/GCP IMDS
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;                      // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
        lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;    // fc00::/7
    if (lower.startsWith('ff')) return true;                              // multicast
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check the embedded v4
    const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateAddress(m[1]);
    return false;
  }
  return true; // not parseable as an IP — treat as private to be safe
}

// Resolve all A/AAAA records for a hostname and refuse if ANY points to
// a private range. Defeats DNS rebinding: the subsequent HTTP fetch will hit
// one of these addresses, and we've already rejected if any are private.
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      const err = new Error('Target address is private');
      err.status = 403;
      throw err;
    }
    return;
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    const err = new Error('DNS lookup failed');
    err.status = 502;
    throw err;
  }
  const bad = records.find(r => isPrivateAddress(r.address));
  if (bad) {
    const err = new Error('Target resolves to a private address');
    err.status = 403;
    throw err;
  }
}

// Combined guard — call before fetching any user-supplied URL.
async function assertSafeOutboundUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); }
  catch {
    const err = new Error('Invalid URL');
    err.status = 400;
    throw err;
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    const err = new Error('Only http/https allowed');
    err.status = 400;
    throw err;
  }
  if (!isAllowedEmbedHost(u.hostname)) {
    const err = new Error('Host not in allowlist');
    err.status = 403;
    throw err;
  }
  await assertPublicHost(u.hostname);
  return u;
}

module.exports = {
  EMBED_HOST_ALLOWLIST,
  isAllowedEmbedHost,
  isPrivateAddress,
  assertPublicHost,
  assertSafeOutboundUrl,
};

// Pure-Node decrypt for upstream's AES-encrypted player tokens.
//
// Strategy: their obfuscated `player.js` exposes its decrypt function publicly
// as `globalThis._L` and also on a `vm*_<hex>` namespace (so their own click
// handlers can call it). We load that script in jsdom, discover the decrypt
// function dynamically — preferring `_L`, falling back to a namespace scan
// that survives obfuscation regen (vmX_ → vmz_ → …).
//
// Cold init ~280 ms (upstream fetch dominates), per-token decrypt ~0.25 ms.
// Zero browser dependencies.

const { JSDOM, VirtualConsole } = require('jsdom');
const { axios } = require('./http');
const { readCache, writeCache, invalidate } = require('./cache');

// The obfuscated upstream player.js schedules async work (microtasks /
// timers) that occasionally throws after we've moved on from buildEnvironment
// — most recently `Cannot read properties of null (reading '_location')` from
// inside jsdom's Window.js location getter. Those errors are unhandled and
// kill the Node process, causing PM2 restarts and 502s during decrypt.
//
// Containment: drop any uncaughtException that originates from jsdom's
// browser internals. We still log it so the rotation is visible, and we
// re-throw anything *not* jsdom so our own bugs still crash loud.
let _jsdomGuardInstalled = false;
function installJsdomCrashGuard() {
  if (_jsdomGuardInstalled) return;
  _jsdomGuardInstalled = true;
  process.on('uncaughtException', (err) => {
    const stack = err && err.stack ? String(err.stack) : '';
    if (stack.includes('jsdom/lib/jsdom/') || stack.includes('buildEnvironment')) {
      console.warn('[decrypt] swallowed async error from jsdom context:', err.message);
      return;
    }
    console.error('uncaughtException', err);
    process.exit(1);
  });
}
installJsdomCrashGuard();

// Upstream rotated CDN + version in 2026: assets.lk21.party/?v=4 → assets.showcdnx.com/?v=8.
// When they rotate again, update these two URLs (and bump the cache key if needed).
const PLAYER_JS_URL = 'https://assets.showcdnx.com/js/player.js?v=8';
const SCRIPT_JS_URL = 'https://assets.showcdnx.com/js/script.js?t=movie&v=8';
const SOURCE_TTL    = 6 * 3600; // seconds — refresh upstream scripts every 6h

let decryptFn  = null;     // cached resolved function
let initAge    = 0;        // unix-seconds when current init was built
let initPromise = null;    // in-flight init (coalesce concurrent callers)

// Hard ceiling for upstream player.js / script.js. Current sizes are ~90 KB and
// ~20 KB respectively; 2 MB leaves an order of magnitude of slack and caps a
// hostile / misbehaving CDN from pulling the process into OOM.
const UPSTREAM_SCRIPT_MAX_BYTES = 2 * 1024 * 1024;

async function fetchUpstreamScript(url) {
  const cacheKey = `upstream-script:${url}`;
  const hit = readCache(cacheKey);
  if (hit && hit.expiresAt > Math.floor(Date.now() / 1000)) return hit.value;

  const res = await axios.get(url, {
    timeout:          12000,
    responseType:     'text',
    maxContentLength: UPSTREAM_SCRIPT_MAX_BYTES,
    maxBodyLength:    UPSTREAM_SCRIPT_MAX_BYTES,
  });
  const body = String(res.data || '');
  if (body.length < 1000) throw new Error(`upstream script too short (${body.length}B): ${url}`);
  writeCache(cacheKey, body, SOURCE_TTL);
  return body;
}

// Find the decrypt function by behavior. Both versions seen in the wild expose
// it on the page as `globalThis._L` AND on a rotating namespace (vmX_<hex>,
// vmz_<hex>, ...). We try the fast path first, then scan namespaces.
function discoverDecryptFn(window, sentinelToken) {
  const looksRight = (out) => typeof out === 'string' && /^https?:\/\//.test(out);

  // Fast path: globalThis._L — present on both v4 and v8.
  if (typeof window._L === 'function') {
    try {
      if (looksRight(window._L(sentinelToken))) return window._L;
    } catch {}
  }

  // Fallback: scan any `vm[A-Za-z]_<hex>` namespace for a function that
  // returns a URL for our sentinel token.
  for (const k of Object.keys(window)) {
    if (!/^vm[A-Za-z]_[a-f0-9]+$/.test(k)) continue;
    const ns = window[k];
    if (!ns || typeof ns !== 'object') continue;
    for (const fname of Object.keys(ns)) {
      const fn = ns[fname];
      if (typeof fn !== 'function') continue;
      try {
        if (looksRight(fn(sentinelToken))) return fn;
      } catch {}
    }
  }
  return null;
}

// One-time init: fetch upstream scripts, run in jsdom, discover decrypt fn.
async function buildEnvironment(sentinelToken) {
  const [playerJs, scriptJs] = await Promise.all([
    fetchUpstreamScript(PLAYER_JS_URL),
    fetchUpstreamScript(SCRIPT_JS_URL),
  ]);

  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {}); // suppress the noisy isMobileBrowser ref warnings etc.
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><ul id="player-list"></ul></body></html>',
    {
      url: 'https://tv10.lk21official.cc/',
      runScripts: 'dangerously',
      virtualConsole: vc,
    }
  );
  // Defensive global stubs (script.js exports these; harmless if it redefines)
  dom.window.isMobileBrowser = () => false;
  dom.window.isIOS = () => false;
  dom.window.isLocalStorageSupported = () => false;

  dom.window.eval(scriptJs);
  dom.window.eval(playerJs);

  const fn = discoverDecryptFn(dom.window, sentinelToken);
  if (!fn) {
    // Best-effort cleanup
    try { dom.window.close(); } catch {}
    throw new Error('decrypt function not found in window scope');
  }
  return { dom, fn };
}

// Idempotent init keyed by a sentinel token (we use the first token the
// resolver hands us). Re-runs after SOURCE_TTL to pick up upstream changes.
async function ensureReady(sentinelToken) {
  const now = Math.floor(Date.now() / 1000);
  const stale = !decryptFn || (now - initAge) > SOURCE_TTL;
  if (!stale) return decryptFn;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const { fn } = await buildEnvironment(sentinelToken);
    decryptFn = fn;
    initAge = Math.floor(Date.now() / 1000);
    return fn;
  })().finally(() => { initPromise = null; });

  return initPromise;
}

// Decrypt one or many tokens. Returns string | null per input.
async function decryptTokens(tokens) {
  if (!tokens.length) return [];
  const fn = await ensureReady(tokens[0]);
  return tokens.map((t) => {
    try {
      const out = fn(t);
      return typeof out === 'string' && /^https?:\/\//.test(out) ? out : null;
    } catch {
      return null;
    }
  });
}

// Force a refresh on the next call (used when the resolver suspects upstream rotation).
// Also drops the cached upstream scripts so the retry actually re-fetches them.
function invalidateInit() {
  decryptFn = null;
  initAge   = 0;
  try {
    invalidate(`upstream-script:${PLAYER_JS_URL}`);
    invalidate(`upstream-script:${SCRIPT_JS_URL}`);
  } catch {}
}

module.exports = { decryptTokens, invalidateInit };

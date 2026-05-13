// Pure-Node decrypt for upstream's AES-encrypted player tokens.
//
// Strategy: their obfuscated `player.js` exposes its decrypt function as a
// public symbol on a `vmX_<hex>` global (so their own click handlers can call
// it). We load that script in jsdom, discover the decrypt function dynamically
// (matches whatever name the next obfuscation pass uses), and call it directly.
//
// Cold init ~60ms, per-token decrypt ~0.25ms. Zero browser dependencies.
//
// If upstream changes their setup so the decrypt function isn't a public
// symbol any more, init() will throw and the resolver falls back to the
// existing headless path (kept around as a safety net).

const { JSDOM, VirtualConsole } = require('jsdom');
const { axios } = require('./http');
const { readCache, writeCache } = require('./cache');

const PLAYER_JS_URL = 'https://assets.lk21.party/js/player.js?v=4';
const SCRIPT_JS_URL = 'https://assets.lk21.party/js/script.js?t=movie&v=4';
const SOURCE_TTL    = 6 * 3600; // seconds — refresh upstream scripts every 6h

let decryptFn  = null;     // cached resolved function
let initAge    = 0;        // unix-seconds when current init was built
let initPromise = null;    // in-flight init (coalesce concurrent callers)

async function fetchUpstreamScript(url) {
  const cacheKey = `upstream-script:${url}`;
  const hit = readCache(cacheKey);
  if (hit && hit.expiresAt > Math.floor(Date.now() / 1000)) return hit.value;

  const res = await axios.get(url, { timeout: 12000, responseType: 'text' });
  const body = String(res.data || '');
  if (body.length < 1000) throw new Error(`upstream script too short (${body.length}B): ${url}`);
  writeCache(cacheKey, body, SOURCE_TTL);
  return body;
}

// Probe every function on every `vmX_*` global with the sentinel token until
// one returns a string that looks like an http(s) URL. That's the decrypt fn.
function discoverDecryptFn(window, sentinelToken) {
  for (const k of Object.keys(window)) {
    if (!/^vmX_/.test(k)) continue;
    const ns = window[k];
    if (!ns || typeof ns !== 'object') continue;
    for (const fname of Object.keys(ns)) {
      const fn = ns[fname];
      if (typeof fn !== 'function') continue;
      try {
        const out = fn(sentinelToken);
        if (typeof out === 'string' && /^https?:\/\//.test(out)) return fn;
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
    throw new Error('decrypt function not found on any vmX_* global');
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

// Force a refresh on the next call (used when the resolver suspects upstream rotation)
function invalidateInit() {
  decryptFn = null;
  initAge   = 0;
}

module.exports = { decryptTokens, invalidateInit };

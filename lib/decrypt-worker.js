// Worker-thread half of the decrypt module. Owns jsdom + the eval'd upstream
// player.js. Lives in a worker so an async throw from the obfuscated script
// (we've seen `Window.location` null-deref via processTicksAndRejections)
// only kills the worker — the parent process keeps serving requests and
// respawns the worker on next demand.
//
// Protocol — parent → worker:
//   { id, op: 'decrypt',     payload: { tokens } }
//   { id, op: 'setScripts',  payload: { playerJs, scriptJs } }
//   { id, op: 'invalidate' }
// Worker → parent:
//   { id, ok: true,  result }
//   { id, ok: false, error }

const { parentPort } = require('worker_threads');
const { JSDOM, VirtualConsole } = require('jsdom');
const { axios } = require('./http');
const { readCache, writeCache, invalidate } = require('./cache');

const DEFAULT_PLAYER_JS_URL = 'https://assets.lk21.party/js/player.js?v=15';
const DEFAULT_SCRIPT_JS_URL = 'https://assets.lk21.party/js/script.js?t=movie&v=15';
const SOURCE_TTL             = 6 * 3600;
const DECRYPT_INIT_WAIT_MS   = 250;
const UPSTREAM_SCRIPT_MAX_BYTES = 2 * 1024 * 1024;

let playerJsUrl = DEFAULT_PLAYER_JS_URL;
let scriptJsUrl = DEFAULT_SCRIPT_JS_URL;
let decryptFn   = null;
let initAge     = 0;
let initPromise = null;

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

function discoverDecryptFn(window, sentinelToken) {
  const looksRight = (out) => typeof out === 'string' && /^https?:\/\//.test(out);
  if (typeof window._L === 'function') {
    try { if (looksRight(window._L(sentinelToken))) return window._L; } catch {}
  }
  for (const k of Object.getOwnPropertyNames(window)) {
    if (k === '_L') continue;
    let fn;
    try { fn = window[k]; } catch { continue; }
    if (typeof fn !== 'function') continue;
    try { if (looksRight(fn(sentinelToken))) return fn; } catch {}
  }
  return null;
}

async function buildEnvironment(sentinelToken) {
  const [playerJs, scriptJs] = await Promise.all([
    fetchUpstreamScript(playerJsUrl),
    fetchUpstreamScript(scriptJsUrl),
  ]);

  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><ul id="player-list"></ul></body></html>',
    { url: 'https://tv10.lk21official.cc/', runScripts: 'dangerously', virtualConsole: vc }
  );
  dom.window.isMobileBrowser = () => false;
  dom.window.isIOS = () => false;
  dom.window.isLocalStorageSupported = () => false;

  dom.window.eval(scriptJs);
  dom.window.eval(playerJs);

  await new Promise((r) => setTimeout(r, DECRYPT_INIT_WAIT_MS));

  const fn = discoverDecryptFn(dom.window, sentinelToken);
  if (!fn) {
    try { dom.window.close(); } catch {}
    throw new Error('decrypt function not found in window scope');
  }
  return fn;
}

async function ensureReady(sentinelToken) {
  const now = Math.floor(Date.now() / 1000);
  const stale = !decryptFn || (now - initAge) > SOURCE_TTL;
  if (!stale) return decryptFn;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const fn = await buildEnvironment(sentinelToken);
    decryptFn = fn;
    initAge = Math.floor(Date.now() / 1000);
    return fn;
  })().finally(() => { initPromise = null; });

  return initPromise;
}

function invalidateInit() {
  decryptFn = null;
  initAge   = 0;
  try {
    invalidate(`upstream-script:${playerJsUrl}`);
    invalidate(`upstream-script:${scriptJsUrl}`);
  } catch {}
}

parentPort.on('message', async (msg) => {
  const { id, op, payload } = msg;
  try {
    if (op === 'decrypt') {
      const { tokens } = payload;
      if (!tokens.length) return parentPort.postMessage({ id, ok: true, result: [] });
      const fn = await ensureReady(tokens[0]);
      const urls = tokens.map((t) => {
        try {
          const out = fn(t);
          return typeof out === 'string' && /^https?:\/\//.test(out) ? out : null;
        } catch { return null; }
      });
      parentPort.postMessage({ id, ok: true, result: urls });
    } else if (op === 'setScripts') {
      const { playerJs, scriptJs } = payload || {};
      let changed = false;
      if (playerJs && playerJs !== playerJsUrl) { playerJsUrl = playerJs; changed = true; }
      if (scriptJs && scriptJs !== scriptJsUrl) { scriptJsUrl = scriptJs; changed = true; }
      if (changed) invalidateInit();
      parentPort.postMessage({ id, ok: true, result: { changed } });
    } else if (op === 'invalidate') {
      invalidateInit();
      parentPort.postMessage({ id, ok: true, result: true });
    } else {
      parentPort.postMessage({ id, ok: false, error: `unknown op: ${op}` });
    }
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e && e.message ? e.message : String(e) });
  }
});

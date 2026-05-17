// Parent half of the decrypt module. The actual jsdom + eval lives in
// ./decrypt-worker.js inside a worker_thread. We talk to it via correlated
// message passing.
//
// Why a worker: the obfuscated upstream player.js occasionally schedules
// async work that throws synchronously from outside any try/catch (most
// recently `Cannot read properties of null (reading '_location')` via jsdom
// Window.location getter, surfacing through processTicksAndRejections). In
// the main process that uncaught throw kills Node — PM2 restarts → 502s
// → frontend gets HTML instead of JSON. Isolating in a worker confines the
// blast radius: the worker dies, we respawn it on next call, the request
// fails cleanly with a normal error.
//
// Public API is identical to the previous monolithic version:
//   decryptTokens(tokens) → Promise<(string|null)[]>
//   invalidateInit()       — drop cached scripts + force rebuild next call
//   setUpstreamScripts({ playerJs, scriptJs })
//   discoverUpstreamScriptsFromPage($)   — cheerio-side helper for scrapers

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'decrypt-worker.js');
const REQUEST_TIMEOUT_MS = 30000;  // hard cap per call — jsdom cold init ~3s, decrypt ~ms

let worker      = null;
let nextSeq     = 1;
const pending   = new Map();          // seq → { resolve, reject, timer }
// State the parent owns and re-applies to a fresh worker after a crash:
let scriptUrls  = { playerJs: null, scriptJs: null };

function killWorker(reason) {
  if (!worker) return;
  const dyingWorker = worker;
  worker = null;
  // Reject all in-flight requests with a clear cause.
  for (const [seq, { reject, timer }] of pending) {
    clearTimeout(timer);
    reject(new Error(`decrypt worker died: ${reason} (seq ${seq})`));
  }
  pending.clear();
  try { dyingWorker.terminate(); } catch {}
}

function spawnWorker() {
  worker = new Worker(WORKER_PATH);
  worker.on('message', (msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else        entry.reject(new Error(msg.error || 'decrypt worker error'));
  });
  worker.on('error', (err) => {
    console.warn('[decrypt] worker error:', err && err.message);
    killWorker(`error: ${err && err.message}`);
  });
  worker.on('exit', (code) => {
    if (code !== 0) console.warn('[decrypt] worker exited with code', code);
    killWorker(`exit code ${code}`);
  });
  // If the parent learned script URLs before this worker existed, push them now.
  if (scriptUrls.playerJs || scriptUrls.scriptJs) {
    send('setScripts', scriptUrls).catch(() => {});
  }
}

function send(op, payload) {
  if (!worker) spawnWorker();
  const id = nextSeq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`decrypt worker timed out after ${REQUEST_TIMEOUT_MS}ms (op=${op})`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      worker.postMessage({ id, op, payload });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

async function decryptTokens(tokens) {
  if (!tokens.length) return [];
  return send('decrypt', { tokens });
}

function invalidateInit() {
  // Don't await — fire-and-forget. Caller doesn't care about the ack.
  send('invalidate').catch(() => {});
}

function setUpstreamScripts({ playerJs, scriptJs } = {}) {
  let changed = false;
  if (playerJs && playerJs !== scriptUrls.playerJs) { scriptUrls.playerJs = playerJs; changed = true; }
  if (scriptJs && scriptJs !== scriptUrls.scriptJs) { scriptUrls.scriptJs = scriptJs; changed = true; }
  if (!changed) return;
  console.log('[decrypt] upstream script URLs updated from page scrape:', scriptUrls.playerJs);
  send('setScripts', scriptUrls).catch(() => {});
}

function discoverUpstreamScriptsFromPage($) {
  let player = null;
  let script = null;
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src.startsWith('http')) return;
    if (!player && /\/player\.js(\?|$)/.test(src)) player = src;
    if (!script && /\/script\.js(\?|$)/.test(src)) script = src;
  });
  if (player || script) setUpstreamScripts({ playerJs: player, scriptJs: script });
}

module.exports = { decryptTokens, invalidateInit, setUpstreamScripts, discoverUpstreamScriptsFromPage };

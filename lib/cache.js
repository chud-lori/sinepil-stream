const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS response_cache (
    key        TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cache_expires ON response_cache(expires_at);
`);

const _get    = db.prepare('SELECT payload, expires_at FROM response_cache WHERE key = ?');
const _upsert = db.prepare(`
  INSERT INTO response_cache (key, payload, expires_at)
  VALUES (@key, @payload, @expires_at)
  ON CONFLICT(key) DO UPDATE SET
    payload    = excluded.payload,
    expires_at = excluded.expires_at
`);
const _delete     = db.prepare('DELETE FROM response_cache WHERE key = ?');
const _cleanStale = db.prepare('DELETE FROM response_cache WHERE expires_at < ?');

function now() { return Math.floor(Date.now() / 1000); }

function readCache(key) {
  const row = _get.get(key);
  if (!row) return null;
  try {
    return { value: JSON.parse(row.payload), expiresAt: row.expires_at };
  } catch {
    _delete.run(key);
    return null;
  }
}

// An empty list is never worth caching: for browse/search it almost always
// means the upstream fetch degraded (dead mirror, interstitial, blocked IP),
// and caching it turns a transient failure into 10+ minutes of empty rails
// that keep re-writing themselves empty on every revalidate.
function isCacheable(value) {
  return !(Array.isArray(value) && value.length === 0);
}

function writeCache(key, value, ttlSeconds) {
  if (!isCacheable(value)) return;
  _upsert.run({
    key,
    payload: JSON.stringify(value),
    expires_at: now() + ttlSeconds,
  });
}

// Prevents a thundering herd: if the same key is being fetched concurrently,
// all waiters share one upstream call.
const inflight = new Map();

/**
 * Wrap an async producer with a SQLite-backed cache.
 *
 * @param {string}   key
 * @param {number}   ttlSeconds
 * @param {Function} producer   async function, called on miss
 * @param {Object}   [opts]
 * @param {boolean}  [opts.staleWhileRevalidate=false]
 *        If true, expired entries are served immediately while a background
 *        refresh runs. Use for browse/list endpoints where "slightly stale"
 *        is fine. Do NOT use for detail endpoints where a wrong cached value
 *        would mislead the user.
 * @param {number}   [opts.staleGraceSeconds=3600]
 *        How long past expiry we'll still serve stale. Beyond this, treat
 *        the entry as absent and do a synchronous fetch.
 */
async function cached(key, ttlSeconds, producer, opts = {}) {
  const { staleWhileRevalidate = false, staleGraceSeconds = 3600 } = opts;

  const hit = readCache(key);
  const nowTs = now();

  // Fresh hit
  if (hit && hit.expiresAt > nowTs) return hit.value;

  // Expired but within grace window — serve stale, refresh in background
  if (hit && staleWhileRevalidate && hit.expiresAt + staleGraceSeconds > nowTs) {
    if (!inflight.has(key)) {
      const p = Promise.resolve()
        .then(() => producer())
        .then(val => { writeCache(key, val, ttlSeconds); return val; })
        .catch(() => null)
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return hit.value;
  }

  // Miss or stale-beyond-grace — synchronous fetch, coalesce concurrent callers
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve()
    .then(() => producer())
    .then(val => { writeCache(key, val, ttlSeconds); return val; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function invalidate(key) { _delete.run(key); }

// Drop expired rows once a day so the table doesn't grow unbounded.
function runStaleCleanup() {
  const { changes } = _cleanStale.run(now());
  if (changes > 0) console.log(`[cache] Dropped ${changes} expired entries`);
}
runStaleCleanup();
setInterval(runStaleCleanup, 24 * 60 * 60 * 1000).unref();

module.exports = { cached, invalidate, readCache, writeCache };

// Cross-device sync.
//
// Identity model:
//   - Each user has a `slot_id` (opaque UUID). Never seen by the client.
//   - Devices authenticate to a slot with a long-lived `token` (64 hex chars).
//   - Pairing happens via a short-lived 6-char `code` (24h window). Once paired,
//     the device uses its token; the code can expire without breaking anything.
//
// Threat shape this addresses:
//   - Leaked codes only grant access during the pairing window (24h default).
//     After that, the leaker can't pair a new device — they'd need a fresh code,
//     which only an existing paired device can mint.
//   - "Disconnect this device" actually revokes that device's token, leaving
//     other paired devices untouched.
//
// Concurrency: /push merges incoming with stored per-slug (LWW on
// watched_at/added_at). Two devices pushing simultaneously can't clobber.

const crypto = require('crypto');
const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS sync_slots (
    slot_id     TEXT PRIMARY KEY,
    payload     TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_codes (
    code        TEXT PRIMARY KEY,
    slot_id     TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sync_codes_slot ON sync_codes(slot_id);
  CREATE TABLE IF NOT EXISTS sync_tokens (
    token       TEXT PRIMARY KEY,
    slot_id     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    last_seen   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sync_tokens_slot ON sync_tokens(slot_id);
`);

// One-time cleanup of the old single-table schema from the previous Sync iteration.
try { db.exec('DROP TABLE IF EXISTS user_state'); } catch (_) {}

const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY3479'; // unambiguous on TV remotes
const CODE_RE  = /^[A-Z3479]{6}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const PAIRING_WINDOW_HOURS = 24;
const MAX_PAYLOAD_BYTES    = 256 * 1024;

function nowIso() { return new Date().toISOString(); }
function expiryIso(hours) { return new Date(Date.now() + hours * 3600 * 1000).toISOString(); }
function genCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
function genToken()  { return crypto.randomBytes(32).toString('hex'); }
function genSlotId() { return crypto.randomUUID(); }

function err(status, message) {
  const e = new Error(message); e.status = status; return e;
}

const stmts = {
  insertSlot:   db.prepare('INSERT INTO sync_slots (slot_id, payload, updated_at) VALUES (?, ?, ?)'),
  getSlot:      db.prepare('SELECT * FROM sync_slots WHERE slot_id = ?'),
  updateSlot:   db.prepare('UPDATE sync_slots SET payload = ?, updated_at = ? WHERE slot_id = ?'),

  insertCode:   db.prepare('INSERT INTO sync_codes (code, slot_id, expires_at) VALUES (?, ?, ?)'),
  getCode:      db.prepare('SELECT * FROM sync_codes WHERE code = ?'),
  deleteCodesForSlot: db.prepare('DELETE FROM sync_codes WHERE slot_id = ?'),

  insertToken:  db.prepare('INSERT INTO sync_tokens (token, slot_id, created_at, last_seen) VALUES (?, ?, ?, ?)'),
  getToken:     db.prepare('SELECT * FROM sync_tokens WHERE token = ?'),
  touchToken:   db.prepare('UPDATE sync_tokens SET last_seen = ? WHERE token = ?'),
  deleteToken:  db.prepare('DELETE FROM sync_tokens WHERE token = ?'),
};

function isValidCode(code)   { return typeof code === 'string'  && CODE_RE.test(code); }
function isValidToken(token) { return typeof token === 'string' && TOKEN_RE.test(token); }

// Allocate a code for a slot, retrying on the (statistically negligible) collision.
function _mintCode(slotId) {
  const expires = expiryIso(PAIRING_WINDOW_HOURS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genCode();
    try { stmts.insertCode.run(code, slotId, expires); return { code, expires_at: expires }; }
    catch (e) { if (!/UNIQUE/.test(e.message)) throw e; }
  }
  throw err(500, 'Could not allocate sync code');
}

// Create a new slot + initial pairing code + initial device token.
function createSlot() {
  const slotId = genSlotId();
  const now = nowIso();
  stmts.insertSlot.run(slotId, '{}', now);
  const { code, expires_at } = _mintCode(slotId);
  const token = genToken();
  stmts.insertToken.run(token, slotId, now, now);
  return { code, token, code_expires_at: expires_at };
}

// Pair a new device by typing the code. Mints a new token for that device.
// Fails if the code is unknown or its pairing window has lapsed.
function pairWithCode(code) {
  if (!isValidCode(code)) throw err(400, 'Invalid code');
  const row = stmts.getCode.get(code);
  if (!row) throw err(404, 'Unknown or expired code');
  if (row.expires_at < nowIso()) throw err(410, 'Code has expired');
  const slot = stmts.getSlot.get(row.slot_id);
  if (!slot) throw err(404, 'Slot missing');
  const token = genToken();
  const now = nowIso();
  stmts.insertToken.run(token, row.slot_id, now, now);
  let payload = {};
  try { payload = JSON.parse(slot.payload || '{}'); } catch { payload = {}; }
  return { token, payload, updated_at: slot.updated_at };
}

function _slotIdFromToken(token) {
  if (!isValidToken(token)) throw err(401, 'Invalid token');
  const row = stmts.getToken.get(token);
  if (!row) throw err(401, 'Unknown token');
  stmts.touchToken.run(nowIso(), token);
  return row.slot_id;
}

function pullByToken(token) {
  const slotId = _slotIdFromToken(token);
  const slot = stmts.getSlot.get(slotId);
  let payload = {};
  try { payload = JSON.parse(slot.payload || '{}'); } catch { payload = {}; }
  return { payload, updated_at: slot.updated_at };
}

// Per-slug last-writer-wins merge using ISO timestamps (string-comparable).
function _mergeLists(local, remote, tsKey) {
  const map = new Map();
  for (const item of (local  || [])) if (item?.slug) map.set(item.slug, item);
  for (const item of (remote || [])) {
    if (!item?.slug) continue;
    const existing = map.get(item.slug);
    if (!existing || (item[tsKey] || '') > (existing[tsKey] || '')) {
      map.set(item.slug, item);
    }
  }
  return [...map.values()].sort((a, b) =>
    String(b[tsKey] || '').localeCompare(String(a[tsKey] || ''))
  );
}

function _mergePayloads(existing, incoming) {
  return {
    v: 1,
    history:  _mergeLists(existing.history,  incoming.history,  'watched_at'),
    wishlist: _mergeLists(existing.wishlist, incoming.wishlist, 'added_at'),
  };
}

// Push merges client payload with stored payload (server-side LWW). Returns
// merged result so the client can replace its local state authoritatively.
function pushByToken(token, incoming) {
  const slotId = _slotIdFromToken(token);
  const incomingJson = JSON.stringify(incoming || {});
  if (incomingJson.length > MAX_PAYLOAD_BYTES) throw err(413, 'Payload too large');

  const slot = stmts.getSlot.get(slotId);
  let existing = {};
  try { existing = JSON.parse(slot.payload || '{}'); } catch {}
  const merged = _mergePayloads(existing, incoming || {});
  const now = nowIso();
  stmts.updateSlot.run(JSON.stringify(merged), now, slotId);
  return { payload: merged, updated_at: now };
}

// Mint a fresh pairing code for the slot, invalidating prior codes for it.
// Useful when the original code expired or was leaked.
function regenerateCode(token) {
  const slotId = _slotIdFromToken(token);
  stmts.deleteCodesForSlot.run(slotId);
  const { code, expires_at } = _mintCode(slotId);
  return { code, code_expires_at: expires_at };
}

// Revoke just this device's token. Other devices keep their access.
function disconnect(token) {
  if (isValidToken(token)) stmts.deleteToken.run(token);
}

module.exports = {
  createSlot,
  pairWithCode,
  pullByToken,
  pushByToken,
  regenerateCode,
  disconnect,
  isValidCode,
  isValidToken,
};

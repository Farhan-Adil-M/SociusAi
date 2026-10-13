// SQLite storage for application records (sources, quizzes, attempts, learner
// progress). Thin module over the uniform engine facade in db.js — schema
// creation, migrations and the two interchangeable engines (node:sqlite /
// libSQL) all live there. ChromaDB stays responsible for vectors and
// semantic search only.

// Remote (hosted Turso) selection is handled by openAppDb() in db.js — the
// server boots (`server/index.js`, `api/index.js`) use that; this module only
// opens the LOCAL node engine, exactly like the previous openDb did.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { openLocalDb, CURRENT_SCHEMA_VERSION } from './db.js';

export { CURRENT_SCHEMA_VERSION };

/** Open the local SQLite application database (node:sqlite engine, migrated). */
export function openDb(dbPath = path.join(config.dataDir, 'app.db')) {
  return openLocalDb(dbPath, { migrate: true });
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`; // 12 unpredictable hex chars
}

/** Defensive parse of a stored JSON object column: never throws, non-object
 *  → `fallback`. Corrupt rows must not crash readers of saved data. */
export function parseJsonObject(text, fallback = {}) {
  try {
    const value = JSON.parse(text ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export async function logActivity(db, type, topic, detail, sessionId = null) {
  await db.run('INSERT INTO activity (type, topic, detail, at, session_id) VALUES (?, ?, ?, ?, ?)',
    type, topic ?? null, detail, nowIso(), sessionId);
}

// ---- app-level metadata (researched values that must survive restarts) ----

export async function getMeta(db, key) {
  const row = await db.get('SELECT value FROM app_meta WHERE key = ?', key);
  return row ? row.value : null;
}

export async function setMeta(db, key, value) {
  await db.run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

export async function delMeta(db, key) {
  await db.run('DELETE FROM app_meta WHERE key = ?', key);
}

// SQLite storage for application records (sources, quizzes, attempts, learner
// progress). Uses Node's built-in node:sqlite — no extra dependency.
// ChromaDB stays responsible for vectors and semantic search only.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export function openDb(dbPath = path.join(config.dataDir, 'app.db')) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      title       TEXT NOT NULL,
      url         TEXT,
      page_count  INTEGER,
      slide_count INTEGER,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      session_id  TEXT,
      tags_json   TEXT NOT NULL DEFAULT '[]',
      org_source  TEXT NOT NULL DEFAULT 'manual',
      manual_override INTEGER NOT NULL DEFAULT 0,
      suggestion_json TEXT
    );

    -- Extracted text with page/slide/paragraph locations. Kept so the vector
    -- index can be rebuilt (npm run reindex) without re-uploading files.
    CREATE TABLE IF NOT EXISTS source_segments (
      source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      seg_index  INTEGER NOT NULL,
      location   TEXT NOT NULL,
      text       TEXT NOT NULL
    );

    -- Study sessions group sources, quizzes and decks. Sources without a
    -- session live in "Unsorted" (session_id IS NULL).
    CREATE TABLE IF NOT EXISTS study_sessions (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'subject',
      description TEXT,
      tags_json   TEXT NOT NULL DEFAULT '[]',
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quizzes (
      id             TEXT PRIMARY KEY,
      topic          TEXT NOT NULL,
      difficulty     TEXT NOT NULL,
      question_count INTEGER NOT NULL,
      created_at     TEXT NOT NULL,
      answered_at    TEXT,
      session_id     TEXT
    );

    -- The answer key lives here, server-side, until the student submits.
    CREATE TABLE IF NOT EXISTS quiz_questions (
      quiz_id           TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      idx               INTEGER NOT NULL,
      text              TEXT NOT NULL,
      choices_json      TEXT NOT NULL,
      correct_choice_id TEXT NOT NULL,
      explanation       TEXT NOT NULL DEFAULT '',
      citations_json    TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (quiz_id, idx)
    );

    CREATE TABLE IF NOT EXISTS quiz_attempts (
      quiz_id      TEXT PRIMARY KEY REFERENCES quizzes(id),
      answers_json TEXT NOT NULL,
      correct      INTEGER NOT NULL,
      total        INTEGER NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learner_topics (
      topic             TEXT PRIMARY KEY,
      correct           INTEGER NOT NULL DEFAULT 0,
      total             INTEGER NOT NULL DEFAULT 0,
      difficulty        TEXT NOT NULL DEFAULT 'medium',
      updated_at        TEXT NOT NULL,
      last_practiced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS decks (
      id               TEXT PRIMARY KEY,
      session_id       TEXT REFERENCES study_sessions(id),
      topic            TEXT NOT NULL,
      source_ids_json  TEXT NOT NULL DEFAULT '[]',
      card_count       INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL,
      last_reviewed_at TEXT
    );

    -- Study-session organisation: AI suggestions stored per source; manual
    -- choices are sticky (manual_override) and never replaced automatically.
    -- (The sources row itself carries session_id/tags/org/override columns.)

    CREATE TABLE IF NOT EXISTS activity (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL,
      topic      TEXT,
      detail     TEXT NOT NULL,
      at         TEXT NOT NULL,
      session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Persistent flashcard decks. Cards inherit their session from the deck.
    CREATE TABLE IF NOT EXISTS decks (
      id               TEXT PRIMARY KEY,
      session_id       TEXT REFERENCES study_sessions(id),
      topic            TEXT NOT NULL,
      source_ids_json  TEXT NOT NULL DEFAULT '[]',
      card_count       INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL,
      last_reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deck_cards (
      deck_id        TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      idx            INTEGER NOT NULL,
      front          TEXT NOT NULL,
      back           TEXT NOT NULL,
      citations_json TEXT NOT NULL DEFAULT '[]',
      status         TEXT NOT NULL DEFAULT 'new', -- new | known | review
      reviewed_at    TEXT,
      PRIMARY KEY (deck_id, idx)
    );
  `);

  migrate(db, dbPath);
  return db;
}

// ---- schema migration -------------------------------------------------------
// v1 databases predate study sessions and decks. The move to v2 is purely
// additive (new columns and tables), so no row can be lost. A one-time copy of
// the v1 file is taken before the first upgrade as a safety net.

function schemaVersion(db) {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 1;
}

function addColumnIfMissing(db, table, column, ddl) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  if (!present.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function migrate(db, dbPath) {
  if (schemaVersion(db) >= 2) return;

  // Safety copy once per database (the .bak is skipped on later runs).
  if (dbPath && fs.existsSync(dbPath) && !fs.existsSync(`${dbPath}.v1.bak`)) {
    try { fs.copyFileSync(dbPath, `${dbPath}.v1.bak`); } catch { /* read-only fs etc. */ }
  }

  addColumnIfMissing(db, 'sources', 'session_id', 'session_id TEXT');
  addColumnIfMissing(db, 'sources', 'tags_json', "tags_json TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'sources', 'org_source', "org_source TEXT NOT NULL DEFAULT 'manual'");
  addColumnIfMissing(db, 'sources', 'manual_override', 'manual_override INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'sources', 'suggestion_json', 'suggestion_json TEXT');
  addColumnIfMissing(db, 'quizzes', 'session_id', 'session_id TEXT');
  addColumnIfMissing(db, 'activity', 'session_id', 'session_id TEXT');

  db.prepare("INSERT INTO app_meta (key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run();
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function logActivity(db, type, topic, detail, sessionId = null) {
  db.prepare('INSERT INTO activity (type, topic, detail, at, session_id) VALUES (?, ?, ?, ?, ?)')
    .run(type, topic ?? null, detail, nowIso(), sessionId);
}

// ---- app-level metadata (researched values that must survive restarts) ----

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

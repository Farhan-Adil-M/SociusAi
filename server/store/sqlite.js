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
      created_at  TEXT NOT NULL
    );

    -- Extracted text with page/slide/paragraph locations. Kept so the vector
    -- index can be rebuilt (npm run reindex) without re-uploading files.
    CREATE TABLE IF NOT EXISTS source_segments (
      source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      seg_index  INTEGER NOT NULL,
      location   TEXT NOT NULL,
      text       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quizzes (
      id             TEXT PRIMARY KEY,
      topic          TEXT NOT NULL,
      difficulty     TEXT NOT NULL,
      question_count INTEGER NOT NULL,
      created_at     TEXT NOT NULL,
      answered_at    TEXT
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

    CREATE TABLE IF NOT EXISTS activity (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      type    TEXT NOT NULL,
      topic   TEXT,
      detail  TEXT NOT NULL,
      at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function logActivity(db, type, topic, detail) {
  db.prepare('INSERT INTO activity (type, topic, detail, at) VALUES (?, ?, ?, ?)')
    .run(type, topic ?? null, detail, nowIso());
}

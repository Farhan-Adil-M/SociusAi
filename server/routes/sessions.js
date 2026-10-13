// Session CRUD. Sessions ARE the organisational layer — a stable workspace of
// related sources, quizzes and decks. Unassigned material lives in "Unsorted"
// and is reported every time a session list is requested.

import express from 'express';
import { CATEGORIES } from '../constants.js';
import { ApiError } from '../middleware/errors.js';
import { newId, nowIso, logActivity } from '../store/sqlite.js';
import { sourceRowToApi } from './sources.js';

export async function getSessionOr404(db, id) {
  const row = await db.get('SELECT * FROM study_sessions WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'SESSION_NOT_FOUND', `Session "${id}" does not exist.`);
  return row;
}

function parseTags(value) {
  try { return JSON.parse(value) || []; } catch { return []; }
}

function validateTags(tags) {
  if (!Array.isArray(tags)) throw new ApiError(400, 'VALIDATION_ERROR', 'Tags must be an array of short strings.');
  if (tags.length > 8) throw new ApiError(400, 'VALIDATION_ERROR', 'Use at most 8 tags per session.');
  const clean = tags.map((tag) => String(tag).trim()).filter(Boolean);
  if (clean.some((tag) => tag.length < 1 || tag.length > 24)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Each tag must be 1–24 characters.');
  }
  return clean;
}

function validateTitle(title) {
  if (typeof title !== 'string' || title.trim().length < 2 || title.trim().length > 80) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Session title must be between 2 and 80 characters.');
  }
  return title.trim();
}

export function sessionToApi(row, extra = {}) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description ?? '',
    tags: parseTags(row.tags_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

// lastActivityAt: session updated_at plus the newest source, deck, quiz or
// logged activity that belongs to the session. Scalar MAX() subqueries ignore
// NULLs and keep the query simple (no nested compound selects).
const LIST_COLUMNS = `
  s.*,
  (SELECT COUNT(*) FROM sources  WHERE session_id = s.id) AS source_count,
  (SELECT COUNT(*) FROM decks    WHERE session_id = s.id) AS deck_count,
  (
    SELECT MAX(
      s.updated_at,
      (SELECT MAX(created_at)     FROM sources WHERE session_id = s.id),
      (SELECT MAX(created_at)     FROM decks   WHERE session_id = s.id),
      (SELECT MAX(last_reviewed_at) FROM decks WHERE session_id = s.id),
      (SELECT MAX(created_at)     FROM quizzes WHERE session_id = s.id),
      (SELECT MAX(at)             FROM activity WHERE session_id = s.id)
    )
  ) AS last_activity
`;

export function sessionsRouter({ db }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const { category, q, includeArchived } = req.query;
    const sort = req.query.sort ?? 'recent';
    if (!['recent', 'alpha', 'active'].includes(sort)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'sort must be recent, alpha, or active.');
    }
    if (category && !CATEGORIES.has(category)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown category. Use subject, research, self-study, exam-prep, or general.');
    }
    const search = typeof q === 'string' && q.trim() !== '' ? q.trim() : null;

    const filters = [];
    if (includeArchived !== '1') filters.push("s.status = 'active'");
    if (category) filters.push('s.category = ?');
    if (search) filters.push('(s.title LIKE ? OR s.description LIKE ? OR s.tags_json LIKE ?)');
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const params = [];
    if (category) params.push(category);
    if (search) {
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const orderBy = { recent: 's.updated_at DESC', alpha: 's.title COLLATE NOCASE ASC', active: 'last_activity DESC' }[sort];
    const rows = await db.all(`SELECT ${LIST_COLUMNS} FROM study_sessions s ${where} ORDER BY ${orderBy}`, ...params);

    const unsortedSourceCount = (await db.get('SELECT COUNT(*) AS n FROM sources WHERE session_id IS NULL')).n;

    res.json({
      sessions: rows.map((row) => sessionToApi(row, {
        sourceCount: row.source_count,
        deckCount: row.deck_count,
        lastActivityAt: row.last_activity,
      })),
      unsortedSourceCount,
    });
  });

  router.post('/', async (req, res) => {
    const { title, category, description, tags } = req.body ?? {};
    const cleanTitle = validateTitle(title);
    if (category !== undefined && !CATEGORIES.has(category)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown category. Use subject, research, self-study, exam-prep, or general.');
    }
    const cleanTags = tags === undefined ? [] : validateTags(tags);
    if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Description must be at most 500 characters.');
    }

    const id = newId('ses');
    const now = nowIso();
    await db.run('INSERT INTO study_sessions (id, title, category, description, tags_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, cleanTitle, category ?? 'subject', description ?? null, JSON.stringify(cleanTags), 'active', now, now);
// session create gets logged with the session id so "active" sorting has real data
    await logActivity(db, 'session', null, `Created session "${cleanTitle}"`, id);
    res.status(201).json({ session: sessionToApi(await db.get('SELECT * FROM study_sessions WHERE id = ?', id)) });
  });

  router.get('/:id', async (req, res) => {
    const session = await getSessionOr404(db, req.params.id);
    const sources = await db.all('SELECT * FROM sources WHERE session_id = ? ORDER BY created_at DESC', session.id);
    const decks = (await db.all('SELECT id, topic, card_count, created_at FROM decks WHERE session_id = ? ORDER BY created_at DESC', session.id))
      .map((row) => ({ id: row.id, topic: row.topic, cardCount: row.card_count, createdAt: row.created_at }));
    res.json({
      session: sessionToApi(session, {
        sourceCount: sources.length,
        deckCount: decks.length,
        lastActivityAt: session.updated_at,
      }),
      sources: sources.map(sourceRowToApi),
      decks,
    });
  });

  router.patch('/:id', async (req, res) => {
    const session = await getSessionOr404(db, req.params.id);
    const { title, category, description, tags, status } = req.body ?? {};
    const updates = [];

    if (title !== undefined) updates.push(['title', validateTitle(title)]);
    if (category !== undefined) {
      if (!CATEGORIES.has(category)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown category.');
      updates.push(['category', category]);
    }
    if (description !== undefined) {
      if (typeof description !== 'string' || description.length > 500) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Description must be at most 500 characters.');
      }
      updates.push(['description', description.trim()]);
    }
    if (tags !== undefined) updates.push(['tags_json', JSON.stringify(validateTags(tags))]);
    if (status !== undefined) {
      if (!['active', 'archived'].includes(status)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'status must be active or archived.');
      }
      updates.push(['status', status]);
    }

    if (updates.length === 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Provide a title, category, description, tags, or status to update.');
    }
    updates.push(['updated_at', nowIso()]);
    const setClause = updates.map(([column]) => `${column} = ?`).join(', ');
    await db.run(`UPDATE study_sessions SET ${setClause} WHERE id = ?`, ...updates.map(([, value]) => value), session.id);

    res.json({ session: sessionToApi(await db.get('SELECT * FROM study_sessions WHERE id = ?', session.id)) });
  });

  return router;
}

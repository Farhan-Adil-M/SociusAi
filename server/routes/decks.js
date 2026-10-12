// Persistent flashcard decks: browse, open, practise with saved review status.
// Generation still lives in flashcardService; this route saves and serves decks.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { CATEGORIES } from './sessions.js';
import { nowIso } from '../store/sqlite.js';

const CARD_STATUSES = new Set(['new', 'known', 'review']);

function deckRowToApi(row, extra = {}) {
  return {
    id: row.id,
    sessionId: row.session_id ?? null,
    topic: row.topic,
    cardCount: row.card_count,
    createdAt: row.created_at,
    lastReviewedAt: row.last_reviewed_at ?? null,
    ...extra,
  };
}

export function decksRouter({ db }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const { sessionId: sessionFilter, category, q } = req.query;
    const sort = req.query.sort ?? 'recent';
    if (!['recent', 'alpha', 'active'].includes(sort)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'sort must be recent, alpha, or active.');
    }
    if (category && !CATEGORIES.has(category)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown category.');
    }
    const search = typeof q === 'string' && q.trim() !== '' ? q.trim() : null;

    const filters = [];
    const params = [];
    if (sessionFilter === 'unsorted') filters.push('d.session_id IS NULL');
    else if (typeof sessionFilter === 'string' && sessionFilter !== '') {
      filters.push('d.session_id = ?');
      params.push(sessionFilter);
    }
    if (category) {
      filters.push('ss.category = ?');
      params.push(category);
    }
    if (search) {
      filters.push('(d.topic LIKE ? OR ss.title LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like);
    }

    const columns = `
      d.*,
      ss.title AS session_title,
      ss.category AS session_category,
      (SELECT COUNT(*) FROM deck_cards WHERE deck_id = d.id AND status = 'known') AS known_count,
      (SELECT COUNT(*) FROM deck_cards WHERE deck_id = d.id AND status = 'review') AS review_count
    `;
    const join = 'decks d LEFT JOIN study_sessions ss ON ss.id = d.session_id';
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    // "active" = last studied first, never-studied decks last, newest first then.
    const orderBy = {
      recent: 'd.created_at DESC',
      alpha: 'd.topic COLLATE NOCASE ASC',
      active: `CASE WHEN d.last_reviewed_at IS NOT NULL THEN d.last_reviewed_at ELSE '' END DESC, d.created_at DESC`,
    }[sort];

    const rows = db.prepare(`SELECT ${columns} FROM ${join} ${where} ORDER BY ${orderBy}`).all(...params);
    const unsortedDeckCount = db.prepare('SELECT COUNT(*) AS n FROM decks WHERE session_id IS NULL').get().n;

    res.json({
      decks: rows.map((row) => deckRowToApi(row, {
        sessionTitle: row.session_title ?? null,
        category: row.session_category ?? null,
        knownCount: row.known_count,
        reviewCount: row.review_count,
      })),
      unsortedDeckCount,
    });
  });

  router.get('/:deckId', (req, res) => {
    const row = db.prepare(`
      SELECT d.*, ss.title AS session_title, ss.category AS session_category
      FROM decks d LEFT JOIN study_sessions ss ON ss.id = d.session_id
      WHERE d.id = ?`).get(req.params.deckId);
    if (!row) throw new ApiError(404, 'DECK_NOT_FOUND', 'That deck does not exist. Generate a new one.');

    const cards = db.prepare('SELECT * FROM deck_cards WHERE deck_id = ? ORDER BY idx').all(row.id)
      .map((card) => ({
        idx: card.idx,
        front: card.front,
        back: card.back,
        citations: JSON.parse(card.citations_json),
        status: card.status,
        reviewedAt: card.reviewed_at,
      }));

    res.json({
      deck: deckRowToApi(row, {
        sessionTitle: row.session_title ?? null,
        category: row.session_category ?? null,
        knownCount: cards.filter((c) => c.status === 'known').length,
        reviewCount: cards.filter((c) => c.status === 'review').length,
        sourceIds: (() => { try { return JSON.parse(row.source_ids_json) || []; } catch { return []; } })(),
      }),
      cards,
    });
  });

  router.patch('/:deckId/cards/:idx', (req, res) => {
    const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(req.params.deckId);
    if (!deck) throw new ApiError(404, 'DECK_NOT_FOUND', 'That deck does not exist. Generate a new one.');

    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= deck.card_count) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Card index does not exist in this deck.');
    }
    const { status } = req.body ?? {};
    if (!CARD_STATUSES.has(status)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'status must be new, known, or review.');
    }

    const now = nowIso();
    db.prepare('UPDATE deck_cards SET status = ?, reviewed_at = ? WHERE deck_id = ? AND idx = ?')
      .run(status, now, deck.id, idx);
    db.prepare('UPDATE decks SET last_reviewed_at = ? WHERE id = ?').run(now, deck.id);
    res.json({ deckId: deck.id, idx, status, lastReviewedAt: now });
  });

  router.delete('/:deckId', (req, res) => {
    const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(req.params.deckId);
    if (!deck) throw new ApiError(404, 'DECK_NOT_FOUND', 'That deck does not exist. Generate a new one.');
    db.prepare('DELETE FROM decks WHERE id = ?').run(deck.id); // cards cascade
    res.status(204).end();
  });

  return router;
}

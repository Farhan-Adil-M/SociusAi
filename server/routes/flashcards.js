// POST /api/flashcards/generate — generates AND persists a deck.
// Session scope is enforced server-side via resolveScope (sessionId present)
// or the legacy sourceIds filter. The deck is saved and returned with its id.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { generateFlashcards } from '../services/flashcardService.js';
import { assertSourcesExist, resolveScope } from '../services/retrieval.js';

export function flashcardsRouter({ db, ai, vector }) {
  const router = express.Router();

  router.post('/generate', async (req, res) => {
    const { topic, count, sourceIds, sessionId } = req.body ?? {};
    if (typeof topic !== 'string' || topic.trim().length < 2 || topic.trim().length > 80) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Topic must be between 2 and 80 characters.');
    }
    if (count !== undefined && (!Number.isInteger(count) || count < 3 || count > 12)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'count must be a whole number between 3 and 12.');
    }
    if (sourceIds !== undefined && (!Array.isArray(sourceIds) || sourceIds.some((s) => typeof s !== 'string'))) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'sourceIds must be an array of source id strings.');
    }

    const scope = await resolveScope(db, { sessionId, sourceIds: sourceIds ?? [] });
    if (!scope.session) {
      await assertSourcesExist(db, sourceIds ?? []); // legacy path: plain source filter
    }

    const result = await generateFlashcards(
      { topic: topic.trim(), count: count ?? 8, sourceIds: scope.sourceIds, sessionId: scope.session?.id ?? null },
      { ai, vector, db },
    );
    res.status(201).json(result);
  });

  return router;
}

// POST /api/tutor/ask — source-grounded question answering.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { answerQuestion } from '../services/tutorService.js';
import { APPROACH_ORDER } from '../services/events.js';
import { assertSourcesExist, resolveScope } from '../services/retrieval.js';
import { logActivity } from '../store/sqlite.js';

export function tutorRouter({ db, ai, vector }) {
  const router = express.Router();

  router.post('/ask', async (req, res) => {
    const { question, sourceIds, sessionId, approach } = req.body ?? {};
    if (typeof question !== 'string' || question.trim().length < 3 || question.trim().length > 300) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Question must be between 3 and 300 characters.');
    }
    if (sourceIds !== undefined && (!Array.isArray(sourceIds) || sourceIds.some((s) => typeof s !== 'string'))) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'sourceIds must be an array of source id strings.');
    }
    // One-off teaching approach for this answer (v1.4): stored styles plus the
    // request-only values 'simpler' and 'different'.
    const APPROACHES = new Set([...APPROACH_ORDER, 'simpler', 'different']);
    if (approach !== undefined && !APPROACHES.has(approach)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `approach must be one of: ${[...APPROACHES].join(', ')}.`);
    }

    const scope = resolveScope(db, { sessionId, sourceIds: sourceIds ?? [] });
    if (!scope.session) {
      await assertSourcesExist(db, sourceIds ?? []); // legacy path: plain source filter
    }

    const result = await answerQuestion(
      { question: question.trim(), sourceIds: scope.sourceIds, db, ...(approach !== undefined ? { approach } : {}) },
      { ai, vector },
    );
    logActivity(db, 'question', null, `Asked: ${question.trim().slice(0, 80)}`, scope.session?.id ?? null);
    res.json({ ...result, ...('approachUsed' in result ? { approachUsed: result.approachUsed } : {}), sessionId: scope.session?.id ?? null });
  });

  return router;
}

// POST /api/tutor/ask — source-grounded question answering.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { answerQuestion } from '../services/tutorService.js';
import { assertSourcesExist } from '../services/retrieval.js';
import { logActivity } from '../store/sqlite.js';

export function tutorRouter({ db, ai, vector }) {
  const router = express.Router();

  router.post('/ask', async (req, res) => {
    const { question, sourceIds } = req.body ?? {};
    if (typeof question !== 'string' || question.trim().length < 3 || question.trim().length > 300) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Question must be between 3 and 300 characters.');
    }
    if (sourceIds !== undefined && (!Array.isArray(sourceIds) || sourceIds.some((s) => typeof s !== 'string'))) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'sourceIds must be an array of source id strings.');
    }

    await assertSourcesExist(db, sourceIds ?? []);
    const result = await answerQuestion({ question: question.trim(), sourceIds: sourceIds ?? [], db }, { ai, vector });
    logActivity(db, 'question', null, `Asked: ${question.trim().slice(0, 80)}`);
    res.json(result);
  });

  return router;
}

// POST /api/tutor/ask — source-grounded question answering.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { answerQuestion } from '../services/tutorService.js';
import { APPROACH_ORDER } from '../services/events.js';
import { assertSourcesExist, resolveScope } from '../services/retrieval.js';
import { classifyIntent, revisionAdvice, progressAdvice, importantQuestions } from '../services/studyAdvice.js';
import { generateFlashcards } from '../services/flashcardService.js';
import { logActivity } from '../store/sqlite.js';

/**
 * Part 8 (contract v1.5) — auto practice deck during active study.
 * Guards a successful session-scoped answer: the session must have material
 * (≥1 source, already resolved by resolveScope) and no deck yet.
 * Returns true when background generation was actually started.
 *
 * Duplicate prevention is the "session has no deck yet" check below — a
 * per-process guard: two asks more than milliseconds apart cannot
 * double-generate because the first deck row is committed by then. Honest
 * limitation stated in the contract: two parallel asks within milliseconds of
 * each other (or two cold serverless instances) could both pass this check
 * before either deck lands — accepted for the local demo; strict
 * cross-instance idempotency arrives with the hosted database.
 */
async function maybeStartAutoDeck({ db, ai, vector, scope }) {
  const { session, sourceIds } = scope;
  if (!session || sourceIds.length === 0) return false; // unscoped answer or zero-source session: never trigger

  const deckCount = await db.get('SELECT COUNT(*) AS n FROM decks WHERE session_id = ?', session.id);
  if (deckCount.n > 0) return false; // the session already has a deck

  const topic = session.title.trim().slice(0, 80);
  // Fire-and-forget, never blocking this answer: the exact saved-deck path as
  // POST /api/flashcards/generate — generateFlashcards with `db` persists the
  // deck row + cards identically (the deck later simply appears in Decks).
  void generateFlashcards({ topic, count: 8, sourceIds, sessionId: session.id }, { ai, vector, db }).catch((err) => {
    // Failure is not silent (contract v1.5): written to the activity feed,
    // and never crashes the already-sent response.
    void logActivity(db, 'deck-failed', topic, `Auto deck generation failed: ${err?.message ?? err}`, session.id).catch(() => {});
  });
  return true;
}

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

    const scope = await resolveScope(db, { sessionId, sourceIds: sourceIds ?? [] });
    if (!scope.session) {
      await assertSourcesExist(db, sourceIds ?? []); // legacy path: plain source filter
    }

    // ---- study-planning intents (Part 6) ----
    // Deterministic keyword routing AFTER all validation and scoping. The
    // 'important-questions' branch passes the SAME server-enforced sourceIds
    // scope as the normal path. intent 'normal' falls through to the existing
    // answering flow below, untouched.
    const intent = classifyIntent(question.trim()).intent;
    if (intent === 'revise-next') {
      const result = await revisionAdvice(db); // deterministic, no AI call
      await logActivity(db, 'question', null, `[revision] asked what to revise: ${question.trim().slice(0, 80)}`, scope.session?.id ?? null);
      return res.json({ ...result, sessionId: scope.session?.id ?? null });
    }
    if (intent === 'progress') {
      const result = await progressAdvice(db); // deterministic roll-up, no AI call
      await logActivity(db, 'question', null, `[progress] asked how they are doing: ${question.trim().slice(0, 80)}`, scope.session?.id ?? null);
      return res.json({ ...result, sessionId: scope.session?.id ?? null });
    }
    if (intent === 'important-questions') {
      const result = await importantQuestions(db, { question: question.trim(), sourceIds: scope.sourceIds }, { ai, vector });
      await logActivity(db, 'question', null, `[practice] asked for important questions: ${question.trim().slice(0, 80)}`, scope.session?.id ?? null);
      return res.json({ ...result, sessionId: scope.session?.id ?? null });
    }

    const result = await answerQuestion(
      { question: question.trim(), sourceIds: scope.sourceIds, db, ...(approach !== undefined ? { approach } : {}) },
      { ai, vector },
    );
    await logActivity(db, 'question', null, `Asked: ${question.trim().slice(0, 80)}`, scope.session?.id ?? null);

    // ---- Part 8 (contract v1.5): auto practice deck during active study ----
    // Only on a successful grounded answer (needsContent false) inside a
    // session with material and no deck yet. The generation itself runs in the
    // background (see maybeStartAutoDeck); this handler only awaits the cheap
    // pre-guard so the response field is honest about "actually started".
    // Intent paths (revise-next / progress / important-questions) returned
    // above, so generation can never start from those paths.
    let extra = {};
    if (!result.needsContent && await maybeStartAutoDeck({ db, ai, vector, scope })) extra = { deckGeneration: 'started' };
    res.json({ ...result, ...('approachUsed' in result ? { approachUsed: result.approachUsed } : {}), ...extra, sessionId: scope.session?.id ?? null });
  });

  return router;
}

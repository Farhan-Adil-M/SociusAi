// Quiz routes: generate (no answer key in the response) and answer (grade,
// reveal, update learner model).

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { chooseDifficulty, applyAttempt } from '../services/learner.js';
import { generateQuiz, gradeAnswers } from '../services/quizService.js';
import { resolveScope, assertSourcesExist } from '../services/retrieval.js';
import { recordEvent, maybeRecordRecovery } from '../services/events.js';
import { logActivity, nowIso } from '../store/sqlite.js';

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

export function quizRouter({ db, ai, vector }) {
  const router = express.Router();

  router.post('/generate', async (req, res) => {
    const { topic, questionCount, difficulty, sourceIds, sessionId } = req.body ?? {};
    if (typeof topic !== 'string' || topic.trim().length < 2 || topic.trim().length > 80) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Topic must be between 2 and 80 characters.');
    }
    if (questionCount !== undefined && (!Number.isInteger(questionCount) || questionCount < 3 || questionCount > 10)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'questionCount must be a whole number between 3 and 10.');
    }
    if (difficulty !== undefined && !DIFFICULTIES.has(difficulty)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'difficulty must be easy, medium, or hard.');
    }
    if (sourceIds !== undefined && (!Array.isArray(sourceIds) || sourceIds.some((s) => typeof s !== 'string'))) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'sourceIds must be an array of source id strings.');
    }

    const scope = await resolveScope(db, { sessionId, sourceIds: sourceIds ?? [] });
    if (!scope.session) {
      await assertSourcesExist(db, sourceIds ?? []); // legacy path: plain source filter
    }

    // No difficulty given → the learner model chooses for this topic.
    const stats = await db.get('SELECT * FROM learner_topics WHERE topic = ?', topic.trim().toLowerCase());
    const chosenDifficulty = difficulty ?? chooseDifficulty(stats);

    const quiz = await generateQuiz(
      { topic: topic.trim(), questionCount: questionCount ?? 5, difficulty: chosenDifficulty, sourceIds: scope.sourceIds },
      { db, ai, vector },
    );
    if (scope.session) {
      await db.run('UPDATE quizzes SET session_id = ? WHERE id = ?', scope.session.id, quiz.id);
    }
    res.status(201).json({
      quiz,
      ...(quiz.weakEvidence ? { weakEvidence: true } : {}),
      sessionId: scope.session?.id ?? null,
    });
  });

  router.post('/:quizId/answer', async (req, res) => {
    const { quizId } = req.params;
    const quiz = await db.get('SELECT * FROM quizzes WHERE id = ?', quizId);
    if (!quiz) throw new ApiError(404, 'QUIZ_NOT_FOUND', 'That quiz does not exist. Generate a new one.');

    const existingAttempt = await db.get('SELECT * FROM quiz_attempts WHERE quiz_id = ?', quizId);
    if (existingAttempt) {
      // Idempotent retry: return the EXACT result the first submission produced
      // (stored verbatim), never a recomputed shape or a second mastery update.
      let stored = null;
      try { stored = existingAttempt.result_json ? JSON.parse(existingAttempt.result_json) : null; } catch { stored = null; }
      const result = stored ?? await buildResult(db, quiz, JSON.parse(existingAttempt.answers_json));
      return res.status(409).json({ error: { code: 'QUIZ_ALREADY_ANSWERED', message: 'This quiz was already submitted.' }, result });
    }

    const questions = await db.all('SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY idx', quizId);
    const { correct, total, perQuestion } = gradeAnswers(questions, req.body?.answers ?? []);
    const percent = Math.round((correct / total) * 100);

    // Deterministic learner-model update, once per quiz.
    const topicKey = quiz.topic.toLowerCase();
    const topicStats = await db.get('SELECT * FROM learner_topics WHERE topic = ?', topicKey);
    const update = applyAttempt(topicKey, topicStats, { correct, total });

    const now = nowIso();
    await db.run(`
      INSERT INTO learner_topics (topic, correct, total, difficulty, updated_at, last_practiced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic) DO UPDATE SET
        correct = excluded.correct, total = excluded.total,
        difficulty = excluded.difficulty, updated_at = excluded.updated_at,
        last_practiced_at = excluded.last_practiced_at
    `, update.topic, update.correct, update.total, update.difficulty, now, now);

    // Observed learning events (server-side only, never touch mastery).
    // Per-question evidence, then the quiz-level result.
    const masteryAfter = Number(update.mastery.toFixed(4));
    for (const item of perQuestion) {
      await recordEvent(db, {
        kind: item.correct ? 'quiz_item_correct' : 'quiz_item_incorrect',
        topic: quiz.topic.toLowerCase().trim(),
        detail: { index: item.index, correct: item.correct },
      });
    }
    await recordEvent(db, {
      kind: 'quiz_result',
      topic: quiz.topic.toLowerCase().trim(),
      detail: { quizId: quiz.id, correct, total, masteryBefore: update.before, masteryAfter, percent },
    });
    // Recovery check (M5): mastery improved while an approach change is still
    // open → credit that approach. 'before' null means the very first attempt,
    // so there is nothing to recover from.
    if (update.before !== null) {
      await maybeRecordRecovery(db, { topic: quiz.topic.toLowerCase().trim(), masteryBefore: update.before, masteryAfter });
    }

    const result = {
      score: { correct, total, percent },
      questions: perQuestion,
      masteryUpdate: {
        topic: update.topic,
        before: update.before,
        after: Number(update.mastery.toFixed(4)),
        ...(update.delta !== null ? { delta: update.delta } : {}),
      },
      recommendedDifficulty: update.difficulty,
    };

    // Attempt record + answered stamp belong together: one atomic write.
    await db.batch([
      {
        sql: 'INSERT INTO quiz_attempts (quiz_id, answers_json, correct, total, created_at, result_json) VALUES (?, ?, ?, ?, ?, ?)',
        args: [quizId, JSON.stringify(req.body.answers), correct, total, now, JSON.stringify(result)],
      },
      { sql: 'UPDATE quizzes SET answered_at = ? WHERE id = ?', args: [now, quizId] },
    ], 'write');
    await logActivity(db, 'quiz', quiz.topic, `${correct}/${total} correct (${percent}%)`, quiz.session_id);

    res.json({ result });
  });

  return router;
}

// Rebuild a result payload from stored data (used for the 409 replay).
async function buildResult(db, quiz, answers) {
  const questions = await db.all('SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY idx', quiz.id);
  const { correct, total, perQuestion } = gradeAnswers(questions, answers);
  const stats = await db.get('SELECT * FROM learner_topics WHERE topic = ?', quiz.topic.toLowerCase());
  return {
    score: { correct, total, percent: Math.round((correct / total) * 100) },
    questions: perQuestion,
    masteryUpdate: stats ? {
      topic: stats.topic,
      correct: stats.correct,
      total: stats.total,
      after: Number((stats.correct / stats.total).toFixed(4)),
    } : null,
    recommendedDifficulty: stats?.difficulty ?? 'medium',
  };
}

// Quiz routes: generate (no answer key in the response) and answer (grade,
// reveal, update learner model).

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { chooseDifficulty, applyAttempt } from '../services/learner.js';
import { generateQuiz, gradeAnswers } from '../services/quizService.js';
import { resolveScope, assertSourcesExist } from '../services/retrieval.js';
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

    const scope = resolveScope(db, { sessionId, sourceIds: sourceIds ?? [] });
    if (!scope.session) {
      await assertSourcesExist(db, sourceIds ?? []); // legacy path: plain source filter
    }

    // No difficulty given → the learner model chooses for this topic.
    const stats = db.prepare('SELECT * FROM learner_topics WHERE topic = ?').get(topic.trim().toLowerCase());
    const chosenDifficulty = difficulty ?? chooseDifficulty(stats);

    const quiz = await generateQuiz(
      { topic: topic.trim(), questionCount: questionCount ?? 5, difficulty: chosenDifficulty, sourceIds: scope.sourceIds },
      { db, ai, vector },
    );
    if (scope.session) {
      db.prepare('UPDATE quizzes SET session_id = ? WHERE id = ?').run(scope.session.id, quiz.id);
    }
    res.status(201).json({ quiz, sessionId: scope.session?.id ?? null });
  });

  router.post('/:quizId/answer', async (req, res) => {
    const { quizId } = req.params;
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId);
    if (!quiz) throw new ApiError(404, 'QUIZ_NOT_FOUND', 'That quiz does not exist. Generate a new one.');

    const existingAttempt = db.prepare('SELECT * FROM quiz_attempts WHERE quiz_id = ?').get(quizId);
    if (existingAttempt) {
      // Idempotent retry: return the stored result, do not update progress twice.
      const stored = buildResult(db, quiz, JSON.parse(existingAttempt.answers_json));
      return res.status(409).json({ error: { code: 'QUIZ_ALREADY_ANSWERED', message: 'This quiz was already submitted.' }, result: stored });
    }

    const questions = db.prepare('SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY idx').all(quizId);
    const { correct, total, perQuestion } = gradeAnswers(questions, req.body?.answers ?? []);
    const percent = Math.round((correct / total) * 100);

    // Deterministic learner-model update, once per quiz.
    const topicKey = quiz.topic.toLowerCase();
    const topicStats = db.prepare('SELECT * FROM learner_topics WHERE topic = ?').get(topicKey);
    const update = applyAttempt(topicKey, topicStats, { correct, total });

    const now = nowIso();
    db.prepare(`
      INSERT INTO learner_topics (topic, correct, total, difficulty, updated_at, last_practiced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic) DO UPDATE SET
        correct = excluded.correct, total = excluded.total,
        difficulty = excluded.difficulty, updated_at = excluded.updated_at,
        last_practiced_at = excluded.last_practiced_at
    `).run(update.topic, update.correct, update.total, update.difficulty, now, now);

    db.prepare('INSERT INTO quiz_attempts (quiz_id, answers_json, correct, total, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(quizId, JSON.stringify(req.body.answers), correct, total, now);
    db.prepare('UPDATE quizzes SET answered_at = ? WHERE id = ?').run(now, quizId);
    logActivity(db, 'quiz', quiz.topic, `${correct}/${total} correct (${percent}%)`, quiz.session_id);

    res.json({
      result: {
        score: { correct, total, percent },
        questions: perQuestion,
        masteryUpdate: {
          topic: update.topic,
          before: update.before,
          after: Number(update.mastery.toFixed(4)),
          ...(update.delta !== null ? { delta: update.delta } : {}),
        },
        recommendedDifficulty: update.difficulty,
      },
    });
  });

  return router;
}

// Rebuild a result payload from stored data (used for the 409 replay).
function buildResult(db, quiz, answers) {
  const questions = db.prepare('SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY idx').all(quiz.id);
  const { correct, total, perQuestion } = gradeAnswers(questions, answers);
  const stats = db.prepare('SELECT * FROM learner_topics WHERE topic = ?').get(quiz.topic.toLowerCase());
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

// GET /api/learner/progress — read-only rollup for the dashboard.

import express from 'express';
import { needsRevision, suggestNext, difficultyFor } from '../services/learner.js';

export function learnerRouter({ db }) {
  const router = express.Router();

  router.get('/progress', (req, res) => {
    const topicRows = db.prepare('SELECT * FROM learner_topics ORDER BY last_practiced_at DESC').all();

    const topics = topicRows.map((row) => ({
      topic: row.topic,
      masteryPercent: row.total > 0 ? Math.round((row.correct / row.total) * 100) : 0,
      difficulty: row.total > 0 ? difficultyFor(row.correct / row.total) : row.difficulty,
      correct: row.correct,
      total: row.total,
      needsRevision: needsRevision(row),
      lastPracticedAt: row.last_practiced_at,
    }));

    const attempts = db.prepare('SELECT correct, total FROM quiz_attempts').all();
    const questionsAnswered = attempts.reduce((sum, a) => sum + a.total, 0);
    const correctAnswers = attempts.reduce((sum, a) => sum + a.correct, 0);

    const recentActivity = db.prepare('SELECT type, topic, detail, at FROM activity ORDER BY id DESC LIMIT 10').all()
      .map((row) => ({ type: row.type, topic: row.topic, detail: row.detail, at: row.at }));

    res.json({
      topics,
      overall: {
        quizzesTaken: attempts.length,
        questionsAnswered,
        accuracyPercent: questionsAnswered > 0 ? Math.round((correctAnswers / questionsAnswered) * 100) : 0,
      },
      suggestedNext: suggestNext(topicRows),
      recentActivity,
    });
  });

  return router;
}

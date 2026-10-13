// Conversational onboarding endpoints (v1.4): POST /message drives the
// interview one short question at a time; POST /skip opts out at any point.
// Turn logic, model validation and all writes live in services/onboarding.js.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { nowIso } from '../store/sqlite.js';
import { profileToApi } from './profile.js'; // same GET /api/profile shape
import { turnOnboarding } from '../services/onboarding.js';

export function onboardingRouter({ db, ai }) {
  const router = express.Router();

  router.post('/message', async (req, res) => {
    const raw = req.body?.message;
    let message = ''; // null or missing → start the conversation
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== 'string') {
        throw new ApiError(400, 'VALIDATION_ERROR', 'message must be null or a string.');
      }
      message = raw.trim();
      if (message.length < 1 || message.length > 800) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'message must be between 1 and 800 characters.');
      }
    }
    res.json(await turnOnboarding(db, message, { ai }));
  });

  router.post('/skip', async (req, res) => {
    const row = await db.get("SELECT * FROM learner_profile WHERE id = 'default'");
    if (row?.state === 'completed') {
      throw new ApiError(409, 'ONBOARDING_COMPLETE', 'Onboarding already finished.');
    }
    // Skipping is always reversible (a later /message restarts the interview),
    // so a skipped row is simply written wholesale with a cleared transcript.
    const now = nowIso();
    if (row) {
      await db.run("UPDATE learner_profile SET state = 'skipped', transcript_json = '[]', updated_at = ? WHERE id = 'default'", now);
    } else {
      await db.run("INSERT INTO learner_profile (id, state, transcript_json, fields_json, created_at, updated_at) VALUES ('default', 'skipped', '[]', '{}', ?, ?)", now, now);
    }
    const updated = await db.get("SELECT * FROM learner_profile WHERE id = 'default'");
    const subjects = await db.all('SELECT * FROM learner_subjects ORDER BY subject COLLATE NOCASE');
    res.json({ profile: profileToApi(updated, subjects) });
  });

  return router;
}

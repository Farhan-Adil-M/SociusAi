// Learner profile (v1.4): a single, installation-scoped profile the student
// can view, edit and delete. No authentication exists, so exactly one row
// (id = 'default') ever exists. Validation is deterministic; no AI involved.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { nowIso } from '../store/sqlite.js';

export const PURPOSES = new Set(['exam', 'project', 'research', 'deep-understanding', 'general']);
export const EXPLANATION_STYLES = new Set(['step-by-step', 'examples-first', 'visual', 'concise', 'guided-questions']);
const FAMILIARITIES = new Set(['none', 'basic', 'familiar', 'confident']);
const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- parsing helpers --------------------------------------------------------

// Defensive: a corrupt fields_json must never crash GET — treat it as empty.
function parseFields(json) {
  try {
    const value = JSON.parse(json ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function loadRow(db) {
  return await db.get("SELECT * FROM learner_profile WHERE id = 'default'") ?? null;
}

async function loadSubjects(db) {
  return db.all('SELECT * FROM learner_subjects ORDER BY subject COLLATE NOCASE');
}

// ---- validation (all input is untrusted; clients cannot write 'source') ----

function validateInterests(value) {
  if (!Array.isArray(value)) throw new ApiError(400, 'VALIDATION_ERROR', 'interests must be an array.');
  if (value.length > 12) throw new ApiError(400, 'VALIDATION_ERROR', 'Use at most 12 interests.');
  return value.map((item, i) => {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (label.length < 1 || label.length > 40) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Interest ${i + 1}: label must be between 1 and 40 characters.`);
    }
    return { label, source: 'stated' }; // client-sent source is stripped
  });
}

function validateGoals(value) {
  if (!Array.isArray(value)) throw new ApiError(400, 'VALIDATION_ERROR', 'goals must be an array.');
  if (value.length > 6) throw new ApiError(400, 'VALIDATION_ERROR', 'Use at most 6 goals.');
  return value.map((item, i) => {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (label.length < 1 || label.length > 120) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Goal ${i + 1}: label must be between 1 and 120 characters.`);
    }
    const deadline = item?.deadline ?? null;
    if (deadline !== null && (typeof deadline !== 'string' || !DEADLINE_RE.test(deadline))) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Goal ${i + 1}: deadline must be a YYYY-MM-DD date.`);
    }
    return { label, deadline, source: 'stated' }; // client-sent source is stripped
  });
}

function validatePurpose(value) {
  if (value === null) return null;
  if (!PURPOSES.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'purpose must be exam, project, research, deep-understanding, general, or null.');
  }
  return value;
}

function validatePreferences(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'preferences must be an object.');
  }
  const clean = {}; // other keys are ignored on purpose
  if (value.explanationStyle !== undefined) {
    const style = typeof value.explanationStyle === 'string' ? value.explanationStyle : value.explanationStyle?.value;
    if (!EXPLANATION_STYLES.has(style)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'explanationStyle must be step-by-step, examples-first, visual, concise, or guided-questions.');
    }
    clean.explanationStyle = { value: style, source: 'stated' };
  }
  return clean;
}

function validateSubjects(value) {
  if (!Array.isArray(value)) throw new ApiError(400, 'VALIDATION_ERROR', 'subjects must be an array.');
  if (value.length > 12) throw new ApiError(400, 'VALIDATION_ERROR', 'Use at most 12 subjects.');
  const clean = new Map(); // subject is the table's primary key — dedupe, last wins
  for (const [i, item] of value.entries()) {
    const subject = typeof item?.subject === 'string' ? item.subject.trim() : '';
    if (subject.length < 1 || subject.length > 60) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Subject ${i + 1}: name must be between 1 and 60 characters.`);
    }
    if (!FAMILIARITIES.has(item?.familiarity)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Subject ${i + 1}: familiarity must be none, basic, familiar, or confident.`);
    }
    const confidence = item?.confidence ?? null;
    if (confidence !== null && (!Number.isInteger(confidence) || confidence < 1 || confidence > 5)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Subject ${i + 1}: confidence must be an integer between 1 and 5.`);
    }
    clean.set(subject, { subject, familiarity: item.familiarity, confidence, source: 'stated' }); // source stripped
  }
  return [...clean.values()];
}

// ---- response shape ---------------------------------------------------------

// Shared with routes/onboarding.js so /api/onboarding/skip can return the
// exact same profile shape as GET /api/profile.
export function profileToApi(row, subjects) {
  if (!row) {
    return {
      state: 'new',
      purpose: null,
      interests: [],
      goals: [],
      preferences: {},
      subjects: [],
      updatedAt: null,
    };
  }
  const fields = parseFields(row.fields_json);
  const preferences = {};
  const style = fields.preferences?.explanationStyle;
  if (style && typeof style === 'object' && EXPLANATION_STYLES.has(style.value)) {
    preferences.explanationStyle = { value: style.value, source: style.source ?? 'stated' };
  }
  return {
    state: row.state,
    purpose: PURPOSES.has(fields.purpose) ? fields.purpose : null,
    interests: Array.isArray(fields.interests) ? fields.interests : [],
    goals: Array.isArray(fields.goals) ? fields.goals : [],
    preferences,
    subjects: subjects.map((s) => ({
      subject: s.subject,
      familiarity: s.familiarity,
      confidence: s.confidence ?? null,
      source: s.source,
    })),
    updatedAt: row.updated_at,
  };
}

export function profileRouter({ db }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const row = await loadRow(db);
    // No row yet → a built default. Never insert on GET; state stays "new".
    res.json({ profile: profileToApi(row, row ? await loadSubjects(db) : []) });
  });

  router.patch('/', async (req, res) => {
    const body = req.body ?? {};
    const keys = ['interests', 'goals', 'purpose', 'preferences', 'subjects'];
    if (!keys.some((key) => body[key] !== undefined)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Provide at least one of: interests, goals, purpose, preferences, subjects.');
    }

    // Validate everything BEFORE writing, so a bad PATCH changes nothing.
    const updates = {};
    if (body.interests !== undefined) updates.interests = validateInterests(body.interests);
    if (body.goals !== undefined) updates.goals = validateGoals(body.goals);
    if (body.purpose !== undefined) updates.purpose = validatePurpose(body.purpose);
    if (body.preferences !== undefined) updates.preferences = validatePreferences(body.preferences);
    if (body.subjects !== undefined) updates.subjects = validateSubjects(body.subjects);

    const row = await loadRow(db);
    const fields = parseFields(row?.fields_json);

    // Each provided key replaces that stored value wholesale; omitted keys are
    // left exactly as they were.
    if (updates.interests !== undefined) fields.interests = updates.interests;
    if (updates.goals !== undefined) fields.goals = updates.goals;
    if (updates.purpose !== undefined) fields.purpose = updates.purpose;
    if (updates.preferences !== undefined) fields.preferences = updates.preferences;

    const now = nowIso();
    if (row) {
      await db.run("UPDATE learner_profile SET fields_json = ?, updated_at = ? WHERE id = 'default'", JSON.stringify(fields), now);
    } else {
      // Manual editing counts as opted out of the intro: state "skipped".
      await db.run("INSERT INTO learner_profile (id, state, transcript_json, fields_json, created_at, updated_at) VALUES ('default', 'skipped', '[]', ?, ?, ?)",
        JSON.stringify(fields), now, now);
    }

    if (updates.subjects !== undefined) {
      // Wholesale replacement: subjects absent from the new list are deleted.
      await db.batch([
        { sql: 'DELETE FROM learner_subjects' },
        ...updates.subjects.map((s) => ({
          sql: 'INSERT INTO learner_subjects (subject, familiarity, confidence, source, updated_at) VALUES (?, ?, ?, ?, ?)',
          args: [s.subject, s.familiarity, s.confidence, s.source, now],
        })),
      ], 'write');
    }

    res.json({ profile: profileToApi(await loadRow(db), await loadSubjects(db)) });
  });

  router.delete('/', async (req, res) => {
    await db.run("DELETE FROM learner_profile WHERE id = 'default'");
    await db.run('DELETE FROM learner_subjects');
    await db.run('DELETE FROM learning_events');
    // 204 with an empty body; deleting when nothing exists is fine (idempotent).
    res.status(204).end();
  });

  return router;
}

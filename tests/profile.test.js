// Learner profile API (v1.4): GET default shape, PATCH wholesale replacement
// + validation + stated-source tagging, DELETE scope, restart persistence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, nowIso } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';
import { fakeVector, makeAi } from './helpers.js';

async function startApp({ ai = makeAi(), vector = fakeVector() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-profile-'));
  const dbPath = path.join(dir, 'app.db');
  const db = openDb(dbPath);
  const app = createApp({ db, ai, vector });
  const server = app.listen(0);
  await once(server, 'listening');
  return {
    base: `http://localhost:${server.address().port}`,
    db,
    dbPath,
    close: () => new Promise((r) => server.close(r)),
  };
}

function patch(base, body) {
  return fetch(`${base}/api/profile`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function expectValidationError(res) {
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.message.length > 0, 'error message must explain the problem');
}

test('GET with no profile row returns the default without inserting', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const res = await fetch(`${ctx.base}/api/profile`);
  assert.equal(res.status, 200);
  const { profile } = await res.json();
  assert.equal(profile.state, 'new');
  assert.equal(profile.purpose, null);
  assert.deepEqual(profile.interests, []);
  assert.deepEqual(profile.goals, []);
  assert.deepEqual(profile.preferences, {});
  assert.deepEqual(profile.subjects, []);
  assert.equal(profile.updatedAt, null);

  // GET never creates a row — an onboarding nudge still makes sense.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM learner_profile').get().n, 0);
});

test('PATCH writes stated items; a later partial PATCH replaces only its keys', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const res = await patch(ctx.base, {
    interests: [{ label: 'Biology' }, { label: 'Chemistry' }],
    goals: [{ label: 'Pass the final exam', deadline: '2026-06-01' }],
    purpose: 'exam',
    preferences: { explanationStyle: 'step-by-step' },
    subjects: [{ subject: 'Biology', familiarity: 'basic', confidence: 3 }],
  });
  assert.equal(res.status, 200);
  const { profile } = await res.json();
  assert.equal(profile.purpose, 'exam');
  assert.equal(profile.interests[0].source, 'stated');
  assert.equal(profile.goals[0].source, 'stated');
  assert.equal(profile.goals[0].deadline, '2026-06-01');
  assert.deepEqual(profile.preferences.explanationStyle, { value: 'step-by-step', source: 'stated' });
  assert.deepEqual(profile.subjects, [{ subject: 'Biology', familiarity: 'basic', confidence: 3, source: 'stated' }]);

  const got = await (await fetch(`${ctx.base}/api/profile`)).json();
  assert.equal(got.profile.interests.length, 2);
  assert.equal(got.profile.goals[0].label, 'Pass the final exam');

  // Interests-only PATCH replaces interests wholesale; the goal survives.
  const res2 = await patch(ctx.base, { interests: [{ label: 'Physics' }] });
  assert.equal(res2.status, 200);
  const after = (await res2.json()).profile;
  assert.deepEqual(after.interests, [{ label: 'Physics', source: 'stated' }]);
  assert.equal(after.goals[0].label, 'Pass the final exam', 'omitted keys stay untouched');
  assert.equal(after.purpose, 'exam');
});

test('PATCH rejects invalid input with VALIDATION_ERROR and changes nothing', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  assert.equal((await patch(ctx.base, { purpose: 'exam', interests: [{ label: 'ok' }] })).status, 200);

  const cases = [
    { purpose: 'nonsense' }, // bad enum
    { interests: [{ label: 'x'.repeat(41) }] }, // label too long
    { interests: Array.from({ length: 13 }, (_, i) => ({ label: `interest ${i}` })) }, // >12
    { goals: [{ label: 'Pass', deadline: 'June 2026' }] }, // bad deadline
    { subjects: [{ subject: 'Bio', familiarity: 'basic', confidence: 6 }] }, // confidence out of range
    { subjects: [{ subject: 'Bio', familiarity: 'expert' }] }, // bad familiarity
    {}, // empty body
  ];
  for (const body of cases) {
    await expectValidationError(await patch(ctx.base, body));
  }

  const { profile } = await (await fetch(`${ctx.base}/api/profile`)).json();
  assert.equal(profile.purpose, 'exam', 'state unchanged after failed PATCHes');
  assert.deepEqual(profile.interests, [{ label: 'ok', source: 'stated' }]);
  assert.deepEqual(profile.goals, []);
});

test('PATCH on a missing row creates it with state "skipped"', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const res = await patch(ctx.base, { interests: [{ label: 'History' }] });
  assert.equal(res.status, 200);
  const { profile } = await res.json();
  assert.equal(profile.state, 'skipped', 'manual edit = opted out of the intro');
  assert.equal(profile.updatedAt !== null, true);
});

test('client-supplied source "inferred" is ignored — everything stored as "stated"', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const res = await patch(ctx.base, {
    interests: [{ label: 'Art', source: 'inferred' }],
    goals: [{ label: 'Finish project', source: 'inferred' }],
    preferences: { explanationStyle: { value: 'visual', source: 'inferred' } },
    subjects: [{ subject: 'Art', familiarity: 'none', source: 'inferred' }],
  });
  assert.equal(res.status, 200);
  const { profile } = await res.json();
  assert.equal(profile.interests[0].source, 'stated');
  assert.equal(profile.goals[0].source, 'stated');
  assert.equal(profile.preferences.explanationStyle.source, 'stated');
  assert.equal(profile.subjects[0].source, 'stated');
});

test('DELETE clears profile, subjects and events — but nothing else — and is idempotent', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  await patch(ctx.base, {
    interests: [{ label: 'Biology' }],
    subjects: [{ subject: 'Biology', familiarity: 'basic' }],
  });
  // Fake an observed event and unrelated learner mastery data.
  ctx.db.prepare("INSERT INTO learning_events (kind, topic, detail_json, weight, at) VALUES ('quiz_result', 'cells', '{}', 3, ?)")
    .run(nowIso());
  ctx.db.prepare("INSERT INTO learner_topics (topic, correct, total, difficulty, updated_at) VALUES ('cells', 3, 5, 'medium', ?)")
    .run(nowIso());

  const res = await fetch(`${ctx.base}/api/profile`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '', '204 has an empty body');

  const { profile } = await (await fetch(`${ctx.base}/api/profile`)).json();
  assert.equal(profile.state, 'new');
  assert.deepEqual(profile.interests, []);
  assert.deepEqual(profile.subjects, []);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM learner_subjects').get().n, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM learning_events').get().n, 0);
  // Mastery is never touched by a profile delete.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM learner_topics').get().n, 1);

  // Second DELETE is still 204 (idempotent).
  const again = await fetch(`${ctx.base}/api/profile`, { method: 'DELETE' });
  assert.equal(again.status, 204);
});

test('the saved profile survives a server restart (reopen same database file)', async (t) => {
  const ctx = await startApp();
  await patch(ctx.base, {
    interests: [{ label: 'Neuroscience' }],
    goals: [{ label: 'Defend my thesis', deadline: '2026-09-30' }],
    purpose: 'research',
    preferences: { explanationStyle: 'concise' },
    subjects: [{ subject: 'Neuroscience', familiarity: 'familiar', confidence: 4 }],
  });
  await ctx.close(); // close server AND release the db file

  const db2 = openDb(ctx.dbPath);
  const app2 = createApp({ db: db2, ai: makeAi(), vector: fakeVector() });
  const server2 = app2.listen(0);
  await once(server2, 'listening');
  t.after(() => new Promise((r) => server2.close(r)));

  const res = await fetch(`http://localhost:${server2.address().port}/api/profile`);
  assert.equal(res.status, 200);
  const { profile } = await res.json();
  assert.equal(profile.state, 'skipped');
  assert.equal(profile.purpose, 'research');
  assert.equal(profile.interests[0].label, 'Neuroscience');
  assert.equal(profile.goals[0].deadline, '2026-09-30');
  assert.equal(profile.preferences.explanationStyle.value, 'concise');
  assert.equal(profile.subjects[0].confidence, 4);
});

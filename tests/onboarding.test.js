// Conversational onboarding (v1.4): turn lifecycle, whitelist-only model
// extraction, bounded model retries ("nothing persists on failure"),
// automatic completion at 6 questions, skip behaviour, and the 409 guard.
// Stub-AI HTTP style, same as tests/organizer.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';
import { makeAi, fakeVector } from './helpers.js';
import { config } from '../server/config.js';

function turn(extra = {}, reply = 'Sure! And what would you like to focus on next?') {
  return JSON.stringify({ reply, ...extra });
}

// Scripted onboarding model: each turn consumes the next canned reply; the
// last entry repeats when the script runs out. `calls` records what the
// service actually sent (messages + options).
function buildOnboardingAi(script) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chatCompletion: async (messages, options) => {
      calls.push({ messages, options });
      const value = script[Math.min(i++, script.length - 1)];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

async function boot(t, ai) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-onb-'));
  const db = await openDb(path.join(dir, 'app.db'));
  const app = await createApp({ db, ai, vector: fakeVector() });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://localhost:${server.address().port}`;
  t.after(() => new Promise((r) => server.close(r)));
  return { db, base };
}

function post(base, url, body) {
  return fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function getProfile(base) {
  return (await (await fetch(`${base}/api/profile`)).json()).profile;
}

function rowOf(db) {
  return db.prepare("SELECT * FROM learner_profile WHERE id = 'default'").get() ?? null;
}

test('first turn starts the interview: row created, reply persisted, assess model used', async (t) => {
  const ai = buildOnboardingAi([
    turn({}, 'Hi! Your answers are saved in the database to personalise learning — you can view, edit or delete them later on the Profile page. What do you enjoy studying?'),
  ]);
  const { db, base } = await boot(t, ai);

  const res = await post(base, '/api/onboarding/message', { message: null });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.state, 'in_progress');
  assert.equal(body.questionsAsked, 1);
  assert.equal(body.done, false);

  const row = rowOf(db);
  assert.ok(row, 'profile row created');
  assert.equal(row.state, 'in_progress');
  const transcript = JSON.parse(row.transcript_json);
  assert.deepEqual(transcript[0], { role: 'student', content: '' });
  assert.equal(transcript[1].role, 'assistant');
  assert.ok(transcript[1].content.includes('Profile page'), 'assistant reply persisted');

  // Prompt shape: one interviewer system message + profile-so-far JSON +
  // conversation, aimed at the assessment model.
  assert.equal(ai.calls.length, 1);
  const { messages, options } = ai.calls[0];
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('ONE short question'));
  const user = messages[1].content;
  assert.ok(user.includes('Student profile so far (JSON):'));
  assert.ok(user.includes('Conversation so far:'));
  assert.equal(options.model, config.nimAssessModel);
  assert.equal(options.maxTokens, 1000);

  // GET /api/profile reflects the started state and the route shape is intact.
  assert.equal((await getProfile(base)).state, 'in_progress');

  // Input validation: overlong or wrong-typed message → 400, no AI call made.
  const long = await post(base, '/api/onboarding/message', { message: 'x'.repeat(801) });
  assert.equal(long.status, 400);
  assert.equal((await long.json()).error.code, 'VALIDATION_ERROR');
  const wrongType = await post(base, '/api/onboarding/message', { message: 42 });
  assert.equal(wrongType.status, 400);
  assert.equal(ai.calls.length, 1);
});

test('extraction whitelist: stated interests/purpose land in the profile, junk is dropped', async (t) => {
  const ai = buildOnboardingAi([
    turn({}, 'Hi! What brings you here?'),
    turn({ extract: { interests: ['football', 42, ''], goals: [], purpose: 'exam' } }, 'Nice — football and an exam to prepare for.'),
  ]);
  const { base } = await boot(t, ai);

  await post(base, '/api/onboarding/message', { message: null });
  const res = await post(base, '/api/onboarding/message', { message: "I love football, and I'm studying for my biology exam." });
  assert.equal(res.status, 200);

  // Non-string and empty interest labels never reach storage; forward-goal
  // purpose persists once, stated.
  const profile = await getProfile(base);
  assert.deepEqual(profile.interests, [{ label: 'football', source: 'stated' }]);
  assert.equal(profile.purpose, 'exam');
});

test('done:true completes: transcript cleared to [], fields kept, no further messages', async (t) => {
  const ai = buildOnboardingAi([
    turn({}, 'Hi! What do you like?'),
    turn({ done: true, extract: { interests: ['chess'], goals: [{ label: 'pass biology', deadline: '2026-06-01' }] } }, 'All set — I will personalise things from here!'),
  ]);
  const { db, base } = await boot(t, ai);

  await post(base, '/api/onboarding/message', { message: null });
  const res = await post(base, '/api/onboarding/message', { message: 'That is everything, thanks!' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.state, 'completed');
  assert.equal(body.done, true);

  const row = rowOf(db);
  assert.equal(row.state, 'completed');
  assert.equal(row.transcript_json, '[]'); // working memory cleared on completion
  const fields = JSON.parse(row.fields_json);
  assert.deepEqual(fields.interests, [{ label: 'chess', source: 'stated' }]);
  assert.deepEqual(fields.goals, [{ label: 'pass biology', deadline: '2026-06-01', source: 'stated' }]);

  const profile = await getProfile(base);
  assert.equal(profile.state, 'completed');
  assert.deepEqual(profile.interests, [{ label: 'chess', source: 'stated' }]);
  assert.deepEqual(profile.goals, [{ label: 'pass biology', deadline: '2026-06-01', source: 'stated' }]);

  // A finished interview blocks further turns with the contract error code.
  const again = await post(base, '/api/onboarding/message', { message: 'one more thing' });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, 'ONBOARDING_COMPLETE');
  assert.equal(ai.calls.length, 2, 'the blocked turn made no model call');
});

test('skip: new → skipped with cleared transcript; repeatable; resumable; 409 once completed', async (t) => {
  const ai = buildOnboardingAi([
    turn({}, 'Hi! Ready to start?'),
    turn({ done: true }, 'All set!'),
  ]);
  const { db, base } = await boot(t, ai);

  const s1 = await post(base, '/api/onboarding/skip', {});
  assert.equal(s1.status, 200);
  let profile = (await s1.json()).profile;
  assert.equal(profile.state, 'skipped'); // same shape as GET /api/profile
  assert.equal(rowOf(db).transcript_json, '[]');

  const s2 = await post(base, '/api/onboarding/skip', {}); // skipping twice is fine
  assert.equal(s2.status, 200);
  assert.equal((await s2.json()).profile.state, 'skipped');

  // Retrying after skip is allowed: → in_progress → completed.
  await post(base, '/api/onboarding/message', { message: null });
  await post(base, '/api/onboarding/message', { message: 'done for now, thanks' });
  assert.equal(rowOf(db).state, 'completed');

  const s3 = await post(base, '/api/onboarding/skip', {});
  assert.equal(s3.status, 409);
  assert.equal((await s3.json()).error.code, 'ONBOARDING_COMPLETE');
});

test('unusable model output twice → 502 NIM_ERROR; nothing persisted; clean recovery later', async (t) => {
  const ai = buildOnboardingAi([
    'no json here at all, sorry',   // attempt 1, turn 1 → retried
    '"just a string"',              // attempt 2, turn 1 → unusable again → 502
    turn({}, 'Ok, phew — let us begin!'), // turn 2 works from the clean slate
  ]);
  const { db, base } = await boot(t, ai);

  const res = await post(base, '/api/onboarding/message', { message: null });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'NIM_ERROR');

  // The "in_progress" state change, the student turn and the transcript append
  // never hit the disk — for a fresh install that means the row still does not
  // exist at all.
  assert.equal(rowOf(db), null);
  assert.equal((await getProfile(base)).state, 'new');

  // A later successful turn starts from that same clean slate (still the first
  // interviewer question, one model call for the turn).
  const retry = await post(base, '/api/onboarding/message', { message: null });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).state, 'in_progress');
  assert.equal(rowOf(db).state, 'in_progress');
});

test('questionsAsked increments across turns; the server completes automatically at 6', async (t) => {
  const ai = buildOnboardingAi([1, 2, 3, 4, 5, 6].map((n) => turn({}, `Question number ${n}?`)));
  const { db, base } = await boot(t, ai);

  let body = await (await post(base, '/api/onboarding/message', { message: null })).json();
  assert.equal(body.questionsAsked, 1);
  assert.equal(body.state, 'in_progress');
  for (let n = 2; n <= 5; n++) {
    body = await (await post(base, '/api/onboarding/message', { message: `Answer ${n}` })).json();
    assert.equal(body.questionsAsked, n);
    assert.equal(body.done, false);
  }
  body = await (await post(base, '/api/onboarding/message', { message: 'Answer 6' })).json();
  assert.equal(body.questionsAsked, 6);
  assert.equal(body.done, true, 'forced completion without model saying done');
  assert.equal(body.state, 'completed');
  assert.equal(rowOf(db).transcript_json, '[]');
});

test('inferred style sticks only until the student states one; inferred interests append with cap', async (t) => {
  const ai = buildOnboardingAi([
    turn({}, 'Hi! What do you enjoy?'),
    // Turn 2: the student never named a style — the model infers it, and
    // infers an interest the student only implied.
    turn({ inferred: { explanationStyle: 'visual', interests: ['space'] } }, 'Pictures it is, then!'),
    turn({ extract: { explanationStyle: 'concise' } }, 'Concise it is.'),
  ]);
  const { base } = await boot(t, ai);

  await post(base, '/api/onboarding/message', { message: null });
  let res = await post(base, '/api/onboarding/message', { message: 'Hmm, hard to say… mostly rocket launches and telescopes.' });
  assert.equal(res.status, 200);

  let profile = await getProfile(base);
  assert.deepEqual(profile.preferences.explanationStyle, { value: 'visual', source: 'inferred' });
  assert.deepEqual(profile.interests, [{ label: 'space', source: 'inferred' }]);

  // Stated always wins over inferred.
  res = await post(base, '/api/onboarding/message', { message: 'Actually, please keep explanations short.' });
  assert.equal(res.status, 200);
  profile = await getProfile(base);
  assert.deepEqual(profile.preferences.explanationStyle, { value: 'concise', source: 'stated' });
  // Inferred never re-writes stated data: the earlier interest stays.
  assert.deepEqual(profile.interests, [{ label: 'space', source: 'inferred' }]);
});

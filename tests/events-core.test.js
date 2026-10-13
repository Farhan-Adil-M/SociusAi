// Learning-events service (v1.4): event weights, recording, repeated-question
// detection, approach choice and recovery tracking. Pure logic + a temp db —
// no HTTP, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/store/sqlite.js';
import {
  EVENT_WEIGHTS,
  APPROACH_ORDER,
  recordEvent,
  isRepeatedQuestion,
  lastApproach,
  chooseApproach,
  summarizeApproaches,
  maybeRecordRecovery,
} from '../server/services/events.js';

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-events-'));
  const db = openDb(path.join(dir, 'app.db'));
  t.after(() => db.close());
  return db;
}

function insertEvent(db, kind, topic, detail, at = '2026-10-13T10:00:00.000Z') {
  const id = db.prepare('INSERT INTO learning_events (kind, topic, detail_json, weight, at) VALUES (?, ?, ?, ?, ?)')
    .run(kind, topic, JSON.stringify(detail), EVENT_WEIGHTS[kind] ?? 1, at).lastInsertRowid;
  return Number(id);
}

test('EVENT_WEIGHTS matches the contract: quiz evidence 3, everything else 1', () => {
  assert.deepEqual(EVENT_WEIGHTS, {
    quiz_result: 3,
    quiz_item_correct: 3,
    quiz_item_incorrect: 3,
    card_known: 1,
    card_review: 1,
    explain_again: 1,
    repeated_question: 1,
    approach_change: 1,
    recovery_success: 1,
  });
  assert.deepEqual(APPROACH_ORDER, ['step-by-step', 'examples-first', 'visual', 'concise', 'guided-questions']);
});

test('recordEvent stores the row with the canonical weight and normalised topic', (t) => {
  const db = tempDb(t);

  const event = recordEvent(db, { kind: 'quiz_result', topic: '  Photosynthesis ', detail: { correct: 3 } });
  assert.equal(event.kind, 'quiz_result');
  assert.equal(event.weight, 3);
  assert.equal(typeof event.at, 'string');

  const row = db.prepare('SELECT * FROM learning_events WHERE id = (SELECT MAX(id) FROM learning_events)').get();
  assert.equal(row.topic, 'photosynthesis', 'topic is trimmed and lowercased');
  assert.deepEqual(JSON.parse(row.detail_json), { correct: 3 });
  assert.equal(row.weight, 3);

  const noTopic = recordEvent(db, { kind: 'card_known' });
  assert.equal(noTopic.weight, 1);
  assert.equal(db.prepare('SELECT topic FROM learning_events WHERE id = (SELECT MAX(id) FROM learning_events)').get().topic, null);
});

test('recordEvent throws VALIDATION_ERROR for unknown kinds', (t) => {
  const db = tempDb(t);
  assert.throws(
    () => recordEvent(db, { kind: 'made_up_event' }),
    (err) => err.status === 400 && err.code === 'VALIDATION_ERROR',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM learning_events').get().n, 0, 'nothing written on error');
});

test('isRepeatedQuestion spots near-duplicates and ignores unrelated or empty input', () => {
  assert.equal(
    isRepeatedQuestion('Explain photosynthesis again!', ['explain photosynthesis please']),
    true,
    'one filler word must not hide a repeat',
  );
  assert.equal(
    isRepeatedQuestion('How does mitosis divide the nucleus?', ['What causes volcanic eruptions?']),
    false,
    'unrelated questions are not repeats',
  );
  assert.equal(isRepeatedQuestion('', []), false);
  assert.equal(isRepeatedQuestion('ok?', ['ok?']), false, 'too-short tokens are dropped');
  assert.equal(isRepeatedQuestion('Explain the Calvin cycle in detail', []), false, 'no history → not a repeat');
  // Only the newest ≤5 items are considered.
  const recent = [
    'a very old question about tectonic plates entirely',
    'another stale question about volcano magma chamber flows',
    'some forgotten question regarding earthquake fault lines',
    'an outdated question on continental drift evidence here',
    'a previous question about the Calvin cycle steps please',
  ];
  assert.equal(isRepeatedQuestion('the Calvin cycle steps please', recent), true);
});

test('chooseApproach: explicit style wins; "different" cycles; preference is the fallback', () => {
  // Explicit wins even when it repeats the previous approach.
  assert.equal(chooseApproach({ explicit: 'visual', previous: 'visual', preferred: 'concise' }), 'visual');

  // 'different' walks the cycle and never repeats the previous approach.
  assert.equal(chooseApproach({ explicit: 'different', previous: 'step-by-step' }), 'examples-first');
  assert.equal(chooseApproach({ explicit: 'different', previous: 'guided-questions' }), 'step-by-step', 'cyclic wrap-around');
  assert.equal(chooseApproach({ explicit: 'different', previous: null, preferred: null }), 'step-by-step');
  assert.equal(chooseApproach({ explicit: 'different', previous: null, preferred: 'visual' }), 'concise');
  for (const previous of APPROACH_ORDER) {
    const next = chooseApproach({ explicit: 'different', previous });
    assert.notEqual(next, previous, `"different" must not return ${previous} again`);
    assert.ok(APPROACH_ORDER.includes(next));
  }

  // No explicit request → the saved preference (or null); previous ignored.
  assert.equal(chooseApproach({ preferred: 'concise', previous: 'visual' }), 'concise');
  assert.equal(chooseApproach({ preferred: 'simpler' }), null, 'non-style preferences count as none');
  assert.equal(chooseApproach({}), null);
});

test('lastApproach returns the newest approach_change for the topic', (t) => {
  const db = tempDb(t);
  assert.equal(lastApproach(db, 'cells'), null, 'no events → null');

  insertEvent(db, 'approach_change', 'cells', { to: 'visual' });
  insertEvent(db, 'approach_change', 'cells', { to: 'step-by-step' });
  insertEvent(db, 'approach_change', 'recursion', { to: 'concise' });

  assert.equal(lastApproach(db, 'cells'), 'step-by-step', 'newest wins');
  assert.equal(lastApproach(db, ' Cells '), 'step-by-step', 'topic normalisation matches recording');
  assert.equal(lastApproach(db, 'recursion'), 'concise');
});

test('summarizeApproaches classifies helped, unhelpful and last', () => {
  const events = [
    { id: 1, kind: 'approach_change', topic: 'cells', detail_json: JSON.stringify({ to: 'visual' }) },
    { id: 2, kind: 'quiz_result', topic: 'cells', detail_json: JSON.stringify({ masteryBefore: 0.6, masteryAfter: 0.5 }) }, // dropped
    { id: 3, kind: 'approach_change', topic: 'cells', detail_json: JSON.stringify({ to: 'step-by-step' }) },
    { id: 4, kind: 'quiz_result', topic: 'cells', detail_json: JSON.stringify({ masteryBefore: 0.4, masteryAfter: 0.7 }) }, // improved
    { id: 5, kind: 'recovery_success', topic: 'cells', detail_json: JSON.stringify({ approach: 'step-by-step' }) },
    { id: 6, kind: 'approach_change', topic: 'cells', detail_json: JSON.stringify({ to: 'concise' }) },
  ];
  const summary = summarizeApproaches(events, 'cells');
  assert.equal(summary.last, 'concise');
  assert.deepEqual(summary.helped, ['step-by-step']);
  assert.deepEqual(summary.unhelpful, ['visual']);

  // An approach that recovered after a drop is "helped", not "unhelpful".
  const recovered = [
    { id: 1, kind: 'approach_change', topic: 'cells', detail_json: JSON.stringify({ to: 'visual' }) },
    { id: 2, kind: 'quiz_result', topic: 'cells', detail_json: JSON.stringify({ masteryBefore: 0.6, masteryAfter: 0.5 }) },
    { id: 3, kind: 'recovery_success', topic: 'cells', detail_json: JSON.stringify({ approach: 'visual' }) },
  ];
  const s2 = summarizeApproaches(recovered, 'cells');
  assert.deepEqual(s2.helped, ['visual']);
  assert.deepEqual(s2.unhelpful, [], 'recovery beats an earlier drop');

  // No approach_change yet → everything null/empty.
  assert.deepEqual(summarizeApproaches([{ id: 1, kind: 'quiz_result', topic: 'cells', detail_json: '{}' }], 'cells'), {
    last: null, helped: [], unhelpful: [],
  });
});

test('maybeRecordRecovery records only on improvement with an open approach_change, and never twice', (t) => {
  const db = tempDb(t);

  // No approach_change yet → nothing to attribute.
  assert.equal(maybeRecordRecovery(db, { topic: 'cells', masteryBefore: 0.4, masteryAfter: 0.6 }), null);

  insertEvent(db, 'approach_change', 'cells', { from: 'visual', to: 'step-by-step' });

  // No improvement → no event.
  assert.equal(maybeRecordRecovery(db, { topic: 'cells', masteryBefore: 0.6, masteryAfter: 0.5 }), null);
  assert.equal(maybeRecordRecovery(db, { topic: 'cells', masteryBefore: 0.6, masteryAfter: 0.6 }), null, 'equal is not improvement');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'recovery_success'").get().n, 0);

  // Improvement with the approach_change still open → recovery recorded.
  const event = maybeRecordRecovery(db, { topic: 'cells', masteryBefore: 0.4, masteryAfter: 0.7 });
  assert.ok(event, 'recovery event returned');
  assert.equal(event.kind, 'recovery_success');
  const row = db.prepare("SELECT * FROM learning_events WHERE kind = 'recovery_success'").get();
  assert.equal(row.topic, 'cells');
  assert.deepEqual(JSON.parse(row.detail_json), { approach: 'step-by-step', before: 0.4, after: 0.7 });

  // Second call finds the recorded recovery → not recorded twice.
  assert.equal(maybeRecordRecovery(db, { topic: 'cells', masteryBefore: 0.5, masteryAfter: 0.8 }), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'recovery_success'").get().n, 1);

  // A fresh approach_change re-opens the question.
  insertEvent(db, 'approach_change', 'cells', { from: 'step-by-step', to: 'examples-first' });
  const second = maybeRecordRecovery(db, { topic: 'cells', masteryBefore: 0.3, masteryAfter: 0.5 });
  assert.ok(second, 'a new approach change can recover again');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'recovery_success'").get().n, 2);
});

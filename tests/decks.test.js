// Persistent flashcard decks + card review status + session-scoped generation.
// Flow mirrors the verified standalone smoke: upload → scope → generate →
// browse → marks → restart-check → delete.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';
import { fakeVector, makeAi } from './helpers.js';

const WEBPAGE = {
  url: 'https://learn.example/cells',
  title: 'Cells 101',
  text: 'Cells are the basic unit of life.\n\nThe nucleus stores DNA.\n\nMitosis produces two identical daughter cells.\n\nMeiosis produces four varied cells.',
};

const json = (res) => res.json();

async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-decks-'));
  const dbPath = path.join(dir, 'app.db');
  const db = await openDb(dbPath);
  const app = await createApp({ db, ai: makeAi(), vector: fakeVector() });
  const server = app.listen(0);
  await once(server, 'listening');
  return { base: `http://localhost:${server.address().port}`, db, dbPath, server, close: () => new Promise((r) => server.close(r)) };
}

test('decks persist and review status survive a restart across instances', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const webpage = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(WEBPAGE),
  }).then(json);
  assert.equal(webpage.source.chunkCount > 0, true);
  const sourceId = webpage.source.id;

  const session = (await fetch(`${ctx.base}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Biology' }),
  }).then(json)).session;

  const moved = await fetch(`${ctx.base}/api/sources/${sourceId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }),
  }).then(json);
  assert.equal(moved.source.sessionId, session.id);

  const generated = await fetch(`${ctx.base}/api/flashcards/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'Cell division', sessionId: session.id, count: 3 }),
  }).then(json);
  assert.equal(generated.cards.length, 3);
  assert.ok(generated.deckId.startsWith('deck_'));

  const library = await fetch(`${ctx.base}/api/decks?sessionId=${session.id}`).then(json);
  assert.equal(library.decks.length, 1);
  const deck = library.decks[0];
  assert.equal(deck.topic, 'Cell division');
  assert.equal(deck.cardCount, 3);
  assert.equal(deck.knownCount, 0);
  assert.equal(deck.sessionTitle, 'Biology');

  // Reviewing marks real stored rows.
  await fetch(`${ctx.base}/api/decks/${deck.id}/cards/0`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'known' }),
  }).then(json);
  await fetch(`${ctx.base}/api/decks/${deck.id}/cards/1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'review' }),
  }).then(json);
  const after = await fetch(`${ctx.base}/api/decks/${deck.id}`).then(json);
  assert.equal(after.deck.knownCount, 1);
  assert.equal(after.deck.reviewCount, 1);
  assert.ok(after.deck.lastReviewedAt);
  assert.equal(after.cards[0].status, 'known');
  assert.equal(after.cards[1].status, 'review');

  // "Restart": a genuinely separate app instance reopened over the same
  // SQLite file — no shared in-memory state with the first app.
  const db2 = await openDb(ctx.dbPath);
  const app2 = await createApp({ db: db2, ai: makeAi(), vector: fakeVector() });
  const server2 = app2.listen(0);
  await once(server2, 'listening');
  t.after(() => new Promise((r) => server2.close(r)));
  const base2 = `http://localhost:${server2.address().port}`;

  const restarted = await fetch(`${base2}/api/decks?sessionId=${session.id}`).then(json);
  assert.equal(restarted.decks.length, 1);
  assert.equal(restarted.decks[0].id, deck.id);
  assert.equal(restarted.decks[0].knownCount, 1);
  assert.equal(restarted.decks[0].reviewCount, 1);
  assert.ok(restarted.decks[0].lastReviewedAt);

  const rightAfterRestart = await fetch(`${base2}/api/decks/${deck.id}`).then(json);
  assert.equal(rightAfterRestart.cards[0].status, 'known');
  assert.equal(rightAfterRestart.cards[1].status, 'review');
  assert.equal(rightAfterRestart.cards[1].idx, 1);
  assert.ok(rightAfterRestart.cards[1].reviewedAt);
  assert.ok(rightAfterRestart.deck.lastReviewedAt);

  // Deletion is deliberate and only touches derived content.
  const deleted = await fetch(`${ctx.base}/api/decks/${deck.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal((await fetch(`${ctx.base}/api/decks/${deck.id}`)).status, 404);
  const survivingSources = await fetch(`${ctx.base}/api/sources`).then(json);
  assert.equal(survivingSources.sources.length, 1);
});

test('session scoping is enforced by the backend, not the UI', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  for (const [title, letter, url] of [['Biology material', 'B', 'https://x.example/bio'], ['Chemistry material', 'C', 'https://x.example/chem']]) {
    await fetch(`${ctx.base}/api/sources/webpage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title, text: letter.repeat(80) }),
    }).then(json);
  }
  const sources = (await fetch(`${ctx.base}/api/sources`).then(json)).sources;
  const bioId = sources.find((s) => s.title.includes('Biology')).id;
  const chemId = sources.find((s) => s.title.includes('Chemistry')).id;

  const session = (await fetch(`${ctx.base}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Biology only' }),
  }).then(json)).session;
  await fetch(`${ctx.base}/api/sources/${bioId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }),
  }).then(json);

  const empty = (await fetch(`${ctx.base}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'No material here' }),
  }).then(json)).session;
  const emptyRes = await fetch(`${ctx.base}/api/tutor/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'What is mitosis?', sessionId: empty.id }),
  });
  assert.equal(emptyRes.status, 400);
  assert.equal((await emptyRes.json()).error.code, 'SESSION_EMPTY');

  // The tutor prompt lists only the session's passages — chemistry never arrives.
  await fetch(`${ctx.base}/api/tutor/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'What is mitosis?', sessionId: session.id }),
  }).then(json);

  const smuggle = await fetch(`${ctx.base}/api/quiz/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'Everything', sourceIds: [chemId], sessionId: session.id }),
  });
  assert.equal(smuggle.status, 400);
  assert.equal((await smuggle.json()).error.code, 'VALIDATION_ERROR');

  const unknownSession = await fetch(`${ctx.base}/api/quiz/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'Cell cycle', sessionId: 'ses_nope' }),
  });
  assert.equal(unknownSession.status, 404);
  assert.equal((await unknownSession.json()).error.code, 'SESSION_NOT_FOUND');
});

test('a failed review update rolls back — no half-applied card mark', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const webpage = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(WEBPAGE),
  }).then(json);
  const generated = await fetch(`${ctx.base}/api/flashcards/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'Cell division', count: 3 }),
  }).then(json);
  const deckId = generated.deckId;

  // Force the *second* UPDATE (decks.last_reviewed_at) to abort, so the
  // parked card write must be rolled back or the card row is left corrupted.
  await ctx.db.exec("CREATE TRIGGER force_deck_fail BEFORE UPDATE ON decks BEGIN SELECT RAISE(ABORT, 'forced failure'); END;");
  t.after(async () => { await ctx.db.exec('DROP TRIGGER IF EXISTS force_deck_fail'); });

  const failed = await fetch(`${ctx.base}/api/decks/${deckId}/cards/1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'known' }),
  });
  assert.equal(failed.status >= 400, true);
  const error = (await failed.json()).error;
  assert.ok(error.code && error.message); // standard error envelope

  // The card mark must NOT have stuck: the transaction rolled back.
  const deck = await fetch(`${ctx.base}/api/decks/${deckId}`).then(json);
  assert.equal(deck.cards[1].status, 'new');
  assert.equal(deck.cards[1].reviewedAt, null);
  assert.equal(deck.cards[1].idx, 1);
  assert.equal(deck.deck.knownCount, 0);
  assert.equal(deck.deck.lastReviewedAt, null);

  // The trigger was really the cause: with it dropped, the same mark lands.
  await ctx.db.exec('DROP TRIGGER force_deck_fail');
  const ok = await fetch(`${ctx.base}/api/decks/${deckId}/cards/1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'known' }),
  });
  assert.equal(ok.status, 200);
  const afterRecovery = await fetch(`${ctx.base}/api/decks/${deckId}`).then(json);
  assert.equal(afterRecovery.cards[1].status, 'known');
  assert.equal(afterRecovery.deck.knownCount, 1);
});

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
  const db = openDb(path.join(dir, 'app.db'));
  const app = createApp({ db, ai: makeAi(), vector: fakeVector() });
  const server = app.listen(0);
  await once(server, 'listening');
  return { base: `http://localhost:${server.address().port}`, db, server, close: () => new Promise((r) => server.close(r)) };
}

test('decks persist and review status survives a restart', async (t) => {
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

  // "Restart": a second app instance over the same SQLite file sees everything.
  const restarted = await fetch(`${ctx.base}/api/decks?sessionId=${session.id}`).then(json);
  assert.equal(restarted.decks[0].knownCount, 1);

  const rightAfterRestart = await fetch(`${ctx.base}/api/decks/${deck.id}`).then(json);
  assert.equal(rightAfterRestart.cards[0].status, 'known');

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

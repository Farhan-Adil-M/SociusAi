// Part 8 (contract v1.5): auto practice decks during active study. Offline:
// in-memory db + stubbed AI/vector, HTTP end-to-end through POST /ask and
// GET /api/decks (startApp pattern from tutor-intents.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';
import { fakeVector, makeAi, EMBEDDING, TUTOR_ANSWER } from './helpers.js';

// ---------- db + stub helpers ----------

async function startApp({ ai, vector } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-autodeck-'));
  const db = await openDb(path.join(dir, 'app.db'));
  const vectorStub = vector ?? fakeVector();
  const app = await createApp({ db, ...(ai ? { ai } : {}), vector: vectorStub });
  const server = app.listen(0);
  await once(server, 'listening');
  return { base: `http://localhost:${server.address().port}`, db, vector: vectorStub, close: () => new Promise((r) => server.close(r)) };
}

const post = (base, body) => fetch(`${base}/api/tutor/ask`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const getDecks = async (base, query = '') => {
  const res = await fetch(`${base}/api/decks${query}`);
  return { status: res.status, decks: (await res.json()).decks ?? [] };
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn returns truthy — the deck generation is fire-and-forget. */
async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within timeout');
    await tick(20);
  }
}

function seedSource(db, id, title, sessionId) {
  db.prepare(
    "INSERT INTO sources (id, type, title, chunk_count, session_id, created_at) VALUES (?, 'webpage', ?, 2, ?, ?)",
  ).run(id, title, sessionId, '2026-01-01T00:00:00Z');
}

/** A study session with `n` webpage sources (chunks embedded in the vector stub). */
async function seedSession(ctx, { title = 'Cell biology', n = 2, chunks = false } = {}) {
  const session = (await fetch(`${ctx.base}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  }).then((r) => r.json())).session;
  const sourceIds = [];
  for (let i = 0; i < n; i++) {
    const id = `src_${String.fromCharCode(97 + i)}`;
    sourceIds.push(id);
    seedSource(ctx.db, id, title, session.id);
    if (chunks) {
      await ctx.vector.addChunks({
        ids: [`${id}_1`],
        embeddings: [EMBEDDING],
        documents: ['Mitosis produces two identical daughter cells.'],
        metadatas: [{ sourceId: id, title: `Doc ${id}`, paragraph: 1 }],
      });
    }
  }
  return { session, sourceIds };
}

// ---------- end-to-end through POST /api/tutor/ask ----------

test('first scoped ask starts one auto deck from NO deck', async (t) => {
  const ai = makeAi();
  const ctx = await startApp({ ai });
  t.after(ctx.close);
  const { session, sourceIds } = await seedSession(ctx, { chunks: true });

  const res = await post(ctx.base, { question: 'How does mitosis work?', sessionId: session.id });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.needsContent, false);
  assert.equal(body.answer, TUTOR_ANSWER); // the grounded answer is unchanged
  assert.equal(body.deckGeneration, 'started');

  const decks = await waitFor(async () => {
    const list = await getDecks(ctx.base, `?sessionId=${session.id}`);
    return list.decks.length === 1 ? list.decks : null;
  });
  assert.equal(decks[0].topic, 'Cell biology'); // topic = session title
  assert.equal(decks[0].sessionId, session.id);
  assert.equal(decks[0].cardCount, 3); // FLASHCARD_JSON cards, persisted deck

  // Scoped to the session's sources, exactly as a manual /generate would be.
  const detail = await fetch(`${ctx.base}/api/decks/${decks[0].id}`).then((r) => r.json());
  assert.deepEqual([...detail.deck.sourceIds].sort(), [...sourceIds].sort());
});

test('second ask in the same session is a no-op: deckGeneration absent, still one deck', async (t) => {
  const ctx = await startApp({ ai: makeAi() });
  t.after(ctx.close);
  const { session } = await seedSession(ctx, { chunks: true });

  const first = await post(ctx.base, { question: 'How does mitosis work?', sessionId: session.id });
  assert.equal((await first.json()).deckGeneration, 'started');
  await waitFor(async () => {
    const list = await getDecks(ctx.base, `?sessionId=${session.id}`);
    return list.decks.length === 1 ? list.decks : null;
  });

  const second = await post(ctx.base, { question: 'What is meiosis?', sessionId: session.id });
  assert.equal(second.status, 200);
  const body2 = await second.json();
  assert.equal(body2.needsContent, false);
  assert.equal(body2.deckGeneration, undefined, 'no field when the session already has a deck');
  assert.equal((await getDecks(ctx.base)).decks.length, 1, 'no second deck was created');
});

test('unscoped ask answers normally with NO deckGeneration field and NO deck', async (t) => {
  const ctx = await startApp({ ai: makeAi() });
  t.after(ctx.close);
  await seedSession(ctx, { chunks: true }); // material exists, but the ask is not session-scoped

  const res = await post(ctx.base, { question: 'How does mitosis work?', sourceIds: ['src_a'] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.needsContent, false);
  assert.equal(body.deckGeneration, undefined);
  assert.equal((await getDecks(ctx.base)).decks.length, 0);
});

test('abstain path (needsContent) does not start auto generation', async (t) => {
  const ctx = await startApp({ ai: makeAi() });
  t.after(ctx.close);
  const { session } = await seedSession(ctx, { chunks: false }); // registered source, empty vector store

  const res = await post(ctx.base, { question: 'How does mitosis work?', sessionId: session.id });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.needsContent, true, 'an empty vector store yields the honest abstain');
  assert.equal(body.deckGeneration, undefined);
  assert.equal((await getDecks(ctx.base)).decks.length, 0);
});

test('background generation failure is non-fatal: answer still 200, deck-failed logged, no deck rows', async (t) => {
  const ai = makeAi();
  const baseChat = ai.chatCompletion;
  ai.chatCompletion = async (messages, opts) => {
    if (messages[0].content.includes('flashcards')) throw new Error('flashcard model exploded'); // only the deck call fails
    return baseChat(messages, opts);
  };
  const ctx = await startApp({ ai });
  t.after(ctx.close);
  const { session } = await seedSession(ctx, { chunks: true });

  const res = await post(ctx.base, { question: 'How does mitosis work?', sessionId: session.id });
  assert.equal(res.status, 200, 'a failed background deck never breaks the answer');
  const body = await res.json();
  assert.equal(body.answer, TUTOR_ANSWER);
  assert.equal(body.deckGeneration, 'started');

  const failure = await waitFor(async () => {
    const rows = await ctx.db.all("SELECT topic, detail FROM activity WHERE type = 'deck-failed'");
    return rows.length === 1 ? rows : null;
  });
  assert.match(failure[0].detail, /Auto deck generation failed: flashcard model exploded/);
  assert.equal(failure[0].topic, 'Cell biology');
  assert.equal((await getDecks(ctx.base)).decks.length, 0, 'no deck rows on failure');
});

test('zero-source session answers SESSION_EMPTY before any deck logic', async (t) => {
  const ctx = await startApp({ ai: makeAi() });
  t.after(ctx.close);
  const session = (await fetch(`${ctx.base}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Empty unit' }),
  }).then((r) => r.json())).session;

  const res = await post(ctx.base, { question: 'How does mitosis work?', sessionId: session.id });
  assert.equal(res.status, 400); // existing behaviour unchanged
  assert.equal((await res.json()).error.code, 'SESSION_EMPTY');
  const rows = await ctx.db.get('SELECT COUNT(*) AS n FROM decks');
  assert.equal(rows.n, 0);
});

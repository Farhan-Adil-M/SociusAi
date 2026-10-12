// End-to-end API test of the whole learning loop with stubbed AI + vector
// services (no network, no ChromaDB). Proves the wiring: upload → retrieve →
// tutor citations → quiz generation without a leaked key → deterministic
// grading → learner update → progress rollup.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { openDb } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';

const EMBEDDING = Array(2048).fill(0.5);

// In-memory stand-in for ChromaDB with the same interface we use.
function fakeVector() {
  const store = [];
  return {
    store,
    addChunks: async ({ ids, embeddings, documents, metadatas }) => {
      ids.forEach((id, i) => store.push({ id, embedding: embeddings[i], text: documents[i], metadata: metadatas[i] }));
    },
    queryChunks: async ({ nResults = 6, sourceIds = [] }) => {
      const pool = sourceIds.length ? store.filter((s) => sourceIds.includes(s.metadata.sourceId)) : store;
      return pool.slice(0, nResults).map((s) => ({ ...s, distance: 0.2 }));
    },
    pingChroma: async () => true,
    resetCollection: async () => { store.length = 0; },
  };
}

const TUTOR_ANSWER = 'Mitosis produces two identical daughter cells [1].';
const QUIZ_JSON = JSON.stringify({
  questions: [
    { question: 'Which process produces two identical cells?', choices: ['Mitosis', 'Meiosis', 'Fusion', 'Diffusion'], answer: 'Mitosis', explanation: 'Mitosis copies the nucleus once.', cite: [1, 2] },
    { question: 'How many divisions does meiosis involve?', choices: ['One', 'Two', 'Three', 'None'], answer: 'Two', explanation: 'Meiosis divides twice.', cite: [2] },
    { question: 'Where does mitosis occur in the cell?', choices: ['Nucleus', 'Ribosome', 'Membrane', 'Vacuole'], answer: 'Nucleus', explanation: 'The nucleus divides.', cite: [1] },
  ],
});
const FLASHCARD_JSON = JSON.stringify({
  cards: [{ front: 'What does mitosis produce?', back: 'Two genetically identical daughter cells.', cite: [1] }],
});

function makeAi() {
  const calls = [];
  return {
    calls,
    embedTexts: async (texts) => texts.map(() => EMBEDDING),
    embedQuery: async () => EMBEDDING,
    chatCompletion: async (messages) => {
      calls.push(messages);
      const system = messages[0].content;
      if (system.includes('flashcards')) return FLASHCARD_JSON;
      if (system.includes('multiple-choice')) return QUIZ_JSON;
      return TUTOR_ANSWER;
    },
  };
}

function buildPptxBuffer() {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile('ppt/slides/slide1.xml', Buffer.from('<p:sld><a:t>Recursion uses a base case to stop.</a:t></p:sld>'));
  zip.addFile('ppt/slides/slide2.xml', Buffer.from('<p:sld><a:t>A recursive call moves toward the base case.</a:t></p:sld>'));
  return zip.toBuffer();
}

async function startApp({ ai = makeAi(), vector = fakeVector() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-test-'));
  const db = openDb(path.join(dir, 'app.db'));
  const app = createApp({ db, ai, vector });
  const server = app.listen(0);
  await once(server, 'listening');
  return { base: `http://localhost:${server.address().port}`, db, ai, vector, close: () => new Promise((r) => server.close(r)) };
}

const WEBPAGE = {
  url: 'https://learn.example/cells',
  title: 'Cells 101',
  text: 'Cells are the basic unit of life.\n\nThe nucleus stores DNA.\n\nMitochondria release energy from glucose.\n\nMitosis produces two identical daughter cells.\n\nMeiosis produces four varied cells for reproduction.',
};

test('full learning loop over the HTTP API (stubbed AI + vector store)', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);
  let sourceId;

  await t.test('health reports ok with stubbed dependencies', async () => {
    const res = await fetch(`${ctx.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.checks.sqlite.ok, true);
    assert.equal(body.checks.nim.ok, true);
  });

  await t.test('webpage ingestion creates a source', async () => {
    const res = await fetch(`${ctx.base}/api/sources/webpage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(WEBPAGE),
    });
    assert.equal(res.status, 201);
    const { source } = await res.json();
    sourceId = source.id;
    assert.equal(source.type, 'webpage');
    assert.equal(source.sizeLabel, 'webpage');
    assert.ok(source.chunkCount >= 5);
    assert.equal(ctx.vector.store.length, source.chunkCount); // vectors actually stored
  });

  await t.test('GET /api/sources lists the source', async () => {
    const { sources } = await (await fetch(`${ctx.base}/api/sources`)).json();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].id, sourceId);
  });

  await t.test('tutor answer carries real retrieved citations', async () => {
    const res = await fetch(`${ctx.base}/api/tutor/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'How does mitosis work?', sourceIds: [sourceId] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.answer, TUTOR_ANSWER);
    assert.equal(body.needsContent, false);
    assert.ok(body.citations.length > 0);
    assert.equal(body.citations[0].sourceId, sourceId);
    assert.equal(body.citations[0].title, 'Cells 101');
    assert.ok(body.citations[0].location.paragraph >= 1);
    assert.equal(typeof body.citations[0].score, 'number');
  });

  await t.test('quiz generation never leaks the answer key', async () => {
    const res = await fetch(`${ctx.base}/api/quiz/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Cell division', sourceIds: [sourceId] }),
    });
    assert.equal(res.status, 201);
    const { quiz } = await res.json();
    assert.ok(quiz.id.startsWith('quiz_'));
    assert.equal(quiz.questions.length, 3);
    assert.equal(quiz.questions[0].choices.length, 4);
    const raw = JSON.stringify(quiz);
    assert.ok(!raw.includes('correctChoiceId'), 'key must not be in the generate response');
    assert.ok(!raw.includes('explanation'), 'explanations must not be in the generate response');
    ctx.quizId = quiz.id;
    ctx.correctChoices = ['a', 'b', 'a']; // from QUIZ_JSON
  });

  await t.test('deterministic grading, key reveal, learner update', async () => {
    const answers = { answers: [{ index: 0, choiceId: 'a' }, { index: 1, choiceId: 'b' }, { index: 2, choiceId: 'b' }] };
    const res = await fetch(`${ctx.base}/api/quiz/${ctx.quizId}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(answers),
    });
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.deepEqual(result.score, { correct: 2, total: 3, percent: 67 });
    assert.equal(result.questions[0].correctChoiceId, 'a'); // revealed only now
    assert.equal(result.questions[0].correct, true);
    assert.equal(result.masteryUpdate.topic, 'cell division');
    assert.ok(Math.abs(result.masteryUpdate.after - 2 / 3) < 0.0001); // rounded to 4 decimals
    assert.equal(result.recommendedDifficulty, 'medium');
  });

  await t.test('resubmitting the same quiz returns 409 with the stored result', async () => {
    const res = await fetch(`${ctx.base}/api/quiz/${ctx.quizId}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: [{ index: 0, choiceId: 'b' }, { index: 1, choiceId: 'b' }, { index: 2, choiceId: 'b' }] }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'QUIZ_ALREADY_ANSWERED');
    assert.equal(body.result.score.correct, 2); // the ORIGINAL attempt, not re-graded
    const topics = await (await fetch(`${ctx.base}/api/learner/progress`)).json();
    assert.equal(topics.overall.quizzesTaken, 1); // progress was not double-counted
  });

  await t.test('progress endpoint reflects everything', async () => {
    const body = await (await fetch(`${ctx.base}/api/learner/progress`)).json();
    assert.equal(body.topics.length, 1);
    assert.equal(body.topics[0].topic, 'cell division');
    assert.equal(body.topics[0].masteryPercent, 67);
    assert.equal(body.overall.questionsAnswered, 3);
    assert.ok(['easy', 'medium', 'hard'].includes(body.suggestedNext.topic === 'cell division' ? body.suggestedNext.difficulty : 'medium'));
    const types = body.recentActivity.map((a) => a.type);
    assert.ok(types.includes('quiz') && types.includes('upload') && types.includes('question'));
  });

  await t.test('flashcards generation returns validated cards', async () => {
    const res = await fetch(`${ctx.base}/api/flashcards/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'Cells', sourceIds: [sourceId] }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.cards.length, 1);
    assert.ok(body.cards[0].front.length > 0);
    assert.equal(body.cards[0].citations[0].sourceId, sourceId);
  });
});

test('pptx upload extracts slides with locations', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);
  const fd = new FormData();
  fd.append('file', new Blob([buildPptxBuffer()]), 'recursion-slides.pptx');
  const res = await fetch(`${ctx.base}/api/sources/upload`, { method: 'POST', body: fd });
  assert.equal(res.status, 201);
  const { source } = await res.json();
  assert.equal(source.type, 'pptx');
  assert.equal(source.slideCount, 2);
  assert.equal(source.sizeLabel, '2 slides');
  const stored = ctx.vector.store.find((c) => c.text.includes('base case'));
  assert.equal(stored.metadata.slide, 1); // slide location preserved into vector metadata
});

test('validation and error handling (all stubbed, no network)', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);
  const post = (url, body) => fetch(`${ctx.base}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  await t.test('unsupported upload type', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['hello']), 'notes.txt');
    const res = await fetch(`${ctx.base}/api/sources/upload`, { method: 'POST', body: fd });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'UNSUPPORTED_FILE');
  });

  await t.test('missing file field', async () => {
    const res = await fetch(`${ctx.base}/api/sources/upload`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  });

  await t.test('webpage: bad URL and short text', async () => {
    assert.equal((await post('/api/sources/webpage', { url: 'nope', text: 'x'.repeat(60) })).status, 400);
    const short = await post('/api/sources/webpage', { url: 'https://ok.org', text: 'tiny' });
    assert.equal(short.status, 400);
    assert.equal((await short.json()).error.code, 'VALIDATION_ERROR');
  });

  await t.test('tutor: bad question length and unknown source', async () => {
    assert.equal((await post('/api/tutor/ask', { question: 'x' })).status, 400);
    const unknown = await post('/api/tutor/ask', { question: 'What is recursion?', sourceIds: ['src_nope'] });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'SOURCE_NOT_FOUND');
  });

  await t.test('quiz: bad difficulty, bad count, unknown quiz', async () => {
    assert.equal((await post('/api/quiz/generate', { topic: 'Cells', difficulty: 'insane' })).status, 400);
    assert.equal((await post('/api/quiz/generate', { topic: 'Cells', questionCount: 99 })).status, 400);
    const res = await post('/api/quiz/quiz_missing/answer', { answers: [{ index: 0, choiceId: 'a' }] });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'QUIZ_NOT_FOUND');
  });

  await t.test('quiz generation with no indexed material returns 422', async () => {
    const emptyCtx = await startApp({ vector: { ...fakeVector(), store: [] } });
    t.after(emptyCtx.close);
    const res = await fetch(`${emptyCtx.base}/api/quiz/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'Anything' }),
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'QUIZ_CONTENT_INVALID');
  });
});

test('health degrades gracefully when Chroma is unreachable', async (t) => {
  const failing = {
    ...fakeVector(),
    pingChroma: async () => { throw new Error('connection refused'); },
  };
  const ctx = await startApp({ vector: failing });
  t.after(ctx.close);
  const body = await (await fetch(`${ctx.base}/api/health`)).json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.checks.chroma.ok, false);
  assert.ok(body.checks.chroma.message.length > 0);
  assert.equal(body.checks.sqlite.ok, true); // the rest still works
});

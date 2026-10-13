// Embedding-model bookkeeping (v1.2): the first ingestion records the model +
// dimension; later ingests either agree silently or stop with an honest error.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getMeta, setMeta } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { fakeVector, makeAi } from './helpers.js';

async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-meta-'));
  const db = await openDb(path.join(dir, 'app.db'));
  const app = await createApp({ db, ai: makeAi(), vector: fakeVector() });
  const server = app.listen(0);
  await once(server, 'listening');
  return { base: `http://localhost:${server.address().port}`, db, dir, close: () => new Promise((r) => server.close(r)) };
}

const WEBPAGE = { url: 'https://learn.example/x', text: 'X'.repeat(90) };

test('first ingestion records the embedding model and dimension', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  assert.equal(await getMeta(ctx.db, 'embed_model'), null); // fresh install: nothing recorded yet
  const res = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(WEBPAGE),
  });
  assert.equal(res.status, 201);
  assert.equal(await getMeta(ctx.db, 'embed_model'), config.nimEmbedModel);

  // same-model ingest right after: no error, meta untouched
  const again = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://learn.example/y', text: 'Y'.repeat(90) }),
  });
  assert.equal(again.status, 201);
  assert.equal(await getMeta(ctx.db, 'embed_model'), config.nimEmbedModel);
});

test('mismatched configured model stops ingestion with a clear reindex instruction', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(WEBPAGE),
  });
  // simulate: the index was built with an older model, config now says another
  await setMeta(ctx.db, 'embed_model', 'some/older-embed-model');

  const res = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://learn.example/z', text: 'Z'.repeat(90) }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.code, 'CHROMA_UNAVAILABLE');
  assert.ok(body.error.message.includes('npm run reindex'));

  // the mismatched (stale) recording must be preserved, never silently replaced
  assert.equal(await getMeta(ctx.db, 'embed_model'), 'some/older-embed-model');
});

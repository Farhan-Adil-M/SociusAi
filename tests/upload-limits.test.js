// Upload-size limits:
//  1) GET /api/health exposes the configured cap as checks.limits.maxUploadMb
//     without changing the system status.
//  2) An upload larger than MAX_UPLOAD_MB hits OUR multer limit and returns the
//     contract's 413 FILE_TOO_LARGE envelope — never a raw 500 — with the real
//     limit named in the message.
//
// config.js reads process.env ONCE at import, so MAX_UPLOAD_MB is set here
// BEFORE the dynamic import below. `node --test` runs this file in its own
// process, so the override cannot leak into other test files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MAX_UPLOAD_MB = '1'; // must precede the first config.js evaluation

const { config } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const { openDb } = await import('../server/store/sqlite.js');
const { fakeVector, makeAi } = await import('./helpers.js');

async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-limits-'));
  const db = openDb(path.join(dir, 'app.db'));
  const app = createApp({ db, ai: makeAi(), vector: fakeVector() });
  const server = app.listen(0);
  await once(server, 'listening');
  return { base: `http://localhost:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('health exposes the configured upload limit without degrading status', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const res = await fetch(`${ctx.base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.checks.limits.maxUploadMb, config.maxUploadMb);
  // The limits block is a fact, not a probe — it must not tip the rollup.
  assert.equal(body.status, 'ok');
});

test('oversized upload returns 413 FILE_TOO_LARGE with the real limit', async (t) => {
  const ctx = await startApp();
  t.after(ctx.close);

  const limitBytes = config.maxUploadMb * 1024 * 1024;
  const form = new FormData();
  form.set('file', new Blob([Buffer.alloc(limitBytes + 1000)]), 'big.pdf');
  const res = await fetch(`${ctx.base}/api/sources/upload`, { method: 'POST', body: form });

  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error.code, 'FILE_TOO_LARGE');
  assert.ok(body.error.message.includes('the upload limit is 1 MB'), body.error.message);
});

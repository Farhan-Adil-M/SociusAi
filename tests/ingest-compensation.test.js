// Ingestion compensation (v1.2): if structured persistence fails after the
// chunks were indexed in Chroma, nothing searchable is left behind —
// neither a misleading source record nor orphan vectors.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';
import { makeAi, fakeVector } from './helpers.js';

/** DB proxy that lets vector-related work run, then throws on the Nth structured
 *  INSERT — mimicking a disk/DB failure right after successful indexing.
 *  (Vector calls go through the injected vector stub, not the db.) */
function dbThatFailsAfterVectors(realDb, failOnInsertNumber) {
  let insertCount = 0;
  return new Proxy(realDb, {
    get(target, prop) {
      if (prop !== 'prepare') return Reflect.get(target, prop);
      return (sql) => {
        if (sql.startsWith('INSERT INTO sources') || sql.startsWith('INSERT INTO source_segments')) {
          insertCount += 1;
          if (insertCount >= failOnInsertNumber) {
            return {
              run() { throw new Error('simulated disk failure after vector indexing'); },
            };
          }
        }
        return target.prepare(sql);
      };
    },
  });
}

const WEBPAGE = { url: 'https://learn.example/unit1', text: 'U'.repeat(200) };

async function startApp({ db, vector } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-orphan-'));
  const realDb = db ?? openDb(path.join(dir, 'app.db'));
  const app = createApp({ db: realDb, ai: makeAi(), vector: vector ?? fakeVector() });
  const server = app.listen(0);
  await once(server, 'listening');
  return { base: `http://localhost:${server.address().port}`, realDb, dir, close: () => new Promise((r) => server.close(r)) };
}

test('vector-orphan compensation runs when structured persistence fails', async (t) => {
  const indexedIds = [];
  const deleted = [];
  const vector = {
    addChunks: async ({ ids }) => { indexedIds.push(...ids); },
    deleteChunks: async (ids) => { deleted.push(...ids); },
    pingChroma: async () => true,
    queryChunks: async ({ nResults = 6, sourceIds = [] }) => [{ id: 'x', text: 't', metadata: { sourceId: 'any' }, distance: 0.1 }],
    resetCollection: async () => {},
  };

  // The db proxy throws on the FIRST sources INSERT — which happens only after
  // the vector indexing step has completed, replicating a real failure order.
  const realDb = openDb(path.join((fs.mkdtempSync(path.join(os.tmpdir(), 'socius-orphan2-'))), 'app.db'));
  const failingDb = dbThatFailsAfterVectors(realDb, 1);
  const ctx = await startApp({ db: failingDb, vector });
  t.after(ctx.close);

  const res = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://learn.example/unit2', text: 'V'.repeat(200) }),
  });
  assert.ok(res.status >= 500, `expected a 5xx for the simulated failure, got ${res.status}`);

  // the indexed vectors were compensated: exactly the ids that were indexed
  // were removed as compensation
  assert.ok(indexedIds.length > 0, 'vectors were indexed before the failure');
  assert.deepEqual([...deleted].sort(), [...indexedIds].sort(), 'every indexed id was removed as compensation');

  // no misleading source record exists afterwards
  const rows = ctx.realDb.prepare('SELECT COUNT(*) AS n FROM sources').get();
  assert.equal(rows.n, 0);
});

test('happy ingestion is unaffected by the compensation wrapper', async (t) => {
  const indexedIds = [];
  const deleted = [];
  const ctx = await startApp({
    vector: {
      addChunks: async ({ ids }) => { indexedIds.push(...ids); },
      deleteChunks: async (ids) => { deleted.push(...ids); },
      pingChroma: async () => true,
      resetCollection: async () => {},
    },
  });
  t.after(ctx.close);

  const res = await fetch(`${ctx.base}/api/sources/webpage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(WEBPAGE),
  });
  assert.equal(res.status, 201);
  assert.ok(indexedIds.length > 0);
  assert.equal(deleted.length, 0); // compensation must not run on success
});

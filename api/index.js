// Vercel serverless entry: mounts the SAME Express app used locally.
// Notes (see README "Deploying to Vercel"):
//  - SQLite here is EPHEMERAL (/tmp) — for real persistence the project also
//    supports cloud storage; on the demo laptop use `npm start` instead.
//  - Vector store on Vercel: Chroma Cloud when CHROMA_* credentials are set,
//    otherwise the SQLite fallback (server/store/sqlite-vector.js) keeps every
//    vector feature working. The fallback is seeded with the committed demo
//    corpus at cold start so the deployment always opens answerable.

import '../api/polyfill.js'; // must run BEFORE pdf-parse loads
import { assertConfig } from '../server/config.js';
import { openAppDb } from '../server/store/db.js';
import { createApp } from '../server/app.js';
import { resolveVectorStore } from '../server/store/vectorProvider.js';
import { seedDemoCorpusIfEmpty } from '../server/store/sqlite-vector.js';
import { embedTexts } from '../server/services/embeddings.js';

assertConfig();
// TURSO_* envs transparently select the hosted engine (openAppDb refuses boot
// with an actionable error when the hosted schema is behind this build — the
// prod-honesty gate; do not catch this away). Local default keeps the
// ephemeral serverless path as before.
const db = await openAppDb({ dbPath: process.env.SQLITE_DB_PATH ?? '/tmp/socius-app.db' });

const vector = resolveVectorStore(db);

// Cold-start seeding (fallback backend only): when the store is empty — every
// fresh /tmp on Vercel — load the committed demo corpus so judges always land
// on a populated, answerable library. NIM failure must not take the app down.
if (vector.backend === 'sqlite') {
  try {
    const seed = await seedDemoCorpusIfEmpty({ db, vector, ai: { embedTexts } });
    if (seed.seeded) console.log(`[seed] demo corpus loaded (${seed.chunks} chunks, sqlite backend)`);
  } catch (err) {
    console.error('[seed] demo corpus seeding failed (app continues, features may be degraded):', err?.message ?? err);
  }
}

const app = await createApp({ db, vector });

export default app;

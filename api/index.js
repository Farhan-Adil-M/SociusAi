// Vercel serverless entry: mounts the SAME Express app used locally.
// Notes (see README "Deploying to Vercel"):
//  - SQLite here is EPHEMERAL (/tmp) — for real persistence the project also
//    supports cloud storage; on the demo laptop use `npm start` instead.
//  - Chroma must be Chroma Cloud on Vercel (CHROMA_API_KEY / TENANT / DATABASE).

import '../api/polyfill.js'; // must run BEFORE pdf-parse loads
import { assertConfig } from '../server/config.js';
import { openDb } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';

assertConfig();
const db = openDb(process.env.SQLITE_DB_PATH ?? '/tmp/socius-app.db');
const app = createApp({ db });

export default app;

// Step-0 verification of @libsql/client API facts we rely on.
import { createClient } from '@libsql/client';
import fs from 'node:fs';

const file = '/tmp/opencode/libsql-verify.db';
for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });

const db = createClient({ url: `file:${file}` });
const out = {};

let r = await db.execute("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
r = await db.execute({ sql: 'INSERT INTO t (id, n) VALUES (?, ?)', args: ['a', 1] });
out.insert = { rowsAffected: r.rowsAffected, lastInsertRowid: String(r.lastInsertRowid), type: typeof r.lastInsertRowid };
r = await db.execute({ sql: 'SELECT * FROM t WHERE id = ?', args: ['a'] });
out.select = { columns: r.columns, rowKeyAccess: r.rows[0]?.id === 'a', n: r.rows[0]?.n };

let multi = true;
try { await db.execute("INSERT INTO t (id, n) VALUES ('b', 2); INSERT INTO t (id, n) VALUES ('c', 3);"); }
catch (e) { multi = false; out.multiErr = String(e).slice(0, 70); }
out.multiStatement = multi;
out.countAfterMulti = (await db.execute('SELECT COUNT(*) AS c FROM t')).rows[0]?.c;

try {
  await db.batch([
    { sql: "INSERT INTO t (id, n) VALUES ('d', 4)" },
    { sql: "INSERT INTO t (id, n) VALUES ('d', 5)" },
  ], 'write');
  out.batchAborts = false;
} catch (e) { out.batchAborts = true; }
out.batchRollbackCount = (await db.execute('SELECT COUNT(*) AS c FROM t')).rows[0]?.c;

await db.execute('CREATE TABLE parent (k TEXT PRIMARY KEY)');
await db.execute('CREATE TABLE child (k TEXT REFERENCES parent(k) ON DELETE CASCADE)');
out.fkDefault = (await db.execute('PRAGMA foreign_keys')).rows[0]?.foreign_keys;
await db.execute('PRAGMA foreign_keys = ON');
try { await db.execute("INSERT INTO child (k) VALUES ('missing')"); out.fkEnforced = false; }
catch { out.fkEnforced = true; }
const cascade = await db.batch([
  { sql: "INSERT INTO parent (k) VALUES ('p1')" },
  { sql: "INSERT INTO child (k) VALUES ('p1')" },
], 'write');
await db.execute("DELETE FROM parent WHERE k='p1'");
out.cascadeDeletesChild = ((await db.execute('SELECT COUNT(*) AS c FROM child')).rows[0]?.c) === 0;

const tx = await db.transaction('write');
await tx.execute("INSERT INTO t (id, n) VALUES ('e', 5)");
await tx.rollback();
out.txRollbackCount = (await db.execute('SELECT COUNT(*) AS c FROM t')).rows[0]?.c;

console.log(JSON.stringify(out, null, 2));

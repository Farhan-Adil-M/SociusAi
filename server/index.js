// Server entrypoint: validate configuration, open storage, start listening.

import os from 'node:os';
import { assertConfig, config } from './config.js';
import { openAppDb } from './store/db.js';
import { createApp } from './app.js';

assertConfig();
const db = await openAppDb(); // local node engine by default; TURSO_* envs select the hosted engine
const app = await createApp({ db });

// Bind address comes from BIND_HOST (default 127.0.0.1 — loopback only).
// Set a LAN address or 0.0.0.0 to let other devices on the network connect;
// the app has no authentication, so only do that on a network you trust.
const BIND_HOST = config.bindHost;
const isLoopback = BIND_HOST === '127.0.0.1' || BIND_HOST === '::1' || BIND_HOST === 'localhost';

// IPv4 addresses other devices can use to reach this machine (empty on loopback).
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

app.listen(config.port, BIND_HOST, () => {
  if (isLoopback) {
    console.log(`Socius AI server running at http://localhost:${config.port} (bound to ${BIND_HOST} — not reachable from other devices)`);
  } else {
    console.log(`Socius AI server running at http://localhost:${config.port} (bound to ${BIND_HOST})`);
    const urls = lanAddresses().map((ip) => `http://${ip}:${config.port}`);
    if (urls.length > 0) {
      console.log('  open from another device:');
      for (const url of urls) console.log(`    ${url}`);
    } else {
      console.log('  no LAN IPv4 address found for this machine');
    }
    console.log('  WARNING: no authentication — anyone on this network can upload, delete, and spend NIM tokens.');
  }
  console.log(`  tutor model:    ${config.nimChatModel}`);
  console.log(`  assessment:     ${config.nimAssessModel}`);
  console.log(`  embedding:      ${config.nimEmbedModel}`);
  console.log(`  database:       ${db.kind === 'libsql' ? 'hosted (libSQL/Turso)' : 'local SQLite (node:sqlite)'} [${db.kind}]`);
  console.log(`  vector store:   ${config.chromaApiKey ? 'Chroma Cloud' : `local (${config.chromaLocalHost}:${config.chromaLocalPort})`}`);
});

process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection]', err);
});

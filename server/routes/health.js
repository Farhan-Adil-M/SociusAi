// GET /api/health — liveness + dependency status. Always 200 while the server
// runs; degraded dependencies are reported inside the payload, never as a crash.

import express from 'express';
import { config } from '../config.js';
import { getMeta } from '../store/sqlite.js';
import { chatCompletion } from '../services/nimChat.js';
import { embedQuery } from '../services/embeddings.js';

const CACHE_MS = 60_000;

export function healthRouter({ db, ai, vector }) {
  const router = express.Router();
  let cached = { at: 0, payload: null };

  router.get('/', async (req, res) => {
    if (cached.payload && Date.now() - cached.at < CACHE_MS) {
      return res.json(cached.payload);
    }

    const checks = { sqlite: { ok: false, message: '' }, chroma: { ok: false, message: '' }, nim: { ok: false, message: '' } };

    try {
      db.prepare('SELECT 1 AS ok').get();
      checks.sqlite.ok = true;
    } catch (err) {
      checks.sqlite.message = 'Local database is not readable.';
    }

    try {
      await (vector?.pingChroma ?? (await import('../store/vectorStore.js')).pingChroma)();
      checks.chroma.ok = true;
    } catch (err) {
      checks.chroma.message = 'Vector database unreachable. Start the local Chroma server or check CHROMA_* in .env.';
    }

    try {
      await (ai?.embedQuery ?? embedQuery)('health check');
      checks.nim.ok = true;
      checks.nim.chatModel = config.nimChatModel;
      checks.nim.embeddingModel = config.nimEmbedModel;
    } catch (err) {
      checks.nim.message = err.message || 'AI provider unreachable.';
    }

    // Embedding-model guard (contract §Rebuilding): warn when the running
    // index was built with a different model than the configured one.
    if (checks.sqlite.ok && checks.nim.ok) {
      const storedModel = getMeta(db, 'embed_model');
      if (storedModel && storedModel !== config.nimEmbedModel) {
        checks.nim.ok = false;
        checks.nim.message = `The vector index was built with "${storedModel}" but NIM_EMBED_MODEL is "${config.nimEmbedModel}" — run npm run reindex before ingesting or asking questions.`;
      }
    }

    const payload = {
      status: Object.values(checks).every((c) => c.ok) ? 'ok' : 'degraded',
      checks,
    };
    cached = { at: Date.now(), payload };
    res.json(payload);
  });

  return router;
}

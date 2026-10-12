// Express app factory. `createApp({ db })` builds the real app; tests pass a
// temporary database and stubbed ai/vector services to run without network.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { chatCompletion } from './services/nimChat.js';
import { embedTexts, embedQuery } from './services/embeddings.js';
import { addChunks, queryChunks, pingChroma, resetCollection } from './store/vectorStore.js';
import { healthRouter } from './routes/health.js';
import { sourcesRouter } from './routes/sources.js';
import { tutorRouter } from './routes/tutor.js';
import { quizRouter } from './routes/quiz.js';
import { learnerRouter } from './routes/learner.js';
import { flashcardsRouter } from './routes/flashcards.js';

const FRONTEND_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../frontend');

export function createApp({ db, ai, vector } = {}) {
  const services = {
    ai: { chatCompletion, embedTexts, embedQuery, ...ai },
    vector: { addChunks, queryChunks, pingChroma, resetCollection, ...vector },
  };
  const ctx = { db, ...services };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/health', healthRouter(ctx));
  app.use('/api/sources', sourcesRouter(ctx));
  app.use('/api/tutor', tutorRouter(ctx));
  app.use('/api/quiz', quizRouter(ctx));
  app.use('/api/learner', learnerRouter(ctx));
  app.use('/api/flashcards', flashcardsRouter(ctx));

  // Serve the frontend built by Freebuff (same origin → no CORS anywhere).
  if (fs.existsSync(FRONTEND_DIR)) {
    app.use(express.static(FRONTEND_DIR));
    app.get(/^\/(?!api\/).*/, (req, res, next) => {
      const requested = path.join(FRONTEND_DIR, path.normalize(req.path).replace(/^(\.\.[/\\])+/, ''));
      if (requested.startsWith(FRONTEND_DIR) && fs.existsSync(requested) && fs.statSync(requested).isFile()) {
        return res.sendFile(requested);
      }
      // Unknown page → serve the landing page; it links to every other page.
      const index = path.join(FRONTEND_DIR, 'index.html');
      if (fs.existsSync(index)) return res.sendFile(index);
      next();
    });
  }

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}

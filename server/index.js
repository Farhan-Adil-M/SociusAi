// Server entrypoint: validate configuration, open storage, start listening.

import { assertConfig, config } from './config.js';
import { openDb } from './store/sqlite.js';
import { createApp } from './app.js';

assertConfig();
const db = openDb();
const app = createApp({ db });

app.listen(config.port, () => {
  console.log(`Socius AI server running at http://localhost:${config.port}`);
  console.log(`  tutor model:    ${config.nimChatModel}`);
  console.log(`  assessment:     ${config.nimAssessModel}`);
  console.log(`  embedding:      ${config.nimEmbedModel}`);
  console.log(`  vector store:   ${config.chromaApiKey ? 'Chroma Cloud' : `local (${config.chromaLocalHost}:${config.chromaLocalPort})`}`);
});

process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection]', err);
});

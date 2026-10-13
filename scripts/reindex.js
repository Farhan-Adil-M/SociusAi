// Rebuild the vector index from the extracted text stored in SQLite.
// Needed after changing NIM_EMBED_MODEL (vectors from different models cannot
// be mixed). No re-uploading required:  npm run reindex

import { config } from '../server/config.js';
import { openDb, getMeta, setMeta } from '../server/store/sqlite.js';
import { chunkSegments } from '../server/services/chunker.js';
import { embedTexts } from '../server/services/embeddings.js';
import { addChunks, resetCollection } from '../server/store/vectorStore.js';

assertConfig();
const db = openDb();

const storedModel = getMeta(db, 'embed_model');
if (storedModel && storedModel !== config.nimEmbedModel) {
  console.log(`Note: the existing index was built with "${storedModel}"; rebuilding with "${config.nimEmbedModel}".`);
}
const storedDim = getMeta(db, 'embed_dimension');
if (storedDim && storedDim !== '2048') {
  console.log(`Note: previous dimension metadata was ${storedDim}; this rebuild updates it to the current vector size.`);
}

console.log(`Rebuilding vector index with embedding model: ${config.nimEmbedModel}`);
await resetCollection();
console.log('Old collection removed.');

const sources = db.prepare('SELECT * FROM sources').all();
let totalChunks = 0;

for (const source of sources) {
  const segments = db.prepare('SELECT location, text FROM source_segments WHERE source_id = ? ORDER BY seg_index')
    .all(source.id)
    .map((row) => ({ text: row.text, location: JSON.parse(row.location) }));

  const chunks = chunkSegments(segments);
  for (let i = 0; i < chunks.length; i += 32) {
    const batch = chunks.slice(i, i + 32);
    const embeddings = await embedTexts(batch.map((c) => c.text));
    await addChunks({
      ids: batch.map((c) => `${source.id}_${c.chunkIndex}`),
      embeddings,
      documents: batch.map((c) => c.text),
      metadatas: batch.map((c) => ({
        sourceId: source.id,
        type: source.type,
        title: source.title,
        chunkIndex: c.chunkIndex,
        ...(source.url ? { url: source.url } : {}),
        ...(c.location?.page != null ? { page: c.location.page } : {}),
        ...(c.location?.slide != null ? { slide: c.location.slide } : {}),
        ...(c.location?.paragraph != null ? { paragraph: c.location.paragraph } : {}),
      })),
    });

    const storedModel = getMeta(db, 'embed_model');
    if (!storedModel || storedModel !== config.nimEmbedModel) {
      setMeta(db, 'embed_model', config.nimEmbedModel);
      setMeta(db, 'embed_dimension', String(embeddings[0].length));
      console.log(`Recorded embedding metadata: model=${config.nimEmbedModel}, dimension=${embeddings[0].length}`);
    }
  }

  db.prepare('UPDATE sources SET chunk_count = ? WHERE id = ?').run(chunks.length, source.id);
  totalChunks += chunks.length;
  console.log(`  ${source.title}: ${chunks.length} chunks`);
}

console.log(`Done. ${sources.length} sources, ${totalChunks} chunks, model "${config.nimEmbedModel}".`);
process.exit(0);

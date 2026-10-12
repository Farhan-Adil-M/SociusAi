// Retrieval: question → embedding → ChromaDB nearest chunks → citation-ready hits.
// Citations are built ONLY from stored metadata; the language model never
// supplies filenames, pages, or slide numbers.

import { embedQuery } from './embeddings.js';
import { queryChunks } from '../store/vectorStore.js';
import { ApiError } from '../middleware/errors.js';

const DEFAULT_K = 6;

export async function retrieve(question, { sourceIds = [], k = DEFAULT_K, ai, vector } = {}) {
  const embedFn = ai?.embedQuery ?? embedQuery;
  const queryFn = vector?.queryChunks ?? queryChunks;

  const embedding = await embedFn(question);
  const hits = await queryFn({ embedding, nResults: k, sourceIds });
  return hits;
}

// Chroma cosine distance: 0 = identical. Similarity shown to users: 1 - distance (clamped).
export function toCitation(hit) {
  const meta = hit.metadata ?? {};
  let location = null;
  if (meta.page != null) location = { page: meta.page };
  else if (meta.slide != null) location = { slide: meta.slide };
  else if (meta.paragraph != null) location = { paragraph: meta.paragraph };

  const score = typeof hit.distance === 'number'
    ? Math.max(0, Math.min(1, Number((1 - hit.distance).toFixed(3))))
    : undefined;

  return {
    sourceId: meta.sourceId ?? '',
    type: meta.type ?? 'pdf',
    title: meta.title ?? 'Unknown source',
    url: meta.url ?? null,
    location,
    excerpt: (hit.text ?? '').slice(0, 300),
    ...(score !== undefined ? { score } : {}),
  };
}

export async function assertSourcesExist(db, sourceIds) {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return;
  const seen = new Set();
  for (const id of sourceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const row = db.prepare('SELECT id FROM sources WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'SOURCE_NOT_FOUND', `Source "${id}" does not exist.`);
  }
}

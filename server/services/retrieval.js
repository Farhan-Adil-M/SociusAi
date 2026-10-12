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

/**
 * Session scope. Enforced HERE (server) because the UI selecting a session is
 * only an interface — retrieval must not touch sources outside it.
 *
 * Rules:
 *  - sessionId only   → the session's sources; empty session → 400 SESSION_EMPTY
 *  - sourceIds only   → passed through as-is (existing behaviour)
 *  - both             → every sourceId must belong to the session
 *  - neither          → { sourceIds: [] } = all material (existing behaviour)
 */
export function resolveScope(db, { sessionId, sourceIds = [] } = {}) {
  if (!sessionId) {
    if (Array.isArray(sourceIds)) return { sourceIds: [...sourceIds], session: null };
    return { sourceIds: [], session: null };
  }

  const session = db.prepare('SELECT * FROM study_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', `Session "${sessionId}" does not exist.`);

  const owned = db.prepare('SELECT id FROM sources WHERE session_id = ?').all(sessionId).map((row) => row.id);
  if (owned.length === 0) {
    throw new ApiError(400, 'SESSION_EMPTY', `No material in "${session.title}" yet. Add sources to this study session first.`);
  }

  const allowed = new Set(owned);
  if (Array.isArray(sourceIds) && sourceIds.length > 0) {
    for (const id of sourceIds) {
      if (!allowed.has(id)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'sourceIds must belong to the selected study session.');
      }
    }
    return { sourceIds: [...sourceIds], session };
  }

  return { sourceIds: owned, session };
}

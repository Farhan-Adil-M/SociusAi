// ChromaDB access. One collection of text chunks with embeddings + metadata.
// Uses Chroma Cloud when CHROMA_API_KEY is set, otherwise a local Chroma
// server (see README "Local Chroma fallback"). Callers never see the difference.

import { ChromaClient, CloudClient } from 'chromadb';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';

let collectionPromise = null;

// We ALWAYS send pre-computed vectors from NVIDIA NIM, so the collection never
// needs Chroma's own embedding. The client still requires an embedding function
// handle when opening a collection, so we hand it one that refuses to run —
// catching accidental text-based calls instead of silently embedding wrongly.
const explicitVectorsOnly = {
  name: 'socius-explicit-vectors',
  async generate() {
    throw new Error('This client always sends explicit NVIDIA NIM embeddings — never text.');
  },
};

function makeClient() {
  if (config.chromaApiKey) {
    return new CloudClient({
      apiKey: config.chromaApiKey,
      tenant: config.chromaTenant || undefined,
      database: config.chromaDatabase || undefined,
    });
  }
  return new ChromaClient({
    host: config.chromaLocalHost,
    port: config.chromaLocalPort,
    ssl: false,
  });
}

export function getCollection() {
  if (!collectionPromise) {
    collectionPromise = makeClient().getOrCreateCollection({
      name: config.chromaCollection,
      embeddingFunction: explicitVectorsOnly,
    })
      .catch((err) => {
        collectionPromise = null; // allow retry on next call
        throw err;
      });
  }
  return collectionPromise;
}

function isNotFound(err) {
  return err && (err.name === 'InvalidCollectionError' || err.name === 'NotFoundError');
}

export async function addChunks({ ids, embeddings, documents, metadatas }) {
  try {
    const collection = await getCollection();
    await collection.add({ ids, embeddings, documents, metadatas });
  } catch (err) {
    throw chromaError(err);
  }
}

export async function queryChunks({ embedding, nResults = 6, sourceIds = [] }) {
  try {
    const collection = await getCollection();
    const where = sourceIds.length > 0 ? { sourceId: { $in: sourceIds } } : undefined;
    const res = await collection.query({
      queryEmbeddings: [embedding],
      nResults,
      ...(where ? { where } : {}),
      include: ['documents', 'metadatas', 'distances'],
    });
    // Flatten Chroma's nested arrays (one query → arrays of length 1).
    const hits = [];
    for (let i = 0; i < (res.ids?.[0]?.length ?? 0); i++) {
      hits.push({
        id: res.ids[0][i],
        text: res.documents[0][i],
        metadata: res.metadatas[0][i] ?? {},
        distance: res.distances?.[0]?.[i],
      });
    }
    return hits;
  } catch (err) {
    throw chromaError(err);
  }
}

// For ingestion compensation (2.5): remove a specific set of chunk ids so a
// failed persistence never leaves searchable orphan vectors behind.
export async function deleteChunks(ids) {
  try {
    const collection = await getCollection();
    await collection.delete({ ids });
  } catch (err) {
    throw chromaError(err);
  }
}

export async function countChunks() {
  const collection = await getCollection();
  return collection.count();
}

export async function pingChroma() {
  const collection = await getCollection();
  await collection.count();
  return true;
}

// For npm run reindex: drop the collection so it can be rebuilt with the
// currently configured embedding model.
export async function resetCollection() {
  try {
    const client = makeClient();
    await client.deleteCollection({ name: config.chromaCollection });
  } catch (err) {
    if (!isNotFound(err)) throw chromaError(err);
  }
  collectionPromise = null;
}

export function chromaError(err) {
  if (err instanceof ApiError) return err;
  console.error('[chroma]', err?.message ?? err);
  return new ApiError(503, 'CHROMA_UNAVAILABLE',
    'The vector database is unreachable. Start the Chroma server or check CHROMA_* settings in .env.');
}

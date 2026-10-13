// Source ingestion routes: PDF/PPTX upload and pasted webpage text.
// Pipeline: extract → chunk → embed → store vectors → store records (SQLite).

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';
import { chunkSegments } from '../services/chunker.js';
import { extractPdf } from '../services/extract/pdf.js';
import { extractPptx } from '../services/extract/pptx.js';
import { extractWebpage } from '../services/extract/webpage.js';
import { addChunks, deleteChunks } from '../store/vectorStore.js';
import { embedTexts } from '../services/embeddings.js';
import { retrieve, toCitation, assertSourcesExist } from '../services/retrieval.js';
import { suggestOrganization, acceptOrganization } from '../services/organizer.js';
import { logActivity, newId, nowIso, getMeta, setMeta, delMeta } from '../store/sqlite.js';

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.pptx']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname ?? '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new ApiError(400, 'UNSUPPORTED_FILE', 'Only .pdf and .pptx files can be uploaded.'));
    }
    cb(null, true);
  },
});

function sizeLabelFor(type, pageCount, slideCount) {
  if (type === 'webpage') return 'webpage';
  if (pageCount != null) return `${pageCount} pages`;
  return `${slideCount} slides`;
}

function parseSourceTags(value) {
  try { return JSON.parse(value) || []; } catch { return []; }
}

export function sourceRowToApi(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    url: row.url ?? null,
    sessionId: row.session_id ?? null,
    tags: parseSourceTags(row.tags_json),
    orgSource: row.org_source ?? 'manual',
    pageCount: row.page_count,
    slideCount: row.slide_count,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    sizeLabel: sizeLabelFor(row.type, row.page_count, row.slide_count),
  };
}

async function persistSource(db, { type, title, url, segments, pageCount, slideCount }, { embed, store, remove }) {
  const sourceId = newId('src');
  const chunks = chunkSegments(segments);
  if (chunks.length === 0) {
    throw new ApiError(400, 'EMPTY_CONTENT', 'No usable text was extracted from this content.');
  }

  const vectors = await embed(chunks.map((c) => c.text));

  // Embedding-model guard (v1.2): record the model on first ingestion, and stop
  // clearly if the configured model no longer matches the recorded index — a
  // mixed-model index would silently corrupt retrieval.
  const storedModel = getMeta(db, 'embed_model');
  if (storedModel && storedModel !== config.nimEmbedModel) {
    throw new ApiError(503, 'CHROMA_UNAVAILABLE',
      `The search index was built with "${storedModel}" but NIM_EMBED_MODEL is "${config.nimEmbedModel}". Run npm run reindex, then try again.`);
  }
  if (!storedModel && vectors[0]) {
    setMeta(db, 'embed_model', config.nimEmbedModel);
    setMeta(db, 'embed_dimension', String(vectors[0].length));
  }

  const metadatas = chunks.map((c) => ({
    sourceId,
    type,
    title,
    chunkIndex: c.chunkIndex,
    ...(url ? { url } : {}),
    ...(c.location?.page != null ? { page: c.location.page } : {}),
    ...(c.location?.slide != null ? { slide: c.location.slide } : {}),
    ...(c.location?.paragraph != null ? { paragraph: c.location.paragraph } : {}),
  }));

  const ids = chunks.map((c) => `${sourceId}_${c.chunkIndex}`);
  const createdAt = nowIso();
  const removeVectors = () => (remove ?? deleteChunks)(ids);

  try {
    await store({
      ids,
      embeddings: vectors,
      documents: chunks.map((c) => c.text),
      metadatas,
    });
  } catch (err) {
    // Compensation (v1.2): if vector storage partially failed, remove anything
    // recorded persistently before rethrowing.
    removeVectors();
    if (!storedModel) {
      delMeta(db, 'embed_model');
      delMeta(db, 'embed_dimension');
    }
    throw err;
  }

  // Structured persistence AFTER indexing: if it fails, delete the freshly
  // indexed vectors so no searchable orphans are left behind.
  try {
    db.prepare('INSERT INTO sources (id, type, title, url, page_count, slide_count, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sourceId, type, title, url ?? null, pageCount, slideCount, chunks.length, createdAt);

    const insertSegment = db.prepare('INSERT INTO source_segments (source_id, seg_index, location, text) VALUES (?, ?, ?, ?)');
    segments.forEach((segment, i) => insertSegment.run(sourceId, i, JSON.stringify(segment.location ?? {}), segment.text));
  } catch (err) {
    removeVectors();
    if (!storedModel) {
      delMeta(db, 'embed_model');
      delMeta(db, 'embed_dimension');
    }
    throw err;
  }

  return {
    id: sourceId, type, title, pageCount, slideCount, chunkCount: chunks.length, createdAt,
    sizeLabel: sizeLabelFor(type, pageCount, slideCount),
  };
}

export function sourcesRouter({ db, ai, vector }) {
  const router = express.Router();
  const embed = ai?.embedTexts ?? embedTexts;
  const store = vector?.addChunks ?? addChunks;
  const remove = vector?.deleteChunks ?? deleteChunks;

  router.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Attach one file in the "file" field.');
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const extracted = ext === '.pdf'
      ? await extractPdf(req.file.buffer)
      : extractPptx(req.file.buffer);

    const source = await persistSource(db, {
      type: ext === '.pdf' ? 'pdf' : 'pptx',
      title: req.file.originalname,
      ...extracted,
    }, { embed, store, remove });
    logActivity(db, 'upload', null, `${source.title} (${source.pageCount ?? source.slideCount} ${source.pageCount != null ? 'pages' : 'slides'})`);
    res.status(201).json({ source: { ...source, url: null } });
  });

  router.post('/webpage', async (req, res) => {
    const { segments, title, url, pageCount, slideCount } = extractWebpage(req.body ?? {});
    const source = await persistSource(db, { type: 'webpage', title, url, segments, pageCount, slideCount }, { embed, store, remove });
    logActivity(db, 'upload', null, `${source.title} (webpage)`);
    res.status(201).json({ source: { ...source, url } });
  });

  router.post('/:id/suggest-organization', async (req, res) => {
    const { description } = req.body ?? {};
    if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Description must be at most 500 characters.');
    }
    const result = await suggestOrganization(db, { sourceId: req.params.id, description }, { chat: ai?.chatCompletion, });
    res.json(result); // 502 NIM_ERROR on model failure — the source simply stays Unsorted
  });

  router.post('/:id/accept-suggestion', (req, res) => {
    const { source, session } = acceptOrganization(db, { sourceId: req.params.id });
    logActivity(db, 'organize', null, `${source.title} → ${session?.title ?? 'Unsorted'}`, session?.id ?? null);
    res.json({ source: sourceRowToApi(source), session: session ? { id: session.id, title: session.title, category: session.category } : null });
  });

  router.get('/', (req, res) => {
    const { sessionId } = req.query;
    const filters = [];
    const params = [];
    if (sessionId === 'unsorted') {
      filters.push('session_id IS NULL');
    } else if (typeof sessionId === 'string' && sessionId !== '') {
      filters.push('session_id = ?');
      params.push(sessionId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM sources ${where} ORDER BY created_at DESC`).all(...params);
    const unsortedSourceCount = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE session_id IS NULL').get().n;
    res.json({ sources: rows.map(sourceRowToApi), unsortedSourceCount });
  });

  router.patch('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
    if (!row) throw new ApiError(404, 'SOURCE_NOT_FOUND', `Source "${req.params.id}" does not exist.`);

    const { sessionId, title, tags } = req.body ?? {};
    const updates = [];
    const params = [];

    if (sessionId !== undefined) {
      if (sessionId !== null) {
        const session = db.prepare('SELECT * FROM study_sessions WHERE id = ?').get(sessionId);
        if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', `Session "${sessionId}" does not exist.`);
      }
      updates.push('session_id = ?');
      params.push(sessionId); // null = back to Unsorted
      const destination = sessionId === null ? 'Unsorted' : db.prepare('SELECT title FROM study_sessions WHERE id = ?').get(sessionId)?.title ?? sessionId;
      logActivity(db, 'organize', null, `${row.title} → moved to ${destination}`, sessionId);
    }
    if (title !== undefined) {
      if (typeof title !== 'string' || title.trim().length < 1 || title.trim().length > 160) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Title must be 1–160 characters.');
      }
      updates.push('title = ?');
      params.push(title.trim());
    }
    if (tags !== undefined) {
      if (!Array.isArray(tags) || tags.length > 8) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Tags must be an array (at most 8).');
      }
      const clean = tags.map((tag) => String(tag).trim()).filter(Boolean);
      if (clean.some((tag) => tag.length > 24)) throw new ApiError(400, 'VALIDATION_ERROR', 'Each tag must be 1–24 characters.');
      updates.push('tags_json = ?');
      params.push(JSON.stringify(clean));
    }

    if (updates.length === 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Provide sessionId, title, or tags to update.');
    }

    // Manual choices are sticky: the organiser never replaces them automatically.
    updates.push('manual_override = 1');
    updates.push('org_source = ?');
    params.push('manual');

    db.prepare(`UPDATE sources SET ${updates.join(', ')} WHERE id = ?`).run(...params, row.id);
    res.json({ source: sourceRowToApi(db.prepare('SELECT * FROM sources WHERE id = ?').get(row.id)) });
  });

  return router;
}

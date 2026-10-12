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
import { addChunks } from '../store/vectorStore.js';
import { embedTexts } from '../services/embeddings.js';
import { logActivity, newId, nowIso } from '../store/sqlite.js';

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

function sourceRowToApi(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    pageCount: row.page_count,
    slideCount: row.slide_count,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    sizeLabel: sizeLabelFor(row.type, row.page_count, row.slide_count),
  };
}

async function persistSource(db, { type, title, url, segments, pageCount, slideCount }, { embed, store }) {
  const sourceId = newId('src');
  const chunks = chunkSegments(segments);
  if (chunks.length === 0) {
    throw new ApiError(400, 'EMPTY_CONTENT', 'No usable text was extracted from this content.');
  }

  const vectors = await embed(chunks.map((c) => c.text));
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
  await store({
    ids,
    embeddings: vectors,
    documents: chunks.map((c) => c.text),
    metadatas,
  });

  const createdAt = nowIso();
  db.prepare('INSERT INTO sources (id, type, title, url, page_count, slide_count, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sourceId, type, title, url ?? null, pageCount, slideCount, chunks.length, createdAt);

  const insertSegment = db.prepare('INSERT INTO source_segments (source_id, seg_index, location, text) VALUES (?, ?, ?, ?)');
  segments.forEach((segment, i) => insertSegment.run(sourceId, i, JSON.stringify(segment.location ?? {}), segment.text));

  return {
    id: sourceId, type, title, pageCount, slideCount, chunkCount: chunks.length, createdAt,
    sizeLabel: sizeLabelFor(type, pageCount, slideCount),
  };
}

export function sourcesRouter({ db, ai, vector }) {
  const router = express.Router();
  const embed = ai?.embedTexts ?? embedTexts;
  const store = vector?.addChunks ?? addChunks;

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
    }, { embed, store });
    logActivity(db, 'upload', null, `${source.title} (${source.pageCount ?? source.slideCount} ${source.pageCount != null ? 'pages' : 'slides'})`);
    res.status(201).json({ source: { ...source, url: null } });
  });

  router.post('/webpage', async (req, res) => {
    const { segments, title, url, pageCount, slideCount } = extractWebpage(req.body ?? {});
    const source = await persistSource(db, { type: 'webpage', title, url, segments, pageCount, slideCount }, { embed, store });
    logActivity(db, 'upload', null, `${source.title} (webpage)`);
    res.status(201).json({ source: { ...source, url } });
  });

  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all();
    res.json({ sources: rows.map(sourceRowToApi) });
  });

  return router;
}

# Socius AI

AI study companion — Track D, Personalized Tutoring & Adaptive Learning.
Upload PDFs / PowerPoint slides / webpage text, ask questions **grounded in your own materials** with verifiable citations, generate quizzes, and watch a deterministic learner model adapt question difficulty to your performance.

Full API specification: [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) — the shared contract between backend (`server/`, OpenCode) and frontend (`frontend/`, Freebuff).

## Requirements

- Node.js ≥ 22.5 (uses built-in `node:sqlite`, `node:test`, `--env-file`)
- An NVIDIA NIM API key ([build.nvidia.com](https://build.nvidia.com))
- A ChromaDB: either **Chroma Cloud** (preferred) or the **local server** set up once below

## Setup

```bash
npm install                    # backend dependencies
cp .env.example .env           # then fill in NIM_API_KEY (and Chroma Cloud keys if you have them)
```

`.env` is git-ignored — never commit it. The model IDs in `.env.example` were verified live against our account on 2026-10-12; do not swap them without re-running the checks below.

### Option A — Chroma Cloud (preferred)

Create a project at [cloud.trychroma.com](https://cloud.trychroma.com), then put its credentials in `.env`:

```
CHROMA_API_KEY=...   CHROMA_TENANT=...   CHROMA_DATABASE=...
```

### Option B — Local Chroma server (fallback, used when the above are empty)

One-time setup (needs Python 3 — this is the only place Python appears; all application code is JavaScript):

```bash
python3 -m venv .venv
.venv/bin/pip install chromadb
```

Start it (keep this terminal open, or run it in the background):

```bash
.venv/bin/chroma run --path data/chroma --port 8100
```

## Run

```bash
# terminal 1 — vector database (local option only; skip if using Chroma Cloud)
.venv/bin/chroma run --path data/chroma --port 8100

# terminal 2 — the app server (also serves the frontend at http://localhost:3000)
npm start            # or: npm run dev   (restarts on file changes)
```

Open http://localhost:3000 — `GET /api/health` shows whether sqlite, Chroma, and NIM are all reachable.

## Test

```bash
npm test             # 48 tests: chunking, extraction, learner model, grading, full HTTP API loop (no network needed)
```

Live end-to-end checks (need a running server + Chroma):

1. Upload a text-based PDF → it appears in the sources list with its page count.
2. Ask a question on the Study page → the answer cites real pages from that PDF.
3. Generate a quiz → no answers are visible before you submit; after submitting you see the key, explanations, and your updated mastery.
4. Restart the server (`npm start` again) → your progress is still there.

## Rebuilding the vector index

Required only after changing `NIM_EMBED_MODEL` (vectors from different models are incompatible):

```bash
npm run reindex      # re-embeds from the extracted text already stored in SQLite — no re-uploading
```

## Model verification (do this before a demo if anything was changed)

Catalog visibility ≠ account access — many public model IDs return 404 on our account. Verified working on our account:

```bash
node --env-file=.env -e "
import('./server/services/embeddings.js').then(async ({embedQuery}) => {
  console.log('embed dims:', (await embedQuery('ping')).length);
  const {chatCompletion} = await import('./server/services/nimChat.js');
  console.log('chat:', await chatCompletion([{role:'user',content:'One sentence, please.'}]));
});"
```

Expected: `embed dims: 2048` and one sentence back. Models in use: `nvidia/nemotron-3-embed-1b` (embeddings), `nvidia/nemotron-3.5-lightning-30b-a3b` (tutor), `nvidia/nemotron-3-super-120b-a12b` (quizzes/flashcards).

## Project layout

```
docs/API_CONTRACT.md   shared API contract (source of truth for both agents)
server/                backend — Express, modular services, SQLite, ChromaDB client
frontend/              frontend — HTML/CSS/vanilla JS (owned by the frontend agent)
scripts/reindex.js     vector index rebuild
tests/                 node:test suite (runs offline)
data/                  runtime data: SQLite file, local Chroma storage (git-ignored)
```

## Known limitations (honest list)

- Login is a visual prototype — there is no real authentication.
- Text-based PDFs and .pptx only; scanned/image-only documents are rejected with a clear message (no OCR).
- Flashcards are generated on demand and not yet persisted per student.
- The tutor answers each question independently (no multi-turn conversation memory).

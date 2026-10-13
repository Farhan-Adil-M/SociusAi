# Socius AI — API Contract (v1)

Shared specification between backend (`server/`, owned by OpenCode) and frontend (`frontend/`, owned by Freebuff).
**This file is owned by the backend agent.** Propose changes in chat before editing; both sides must follow it.

Base URL: same origin — Express serves the API under `/api` and the static frontend at `/`.
All request and response bodies are JSON (`Content-Type: application/json`) except file upload.

---

## Conventions

**Success:** the endpoint's JSON object directly, with the documented status code.

**Error envelope** (every non-2xx response):

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Question must be between 3 and 300 characters." } }
```

Stable error codes:

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing/invalid input (details in `message`) |
| `INVALID_URL` | 400 | Webpage URL is not a valid http(s) URL |
| `UNSUPPORTED_FILE` | 400 | Upload is not a supported .pdf or .pptx |
| `EMPTY_CONTENT` | 400 | No readable text extracted (e.g. scanned PDF) |
| `FILE_TOO_LARGE` | 413 | Upload exceeds `MAX_UPLOAD_MB` |
| `SOURCE_NOT_FOUND` | 404 | Referenced source ID does not exist |
| `QUIZ_NOT_FOUND` | 404 | Quiz ID does not exist |
| `QUIZ_ALREADY_ANSWERED` | 409 | Attempt already recorded; response body includes stored `result` |
| `QUIZ_CONTENT_INVALID` | 422 | Model could not produce valid questions after bounded retries |
| `NIM_ERROR` | 502 | AI provider failed or returned unusable output |
| `NIM_TIMEOUT` | 504 | AI provider did not respond in time |
| `CHROMA_UNAVAILABLE` | 503 | Vector store unreachable |
| `SESSION_NOT_FOUND` | 404 | Referenced session ID does not exist |
| `SESSION_EMPTY` | 400 | The session has no material yet (tutor/quiz/flashcards with a `sessionId`) |
| `DECK_NOT_FOUND` | 404 | Referenced deck ID does not exist |
| `ONBOARDING_COMPLETE` | 409 | Onboarding already finished (see v1.4) |
| `INTERNAL` | 500 | Unexpected server error |

**IDs:** readable strings, `src_…`, `quiz_…`, `card_…` (server-generated).

**Citation schema** — used by tutor answers, quiz questions, and flashcards. Built **only** from retrieved ChromaDB metadata; the language model never supplies filenames, pages, or slide numbers.

```json
{
  "sourceId": "src_a1b2c3",
  "type": "pdf",
  "title": "chapter3.pdf",
  "url": null,
  "location": { "page": 12 },
  "excerpt": "…the exact retrieved chunk text (≤300 chars)…",
  "score": 0.81
}
```

- `type`: `"pdf" | "pptx" | "webpage"`
- `title`: filename for uploads; webpage title (or hostname) for webpages
- `url`: set for webpages, `null` otherwise
- `location`: `{ "page": n }` for PDF, `{ "slide": n }` for PPTX, `{ "paragraph": n }` for webpages, or `null` if unknown
- `score`: Chroma similarity (0–1, higher = closer); optional, may be omitted

Frontend rendering guidance: show `title` + `location` as the citation chip; expose `excerpt` and `url` on expand/click.

---

## Endpoints

### GET /api/health

Liveness + dependency status. The frontend calls this once on load to decide what to enable.

**Response 200** (always 200 if the server is running — degraded dependencies are reported inside):

```json
{
  "status": "ok",
  "checks": {
    "sqlite": { "ok": true },
    "chroma": { "ok": true, "message": "" },
    "nim": { "ok": true, "chatModel": "nvidia/nemotron-3.5-lightning-30b-a3b", "embeddingModel": "nvidia/nemotron-3-embed-1b", "message": "" }
  }
}
```

`status` is `"ok"` when every check is ok, else `"degraded"`. NIM check results are cached ~60 s. Secrets are never included.

---

### POST /api/sources/upload

Ingest a PDF or PowerPoint file: extract text with page/slide locations → chunk → embed → store in ChromaDB → register the source. All-or-nothing: if embedding fails, nothing is saved.

**Request:** `multipart/form-data`, one file field `file`. Allowed: `.pdf`, `.pptx`. Max size `MAX_UPLOAD_MB` (default 25 MB).

**Response 201:**

```json
{
  "source": {
    "id": "src_a1b2c3",
    "type": "pdf",
    "title": "chapter3.pdf",
    "pageCount": 14,
    "slideCount": null,
    "chunkCount": 42,
    "createdAt": "2026-10-12T17:00:00.000Z"
  }
}
```

**Errors:** 400 `VALIDATION_ERROR` (no file field), 400 `UNSUPPORTED_FILE`, 400 `EMPTY_CONTENT` (message explains: likely scanned/image-only), 413 `FILE_TOO_LARGE`, 502 `NIM_ERROR` (embedding call failed), 503 `CHROMA_UNAVAILABLE`.

---

### POST /api/sources/webpage

Ingest pasted webpage text with its URL.

**Request:**

```json
{ "url": "https://example.org/lesson1", "title": "Lesson 1: Cells", "text": "The student pastes the page text here… (min 50 chars)" }
```

`title` optional (defaults to URL hostname). `text` required, 50–200 000 chars.

**Response 201:** same `source` shape as upload, `"type": "webpage"`, `pageCount`/`slideCount` null.

**Errors:** 400 `INVALID_URL`, 400 `VALIDATION_ERROR` (text too short/long), 502 `NIM_ERROR`, 503 `CHROMA_UNAVAILABLE`.

---

### GET /api/sources

List ingested sources, newest first. Metadata only — never passages.

**Response 200:**

```json
{
  "sources": [
    { "id": "src_a1b2c3", "type": "pdf", "title": "chapter3.pdf", "sizeLabel": "14 pages", "chunkCount": 42, "createdAt": "2026-10-12T17:00:00.000Z" }
  ]
}
```

`sizeLabel` is pre-formatted: `"14 pages"`, `"8 slides"`, or `"webpage"`.

---

### POST /api/tutor/ask

Source-grounded question answering.

**Request:**

```json
{ "question": "What is the difference between mitosis and meiosis?", "sourceIds": ["src_a1b2c3"] }
```

`question`: 3–300 chars. `sourceIds` optional filter (all sources if omitted).

**Response 200:**

```json
{
  "answer": "Mitosis produces two identical cells…",
  "citations": [ { "sourceId": "src_a1b2c3", "type": "pdf", "title": "chapter3.pdf", "url": null, "location": { "page": 12 }, "excerpt": "…", "score": 0.81 } ],
  "model": "nvidia/nemotron-3.5-lightning-30b-a3b",
  "needsContent": false
}
```

- Citations come from retrieval (max 6, deduplicated by chunk).
- If retrieved passages are insufficient, the tutor abstains:
  `200` with `"answer": "I couldn't find enough in your study materials to answer that. Try adding material on this topic, or ask about a topic covered in your sources.", "citations": [], "needsContent": true`.
- Conversation history is not required for v1; each question is answered independently.

**Errors:** 400 `VALIDATION_ERROR`, 404 `SOURCE_NOT_FOUND`, 502 `NIM_ERROR`, 503 `CHROMA_UNAVAILABLE`, 504 `NIM_TIMEOUT`.

---

### POST /api/flashcards/generate

Generate flashcards (front/back + topic + citations) from retrieved passages for a topic.

**Request:**

```json
{ "topic": "Photosynthesis", "count": 8, "sourceIds": ["src_a1b2c3"] }
```

`count`: 3–12, default 8. `sourceIds` optional.

**Response 201:**

```json
{
  "topic": "Photosynthesis",
  "cards": [
    { "id": "card_1", "front": "What role does chlorophyll play in photosynthesis?", "back": "Chlorophyll absorbs light energy…", "citations": [ /* Citation schema */ ] }
  ],
  "model": "nvidia/nemotron-3-super-120b-a12b"
}
```

Cards are validated server-side (front/back non-empty, within length bounds); invalid cards are discarded. The deck itself is **saved** (see v1.1 "Persistent flashcard decks"): every card's study status (`status` + `reviewedAt`) is persisted server-side and survives restarts, and deck review updates are atomic (both the card mark and the deck's `lastReviewedAt` stamp are one SQLite transaction that rolls back on failure).

**Errors:** 400 `VALIDATION_ERROR`, 404 `SOURCE_NOT_FOUND`, 422 `QUIZ_CONTENT_INVALID`, 502 `NIM_ERROR`, 503 `CHROMA_UNAVAILABLE`, 504 `NIM_TIMEOUT`.

---

### POST /api/quiz/generate

Generate a source-grounded multiple-choice quiz. **The answer key never leaves the backend in this response.**

**Request:**

```json
{ "topic": "Photosynthesis", "questionCount": 5, "difficulty": "medium", "sourceIds": ["src_a1b2c3"] }
```

- `topic`: required, 2–80 chars.
- `questionCount`: 3–10, default 5.
- `difficulty`: optional `"easy" | "medium" | "hard"`; **if omitted, the learner model chooses** (see `GET /api/learner/progress`).
- `sourceIds` optional filter.

**Response 201:**

```json
{
  "quiz": {
    "id": "quiz_x9y8z7",
    "topic": "Photosynthesis",
    "difficulty": "medium",
    "questions": [
      {
        "index": 0,
        "text": "Which pigment absorbs light energy for photosynthesis?",
        "choices": [ { "id": "a", "text": "Chlorophyll" }, { "id": "b", "text": "Starch" }, { "id": "c", "text": "Oxygen" }, { "id": "d", "text": "Carbon dioxide" } ],
        "citations": [ /* Citation schema */ ]
      }
    ]
  }
}
```

`choices` is always 4 items with ids `a`–`d`. There is **no** `correctChoiceId` or `explanation` field in this payload — by contract and by server-side filtering. The key is stored in SQLite, keyed by `(quizId, index)`.

**Errors:** 400 `VALIDATION_ERROR`, 404 `SOURCE_NOT_FOUND`, 422 `QUIZ_CONTENT_INVALID`, 502 `NIM_ERROR`, 503 `CHROMA_UNAVAILABLE`, 504 `NIM_TIMEOUT`.

---

### POST /api/quiz/:quizId/answer

Submit the full attempt. Deterministic grading (string comparison against the stored key — no AI involved). Reveals the key, updates the learner model once.

**Request:**

```json
{ "answers": [ { "index": 0, "choiceId": "b" }, { "index": 1, "choiceId": null } ] }
```

- One entry per question, `index` 0-based, `choiceId` one of `"a".."d"` or `null` (unanswered → incorrect).
- Out-of-range or duplicate indices → 400.

**Response 200:**

```json
{
  "result": {
    "score": { "correct": 3, "total": 5, "percent": 60 },
    "questions": [
      { "index": 0, "yourChoiceId": "b", "correctChoiceId": "c", "correct": false, "explanation": "Chlorophyll absorbs light energy…", "citations": [ /* Citation schema */ ] }
    ],
    "masteryUpdate": { "topic": "Photosynthesis", "before": 0.5, "after": 0.6, "delta": 0.1 },
    "recommendedDifficulty": "medium"
  }
}
```

**Idempotency:** a second submission to the same quiz returns **409** `QUIZ_ALREADY_ANSWERED` with the stored result under `"result"` — display it, do not resubmit.

**Errors:** 400 `VALIDATION_ERROR`, 404 `QUIZ_NOT_FOUND`, 409 `QUIZ_ALREADY_ANSWERED`, 500 `INTERNAL`.

---

### GET /api/learner/progress

Read-only rollup from SQLite. No AI or vector calls.

**Response 200:**

```json
{
  "topics": [
    { "topic": "Photosynthesis", "masteryPercent": 60, "difficulty": "medium", "correct": 3, "total": 5, "needsRevision": false, "lastPracticedAt": "2026-10-12T17:30:00.000Z" }
  ],
  "overall": { "quizzesTaken": 2, "questionsAnswered": 10, "accuracyPercent": 70 },
  "suggestedNext": { "topic": "Recursion", "difficulty": "easy" },
  "recentActivity": [
    { "type": "quiz", "topic": "Photosynthesis", "detail": "4/5 correct", "at": "2026-10-12T17:30:00.000Z" },
    { "type": "upload", "topic": null, "detail": "chapter3.pdf (14 pages)", "at": "2026-10-12T17:00:00.000Z" },
    { "type": "question", "topic": null, "detail": "Asked about mitosis", "at": "2026-10-12T17:10:00.000Z" }
  ]
}
```

- `masteryPercent`: 0–100 (see learner rules below).
- `needsRevision`: `total >= 3 AND mastery < 0.6`.
- `difficulty`: the difficulty that `POST /api/quiz/generate` will use when `difficulty` is omitted for this topic.
- `suggestedNext`: worst-mastery topic that needs revision, else least-recently practiced; `null` if no topic yet.
- `recentActivity`: newest first, max 10. Empty account: all empty arrays / zeros / `null` — the frontend shows its empty state.

**Errors:** 500 `INTERNAL`.

---

## Learner model (deterministic, server-side)

Per topic (topic = trimmed key from the quiz request):

- `mastery = correct / total` across all graded attempts.
- Next difficulty: `mastery < 0.5 → "easy"`, `0.5–0.79 → "medium"`, `≥ 0.8 → "hard"`.
- `needsRevision = total >= 3 AND mastery < 0.6`.

Pure functions in `server/services/learner.js`, covered by unit tests. Persisted in SQLite; survives restart.

---

## Mock mode (frontend-only)

`frontend/js/api.js` is the only file that talks to the backend. With `?mock=1` (or `localStorage.socius_mock === '1'`) it serves fixtures from `frontend/js/mocks/` matching **this** contract exactly — including error payloads. Mocks must be labeled as demo data in the UI (e.g. a small "Demo data" badge), never presented as real AI output. Real mode (default once the backend runs) calls the same functions against `/api/...`.

---

## Verified AI configuration (as of 2026-10-12, account-scoped)

| Role | Model | Evidence |
|---|---|---|
| Embeddings (documents **and** queries) | `nvidia/nemotron-3-embed-1b` (2048 dims) | live `/v1/embeddings` call OK |
| Tutoring (fast generation) | `nvidia/nemotron-3.5-lightning-30b-a3b` | live `/v1/chat/completions` OK |
| Assessment + flashcards (stronger generation) | `nvidia/nemotron-3-super-120b-a12b` | live `/v1/chat/completions` OK |

Reserve (verified working): `z-ai/glm-5.3-flash`, `z-ai/glm-5.3`, `openai/gpt-oss-20b`.
Catalog visibility ≠ account access: many listed models returned HTTP 404 for this account. Model IDs live in `.env` (`NIM_EMBED_MODEL`, `NIM_CHAT_MODEL`, `NIM_ASSESS_MODEL`) — swap without code changes.

**Rebuilding the vector index** (required if the embedding model ever changes): stop the server, delete the Chroma collection and the chunks table, then run `npm run reindex` — it re-embeds from the extracted text already stored in SQLite (no re-uploading). Stored vectors embedding model is recorded; startup refuses a mismatched model.

---

## Non-goals for v1 (explicit)

Real authentication (login page is a labeled visual prototype), multi-user profiles, browser-extension capture, lecture-video processing, OCR for scanned PDFs, spaced-repetition scheduling for flashcards, cloud deployment.

---

# v1.1 — Study sessions, AI organisation, persistent flashcard decks (2026-10-13)

All changes are **additive**: existing request/response shapes are unchanged, all new fields are optional.
New server-minted IDs: `ses_…`, `deck_…`. The server owns all database writes; client-supplied IDs in bodies are never authoritative.

## Categories (fixed enum, used by sessions)

`subject` · `research` · `self-study` · `exam-prep` · `general`

## Unsorted

A source or deck whose `sessionId` is `null` lives in **Unsorted**. Lists report `unsortedSourceCount`.

## Study sessions

### `GET /api/sessions?category=&q=&sort=recent|alpha|active&includeArchived=`

Query: `sort` default `recent` (by `updatedAt`); `alpha` = title A–Z (case-insensitive); `active` = `lastActivityAt` desc.
→ `200 { sessions: [ { id, title, category, description, tags: string[], status: "active"|"archived", sourceCount, deckCount, lastActivityAt, createdAt, updatedAt } ], unsortedSourceCount }`

### `POST /api/sessions`

`{ title, category?, description?, tags? }` → `201 { session }`
Validation: title 2–80 chars; `category` in the enum (default `subject`); ≤8 tags, each 1–24 chars.

### `GET /api/sessions/:id`

→ `200 { session, sources: [source + { sessionId, tags }], decks: [{ id, topic, cardCount, createdAt }] }`
`404 { error: { code: "SESSION_NOT_FOUND", … } }`

### `PATCH /api/sessions/:id`

`{ title?, category?, description?, tags?, status? }` (any subset; at least one) → `200 { session }`
Archiving (`status: "archived"`) keeps sources assigned and working — it only hides the session from default lists (`?includeArchived=1` to see it). Nothing is deleted.

## Source organisation

Additions to the source object everywhere: `{ sessionId, tags, orgSource: "manual"|"ai" }`.

### `PATCH /api/sources/:id`

`{ sessionId?: "ses_…"|null, title?, tags? }` (any subset) → `200 { source }`
Manual move/edit; sets `orgSource: "manual"` and marks the source as manually managed (`manualOverride`) — later AI suggestions never replace these choices automatically. `sessionId: null` = move to Unsorted.
Errors: `404 SOURCE_NOT_FOUND`, `404 SESSION_NOT_FOUND`.

### `POST /api/sources/:id/suggest-organization`

`{ description? }` → `200 { sourceId, applicable, suggestion }` where
`suggestion = { matchSessionId, newSession: { category, title, subject, tags } | null, confidence: "high"|"low", reason }`
Exactly one of `matchSessionId` / `newSession` is non-null; `matchSessionId` always references a session the server listed to the model. The suggestion is stored server-side (reviewable). `applicable: false` means the user already made manual choices — show, don't apply.
Errors: `404 SOURCE_NOT_FOUND`, `502 NIM_ERROR` (never blocks anything — the upload already happened in a earlier call).

### `POST /api/sources/:id/accept-suggestion`

No body → `200 { source, session }` — applies the server-stored suggestion: existing session → assigns; new session → creates (if a case-insensitive title match exists, reuses it) then assigns. Accepting is an explicit user action and also marks the source as manually managed.
Errors: `400 VALIDATION_ERROR` (no suggestion stored), `404 SOURCE_NOT_FOUND`.

## Session-scoped AI features

`POST /api/tutor/ask`, `POST /api/quiz/generate`, `POST /api/flashcards/generate` gain an **optional `sessionId`**.

- `sessionId` only → backend resolves the session to exactly its sources (server-enforced scope, not a UI highlight).
- `sourceIds` only → existing behaviour, unchanged.
- both → every `sourceId` must belong to the session, else `400 VALIDATION_ERROR`.
- neither → all material (today's behaviour).

Empty session: `400 { error: { code: "SESSION_EMPTY", message: "No material in «Physics» yet…" } }`. Quiz answer-key protection unchanged.

## Persistent flashcard decks

### `GET /api/decks?sessionId=&category=&q=&sort=recent|alpha|active`

→ `200 { decks: [ { id, topic, sessionId, sessionTitle, category, cardCount, knownCount, reviewCount, createdAt, lastReviewedAt } ], unsortedDeckCount }`
`category` filters via the parent session (decks under Unsorted have `category: null`). Unsorted decks are excluded from `category` filters unless `sessionId=unsorted` is used. `unsortedDeckCount` (like the sessions list's `unsortedSourceCount`) is the number of decks whose `sessionId` is `null`.

### `GET /api/decks/:deckId`

→ `200 { deck: { …as above + sourceIds }, cards: [ { idx, front, back, citations, status: "new"|"known"|"review", reviewedAt } ] }`
`404 DECK_NOT_FOUND`

### `POST /api/flashcards/generate`

As before, plus: optional `sessionId`; response gains `deckId`, `sessionId`. The deck is **saved** (cards + citations + generation scope `sourceIds` stored). Unsorted when no session given.

### `PATCH /api/decks/:deckId/cards/:idx`

`{ status: "new"|"known"|"review" }` → `200 { deckId, idx, status, lastReviewedAt }` (deck-level `lastReviewedAt` stamped). `404 DECK_NOT_FOUND` / `400 VALIDATION_ERROR`.

### `DELETE /api/decks/:deckId`

`204`. Deleting a deck removes only derived content — sources and study sessions are untouched; the frontend must double-confirm.

---

# v1.2 — Retrieval quality & evidence discipline (2026-10-13)

Additive, backend-only; no existing request/response shapes changed.

**Evidence floor for the tutor.** Retrieved chunks scoring below `RAG_MIN_SIMILARITY` (default 0.2, env-tunable) are removed before generation. When nothing survives, the tutor abstains exactly as before (`needsContent: true`, empty citations) instead of answering from unrelated passages.

**Generation breadth.** Quiz and flashcard generation retrieve without the floor (a topic query on a small corpus scores lower than a full question), but the response gains `"weakEvidence": true` whenever every retrieved passage scored below the floor — the frontend should surface a "material is thin" notice rather than pretending the deck is strongly grounded.

**Retrieved-passage dedup.** Repeated chunk text (chunk-overlap neighbours) is collapsed before prompts; cross-source duplicates of the same text are kept (they may legitimately appear in several sources).

**Embedding-model guard.** `npm run reindex` (and dataset ingestion, when added) record the embedding model + dimension in `app_meta` (`embed_model`, `embed_dimension`). `GET /api/health` reports the index as degraded with a reindex instruction when the configured `NIM_EMBED_MODEL` no longer matches the recorded one.

Retrieval quality is measured by `tests/eval-set.json` + `scripts/eval-retrieval.mjs` (offline and live runs) — changing any retrieval constant must be accompanied by re-running those.

---

# v1.3 — Serverless vector fallback & demo seeding (2026-10-13)

Additive, backend-only; no request/response shapes changed except one additive health field.

**Two interchangeable vector backends.** The app selects its vector store through `server/store/vectorProvider.js`:

- `VECTOR_STORE=chroma` (default on the laptop) — ChromaDB exactly as before (local server or Chroma Cloud via `CHROMA_*`).
- `VECTOR_STORE=sqlite` (also auto-selected on Vercel when no Chroma Cloud key is set) — `server/store/sqlite-vector.js` stores the same chunks (text + embedding + trusted metadata) in the app database and answers queries with cosine similarity computed in JavaScript. Scoring is identical by construction: `distance = 1 − cosine`, so dedup, the evidence floor, `hitScore`, scoping, and every downstream rule behave unchanged. Interface: `addChunks`, `queryChunks`, `pingChroma`, `countChunks`, `resetCollection`, `deleteChunks`, `deleteBySource`, plus `backend: 'chroma' | 'sqlite'`.

**Cold-start demo seeding (fallback only).** When the fallback store is empty, the serverless entry seeds `data/demo-seed.json` (three committed biology pages) — chunked and embedded live via NIM at boot, recorded as a normal source (`origin: 'seed'`, id `src_seed_demo`) so it appears in the library, is organizable, and is citable. Idempotent (no-op once the store holds anything); a NIM failure during seeding is logged and the app still boots.

**Schema v4/v5 (both additive).** v4: `sources.license`, `sources.origin`, tables `dataset_items`, `dataset_runs` (dataset-ingestion pilot, CLI-only — no API yet). v5: `vector_chunks`.

**`GET /api/health`**: `checks.chroma` gains `backend` (`"chroma"` | `"sqlite"`) so the UI can show which store is live. `checks.chroma.ok` is `true` whenever the active backend answers — a healthy fallback is a healthy vector store.

---

# v1.4 — Learner profile, onboarding & personalisation (2026-10-13)

Additive. New error code: `ONBOARDING_COMPLETE` (409). No existing request/response shape changes except two additive fields on `POST /api/tutor/ask`. Singleton profile — the app has no authentication, so there is exactly one learner profile per installation (same scope as `learner_topics` today).

## Data model (schema v6, server-internal)

| Table | Purpose |
|---|---|
| `learner_profile` (singleton row `id='default'`) | `state`: `new \| in_progress \| completed \| skipped`; `transcript_json` (onboarding working memory, **cleared whenever state != `in_progress`**); `fields_json` = `{ interests:[{label,source}], goals:[{label,deadline?,source}], purpose, preferences:{explanationStyle:{value,source}} }` |
| `learner_subjects` | Self-reported familiarity per subject: `{subject, familiarity: "none"\|"basic"\|"familiar"\|"confident", confidence: 1–5 \| null, source}` |
| `learning_events` | Append-only observed evidence: `kind`, nullable `topic`, `detail_json`, `weight`, `at` |

- `source` is `"stated"` (the student said it — onboarding extraction or manual edit) or `"inferred"` (the model guessed). **Clients cannot write `inferred`.**
- Event kinds and weights: `quiz_result` / `quiz_item_correct` / `quiz_item_incorrect` = **3**; `card_known` / `card_review` = **1** (flashcard review is deliberately weaker evidence than solving an unfamiliar assessment question); `explain_again` / `repeated_question` / `approach_change` / `recovery_success` = **1**. Events are recorded **server-side only** and are not exposed through an API in v1.
- Events never modify `learner_topics` mastery; mastery math is unchanged.

## Enums (fixed)

- `purpose`: `exam | project | research | deep-understanding | general` (nullable)
- `explanationStyle`: `step-by-step | examples-first | visual | concise | guided-questions`
- tutor `approach`: `step-by-step | examples-first | concise | visual | guided-questions | simpler | different`

## `GET /api/profile`

→ `200 { profile: { state, purpose, interests: [{label, source}], goals: [{label, deadline, source}], preferences: { explanationStyle: {value, source} | undefined }, subjects: [{subject, familiarity, confidence, source}], updatedAt } }`

No profile row yet → `state: "new"` with empty arrays (never a 404).

## `POST /api/onboarding/message`

Conversational onboarding turn. One short question per reply; skipping and correcting are always allowed.

Request: `{ "message": string | null }` (`null` starts the conversation; `message` 1–800 chars)
→ `200 { reply, state, questionsAsked, done }` — `state` after this turn; `done: true` when the interview finishes (server also completes at 6 turns).

Errors: `400 VALIDATION_ERROR`, `409 ONBOARDING_COMPLETE`, `502 NIM_ERROR`, `504 NIM_TIMEOUT`.

Server behaviour: the opening reply states that answers are saved in the app's database to personalise learning and can be viewed/edited/deleted later; the model must not ask for sensitive personal data (name, age, contact, health, politics, religion) and off-list answers are simply not stored (whitelist-only extraction); model output is validated with bounded retries like quiz generation.

## `POST /api/onboarding/skip`

No body → `200 { profile }` with `state: "skipped"`, transcript cleared. `409 ONBOARDING_COMPLETE` if already completed.

## `PATCH /api/profile`

Body: any **subset** of `{ interests?, goals?, purpose?, preferences?, subjects? }` — each provided top-level key **replaces that value wholesale** (omitted keys are untouched).
Shapes: `interests: [{label}]` (≤12, 1–40 chars) · `goals: [{label, deadline?}]` (≤6, label ≤120, deadline `YYYY-MM-DD`) · `purpose` enum or `null` · `preferences: {explanationStyle}` · `subjects: [{subject, familiarity, confidence?}]` (≤12, subject ≤60 chars, confidence 1–5).
→ `200 { profile }`. Every written item gets `source: "stated"`; a client-sent `source` field is ignored. `400 VALIDATION_ERROR` on violations. PATCH on a missing row creates it with `state: "skipped"` (direct editing counts as opted-out of the intro — no onboarding nudge).

## `DELETE /api/profile`

No body → `204`. Deletes profile, subjects, and learning events (state returns to `new`). **Never touches** quizzes, decks, sources, sessions, or `learner_topics` mastery.

## `POST /api/tutor/ask` — additive fields

Request gains optional `approach` (enum above, applies to **that answer only**; it does not rewrite the saved preference).
Response gains optional `approachUsed` (the teaching approach actually **applied**; present only when an approach was applied or requested by the client — omitted on the abstain path, where no approach could be applied. `"different"` resolves server-side to a concrete approach so the student sees what was actually used).

**Guarantees (unchanged):** retrieval, evidence floor, abstain (`needsContent`), citations (from retrieved metadata only), source/session scoping, answer-key protection, and the facts-from-passages-only rule. Personalisation may affect explanation style, examples, structure, and teaching strategy only — never factual content. When no profile exists, behaviour is byte-identical to v1.3. The learner context block sent to the model is compact (server-enforced budget) and never includes the onboarding transcript or unrelated profile details.

## Frontend notes (Freebuff)

- Study page: when `GET /api/profile` returns `state:"new"`, show a dismissible offer ("quick intro so the tutor can teach your way") → onboarding chat (one question at a time, Skip always visible). Dismissing without Skip leaves `state:"new"` (re-offer later); Skip uses `POST /api/onboarding/skip`.
- New **Profile** page: view/edit all fields with `stated`/`inferred` badges, "Restart intro" (= `DELETE /api/profile`, which returns state to `new`, then start onboarding again), delete profile with confirm + privacy explainer text.
- Tutor answers: an **"Explain differently"** button sends `approach: "different"`; optional style chips send the other enum values.
- `frontend/js/mocks/fixtures.js` must implement every new endpoint to match this section exactly.

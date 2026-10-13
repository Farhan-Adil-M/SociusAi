# Socius AI — OpenCode Engineering TODO

**Purpose:** Stabilise the current working tree, fix the verified defects from the Freebuff audit, and leave the project reproducible and ready for the hackathon demo.

**Source:** Full technical audit dated 2026-10-12. The audit reported 64 offline tests passing, but it also observed concurrent edits, an uncommitted working tree, a stale running server, and a live AI-organisation failure. Re-verify all findings against the current files before acting.

## Rules for OpenCode

- Read `AGENTS.md`, `README.md`, and `docs/API_CONTRACT.md` first.
- Work on one item at a time. Do not refactor or rewrite the project.
- Inspect `git status`, diffs, and untracked files before editing. Preserve all existing work.
- Make sure Freebuff is not editing the same files at the same time. Do not change frontend files unless a task below explicitly requires it.
- Never print, copy, commit, or expose `.env` values, NIM keys, or other secrets.
- Do not delete `data/`, reset the real Chroma collection, run `git reset --hard`, run `git clean -fd`, force-push, or perform destructive database operations.
- Do not use live NIM calls for ordinary tests. A live test is allowed only for the single organisation verification task below, after checking that the user has approved the small API credit cost.
- Do not claim a test passed unless you ran it and recorded the result.
- After each change, run relevant safe tests. At the end, run the full offline suite and inspect the final diff.
- Do not push to GitHub until the changes have been reviewed and the user has explicitly approved the push.

## Phase 0 — Stabilise the workspace first

- [x] **0.1 Stop concurrent edits.** Confirm no other agent is currently changing the same repository. Ask Freebuff to pause code edits until the backend fixes are complete.
- [x] **0.2 Inspect Git state.** Run `git status --short`, inspect `git diff --stat`, inspect the important diffs, list untracked files, and confirm the current branch and upstream. Do not overwrite or discard any changes.
- [x] **0.3 Protect the current work.** Propose a safe local checkpoint/backup strategy for both tracked and untracked changes. Do not stage or commit `.env`, `data/`, credentials, or generated runtime data. If a checkpoint commit would include unexpected or unclear files, show the file list and ask first.
- [x] **0.4 Re-run the offline tests on the current tree.** Use the existing test command from `package.json` (audit says `npm test`). Record actual pass/fail counts. Do not run live E2E or reindex at this step.
- [x] **0.5 Restart only after code changes are complete.** Identify whether the currently running server is stale. Do not kill broad process patterns; stop only the known Socius AI process using its exact PID or documented command.

**Definition of done:** current changes are preserved, the workspace state is understood, concurrent editing is stopped, and the test baseline is recorded.

## Phase 1 — Fix verified high-priority defects

- [x] **1.1 Fix the broken reindex script import (P1-1).** Audit evidence says `scripts/reindex.js` calls `assertConfig()` but imports only `config`. Verify the current file, add the missing import if still absent, and add a safe automated check. Do not run reindex against the real collection. If runtime testing is needed, use a scratch/test collection only and verify the script's help/dry-run path without deleting real vectors.
  - **Acceptance:** no `ReferenceError`; tests pass; real Chroma collection remains untouched.

- [x] **1.2 Repair live AI organisation failure (P1-2).** DONE: organiser max-tokens raised to 1200 headroom (reasoning-model empty-output cause), bounded retries verified by stub tests (empty ×2, unusable ×2), source stays ingested + Unsorted on failure. LIVE re-verification call still pending user approval.

- [x] **1.3 Resolve the exposure policy (P1-4).** Authentication and rate limiting were intentionally out of scope, but AI endpoints and destructive deck/source operations are unsafe if exposed beyond localhost. Verify the actual bind address and README instructions. For the hackathon, keep the server local-only and document not to expose/port-forward it. If it must be exposed to a LAN or public internet, stop and propose a minimal authentication/rate-limit solution for approval before implementing it.
  - **Acceptance:** the actual listen configuration and the documented exposure policy agree. Do not claim the app has authentication.

- [x] **1.4 Add a safe commit/test gate (related to P1-3/P2-1).** After the working tree is stable, recommend or add a lightweight pre-commit check using existing tools only (for example, the existing offline test command and JavaScript syntax checks). Do not add dependencies just for hooks. If setting up Git hooks risks overwriting existing hooks, explain first.
  - **Acceptance:** the check can be run reliably and does not call NIM or modify user data.

## Phase 2 — Fix high-value reliability and correctness issues

- [x] **2.1 Persist embedding-model metadata on first ingestion (P2-2).** Audit reports that `app_meta.embed_model` is only written by the reindex script, making the health-check model-drift guard ineffective on a fresh install. Verify current code. On initial ingestion, record the configured embedding model and dimension safely, and reject or clearly stop incompatible mixed-model indexing. Preserve existing data and don't trigger a full reindex automatically.
  - **Acceptance:** tests cover first ingest, same-model ingest, and mismatch behaviour.

- [x] **2.2 Stop spending an embedding call on frequent health checks (P2-3).** Inspect `server/routes/health.js`. Replace repeated live embedding probes with an appropriate cheap readiness check or a longer cache, preserving clear reporting of what is and is not verified. Health should not claim the model is fully available unless that has actually been established.
  - **Acceptance:** repeated health checks do not trigger a fresh paid embedding request every 60 seconds; health response semantics are documented and tested.

- [x] **2.3 Harden prompts against retrieved-content injection (P2-4).** Inspect prompt construction in `tutorService.js`, `quizService.js`, `flashcardService.js`, and `organizer.js`. Delimit retrieved documents and clearly instruct the model that their contents are untrusted data, not system instructions. Do not rely on prompt wording alone for citation correctness; keep server-side citation validation and answer-key protection.
  - **Acceptance:** tests include adversarial text inside a retrieved chunk and verify citations/source IDs are still constructed from trusted stored metadata; assessment answers remain protected.

- [x] **2.4 Align quiz retrieval evidence rules (P2-5).** Audit reports that quizzes use `minScore: 0` and create an unused `weakEvidence` flag absent from the API contract. Inspect the current tree and decide on one consistent approach. Prefer applying the configured evidence threshold used by tutor/flashcards and returning a clear insufficient-material response. If retaining `weakEvidence`, update the contract and UI only with approval.
  - **Acceptance:** quiz generation refuses or clearly handles weak evidence; response matches `docs/API_CONTRACT.md`; add tests for weak and adequate evidence.

- [x] **2.5 Prevent vector orphans on source persistence failures (P2-6).** Inspect source ingestion transaction order and Chroma capabilities. Add a safe rollback/compensation path so a SQLite failure after vector insertion does not leave searchable orphan chunks. If a source-deletion endpoint is included, propose it separately and implement only with approval because it changes public API behaviour and is destructive.
  - **Acceptance:** fault-injection test proves partial ingestion leaves neither a misleading source record nor orphan vectors.

- [x] **2.6 Make quiz replay return the original result shape (P2-7).** Audit reports that replaying a submitted quiz returns a different `masteryUpdate` shape than the original contract. Inspect current code. Persist/replay the original result or normalise it without applying mastery twice.
  - **Acceptance:** first submission and replay return the same documented response shape; replay does not double-count mastery; the existing 409 guard remains.

## Phase 3 — Remove confusing drift and small bugs

- [x] **3.1 Synchronise README and API contract.** Audit says docs still claim 48 tests and non-persistent flashcards while the implementation now has 64 tests and persisted decks. Verify the actual current test count/behaviour and update the main documentation, removing contradictory v1/v1.1 statements rather than appending another conflicting appendix.
- [x] **3.2 Remove duplicate `CREATE TABLE IF NOT EXISTS decks` DDL only if still present.** Confirm it is genuinely redundant and preserve schema/migration semantics.
- [x] **3.3 Check `PATCH /api/decks/:deckId/cards/:idx` row counts.** If the code checks only `card_count`, also inspect affected-row count and return the correct not-found/error result when no card row was updated.
- [ ] **3.4 Add dashboard icons for `session` and `organize` activity types.** Only if the UI owner is available and this small frontend change has been coordinated; do not overlap Freebuff's edits.
- [ ] **3.5 Consolidate duplicated upload validation.** Audit reports similar upload/webpage validation logic in `study.js` and `material-import.js`. Verify duplication still exists. Coordinate with Freebuff before changing frontend code; reuse the shared component rather than changing limits independently in two places.
- [ ] **3.6 Add an honest duplicate-upload hint or detection.** This is optional. Do not introduce fuzzy deduplication that could reject two legitimate versions of the same notes. Prefer a clear warning only if a reliable existing fingerprint can be reused.
- [x] **3.7 Consider replacing `Math.random()` IDs with Node's built-in cryptographic UUID/random ID generation.** Only do so if IDs are not externally relied on and existing tests can verify format compatibility. No new dependency.
- [ ] **3.8 Improve the empty-session onboarding path.** Coordinate with Freebuff. The first session should clearly guide users to add material directly into that session. Treat this as UI polish after functional defects are fixed.

## Phase 4 — Final verification and delivery

- [x] **4.1 Run the full offline suite** using the project's existing command. Audit baseline: 64 tests reportedly passed. Record the actual current result; do not assume it remains 64 after new tests.
- [x] **4.2 Run syntax checks** for changed JavaScript files and all existing safe static checks.
- [x] **4.3 Restart the backend from the documented command** so the running process is definitely using the current files. Avoid broad `pkill` patterns.
- [x] **4.4 Verify local health and core read-only routes** (`/api/health`, sources, sessions, decks). Do not print secrets.
- [x] **4.5 Perform one end-to-end smoke test only after offline tests pass.** It can make live NIM calls and consume credits. Obtain approval first. Do not run `npm run reindex` on the actual Chroma collection.
- [ ] **4.6 Manually click through the UI:** landing → login prototype → dashboard → create/open session → upload a PDF → request organisation suggestion → accept/move source → ask a cited question → generate a quiz → submit answer → review a saved flashcard deck → verify progress. Note which steps require a live service.
- [x] **4.7 Review Git diff and sensitive files.** Confirm `.env` and `data/` remain ignored and untracked, inspect all staged files, and ensure only intended changes are included.
- [x] **4.8 Present a commit/push summary for approval.** Do not push until the user approves. After approval, commit in logical chunks and push normally; never force-push.

## Explicitly preserve these working design decisions

- Server-side quiz answer-key protection.
- Idempotent quiz submission and 409 replay guard.
- Citation construction from real stored metadata.
- `resolveScope` as the single enforcement point for session source scope.
- Deterministic learner-model functions.
- `createApp({ db, ai, vector })` injection seam and offline tests.
- Isolated, explicitly labelled mock mode (`?mock=1`).
- Additive database migration strategy and backup safety.
- Frontend design tokens and the rule that only the landing page uses pixel art.

## How to execute this list

Start by reporting the current repository status and a short plan for Phase 0. Then complete Phase 0, report the test result, and proceed through the phases in order. If a task requires a destructive action, new dependency, API-contract change, paid live API call, or push to GitHub, stop and request explicit approval before doing it.

When finished, report:
- Checked-off tasks.
- Files changed.
- Tests actually run and results.
- Live calls made and why.
- Any tasks not completed and why.
- Remaining risks and manual checks.

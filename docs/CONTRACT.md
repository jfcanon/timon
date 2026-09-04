# Timon Worker — Baseline Contract (NID-468)

**Pinned commit:** `e2cc553d20cc0aed10e9cc7067d6d1e1a43632b0`
**Live worker:** `https://timon-worker.ygdcbtmc4u.workers.dev`

---

## 1. Route Table

All routes defined in `src/index.js`:

| Method | Path | Auth | Request Body | Response JSON Shape |
|--------|------|------|--------------|---------------------|
| GET | `/healthz` | None | — | `{ "status": "ok", "service": "timon-worker" }` |
| POST | `/api/auth/login` | **None** (this is how a browser gets one) | `{ "password": "string" }` | `{ "ok": true }` + `Set-Cookie: timon_session=…; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`. `401 {"error":"invalid_credentials"}` on a wrong password; **`500 {"error":"auth_unavailable"}` when the `APP_PASSWORD` secret is not set on the Worker** |
| POST | `/api/auth/logout` | None | — | `{ "ok": true }` + a cleared cookie |
| POST | `/api/voice` | Bearer **or** cookie ¹ | `multipart/form-data` with `audio` file **OR** raw `audio/wav` body | `{ "task_id": "uuid", "intent": { "title": "string", "date": "ISO8601\|null", "priority": "high\|medium\|low", "category": "string\|null", "tags": "string[]" }, "transcription": "string" }` |
| GET | `/api/tasks` | Bearer **or** cookie ¹ | — (query params: `status`, `category`, `parent_id`) | `{ "tasks": [{ ...task, "parent_title": "string\|null", "subtask_count": "number", "blocked_by_count": "number", "blocked_by_open_count": "number", "blocked_by": [{ "id": "uuid", "title": "string", "status": "string\|null" }] }] }` ² |
| POST | `/api/tasks` | Bearer **or** cookie ¹ | `{ "text": "string (required)", "device_id": "string (optional)", "ts": "ISO8601 (optional)", "priority": "high\|medium\|low (optional)", "category": "string (optional)", "parent_id": "uuid (optional)" }` | `{ "task_id": "uuid", "task": { ... }, "status": "created" }` (201). `400 {"error":"parent_not_found"}` if `parent_id` is set and no such task exists. |
| GET | `/api/tasks/:taskId` | Bearer **or** cookie ¹ | — | `{ "task": { ... }, "parent": "task\|null", "siblings": "task[]", "subtasks": "task[]", "blockers": "task[]", "blocks": "task[]" }` |
| PATCH | `/api/tasks/:taskId` | Bearer **or** cookie ¹ | `{ "title": "string (optional)", "status": "pending\|in_progress\|done\|cancelled (optional)", "due_date": "ISO8601\|null (optional)", "priority": "high\|medium\|low (optional)", "category": "string\|null (optional)", "parent_id": "uuid\|null (optional)" }` | `{ "task": { ... } }` |
| DELETE | `/api/tasks/:taskId` | Bearer **or** cookie ¹ | — | `{ "deleted": "uuid" }` |
| POST | `/api/tasks/:taskId/dependencies` | Bearer **or** cookie ¹ | `{ "depends_on_id": "uuid (required)" }` | `{ "task_id": "uuid", "depends_on_id": "uuid", "status": "created" }` (201). Errors: `400 depends_on_id_required` / `cannot_depend_on_self` / `depends_on_not_found` / `dependency_cycle_detected`; `404 task_not_found`. Idempotent if the edge already exists. |
| DELETE | `/api/tasks/:taskId/dependencies/:dependsOnId` | Bearer **or** cookie ¹ | — | `{ "removed": true\|false }` (200). `removed` is `false` when no row was deleted. `404 task_not_found` if `:taskId` does not exist. |
| GET | `/api/ws` | Bearer **or** cookie ¹ | WebSocket upgrade | WebSocket connection to `SessionDO` |
| * | * | — | — | `{ "status": 404, "body": "Not found" }` |

¹ **The gate accepts either credential** (`isAuthorized` in `src/lib/auth.js`, since NID-526): an `Authorization: Bearer <TIMON_API_KEY>` header — the ESP32 / apollo voice path — **or** a valid `timon_session` HttpOnly cookie — the browser. `/api/auth/login` and `/api/auth/logout` sit outside the gate by necessity, since a browser has no Bearer key. The gate is scoped to `/api` and `/api/*`; every other path is served from the static assets binding.

² **Two counts, two meanings — do not use them interchangeably.** `blocked_by_count` is every dependency edge, resolved or not (pre-existing semantics, unchanged). `blocked_by_open_count` excludes blockers whose status is `done` or `cancelled` — this is the one that answers "can I start this?", and it is what the UI acts on. A task whose dependencies are all finished reports `blocked_by_count: 2, blocked_by_open_count: 0`.

⚠ **`GET /api/tasks` has no `LIMIT` and no cursor.** It returns every matching row, and `decorateTasks` additionally reads the `tasks` and `dependencies` index tables whole. This is bounded only by table size (179 rows as of 2026-08-29). Pagination is the next thing this endpoint needs. The previous scale wall here was a hard 500: decoration used to build `WHERE id IN (?, …)` from every result id, and D1 caps a query at 100 bound parameters, so the endpoint threw a 1101 on every unfiltered read once the table passed 100 rows (NID-527).

### SessionDO Routes (Durable Object `SessionDO`)

| Method | Path | Auth | Request Body | Response JSON Shape |
|--------|------|------|--------------|---------------------|
| GET | `/ws` | WebSocket upgrade | — | `101 Switching Protocols` |
| GET | `/tasks` | None | — | `{ "tasks": [{ "taskId": "uuid", "intent": "object", "addedAt": "ISO8601" }] }` |
| POST | `/tasks` | None | `{ "taskId": "uuid", "intent": "object", ... }` | `{ "ok": true }` |

WebSocket messages (client → server): `{ "type": "subscribe" }`
WebSocket messages (server → client): `{ "type": "subscribed", "tasks": [...] }` or `{ "type": "task_added", "task": {...} }` or `{ "type": "error", "message": "string" }`

---

## 2. Module Inventory

### `src/lib/transcribe.js` — **REAL**
- **Function:** `transcribeAudio(audioBuffer, env) → { text, duration } | { error, message }`
- **Implementation:** POSTs audio to Groq `whisper-large-v3-turbo` via `https://api.groq.com/openai/v1/audio/transcriptions`
- **Auth:** `Authorization: Bearer ${env.GROQ_API_KEY}` (secret, not in git)
- **Error handling:** Returns `{ error: "transcription_failed", message: err.message }` on any failure (network, 4xx/5xx, empty transcript)
- **No retries** — fail-fast per Talvi idiom

### `src/lib/intents.js` — **REAL (Groq chat completions, NID-469)**
- **Function:** `extractIntent(transcript, env) → { title, date, priority, category, tags }`
- **LLM:** `qwen/qwen3.8-27b` via Groq chat completions over `fetch()` (`https://api.groq.com/openai/v1/chat/completions`, JSON mode, same `GROQ_API_KEY` as STT). Note: the NID-469 "llama-3.x-8b class" default is **not available** on this account (404 `model_not_found`); `qwen/qwen3.8-27b` was verified live to resolve relative dates and Spanish correctly.
- **Auth:** `Authorization: Bearer ${env.GROQ_API_KEY}` (secret, not in git)
- **Timeout:** 10s `AbortController` abort — fail-fast per Talvi idiom
- **Prompt:** System prompt injects today's date (in `TZ` if set) and timezone so the LLM resolves relative dates ("tomorrow", "3pm"); `TZ` documented in `wrangler.toml`
- **Fallback:** On any error (network, 4xx/5xx, malformed JSON), returns heuristic defaults: `{ title: transcript.slice(0,50), date: null, priority: "medium", category: null, tags: [] }`

### `src/lib/store.js` — **REAL (full schema support, partial API exposure)**
- **`ensureSchema(db)`** — Creates three tables: `task_events`, `tasks`, `dependencies` (see D1 Schema below)
- **`createTask(db, intent, userId)`** — Inserts into `tasks` with `parent_id = null` (hierarchy column exists but not used), writes `task_events` audit row
- **`getTaskWithContext(db, taskId)`** — Returns full context: task, parent, siblings, subtasks, blockers (via `dependencies` table)
- **Schema support:** All hierarchy columns (`parent_id`), categories, dependencies exist in DDL but **not wired through `/api/voice`** (always inserts `parent_id = null`)

### `src/durable-objects/session.js` — **REAL (session-scoped task broadcast)**
- **Class:** `SessionDO extends DurableObject`
- **Storage:** In-memory array `this.tasks` persisted to `ctx.storage` (key `"tasks"`)
- **WebSocket:** Accepts upgrade, broadcasts `task_added` to all subscribers on new task
- **HTTP endpoints:** `GET /tasks` (list session tasks), `POST /tasks` (add to session + broadcast)
- **Method:** `addTask(taskId, intent)` — called from `handleVoice` after DB insert

---

## 3. D1 Schema (as created by `ensureSchema`)

```sql
-- task_events: append-only audit log
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,           -- ISO 8601 timestamp
  task_id TEXT NOT NULL,      -- FK to tasks.id
  event_type TEXT NOT NULL,   -- e.g. "created"
  data TEXT NOT NULL          -- JSON string of intent at creation
);

-- tasks: core task table with full hierarchy support
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  parent_id TEXT,             -- FK to tasks.id (nullable, hierarchy)
  due_date TEXT,              -- ISO 8601 or null
  priority TEXT DEFAULT 'medium',  -- high|medium|low
  category TEXT,              -- free text or null
  created_at TEXT NOT NULL,   -- ISO 8601
  updated_at TEXT NOT NULL    -- ISO 8601
);

-- dependencies: task dependency graph (blockers)
CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,      -- the dependent task
  depends_on_id TEXT NOT NULL,-- the blocker task
  created_at TEXT NOT NULL
);
```

### `wrangler.toml` Bindings & Secrets

```toml
name = "timon-worker"
main = "src/index.js"
compatibility_date = "2026-08-25"
compatibility_flags = ["nodejs_compat"]

# Durable Objects
[durable_objects]
bindings = [
  { name = "SESSION", class_name = "SessionDO" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SessionDO"]

# D1 database
[[d1_databases]]
binding = "TIMON_META"
database_name = "timon-meta"
database_id = "d73464c6-f3e8-4809-ab24-900d9b79c94a"

# Secrets (set via `wrangler secret put GROQ_API_KEY`)
# GROQ_API_KEY is a secret, NOT in [vars]
```

**Required secrets:** `GROQ_API_KEY` (Groq key, shared by Whisper STT and intent extraction), `TIMON_API_KEY` (Bearer token for `POST /api/tasks` auth)
**Optional secrets:** `TZ` (IANA timezone, e.g. `America/Argentina/Buenos_Aires`) for relative-date resolution in intent extraction
**Note:** Cloudflare Workers AI is **not** used (NID-465 locked decision: quota error 4006, cost must stay $0). There is no `[ai]` binding; intent extraction calls Groq over plain `fetch()` (see §2).

---

## 4. Test / Benchmark State

### Test Suite (`npm test` / `vitest run`)
- **File:** `test/intents.test.js`
- **Tests:** 27 (26 unit + 1 live smoke gated on `GROQ_API_KEY` being set): 10 English transcripts, 5 Spanish transcripts, error/fallback cases (timeout, non-200, invalid JSON, title truncation, missing fields, priority clamp, surrogate-pair safety), API verification (auth header, JSON mode, system-prompt TZ/date injection), and one live smoke test that asserts a real LLM call resolves "tomorrow" to a non-null date
- **Coverage:** 165 passing / 1 skipped across `test/*.test.js` (worker: intents, store, auth, HTTP routes) and `app/src/**/*.test.ts` (app: date/label formatting, list nesting, URL routing, context view). One `bun run test` runs both halves — see `vitest.config.js`. Still untested: `transcribe.js`, `session.js`, and the list/auth view modules.
- **Benchmark file:** `benchmark_results.json` exists but is empty (`{"tests":[],"summary":{}}`)

### Corpus (`test/corpus.json`)
- **20 entries** with fields: `id`, `text` (expected transcript), `expected` (same as text), `accent`, `noise`
- Accents: american (11), british (3), australian (2), indian (1)
- Noise conditions: none (16), cafe (1), music (1), echo (1)
- **No audio files** — corpus is text-only reference for STT accuracy measurement

### Reported Metrics (from NID-463)
- **Strict accuracy:** 85% (exact match on `text` vs `expected`)
- **Normalised accuracy:** 100% (after lowercasing, punctuation stripping)
- **Latency:** ~2.5s end-to-end (audio → task_id response)
- **Note:** These are historical claims; no current benchmark run produces these numbers.

---

## 5. Gap List vs Product Goal (TDAH + Jarvis Integration)

| Feature | Status | Notes |
|---------|--------|-------|
| **Hierarchy (parent_id)** | **Implemented** | Column exists in DDL, `getTaskWithContext` returns parent/siblings/subtasks, `POST /api/tasks` accepts `parent_id` (NID-528), `PATCH /api/tasks/:id` supports `parent_id` updates. |
| **Categories** | **Implemented** | Column exists, `extractIntent` returns category, `createTask` stores it, `GET /api/tasks?category=` filters. |
| **Dependencies / Blockers** | **Implemented** | `dependencies` table exists, `getTaskWithContext` returns blockers and blocks, `POST /api/tasks/:id/dependencies` and `DELETE /api/tasks/:id/dependencies/:dependsOnId` create/remove edges (NID-549). Voice-path phrasing is not wired. |
| **Task Read API** | **Implemented** | `GET /api/tasks/:taskId` returns full context (task, parent, siblings, subtasks, blockers, blocks). |
| **Task Create API (text-in)** | **Implemented** | `POST /api/tasks` with `{text, device_id, ts, priority, category, parent_id}`. |
| **Task Update API** | **Implemented** | `PATCH /api/tasks/:id` supports title, status, due_date, priority, category, parent_id. |
| **Task Delete API** | **Implemented** | `DELETE /api/tasks/:id` re-parents children, removes dependencies, deletes task. |
| **Task List/Filter API** | **Implemented** | `GET /api/tasks` with query params (status, category, parent_id), returns `subtask_count`, `blocked_by_count`, `parent_title` and a named `blocked_by` array (NID-527). |
| **Auth on all /api/\* routes** | **Implemented** | `isAuthorized` gates `/api` and `/api/*`: Bearer key (device) **or** `timon_session` cookie (browser). `/api/auth/login` and `/api/auth/logout` are outside the gate by design. ⚠ **`APP_PASSWORD` is not set on the deployed Worker as of 2026-08-29**, so `/api/auth/login` returns 500 and no browser can obtain a session; fix is `wrangler secret put APP_PASSWORD` out-of-band (CI is forbidden from setting secrets). |
| **UI (minimal single-hue, reduced-motion, real form controls)** | **Implemented** | `app/` — Vite + vanilla TS. List view and context-first task view (parent / siblings / subtasks / blockers on one screen, no modal), single-hue instrument tokens, `prefers-reduced-motion`, real `<form>`/`<button>`/`<select>`, strict CSP with no inline styles or scripts (NID-525, NID-526, NID-527). |
| **Jarvis Bridge (LLM tool `timon_create_task`)** | **Missing** | Apollo worker should call Timon over HTTP with text. Timon needs text-in endpoint. |
| **LLM intent extraction** | **Wired (NID-469)** | `src/lib/intents.js` now calls Groq chat completions (`qwen/qwen3.8-27b`, JSON mode, same `GROQ_API_KEY` as STT) over `fetch()`. NID-465's DeepSeek-via-OpenRouter alternative remains a fallback if Groq JSON output proves unreliable, per the NID-469 decision. |

---

## 6. `POST /api/tasks` Contract (NID-470 — Implemented)

### Request
```http
POST /api/tasks
Content-Type: application/json
Authorization: Bearer <TIMON_API_KEY>

{
  "text": "buy milk tomorrow",           # required, natural language
  "device_id": "esp32-jarvis-01",        # optional, stored in task_events
  "ts": "2026-08-26T14:30:00.000Z"       # optional, ISO 8601; becomes the task due_date when present
}
```

### Success Response (201)
```json
{
  "task_id": "adb14987-6856-43e7-aa92-ab234f7d7ebb",
  "task": {
    "id": "adb14987-6856-43e7-aa92-ab234f7d7ebb",
    "title": "buy milk",
    "parent_id": null,
    "due_date": "2026-08-27T00:00:00.000Z",
    "priority": "medium",
    "category": "shopping",
    "created_at": "2026-08-26T14:30:00.123Z",
    "updated_at": "2026-08-26T14:30:00.123Z"
  },
  "status": "created"
}
```

### Error Responses
- `400 { "error": "text_required" }` — missing `text`
- `400 { "error": "invalid_ts" }` — `ts` present but not a valid ISO 8601 date
- `400 { "error": "intent_extraction_failed", "message": "..." }` — LLM failure (fallback still creates task)
- `500 { "error": "internal_error" }` — DB or unexpected failure

### Implementation Notes
- Reuse `extractIntent(text, env)` → `createTask(db, intent)` → `SessionDO.addTask(taskId, intent)`
- Returns `{task_id, task, status:"created"}` with HTTP 201
- Auth: Bearer **or** cookie ¹ — 401 on bad/missing key
- Validation: 400 on empty/missing `text`, 400 on invalid JSON
- `device_id` stored in `task_events.data` for audit correlation
- Fail fast: no retries, no retry loops

---

## 7. Live Proof

### Health Check
```bash
$ curl -s https://timon-worker.ygdcbtmc4u.workers.dev/healthz
{"status":"ok","service":"timon-worker"}
```

### Voice Call (1s silence WAV → transcribed as "Thank you." by Whisper)
```bash
$ curl -s -X POST https://timon-worker.ygdcbtmc4u.workers.dev/api/voice \
  -F "audio=@/tmp/test_audio.wav" \
  -H "x-session-id: test-session-123"
{"task_id":"adb14987-6856-43e7-aa92-ab234f7d7ebb","intent":{"title":"Thank you.","date":null,"priority":"medium","category":null,"tags":[]},"transcription":"Thank you."}
```

### Task Read (using task_id from above)
```bash
$ curl -s https://timon-worker.ygdcbtmc4u.workers.dev/api/tasks/adb14987-6856-43e7-aa92-ab234f7d7ebb
{"task":{"id":"adb14987-6856-43e7-aa92-ab234f7d7ebb","title":"Thank you.","parent_id":null,"due_date":null,"priority":"medium","category":null,"created_at":"2026-08-26T03:40:12.123Z","updated_at":"2026-08-26T03:40:12.123Z"},"parent":null,"siblings":[],"subtasks":[],"blockers":[]}
```

---

*Generated by NID-468 baseline audit. No code changes made — documentation only.*
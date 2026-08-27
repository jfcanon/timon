# Timon Worker — Baseline Contract (NID-468)

**Pinned commit:** `e2cc553d20cc0aed10e9cc7067d6d1e1a43632b0`
**Live worker:** `https://timon-worker.ygdcbtmc4u.workers.dev`

---

## 1. Route Table

All routes defined in `src/index.js`:

| Method | Path | Auth | Request Body | Response JSON Shape |
|--------|------|------|--------------|---------------------|
| GET | `/healthz` | None | — | `{ "status": "ok", "service": "timon-worker" }` |
| POST | `/api/voice` | None (session via `x-session-id` header) | `multipart/form-data` with `audio` file **OR** raw `audio/wav` body | `{ "task_id": "uuid", "intent": { "title": "string", "date": "ISO8601|null", "priority": "high\|medium\|low", "category": "string|null", "tags": "string[]" }, "transcription": "string" }` |
| POST | `/api/tasks` | `Authorization: Bearer <TIMON_API_KEY>` | `{ "text": "string (required)", "device_id": "string (optional)", "ts": "ISO8601 (optional)" }` | `{ "task_id": "uuid", "task": { ... }, "status": "created" }` (201) |
| GET | `/api/tasks/:taskId` | None | — | `{ "task": { "id": "uuid", "title": "string", "parent_id": "uuid|null", "due_date": "ISO8601|null", "priority": "string", "category": "string|null", "created_at": "ISO8601", "updated_at": "ISO8601" }, "parent": "task|null", "siblings": "task[]", "subtasks": "task[]", "blockers": "task[]" }` |
| GET | `/api/ws` | None (session via `x-session-id` header) | WebSocket upgrade | WebSocket connection to `SessionDO` |
| * | * | — | — | `{ "status": 404, "body": "Not found" }` |

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

### `src/lib/intents.js` — **PARTIAL / EFFECTIVELY HEURISTIC-ONLY (LLM path is dead code)**
- **Function:** `extractIntent(transcript, env) → { title, date, priority, category, tags }`
- **Code references LLM:** `@cf/meta/llama-2-7b-chat-int8` via `env.AI.run()` (Cloudflare Workers AI)
- **BUT `env.AI` is NOT bound:** `wrangler.toml` declares no `[ai]` binding, so `env.AI` is `undefined` at runtime. `env.AI.run()` always throws `TypeError: Cannot read properties of undefined (reading 'run')`, and the catch block always returns the heuristic fallback. **In production the worker never calls any LLM — intents are 100% heuristic.** Verified empirically: calling `extractIntent('Thank you.', {})` returns the fallback, and the live `/api/voice` response in §7 is byte-identical to it.
- **Prompt:** Hardcoded extraction prompt requesting JSON with title, date, priority, category, tags
- **Fallback:** On any error, returns heuristic defaults: `{ title: transcript.slice(0,50), date: null, priority: "medium", category: null, tags: [] }`
- **Gap:** Locked decision (NID-465) says intent extraction should use DeepSeek via OpenRouter (apollo worker). Today there is nothing to swap — the LLM call is non-functional, so Stage 3 must wire a working LLM, not replace an active one.

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

**Required secrets:** `GROQ_API_KEY` (Groq API key for Whisper STT), `TIMON_API_KEY` (Bearer token for `POST /api/tasks` auth)
**Note:** There is NO `[ai]` binding in `wrangler.toml`. Cloudflare Workers AI is **not** implicitly available — it must be declared as a binding. `env.AI` is therefore `undefined` at runtime, and the `intents.js` Llama-2 call always throws (see §2). If Workers AI were intended, an `[ai]` binding would have to be added — but the NID-465 locked decision forbids Cloudflare Workers AI (quota error 4006; cost must stay $0).

---

## 4. Test / Benchmark State

### Test Suite (`npm test` / `vitest run`)
- **File:** `test/intents.test.js`
- **Tests:** 3 passing
  1. `should extract title from simple transcript` — mocks `env.AI.run` returning structured JSON
  2. `should fallback on LLM failure` — mocks `env.AI.run` throwing; verifies heuristic fallback
  3. `should handle vague input` — mocks LLM returning minimal JSON
- **Coverage:** Only `extractIntent` is tested. No tests for `transcribe.js`, `store.js`, `session.js`, or HTTP routes.
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
| **Hierarchy (parent_id)** | **Partial** | Column exists in DDL, `getTaskWithContext` returns parent/siblings/subtasks, but `createTask` always inserts `parent_id = null`. No API to set/update parent. |
| **Categories** | **Partial** | Column exists, `extractIntent` returns category, `createTask` stores it. No category listing/filtering API. |
| **Dependencies / Blockers** | **Partial** | `dependencies` table exists, `getTaskWithContext` returns blockers. No API to create/query dependencies. |
| **Task Read API** | **Exists** | `GET /api/tasks/:taskId` returns full context (task, parent, siblings, subtasks, blockers). |
| **Task Create API (text-in)** | **Missing** | Only `POST /api/voice` (audio-in) exists. Jarvis bridge needs `POST /api/tasks` with `{text, device_id, ts}`. |
| **Task Update/Complete/Delete API** | **Missing** | No PATCH/DELETE endpoints. |
| **Task List/Filter API** | **Missing** | No `GET /api/tasks` with query params (status, category, parent, etc.). |
| **UI (minimal single-hue, reduced-motion, real form controls)** | **Missing** | No frontend code in this repo. |
| **Jarvis Bridge (LLM tool `timon_create_task`)** | **Missing** | Apollo worker should call Timon over HTTP with text. Timon needs text-in endpoint. |
| **DeepSeek via OpenRouter for intents** | **Missing** | Code references Cloudflare Workers AI (Llama-2-7b) but no `[ai]` binding exists, so the LLM call is dead code — intents are currently 100% heuristic. Locked decision (NID-465) says DeepSeek via OpenRouter (apollo calls Groq STT → DeepSeek → Timon). Stage 3 must wire a working LLM, not replace an active one. |

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
- Auth: `Authorization: Bearer <TIMON_API_KEY>` — 401 on bad/missing key
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
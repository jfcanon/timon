# Timon

Voice-activated task manager — Cloudflare Worker backed by Groq for speech transcription and intent extraction.

## Development

```bash
bun install
bun run dev          # local dev server
bun run test         # vitest
bun run test:watch   # watch mode
```

## How changes reach production

1. **Open a PR** against `master`. The CI workflow runs automatically:
   - `bun install --frozen-lockfile` + `bun run test` (tests must pass; they stub `fetch` so no network needed)
   - Conflict-marker detection (rejects `<<<<<<<` / `=======` / `>>>>>>>` in source files)
2. **Get CI green** and merge the PR.
3. **The Deploy workflow** triggers on the merge to `master`:
   - Re-runs tests (safety net)
   - Runs `bunx wrangler deploy` with `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from the `production` GitHub environment
   - Worker secrets (`GROQ_API_KEY`, `TIMON_API_KEY`, `TZ`) persist across deploys — no `wrangler secret put` step needed

**Do not run `wrangler deploy` manually.** All deploys go through CI.

## Environment

| Variable | Where |
|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub `production` secret |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub `production` secret |
| `GROQ_API_KEY` | Cloudflare Worker secret (persists) |
| `TIMON_API_KEY` | Cloudflare Worker secret (persists) — Bearer key for the ESP32 / apollo path |
| `APP_PASSWORD` | Cloudflare Worker secret (persists) — browser login password |
| `SESSION_SECRET` | Cloudflare Worker secret (persists) — HMAC key for the session cookie. Rotating it revokes every session. |
| `TZ` | Cloudflare Worker secret (persists) |

## Live updates

An open tab holds one WebSocket to `/api/ws` and re-renders when a task is
added, edited or deleted anywhere — the ESP32, apollo, or another tab. The
upgrade is authorized by the same gate as the rest of `/api/*`: the browser's
`__Host-timon_session` cookie rides the handshake, since a WebSocket upgrade is
a plain GET and cannot carry an `Authorization` header. The event payload is the
full `GET /api/tasks` row; see `docs/CONTRACT.md` for the message contract.

Running it locally needs the secrets above in a `.dev.vars` file (gitignored):

```bash
bun run dev          # http://localhost:8787, serves app/dist for non-/api paths
cd app && bun run build   # rebuild the SPA the Worker serves
```

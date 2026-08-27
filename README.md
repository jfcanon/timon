# timon

Voice-activated task manager Cloudflare Worker.

## How changes reach production

1. Open a PR against `master`.
2. CI runs `bun install --frozen-lockfile`, `bun run test`, and checks for conflict markers.
3. Merge the PR once CI is green.
4. On push to `master`, the Deploy workflow re-runs tests then runs `bunx wrangler deploy`.
5. The worker is live — no manual `wrangler deploy` needed.

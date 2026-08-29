import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Worker tests plus the app's pure presentation logic, so one
    // `bun run test` covers both halves in CI.
    include: ["test/**/*.test.js", "app/src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "./test/__mocks__/cloudflare-workers.js",
        import.meta.url
      ).pathname,
    },
  },
});

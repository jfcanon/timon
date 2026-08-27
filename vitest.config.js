import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.js"],
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

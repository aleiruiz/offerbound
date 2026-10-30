import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: { resolve: { conditions: ["@offerbound/source"] } },
  test: {
    name: "api-integration",
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

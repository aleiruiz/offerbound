import { defineProject } from "vitest/config";

export default defineProject({
  ssr: { resolve: { conditions: ["@offerbound/source"] } },
  test: {
    name: "api",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts", "node_modules", "dist"],
  },
});

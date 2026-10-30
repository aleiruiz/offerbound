import { defineProject } from "vitest/config";

export default defineProject({
  ssr: { resolve: { conditions: ["@offerbound/source"] } },
  test: { name: "contracts", include: ["src/**/*.test.ts"] },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/domain", "packages/contracts", "apps/api", "apps/web"],
  },
});

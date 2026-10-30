import { defineConfig, devices } from "@playwright/test";

/**
 * The demo smoke test (TECHNICAL_SPEC §15, Release 1.1). It needs a running demo (`APP_MODE=demo`)
 * and is not part of `pnpm test`, which must not need a backend. Run it with
 * `DEMO_BASE_URL=https://offerbound.northsoftmx.com pnpm --filter @offerbound/web test:e2e`.
 * Without `DEMO_BASE_URL` it uses the web dev server, which proxies /api to the demo API.
 */
export default defineConfig({
  testDir: "./e2e",
  // The tests share one demo database: one at a time, in file order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.DEMO_BASE_URL ?? "http://localhost:5175",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

import react from "@vitejs/plugin-react";
import { defaultClientConditions } from "vite";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [react()],
  resolve: { conditions: [...defaultClientConditions, "@offerbound/source"] },
  ssr: { resolve: { conditions: ["@offerbound/source"] } },
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", "dist"],
    // The suite runs slowly under load (jsdom plus MUI), and several tests sit close to the 5 s
    // default, so a busy machine makes them fail without anything being wrong.
    testTimeout: 15_000,
  },
});

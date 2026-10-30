import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

// The web dev server is port 5175 and proxies /api to the stream C API (3002).
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: [...defaultClientConditions, "@offerbound/source"] },
  server: {
    port: 5175,
    proxy: { "/api": "http://localhost:3002" },
  },
  build: { outDir: "dist", sourcemap: false },
});

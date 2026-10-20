import { defineConfig } from "vitest/config";

// Development server. PDFINK_API is where `npm run api` listens; set
// PDFINK_ALLOWED_HOSTS (comma-separated) to reach the dev server by a hostname
// other than localhost, e.g. from a tablet on the same network.
const allowedHosts = (process.env.PDFINK_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    allowedHosts,
    proxy: { "/api": process.env.PDFINK_API ?? "http://127.0.0.1:5174" },
  },
  preview: { port: 5173, strictPort: true, host: true, allowedHosts },
  build: { target: "es2022" },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:5175",
    headless: true,
    viewport: { width: 1000, height: 1200 },
    permissions: ["clipboard-read", "clipboard-write"],
  },
  // Test servers use their own ports and a throwaway notebooks directory so
  // they never touch a running production server or the real notebooks.
  webServer: [
    {
      command: "rm -rf test-results/notebooks && mkdir -p test-results/notebooks && NOTEBOOKS_DIR=test-results/notebooks DIST_DIR= PORT=5176 PDFINK_COMMANDS=tests/fixtures/pdfink-commands.conf node server/index.ts",
      url: "http://127.0.0.1:5176/api/notebooks",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "PDFINK_API=http://127.0.0.1:5176 npx vite --port 5175 --strictPort",
      url: "http://localhost:5175",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});

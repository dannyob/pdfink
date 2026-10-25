import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * pdf.js loads CMaps, standard fonts, wasm decoders and ICC profiles on demand
 * (src/pdf/pdfjs-assets.ts). Serve them from pdfjs-dist under /pdfjs/ in
 * development, and copy them into the build.
 */
const PDFJS_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];
const pdfjsRoot = path.resolve("node_modules/pdfjs-dist");
function pdfjsAssets(): Plugin {
  let outDir = "dist";
  return {
    name: "pdfjs-assets",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/pdfjs\/([a-z_]+)\/([A-Za-z0-9._-]+)$/.exec((req.url ?? "").split("?")[0]);
        if (!m || !PDFJS_DIRS.includes(m[1])) return next();
        const file = path.join(pdfjsRoot, m[1], m[2]);
        if (!fs.existsSync(file)) return next();
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const dir of PDFJS_DIRS) fs.cpSync(path.join(pdfjsRoot, dir), path.join(outDir, "pdfjs", dir), { recursive: true });
    },
  };
}

// Development server. PDFINK_API is where `npm run api` listens; set
// PDFINK_ALLOWED_HOSTS (comma-separated) to reach the dev server by a hostname
// other than localhost, e.g. from a tablet on the same network.
const allowedHosts = (process.env.PDFINK_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [pdfjsAssets()],
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    allowedHosts,
    proxy: { "/api": { target: process.env.PDFINK_API ?? "http://127.0.0.1:5174", ws: true } },
  },
  preview: { port: 5173, strictPort: true, host: true, allowedHosts },
  build: { target: "es2022" },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});

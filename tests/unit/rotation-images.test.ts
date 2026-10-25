import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PDFDocument, degrees } from "pdf-lib";
import { exportPdf } from "../../src/pdf/export";
import { importPdf } from "../../src/pdf/import";
import type { PageModel } from "../../src/model";

const OUT = path.resolve("test-results/rotation");

/** For each /Rotate, place the arrow image and a stroke near the display top-left and export. */
describe("rotated pages", () => {
  const png = new Uint8Array(fs.readFileSync(path.resolve("tests/fixtures/arrow.png")));

  for (const rotate of [0, 90, 180, 270]) {
    it(`exports image + stroke on a /Rotate ${rotate} page and re-imports the stroke`, async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      page.setRotation(degrees(rotate));
      const base = await doc.save({ useObjectStreams: false });
      const imported = await importPdf(base);
      const size = imported.pages[0];
      // Display size swaps for 90/270
      expect(size.width).toBe(rotate % 180 === 0 ? 612 : 792);
      const model: PageModel = {
        width: size.width,
        height: size.height,
        images: [{ id: "a", x: 40, y: 40, w: 200, h: 120, mime: "image/png", bytes: png }],
        links: [],
        texts: [],
        strokes: [
          {
            id: "s",
            color: "#0000ff",
            width: 4,
            opacity: 1,
            points: [
              { x: 40, y: 200, p: 1 },
              { x: 240, y: 200, p: 1 },
              { x: 240, y: 260, p: 1 },
            ],
          },
        ],
      };
      const out = await exportPdf(imported.baseBytes, [model]);
      fs.mkdirSync(OUT, { recursive: true });
      const file = path.join(OUT, `rot${rotate}.pdf`);
      fs.writeFileSync(file, out);
      // Stroke comes back where it was, in display space.
      const again = await importPdf(out);
      expect(again.pages[0].strokes).toHaveLength(1);
      const pts = again.pages[0].strokes[0].points;
      expect(pts[0].x).toBeCloseTo(40, 2);
      expect(pts[0].y).toBeCloseTo(200, 2);
      expect(pts[2].x).toBeCloseTo(240, 2);
      expect(pts[2].y).toBeCloseTo(260, 2);
      // Render for eyeballing (pdftoppm honours /Rotate like a viewer does).
      try {
        execFileSync("pdftoppm", ["-r", "30", "-png", file, path.join(OUT, `rot${rotate}`)]);
      } catch {
        /* pdftoppm not installed; skip the picture */
      }
    });
  }
});

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBlankPdf } from "../../src/pdf/export";
import { importPdf } from "../../src/pdf/import";

const haveUv = spawnSync("uv", ["--version"]).status === 0;

describe.skipIf(!haveUv)("tools/star.py", () => {
  it("stamps a star that pdfink reads back as a stroke at the point", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-star-"));
    const file = path.join(dir, "s.pdf");
    fs.writeFileSync(file, await createBlankPdf(2));
    const out = execFileSync("uv", ["run", "--script", path.resolve("tools/star.py"), file, "2", "300", "500"], { encoding: "utf8", timeout: 120_000 });
    expect(out).toContain("star at (300, 500) on page 2");
    const r = await importPdf(new Uint8Array(fs.readFileSync(file)));
    expect(r.pages[0].strokes).toHaveLength(0);
    expect(r.pages[1].strokes).toHaveLength(1);
    const s = r.pages[1].strokes[0];
    expect(s.points).toHaveLength(11);
    expect(s.color).toBe("#d91a1a");
    // PDF (300, 500) on a Letter page is display (300, 292); the first point is the top tip, radius 12 above.
    expect(s.points[0].x).toBeCloseTo(300, 3);
    expect(s.points[0].y).toBeCloseTo(792 - 500 - 12, 3);
  });
});

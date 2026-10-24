import { describe, expect, it } from "vitest";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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

  it("draws through the bridge when $PDFINK_SOCKET is set, leaving the file alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-star-"));
    const file = path.join(dir, "s.pdf");
    fs.writeFileSync(file, await createBlankPdf(2));
    const mtime = fs.statSync(file).mtimeMs;
    const sock = path.join(dir, "page.sock");
    const requests: { id: number; call: string; args: unknown[] }[] = [];
    const server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          requests.push(msg);
          if (msg.call === "addStrokes") conn.write(JSON.stringify({ id: msg.id, result: ["s1"] }) + "\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile(
          "uv",
          ["run", "--script", path.resolve("tools/star.py"), file, "2", "300", "500", "20"],
          { encoding: "utf8", timeout: 120_000, env: { ...process.env, PDFINK_SOCKET: sock } },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        ),
      );
      expect(out).toContain("star at (300, 500) on page 2 (drawn in the browser)");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    const adds = requests.filter((r) => r.call === "addStrokes");
    expect(adds).toHaveLength(1);
    const [pageIndex, strokes, opts] = adds[0].args as [number, { points: { x: number; y: number; p: number }[]; color: string; width: number; opacity: number }[], { space: string }];
    expect(pageIndex).toBe(1);
    expect(opts).toEqual({ space: "pdf" });
    expect(strokes).toHaveLength(1);
    const s = strokes[0];
    expect(s.points).toHaveLength(11);
    expect(s).toMatchObject({ color: "#d91a1a", width: 1.5, opacity: 1 });
    expect(s.points.every((p) => p.p === 0.6)).toBe(true);
    // PDF space, so the first point is the top tip, radius 20 above the point.
    expect(s.points[0].x).toBeCloseTo(300, 3);
    expect(s.points[0].y).toBeCloseTo(520, 3);
  });
});

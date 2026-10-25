import { describe, expect, it } from "vitest";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createBlankPdf } from "../../src/pdf/export";
import { importPdf } from "../../src/pdf/import";

const haveUv = spawnSync("uv", ["--version"]).status === 0;
const script = path.resolve("tools/timestamp.py");
const AT = "2026-10-25 13:46";

type Pt = { x: number; y: number; p: number };
type Stroke = { points: Pt[]; color: string; width: number; opacity: number };

describe.skipIf(!haveUv)("tools/timestamp.py", () => {
  it("stamps a red chevron and the date and time as ink, and bookmarks the page", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-ts-"));
    const file = path.join(dir, "t.pdf");
    fs.writeFileSync(file, await createBlankPdf(2));
    fs.chmodSync(file, 0o644);
    const out = execFileSync("uv", ["run", "--script", script, file, "2", "72", "500", "--at", AT], { encoding: "utf8", timeout: 120_000 });
    expect(out).toContain(`${AT} on page 2`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    const r = await importPdf(new Uint8Array(fs.readFileSync(file)));
    expect(r.pages[0].strokes).toHaveLength(0);
    const strokes = r.pages[1].strokes;
    // The chevron, then at least one stroke per digit (twelve of them).
    expect(strokes.length).toBeGreaterThan(12);
    expect(strokes[0].color).toBe("#d91a1a");
    expect(strokes.slice(1).every((s) => s.color !== "#d91a1a")).toBe(true);
    // Everything starts at the pen point and reads left to right, centred on it.
    const xs = strokes.flatMap((s) => s.points.map((p) => p.x));
    const ys = strokes.flatMap((s) => s.points.map((p) => p.y));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(72 - 2);
    expect(Math.max(...xs)).toBeGreaterThan(72 + 100);
    const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(mid).toBeCloseTo(792 - 500, -1);
    expect(r.bookmarks).toEqual([expect.objectContaining({ title: AT, page: 1 })]);
  });

  it("keeps the stamp on the page when the pen is near the right edge", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-ts-"));
    const file = path.join(dir, "t.pdf");
    fs.writeFileSync(file, await createBlankPdf(1));
    execFileSync("uv", ["run", "--script", script, file, "1", "600", "500", "--at", AT], { encoding: "utf8", timeout: 120_000 });
    const r = await importPdf(new Uint8Array(fs.readFileSync(file)));
    const xs = r.pages[0].strokes.flatMap((s) => s.points.map((p) => p.x));
    expect(Math.max(...xs)).toBeLessThanOrEqual(612);
  });

  it("draws and bookmarks through the bridge when $PDFINK_SOCKET is set, leaving the file alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-ts-"));
    const file = path.join(dir, "t.pdf");
    fs.writeFileSync(file, await createBlankPdf(2));
    const mtime = fs.statSync(file).mtimeMs;
    const sock = path.join(dir, "page.sock");
    const requests: { id: number; call: string; args: unknown[] }[] = [];
    const answers: Record<string, unknown> = { addStrokes: ["s1"], addBookmark: 0, bookmarks: [] };
    const server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          requests.push(msg);
          conn.write(JSON.stringify({ id: msg.id, result: answers[msg.call] ?? null }) + "\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile(
          "uv",
          ["run", "--script", script, file, "2", "72", "500", "--at", AT, "--page-width", "612"],
          { encoding: "utf8", timeout: 120_000, env: { ...process.env, PDFINK_SOCKET: sock } },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        ),
      );
      expect(out).toContain(`${AT} on page 2 (drawn in the browser)`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    const adds = requests.filter((r) => r.call === "addStrokes");
    expect(adds).toHaveLength(1);
    const [pageIndex, strokes, opts] = adds[0].args as [number, Stroke[], { space: string }];
    expect(pageIndex).toBe(1);
    expect(opts).toEqual({ space: "pdf" });
    expect(strokes[0].color).toBe("#d91a1a");
    expect(strokes.length).toBeGreaterThan(12);
    // PDF space: y grows upwards, centred on the pen point.
    const ys = strokes.flatMap((s) => s.points.map((p) => p.y));
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(500, -1);
    const marks = requests.filter((r) => r.call === "addBookmark");
    expect(marks.map((m) => m.args)).toEqual([[1, AT, { level: 0 }]]);
  });
});

describe.skipIf(!haveUv)("journal-page.py timestamp helpers", () => {
  it("passes its own unittest suite", () => {
    execFileSync("uv", ["run", "--script", path.resolve("tools/tests/test_journal_timestamps.py")], { encoding: "utf8", stdio: "pipe", timeout: 120_000 });
  }, 130_000);
});

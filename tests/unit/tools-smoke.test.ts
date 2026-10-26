import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const haveUv = spawnSync("uv", ["--version"]).status === 0;

function run(script: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) =>
    execFile("uv", ["run", "--script", path.resolve("tools", script), ...args], { encoding: "utf8", timeout: 180_000, env }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  );
}

describe.skipIf(!haveUv)("tools smoke", () => {
  it("describe-selection.py --help exits 0", async () => {
    const r = await run("describe-selection.py", ["--help"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("--dry-run");
  }, 200_000);

  it("journal-page.py --help exits 0", async () => {
    const r = await run("journal-page.py", ["--help"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("--date");
  }, 200_000);

  it("describe-selection.py --dry-run asks the page and prints the answer when told to", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-describe-"));
    const sock = path.join(dir, "page.sock");
    const answers: Record<string, unknown> = {
      selection: { page: 0, rect: { x: 10, y: 20, w: 30, h: 40 }, strokeIds: ["s1"], imageIds: [] },
      selectionPng: Buffer.from("not really a png").toString("base64"),
      choose: "Print",
      progress: null,
      toast: null,
    };
    const calls: { call: string; args: unknown[] }[] = [];
    const server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          calls.push(msg);
          if (msg.call in answers) conn.write(JSON.stringify({ id: msg.id, result: answers[msg.call] }) + "\n");
          else conn.write(JSON.stringify({ id: msg.id, error: `unknown method ${msg.call}` }) + "\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      const r = await run("describe-selection.py", ["--dry-run"], { ...process.env, PDFINK_SOCKET: sock, PAGE: "1" });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe("(dry run) 1 image");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const names = calls.map((c) => c.call);
    expect(names).toContain("selectionPng");
    expect(names).toContain("choose");
    const choose = calls.find((c) => c.call === "choose")!;
    expect(choose.args).toEqual(["(dry run) 1 image", ["Show in status", "Print", "Cancel"]]);
    expect(calls.filter((c) => c.call === "progress").map((c) => c.args[0])).toEqual(["Looking…", null]);
  }, 200_000);
  it("ocr-page.py --help exits 0", async () => {
    const r = await run("ocr-page.py", ["--help"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("--dry-run");
  }, 200_000);

  it("ocr-page.py without a page exits 1 and says why", async () => {
    const env = { ...process.env };
    delete env.PDFINK_SOCKET;
    const r = await run("ocr-page.py", ["1"], env);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("needs the pdfink page (run it from the pen menu)");
  }, 200_000);

  it("ocr-page.py --dry-run prints the numbered lines and sets no text", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-ocr-"));
    const sock = path.join(dir, "page.sock");
    // Two words on two rows, as zig-zag strokes 14 pt tall.
    const zig = (id: string, x: number, y: number) => ({
      id,
      points: [0, 1, 2, 3, 4].map((i) => ({ x: x + 2.5 * i, y: y + (i % 2 ? 14 : 0), p: 0.5 })),
      color: "#000000",
      width: 1.5,
      opacity: 1,
    });
    const answers: Record<string, unknown> = {
      strokes: [zig("s1", 100, 100), zig("s2", 112, 100), zig("s3", 100, 200)],
      inkText: [],
      selection: null,
      progress: null,
    };
    const calls: { call: string; args: unknown[] }[] = [];
    const server = net.createServer((conn) => {
      let buf = "";
      // progress(None) is fire-and-forget: the tool may hang up before its reply.
      conn.on("error", () => {});
      conn.on("data", (chunk) => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          calls.push(msg);
          if (msg.call in answers) conn.write(JSON.stringify({ id: msg.id, result: answers[msg.call] }) + "\n");
          else conn.write(JSON.stringify({ id: msg.id, error: `unknown method ${msg.call}` }) + "\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    let r;
    try {
      r = await run("ocr-page.py", ["1", "--dry-run"], { ...process.env, PDFINK_SOCKET: sock, PAGE: "1" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(r.code, r.stderr).toBe(0);
    const numbered = r.stdout.split("\n").filter((l) => /^\d+: /.test(l));
    expect(numbered.map((l) => l.split(":")[0])).toEqual(["1", "2"]);
    const names = calls.map((c) => c.call);
    expect(names).toContain("strokes");
    expect(names).not.toContain("setInkText");
    expect(calls.find((c) => c.call === "strokes")!.args[0]).toBe(0);
  }, 200_000);
});

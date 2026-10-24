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
});

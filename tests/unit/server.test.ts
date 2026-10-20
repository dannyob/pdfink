import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, optionsFrom, validName } from "../../server/index";
import { createBlankPdf } from "../../src/pdf/export";

let dir: string;
let base: string;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-"));
  server = createServer({ mode: "server", notebooksDir: dir, distDir: null, host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("notebook names", () => {
  it("accepts ordinary names and rejects traversal", () => {
    expect(validName("2026.pdf")).toBe(true);
    expect(validName("My notes (draft).pdf")).toBe(true);
    expect(validName("../etc.pdf")).toBe(false);
    expect(validName("a/b.pdf")).toBe(false);
    expect(validName(".hidden.pdf")).toBe(false);
    expect(validName("notes.txt")).toBe(false);
  });
});

describe("notebook API", () => {
  it("lists, creates, loads and updates with mtime checks", async () => {
    let res = await fetch(`${base}/api/notebooks`);
    expect(await res.json()).toEqual([]);

    const pdf = await createBlankPdf(1);
    res = await fetch(`${base}/api/notebooks/a.pdf`, { method: "PUT", headers: { "X-If-Mtime": "new" }, body: pdf as BodyInit });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { mtime: number; size: number };
    expect(created.size).toBe(pdf.length);

    // "new" again → conflict
    res = await fetch(`${base}/api/notebooks/a.pdf`, { method: "PUT", headers: { "X-If-Mtime": "new" }, body: pdf as BodyInit });
    expect(res.status).toBe(409);

    res = await fetch(`${base}/api/notebooks`);
    const list = (await res.json()) as { name: string }[];
    expect(list.map((n) => n.name)).toEqual(["a.pdf"]);

    res = await fetch(`${base}/api/notebooks/a.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const mtime = Number(res.headers.get("x-mtime"));
    expect(mtime).toBe(created.mtime);
    expect((await res.arrayBuffer()).byteLength).toBe(pdf.length);

    // stale mtime → conflict with the current mtime reported
    res = await fetch(`${base}/api/notebooks/a.pdf`, { method: "PUT", headers: { "X-If-Mtime": String(mtime - 1000) }, body: pdf as BodyInit });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { mtime: number }).mtime).toBe(mtime);

    // matching mtime → ok
    const pdf2 = await createBlankPdf(2);
    res = await fetch(`${base}/api/notebooks/a.pdf`, { method: "PUT", headers: { "X-If-Mtime": String(mtime) }, body: pdf2 as BodyInit });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(dir, "a.pdf")).length).toBe(pdf2.length);
    // no temp files left behind
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("rejects bad names, non-PDF bodies and unknown files", async () => {
    let res = await fetch(`${base}/api/notebooks/..%2Fx.pdf`, { method: "PUT", body: "x" });
    expect(res.status).toBe(400);
    res = await fetch(`${base}/api/notebooks/b.pdf`, { method: "PUT", body: "not a pdf" });
    expect(res.status).toBe(400);
    res = await fetch(`${base}/api/notebooks/missing.pdf`);
    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(dir, "b.pdf"))).toBe(false);
  });

  it("ignores hidden and non-pdf files when listing", async () => {
    fs.writeFileSync(path.join(dir, ".hidden.pdf"), "%PDF-");
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    const res = await fetch(`${base}/api/notebooks`);
    const list = (await res.json()) as { name: string }[];
    expect(list.map((n) => n.name)).toEqual(["a.pdf"]);
  });

  it("reports its mode on /api/status", async () => {
    const res = await fetch(`${base}/api/status`);
    expect(await res.json()).toMatchObject({ mode: "server" });
  });
});

describe("command line", () => {
  it("parses flags, falls back to env, then defaults", () => {
    const o = optionsFrom(["--mode", "browser", "--host", "0.0.0.0", "--port", "8080", "--notebooks", "/tmp/nb", "--dist", "none"], {});
    expect(o).toMatchObject({ mode: "browser", host: "0.0.0.0", port: 8080, notebooksDir: "/tmp/nb", distDir: null });
    const e = optionsFrom([], { PDFINK_MODE: "server", HOST: "::1", PORT: "7000", NOTEBOOKS_DIR: "/tmp/env" });
    expect(e).toMatchObject({ mode: "server", host: "::1", port: 7000, notebooksDir: "/tmp/env" });
    const d = optionsFrom([], {});
    expect(d.mode).toBe("server");
    expect(d.host).toBe("127.0.0.1");
    expect(d.port).toBe(5173);
    expect(d.notebooksDir.endsWith("/notebooks")).toBe(true);
    expect(() => optionsFrom(["--mode", "cloud"], {})).toThrow(/--mode/);
  });
});

describe("browser mode", () => {
  it("serves no notebook API", async () => {
    const srv = createServer({ mode: "browser", notebooksDir: dir, distDir: null, host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    expect(await (await fetch(`${b}/api/status`)).json()).toEqual({ mode: "browser" });
    expect((await fetch(`${b}/api/notebooks`)).status).toBe(404);
    expect((await fetch(`${b}/api/notebooks/a.pdf`, { method: "PUT", body: "%PDF-" })).status).toBe(404);
    await new Promise((r) => srv.close(r));
  });
});

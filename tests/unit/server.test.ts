import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  server = createServer({ mode: "server", notebooksDir: dir, distDir: null, host: "127.0.0.1", port: 0, commandsFile: null });
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
    const srv = createServer({ mode: "browser", notebooksDir: dir, distDir: null, host: "127.0.0.1", port: 0, commandsFile: null });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    expect(await (await fetch(`${b}/api/status`)).json()).toEqual({ mode: "browser" });
    expect((await fetch(`${b}/api/notebooks`)).status).toBe(404);
    expect((await fetch(`${b}/api/notebooks/a.pdf`, { method: "PUT", body: "%PDF-" })).status).toBe(404);
    await new Promise((r) => srv.close(r));
  });
});

describe("pen-menu commands API", () => {
  it("lists commands from the file and runs one with the point in PDF space", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-cmd-"));
    const conf = path.join(dir, "pdfink-commands.conf");
    fs.writeFileSync(conf, `[Where]\ncommand = printf "%s %s %s %s %s" "$NAME" "$PAGE" "$X" "$Y" "$ROTATE" > where.txt; cat where.txt\n\n[Touch]\ncommand = printf "%%" >> "$PDF"\nreload = true\n`);
    fs.writeFileSync(path.join(dir, "a.pdf"), await createBlankPdf(2));
    const srv = createServer({ mode: "server", notebooksDir: dir, distDir: null, host: "127.0.0.1", port: 0, commandsFile: conf });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      let res = await fetch(`${base}/api/commands`);
      expect(await res.json()).toEqual([
        { id: "Where", label: "Where", reload: false, confirm: false, detach: false },
        { id: "Touch", label: "Touch", reload: true, confirm: false, detach: false },
      ]);
      // display point (100, 100) on a Letter page → PDF (100, 692)
      res = await fetch(`${base}/api/commands/Where`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "a.pdf", page: 1, x: 100, y: 100 }) });
      expect(res.status).toBe(200);
      let out = (await res.json()) as { status: number; stdout: string; changed: boolean; reload: boolean };
      expect(out.status).toBe(0);
      expect(out.stdout).toBe("a.pdf 2 100 692 0");
      expect(out.changed).toBe(false);
      expect(fs.existsSync(path.join(dir, "where.txt"))).toBe(true); // cwd is the config's folder

      res = await fetch(`${base}/api/commands/Touch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "a.pdf", page: 0, x: 1, y: 1 }) });
      out = (await res.json()) as typeof out;
      expect(out).toMatchObject({ status: 0, changed: true, reload: true });

      res = await fetch(`${base}/api/commands/Nope`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "a.pdf", page: 0, x: 1, y: 1 }) });
      expect(res.status).toBe(404);
      res = await fetch(`${base}/api/commands/Where`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "a.pdf", page: 7, x: 1, y: 1 }) });
      expect(res.status).toBe(400);
    } finally {
      srv.close();
    }
  });

  it("--commands and PDFINK_COMMANDS pick the file; the default sits beside the notebooks", () => {
    expect(optionsFrom(["--commands", "/tmp/c.conf"], {}).commandsFile).toBe("/tmp/c.conf");
    expect(optionsFrom([], { PDFINK_COMMANDS: "none" }).commandsFile).toBeNull();
    expect(optionsFrom(["--notebooks", "/tmp/nb"], {}).commandsFile).toBe("/tmp/nb/pdfink-commands.conf");
  });
});

describe("a command that fails to start", () => {
  it("answers 500 and leaves no run socket behind", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-nul-"));
    const conf = path.join(dir, "pdfink-commands.conf");
    // A NUL in the command makes spawn() throw synchronously.
    fs.writeFileSync(conf, "[Broken]\ncommand = echo a\u0000b\n");
    fs.writeFileSync(path.join(dir, "a.pdf"), await createBlankPdf(1));
    const sockDir = path.join(dir, "sock");
    const srv = createServer({ mode: "server", notebooksDir: dir, distDir: null, host: "127.0.0.1", port: 0, commandsFile: conf, socketDir: sockDir });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await fetch(`${base}/api/commands/Broken`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "a.pdf", page: 0, x: 1, y: 1 }) });
      expect(res.status).toBe(500);
      expect(fs.readdirSync(sockDir)).toEqual([]);
    } finally {
      errors.mockRestore();
      await new Promise((r) => srv.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("page bridge", () => {
  let bdir: string;
  let bsrv: ReturnType<typeof createServer>;
  let port: number;
  const pages: WebSocket[] = [];

  const CALL = `node -e 'const s=require("net").connect(process.env.PDFINK_SOCKET);s.write(JSON.stringify({id:1,call:"state"})+"\\n");s.on("data",d=>{process.stdout.write(JSON.parse(d).result.tool);s.end()})'`;

  beforeAll(async () => {
    bdir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-bridge-"));
    const conf = path.join(bdir, "pdfink-commands.conf");
    fs.writeFileSync(
      conf,
      [
        "[Env]",
        `command = printf '%s %s %s %s %s %s' "$PDFINK_RUN" "$SELECTED" "$SEL_PAGE" "$SEL_X" "$SEL_Y" "$SEL_H" ; test -S "$PDFINK_SOCKET" && printf ' sock'`,
        "[Call]",
        `command = ${CALL}`,
        "[D]",
        "command = sleep 1",
        "detach = true",
        "[Long]",
        "command = sleep 30",
        "detach = true",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(bdir, "a.pdf"), await createBlankPdf(1));
    fs.writeFileSync(path.join(bdir, "b.pdf"), await createBlankPdf(2));
    bsrv = createServer({ mode: "server", notebooksDir: bdir, distDir: null, host: "127.0.0.1", port: 0, commandsFile: conf, socketDir: path.join(bdir, "sock") });
    await new Promise<void>((r) => bsrv.listen(0, "127.0.0.1", () => r()));
    port = (bsrv.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const ws of pages) ws.close();
    await new Promise((r) => bsrv.close(r));
    fs.rmSync(bdir, { recursive: true, force: true });
  });

  /** Connect as the page; every frame it receives lands in `frames`. */
  async function page(session: string): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/page?session=${session}`);
    pages.push(ws);
    const frames: Record<string, unknown>[] = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    return { ws, frames };
  }

  async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v !== undefined) return v;
      if (Date.now() - t0 > ms) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  const post = (id: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/commands/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("GET /api/commands reports detach", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/commands`);
    const list = (await res.json()) as { id: string; detach: boolean }[];
    expect(list.map((c) => [c.id, c.detach])).toEqual([
      ["Env", false],
      ["Call", false],
      ["D", true],
      ["Long", true],
    ]);
  });

  it("a command gets PDFINK_SOCKET, PDFINK_RUN and the selection in PDF points", async () => {
    await page("t1");
    const res = await post("Env", { name: "a.pdf", page: 0, x: 1, y: 1, session: "t1", selection: { page: 0, rect: { x: 100, y: 92, w: 50, h: 200 }, count: 2 } });
    const out = (await res.json()) as { run: string; stdout: string; status: number };
    expect(out.status).toBe(0);
    expect(out.run).toMatch(/^[0-9a-z]{6}$/);
    expect(out.stdout).toBe(`${out.run} 2 1 100 500 200 sock`);
  });

  it("a command without a session still runs, with empty selection variables", async () => {
    const res = await post("Env", { name: "a.pdf", page: 0, x: 1, y: 1 });
    const out = (await res.json()) as { run: string; stdout: string; status: number };
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(`${out.run}      sock`);
  });

  it("the selection may sit on another page than the menu; bad sessions and selections are refused", async () => {
    let res = await post("Env", { name: "b.pdf", page: 0, x: 1, y: 1, selection: { page: 1, rect: { x: 10, y: 692, w: 20, h: 10 }, count: 1 } });
    const out = (await res.json()) as { run: string; stdout: string };
    expect(out.stdout).toBe(`${out.run} 1 2 10 90 10 sock`);
    res = await post("Env", { name: "b.pdf", page: 0, x: 1, y: 1, selection: { page: 2, rect: { x: 0, y: 0, w: 1, h: 1 }, count: 1 } });
    expect(res.status).toBe(400);
    res = await post("Env", { name: "b.pdf", page: 0, x: 1, y: 1, selection: { page: 0, rect: { x: 0 }, count: 1 } });
    expect(res.status).toBe(400);
    res = await post("Env", { name: "b.pdf", page: 0, x: 1, y: 1, session: "../x" });
    expect(res.status).toBe(400);
  });

  it("a detached run whose page never connects still exits cleanly", async () => {
    const out = (await (await post("D", { name: "a.pdf", page: 0, x: 1, y: 1, session: "nobody" })).json()) as { run: string; detached: boolean };
    expect(out.detached).toBe(true);
    const sock = path.join(bdir, "sock", `${out.run}.sock`);
    expect(fs.existsSync(sock)).toBe(true);
    await until(() => (fs.existsSync(sock) ? undefined : true));
  });

  it("a command can call the page through the socket", async () => {
    const { ws } = await page("t2");
    ws.addEventListener("message", (e) => {
      const f = JSON.parse(String(e.data)) as { run: string; id?: string; call?: string };
      if (f.call === "state") ws.send(JSON.stringify({ run: f.run, id: f.id, result: { tool: "pen" } }));
    });
    const res = await post("Call", { name: "a.pdf", page: 0, x: 1, y: 1, session: "t2" });
    const out = (await res.json()) as { stdout: string; stderr: string; status: number };
    expect(out.stderr).toBe("");
    expect(out.stdout).toBe("pen");
  });

  it("a detached command answers at once and the page sees started then exited", async () => {
    const { frames } = await page("t3");
    const t0 = Date.now();
    const res = await post("D", { name: "a.pdf", page: 0, x: 1, y: 1, session: "t3" });
    const out = (await res.json()) as Record<string, unknown>;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(out).toMatchObject({ detached: true, status: null, signal: null, timedOut: false, stdout: "", stderr: "", changed: false, reload: false });
    expect(typeof out.mtime).toBe("number");
    const run = out.run as string;
    expect(frames.find((f) => f.run === run && f.started)).toMatchObject({ started: { label: "D", detached: true } });
    const exited = await until(() => frames.find((f) => f.run === run && f.exited));
    expect(exited).toMatchObject({ exited: { status: 0 } });
  });

  it("dismiss over the WebSocket kills a detached run", async () => {
    const { ws, frames } = await page("t4");
    const out = (await (await post("Long", { name: "a.pdf", page: 0, x: 1, y: 1, session: "t4" })).json()) as { run: string };
    ws.send(JSON.stringify({ dismiss: out.run }));
    const exited = await until(() => frames.find((f) => f.run === out.run && f.exited));
    expect(exited).toMatchObject({ exited: { signal: "SIGTERM" } });
  });

  it("the upgrade is refused in browser mode and on other paths", async () => {
    const refused = (url: string) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(url);
        ws.addEventListener("open", () => { ws.close(); resolve(false); });
        ws.addEventListener("error", () => resolve(true));
      });
    expect(await refused(`ws://127.0.0.1:${port}/api/other?session=x`)).toBe(true);
    expect(await refused(`ws://127.0.0.1:${port}/api/page`)).toBe(true);
    const srv = createServer({ mode: "browser", notebooksDir: bdir, distDir: null, host: "127.0.0.1", port: 0, commandsFile: null });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    expect(await refused(`ws://127.0.0.1:${(srv.address() as AddressInfo).port}/api/page?session=x`)).toBe(true);
    await new Promise((r) => srv.close(r));
  });
});

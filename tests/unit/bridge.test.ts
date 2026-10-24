import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Bridge, type ExitInfo, type PageSocket } from "../../server/bridge";

/** Stands in for the page's WebSocket: records frames, lets the test speak as the page. */
class FakePage implements PageSocket {
  sent: any[] = [];
  closed = false;
  private messageFns: ((text: string) => void)[] = [];
  private closeFns: (() => void)[] = [];
  private waiters: (() => void)[] = [];
  send(text: string) { this.sent.push(JSON.parse(text)); this.waiters.splice(0).forEach((w) => w()); }
  close() { if (this.closed) return; this.closed = true; this.closeFns.forEach((f) => f()); }
  onMessage(fn: (text: string) => void) { this.messageFns.push(fn); }
  onClose(fn: () => void) { this.closeFns.push(fn); }
  /** Speak as the page. */
  emit(obj: unknown) { this.messageFns.forEach((f) => f(JSON.stringify(obj))); }
  /** Frames with an `id`: the requests relayed from run clients. */
  requests() { return this.sent.filter((f) => "id" in f); }
  async waitFor(pred: (sent: any[]) => boolean): Promise<void> {
    while (!pred(this.sent)) await new Promise<void>((r) => this.waiters.push(r));
  }
}

/** A run-socket client speaking newline-delimited JSON. */
function client(socketPath: string) {
  const sock = net.connect(socketPath);
  sock.setEncoding("utf8");
  sock.on("error", () => {});
  const queue: object[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  let buf = "";
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      queue.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
    wake?.();
  });
  sock.on("close", () => { ended = true; wake?.(); });
  const ready = new Promise<void>((r) => sock.once("connect", () => r()));
  return {
    sock,
    ready,
    send(obj: unknown) { sock.write((typeof obj === "string" ? obj : JSON.stringify(obj)) + "\n"); },
    async *lines(): AsyncIterable<any> {
      for (;;) {
        if (queue.length) { yield queue.shift()!; continue; }
        if (ended) return;
        await new Promise<void>((r) => { wake = r; });
        wake = null;
      }
    },
    /** The next line, or null if the connection closed first. */
    async next(): Promise<any> {
      for await (const line of this.lines()) return line;
      return null;
    },
    /** Resolves once the server has closed the connection. */
    closed: new Promise<void>((r) => sock.on("close", () => r())),
    end() { sock.end(); },
    destroy() { sock.destroy(); },
  };
}

const exit: ExitInfo = { status: 0, signal: null, timedOut: false, stdout: "", changed: false, mtime: null, reload: false };
const runInfo = { session: "s1", label: "L", detached: false, notebook: "n.pdf" };

let dir: string;
let bridge: Bridge;
let page: FakePage;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pib-"));
  bridge = new Bridge({ socketDir: path.join(dir, "s") });
  page = new FakePage();
  bridge.addPage("s1", page);
});

afterEach(async () => {
  await bridge.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Bridge", () => {
  it("creates a short socket path under the socket dir, mode 0600", async () => {
    const run = await bridge.openRun(runInfo, () => {});
    expect(run.id).toMatch(/^[a-z0-9]{6}$/);
    expect(path.dirname(run.socketPath)).toBe(path.join(dir, "s"));
    expect(run.socketPath.length).toBeLessThan(100);
    expect(fs.statSync(run.socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "s")).mode & 0o777).toBe(0o700);
    expect(bridge.runsFor("s1").map((r) => r.id)).toEqual([run.id]);
    expect(page.sent).toContainEqual({ run: run.id, started: { label: "L", detached: false } });
  });

  it("relays a call to the page with a token and routes the reply to the asking client", async () => {
    const run = await bridge.openRun(runInfo, () => {});
    const a = client(run.socketPath);
    const b = client(run.socketPath);
    await Promise.all([a.ready, b.ready]);
    a.send({ id: 1, call: "state" });
    await page.waitFor(() => page.requests().length === 1);
    b.send({ id: 1, call: "state", args: [2] });
    await page.waitFor(() => page.requests().length === 2);
    const [ra, rb] = page.requests();
    expect(ra).toMatchObject({ run: run.id, call: "state" });
    expect(rb).toMatchObject({ run: run.id, call: "state", args: [2] });
    expect(ra.id).not.toBe(rb.id);
    expect(ra.id).toMatch(/^\d+:1$/);
    // Answer the second first.
    page.emit({ run: run.id, id: rb.id, result: "for b" });
    page.emit({ run: run.id, id: ra.id, result: "for a" });
    expect(await b.next()).toEqual({ id: 1, result: "for b" });
    expect(await a.next()).toEqual({ id: 1, result: "for a" });
    a.destroy(); b.destroy();
  });

  it("relays eval and errors, and ignores replies for unknown tokens", async () => {
    const run = await bridge.openRun(runInfo, () => {});
    const c = client(run.socketPath);
    await c.ready;
    c.send({ id: "x", eval: "1+1" });
    await page.waitFor(() => page.requests().length === 1);
    const [req] = page.requests();
    expect(req).toMatchObject({ run: run.id, eval: "1+1" });
    page.emit({ run: run.id, id: "999:x", result: "stray" });
    page.emit({ run: "nope00", id: req.id, result: "stray" });
    page.emit({ run: run.id, id: req.id, error: "boom" });
    expect(await c.next()).toEqual({ id: "x", error: "boom" });
    c.destroy();
  });

  it("answers page gone when the session has no page", async () => {
    const run = await bridge.openRun({ ...runInfo, session: "nobody" }, () => {});
    const c = client(run.socketPath);
    await c.ready;
    c.send({ id: 7, call: "state" });
    expect(await c.next()).toEqual({ id: 7, error: "page gone" });
    const n = await bridge.openRun({ ...runInfo, session: null }, () => {});
    const d = client(n.socketPath);
    await d.ready;
    d.send({ id: 8, eval: "1" });
    expect(await d.next()).toEqual({ id: 8, error: "page gone" });
    c.destroy(); d.destroy();
  });

  it("answers pending requests with page gone when the page closes", async () => {
    const run = await bridge.openRun(runInfo, () => {});
    const c = client(run.socketPath);
    await c.ready;
    c.send({ id: 3, call: "state" });
    await page.waitFor(() => page.requests().length === 1);
    page.close();
    expect(bridge.hasPage("s1")).toBe(false);
    expect(await c.next()).toEqual({ id: 3, error: "page gone" });
    c.destroy();
  });

  it("a replacing page takes over; the old one's close does not drop it", async () => {
    const run = await bridge.openRun(runInfo, () => {});
    const c = client(run.socketPath);
    await c.ready;
    c.send({ id: 1, call: "state" });
    await page.waitFor(() => page.requests().length === 1);
    const fresh = new FakePage();
    bridge.addPage("s1", fresh);
    expect(await c.next()).toEqual({ id: 1, error: "page gone" });
    c.send({ id: 2, call: "state" });
    await fresh.waitFor(() => fresh.requests().length === 1);
    page.close();
    page.emit({ event: "selection", data: {} });
    expect(bridge.hasPage("s1")).toBe(true);
    fresh.emit({ run: run.id, id: fresh.requests()[0].id, result: "fresh" });
    expect(await c.next()).toEqual({ id: 2, result: "fresh" });
    c.destroy();
  });

  it("replies bad json and keeps the connection", async () => {
    const run = await bridge.openRun(runInfo, () => {});
    const c = client(run.socketPath);
    await c.ready;
    c.send("not json");
    c.send({ id: 2, call: "state" });
    expect(await c.next()).toEqual({ error: "bad json" });
    await page.waitFor(() => page.requests().length === 1);
    page.emit({ run: run.id, id: page.requests()[0].id, result: 42 });
    expect(await c.next()).toEqual({ id: 2, result: 42 });
    c.destroy();
  });

  it("handles partial lines and several messages in one chunk", async () => {
    const run = await bridge.openRun(runInfo, () => {});
    const c = client(run.socketPath);
    await c.ready;
    c.sock.write('{"id":1,"ca');
    await new Promise((r) => setTimeout(r, 20));
    c.sock.write('ll":"a"}\n{"id":2,"call":"b"}\n');
    await page.waitFor(() => page.requests().length === 2);
    expect(page.requests().map((r) => r.call)).toEqual(["a", "b"]);
    c.destroy();
  });

  it("fans out subscribed events only to subscribers", async () => {
    const run = await bridge.openRun(runInfo, () => {});
    const a = client(run.socketPath);
    const b = client(run.socketPath);
    await Promise.all([a.ready, b.ready]);
    a.send({ subscribe: ["selection"] });
    // A round trip through the page proves the subscribe line has been read.
    a.send({ id: 1, call: "ping" });
    b.send({ id: 1, call: "ping" });
    await page.waitFor(() => page.requests().length === 2);
    page.emit({ event: "selection", data: { x: 1 } });
    for (const r of page.requests()) page.emit({ run: run.id, id: r.id, result: "pong" });
    const aLines = [await a.next(), await a.next()];
    expect(aLines).toContainEqual({ event: "selection", data: { x: 1 } });
    expect(await b.next()).toEqual({ id: 1, result: "pong" });
    // b got the pong but never the event.
    b.end();
    expect(await b.next()).toBeNull();
    a.destroy();
  });

  it("delivers pending replies after a half-close, then ends", async () => {
    const run = await bridge.openRun(runInfo, () => {});
    const c = client(run.socketPath);
    await c.ready;
    c.send({ id: 5, call: "state" });
    c.end();
    await page.waitFor(() => page.requests().length === 1);
    page.emit({ run: run.id, id: page.requests()[0].id, result: "late" });
    expect(await c.next()).toEqual({ id: 5, result: "late" });
    await c.closed;
  });

  it("forgets a client that disconnects with requests pending", async () => {
    const run = await bridge.openRun(runInfo, () => {});
    const c = client(run.socketPath);
    await c.ready;
    c.send({ id: 1, call: "state" });
    await page.waitFor(() => page.requests().length === 1);
    c.destroy();
    await c.closed;
    await new Promise((r) => setTimeout(r, 20));
    page.emit({ run: run.id, id: page.requests()[0].id, result: "nobody home" });
    // The run still serves new clients.
    const d = client(run.socketPath);
    await d.ready;
    d.send({ id: 1, call: "state" });
    await page.waitFor(() => page.requests().length === 2);
    page.emit({ run: run.id, id: page.requests()[1].id, result: "ok" });
    expect(await d.next()).toEqual({ id: 1, result: "ok" });
    d.destroy();
  });

  it("carries a 3 MB result as one line", async () => {
    const run = await bridge.openRun(runInfo, () => {});
    const c = client(run.socketPath);
    await c.ready;
    c.send({ id: 1, call: "pdf" });
    await page.waitFor(() => page.requests().length === 1);
    page.emit({ run: run.id, id: page.requests()[0].id, result: "x".repeat(3_000_000) });
    const line = await c.next();
    expect(line.id).toBe(1);
    expect(line.result.length).toBe(3_000_000);
    // And a 3 MB request travels the other way.
    c.send({ id: 2, call: "put", args: ["y".repeat(3_000_000)] });
    await page.waitFor(() => page.requests().length === 2);
    expect(page.requests()[1].args[0].length).toBe(3_000_000);
    c.destroy();
  });

  it("closeRun unlinks the socket and tells the page", async () => {
    const run = await bridge.openRun(runInfo, () => {});
    const c = client(run.socketPath);
    await c.ready;
    const done = { ...exit, status: 3, stdout: "hi" };
    await bridge.closeRun(run.id, done);
    expect(fs.existsSync(run.socketPath)).toBe(false);
    expect(page.sent).toContainEqual({ run: run.id, exited: done });
    expect(bridge.runsFor("s1")).toEqual([]);
    await c.closed;
    await bridge.closeRun(run.id, done); // a second close is harmless
  });

  it("killRun sends the exit event before onKill", async () => {
    let id = "";
    const order: string[] = [];
    // A killed process goes away at once: closing the run in onKill must not lose the event.
    const run = await bridge.openRun(runInfo, () => { order.push("kill"); void bridge.closeRun(id, { ...exit, signal: "SIGTERM" }); });
    id = run.id;
    const c = client(run.socketPath);
    await c.ready;
    c.send({ subscribe: [] });
    await new Promise((r) => setTimeout(r, 20));
    bridge.killRun(run.id);
    expect(order).toEqual(["kill"]);
    expect(await c.next()).toEqual({ event: "exit" });
    await c.closed;
  });
});

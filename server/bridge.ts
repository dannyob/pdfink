/**
 * The bridge between pen-menu commands and the browser page.
 *
 * Each command run gets its own Unix socket (its path goes to the command as
 * PDFINK_SOCKET). Anything that connects to it speaks newline-delimited JSON,
 * one object per line, with no length limit:
 *
 *     in:   {"id":I,"call":"name","args":[…]}    call a page function
 *           {"id":I,"eval":"js"}                 evaluate JavaScript in the page
 *           {"subscribe":["selection",…]}        receive these page events
 *     out:  {"id":I,"result":…}                  the page's answer
 *           {"id":I,"error":"…"}                 the page's error, or "page gone"
 *           {"event":"name","data":…}            a subscribed event; "exit" when
 *                                                the run is being killed
 *           {"error":"bad json"}                 a line that did not parse
 *
 * Requests are forwarded over the page's WebSocket (one per browser session)
 * with a server token in place of the client's id, so replies find their way
 * back to the connection that asked:
 *
 *     to page:    {"run":R,"id":T,"call":…,"args":…}  |  {"run":R,"id":T,"eval":…}
 *                 {"run":R,"started":{"label":…,"detached":…}}
 *                 {"run":R,"exited":ExitInfo}
 *     from page:  {"run":R,"id":T,"result":…}  |  {"run":R,"id":T,"error":…}
 *                 {"event":…,"data":…}
 *                 {"bye":true}  |  {"dismiss":R}  |  {"notebook":"name"}
 *
 * T is "<connection-number>:<client id>". A request for a session with no
 * live page is answered at once with "page gone", as are requests still
 * waiting when the page goes away. A client that half-closes (ends its write
 * side) still gets its pending replies; then the server ends the connection.
 *
 * Sessions. A session has at most one live page; a new page for it closes
 * the old one (newest wins). A detached run outlives its page for a grace
 * period (graceMs, default ten minutes) so that a reload or reconnect finds it
 * still going; a normal run is never killed because its page went away.
 *
 *   - page closes:          a grace timer starts; a new page for the session
 *                           cancels it. When it fires, every connection of every
 *                           run on the session gets {"event":"gone"}, then each
 *                           detached run of the session is killed.
 *   - {"bye":true}:         the page is leaving for good; the session's detached
 *                           runs are killed at once.
 *   - {"dismiss":R}:        run R (of this session) is killed.
 *   - {"notebook":N}:       subscribers on the session get
 *                           {"event":"notebook","data":{"name":N}}, then the
 *                           session's detached runs bound to another notebook
 *                           are killed.
 *   - a new detached run with the same label and session as a live detached
 *     run kills the old one first.
 *   - shutdown() kills every run and removes every socket; afterwards pages
 *     are ignored (a new one is closed at once) and no timer is started.
 *
 * Killing a run sends {"event":"exit"} to its connections and calls its onKill
 * once; the run stays until closeRun.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** The page's end of its WebSocket, as the bridge sees it. */
export interface PageSocket {
  send(text: string): void;
  close(): void;
  onMessage(fn: (text: string) => void): void;
  onClose(fn: () => void): void;
}

export interface RunInfo {
  /** Six base-36 characters. */
  id: string;
  /** Browser session the run talks to; null when it has none. */
  session: string | null;
  label: string;
  detached: boolean;
  notebook: string;
  socketPath: string;
}

export interface ExitInfo {
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  changed: boolean;
  mtime: number | null;
  reload: boolean;
}

export interface BridgeOptions {
  /** Where run sockets live; default path.join(os.tmpdir(), "pdfink"). */
  socketDir?: string;
  /** How long a session outlives its page, in ms; default 600_000. */
  graceMs?: number;
}

type Json = Record<string, unknown>;

/** One client connection to a run's socket. */
interface Conn {
  n: number;
  socket: net.Socket;
  /** Token → the client's own id, for requests the page has not answered. */
  pending: Map<string, unknown>;
  subs: Set<string>;
  /** The client has ended its write side. */
  halfClosed: boolean;
}

interface Run {
  info: RunInfo;
  server: net.Server;
  conns: Set<Conn>;
  onKill: () => void;
  /** killRun has been called; onKill is not called again. */
  killed: boolean;
}

interface Session {
  /** The live page, or null while the session waits out its grace period. */
  socket: PageSocket | null;
  graceTimer: NodeJS.Timeout | null;
}

/** Calls `onLine` for each "\n"-terminated line; buffers partial lines however long. */
function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf("\n", start)) >= 0) {
      const line = buf.slice(start, nl).replace(/\r$/, "");
      start = nl + 1;
      if (line.trim()) onLine(line);
    }
    buf = buf.slice(start);
  };
}

function parse(text: string): Json | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function newRunId(): string {
  return crypto.randomInt(36 ** 6).toString(36).padStart(6, "0");
}

function write(conn: Conn, obj: unknown): void {
  if (conn.socket.writable) conn.socket.write(JSON.stringify(obj) + "\n");
}

/** End a connection once its queued output has gone out. */
function endConn(conn: Conn): void {
  conn.socket.end(() => conn.socket.destroy());
}

export class Bridge {
  private readonly socketDir: string;
  readonly graceMs: number;
  private readonly runs = new Map<string, Run>();
  private readonly sessions = new Map<string, Session>();
  private connCount = 0;
  /** shutdown() has been called: pages are turned away and start no timers. */
  private closed = false;

  constructor(opts: BridgeOptions = {}) {
    this.socketDir = opts.socketDir ?? path.join(os.tmpdir(), "pdfink");
    this.graceMs = opts.graceMs ?? 600_000;
  }

  addPage(session: string, socket: PageSocket): void {
    if (this.closed) return socket.close();
    let s = this.sessions.get(session);
    if (!s) this.sessions.set(session, (s = { socket: null, graceTimer: null }));
    const entry = s;
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
    // A new page replaces the old one; what the old one was asked is lost.
    const previous = entry.socket;
    entry.socket = socket;
    if (previous) {
      this.failPending(session);
      previous.close();
    }
    socket.onMessage((text) => { if (entry.socket === socket) this.fromPage(session, text); });
    socket.onClose(() => {
      if (entry.socket !== socket) return;
      entry.socket = null;
      this.failPending(session);
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
      entry.graceTimer = setTimeout(() => this.graceExpired(session, entry), this.graceMs);
    });
  }

  hasPage(session: string): boolean {
    return !!this.sessions.get(session)?.socket;
  }

  async openRun(info: Omit<RunInfo, "id" | "socketPath">, onKill: () => void): Promise<RunInfo> {
    fs.mkdirSync(this.socketDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.socketDir, 0o700);
    if (info.detached) {
      for (const r of this.runs.values()) {
        if (r.info.detached && r.info.session === info.session && r.info.label === info.label) this.killRun(r.info.id);
      }
    }
    let id = newRunId();
    while (this.runs.has(id)) id = newRunId();
    const socketPath = path.join(this.socketDir, `${id}.sock`);
    fs.rmSync(socketPath, { force: true });
    const run: Run = { info: { ...info, id, socketPath }, server: net.createServer({ allowHalfOpen: true }), conns: new Set(), onKill, killed: false };
    run.server.on("connection", (socket) => this.accept(run, socket));
    await new Promise<void>((resolve, reject) => {
      run.server.once("error", reject);
      run.server.listen(socketPath, () => { run.server.off("error", reject); resolve(); });
    });
    run.server.on("error", () => {});
    fs.chmodSync(socketPath, 0o600);
    this.runs.set(id, run);
    if (info.session !== null) this.toPage(info.session, { run: id, started: { label: info.label, detached: info.detached } });
    return run.info;
  }

  async closeRun(id: string, exit: ExitInfo): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    await this.dispose(run);
    if (run.info.session !== null) this.toPage(run.info.session, { run: id, exited: exit });
  }

  killRun(id: string): void {
    const run = this.runs.get(id);
    if (!run || run.killed) return;
    run.killed = true;
    for (const conn of run.conns) write(conn, { event: "exit" });
    run.onKill();
  }

  runsFor(session: string): RunInfo[] {
    return [...this.runs.values()].filter((r) => r.info.session === session).map((r) => r.info);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const s of this.sessions.values()) {
      if (s.graceTimer) clearTimeout(s.graceTimer);
      // Detach the page so its later close (the server tears it down) starts no timer.
      s.socket = null;
    }
    this.sessions.clear();
    const runs = [...this.runs.values()];
    for (const r of runs) this.killRun(r.info.id);
    await Promise.all(runs.map((r) => this.dispose(r)));
  }

  /** Stop listening, end every connection and remove the socket file. */
  private async dispose(run: Run): Promise<void> {
    this.runs.delete(run.info.id);
    const closed = new Promise<void>((r) => run.server.close(() => r()));
    for (const conn of run.conns) endConn(conn);
    fs.rmSync(run.info.socketPath, { force: true });
    await closed;
  }

  private accept(run: Run, socket: net.Socket): void {
    const conn: Conn = { n: ++this.connCount, socket, pending: new Map(), subs: new Set(), halfClosed: false };
    run.conns.add(conn);
    socket.setEncoding("utf8");
    socket.on("data", lineSplitter((line) => this.fromClient(run, conn, line)));
    socket.on("end", () => {
      conn.halfClosed = true;
      if (conn.pending.size === 0) endConn(conn);
    });
    socket.on("error", () => {});
    socket.on("close", () => run.conns.delete(conn));
  }

  private fromClient(run: Run, conn: Conn, line: string): void {
    if (!this.runs.has(run.info.id)) return; // the run is closing
    const msg = parse(line);
    if (!msg) return write(conn, { error: "bad json" });
    if (Array.isArray(msg.subscribe)) {
      for (const name of msg.subscribe) if (typeof name === "string") conn.subs.add(name);
      return;
    }
    const isCall = typeof msg.call === "string";
    const isEval = typeof msg.eval === "string";
    if (!("id" in msg) || (!isCall && !isEval)) return write(conn, "id" in msg ? { id: msg.id, error: "bad request" } : { error: "bad request" });
    const session = run.info.session;
    if (session === null || !this.hasPage(session)) return write(conn, { id: msg.id, error: "page gone" });
    const token = `${conn.n}:${String(msg.id)}`;
    conn.pending.set(token, msg.id);
    const frame = isCall ? { run: run.info.id, id: token, call: msg.call, args: Array.isArray(msg.args) ? msg.args : [] } : { run: run.info.id, id: token, eval: msg.eval };
    this.toPage(session, frame);
  }

  private fromPage(session: string, text: string): void {
    const msg = parse(text);
    if (!msg) return;
    if (typeof msg.event === "string") return this.fanOut(session, msg.event, msg.data);
    if (typeof msg.run === "string" && typeof msg.id === "string") {
      const run = this.runs.get(msg.run);
      if (!run || run.info.session !== session) return;
      const n = Number(msg.id.slice(0, msg.id.indexOf(":")));
      const conn = [...run.conns].find((c) => c.n === n);
      if (!conn || !conn.pending.has(msg.id)) return;
      this.reply(conn, msg.id, "error" in msg ? { error: msg.error } : { result: msg.result });
    }
    if (msg.bye === true) return this.killDetached(session, () => true);
    if (typeof msg.dismiss === "string") {
      if (this.runs.get(msg.dismiss)?.info.session === session) this.killRun(msg.dismiss);
      return;
    }
    if (typeof msg.notebook === "string") {
      const name = msg.notebook;
      this.fanOut(session, "notebook", { name });
      this.killDetached(session, (r) => r.info.notebook !== name);
    }
  }

  /** Send an event to the session's connections subscribed to it. */
  private fanOut(session: string, event: string, data: unknown): void {
    for (const run of this.runs.values()) {
      if (run.info.session !== session) continue;
      for (const conn of run.conns) if (conn.subs.has(event)) write(conn, { event, data });
    }
  }

  /** Kill the session's detached runs that match. */
  private killDetached(session: string, match: (run: Run) => boolean): void {
    for (const run of [...this.runs.values()]) {
      if (run.info.session === session && run.info.detached && match(run)) this.killRun(run.info.id);
    }
  }

  /** The session's page did not come back in time. */
  private graceExpired(session: string, entry: Session): void {
    entry.graceTimer = null;
    if (this.sessions.get(session) === entry) this.sessions.delete(session);
    for (const run of this.runs.values()) {
      if (run.info.session === session) for (const conn of run.conns) write(conn, { event: "gone" });
    }
    this.killDetached(session, () => true);
  }

  /** Answer a pending request, ending a half-closed connection once nothing is left. */
  private reply(conn: Conn, token: string, body: Json): void {
    const id = conn.pending.get(token);
    conn.pending.delete(token);
    write(conn, { id, ...body });
    if (conn.halfClosed && conn.pending.size === 0) endConn(conn);
  }

  /** The page for a session has gone: nothing waiting on it will be answered. */
  private failPending(session: string): void {
    for (const run of this.runs.values()) {
      if (run.info.session !== session) continue;
      for (const conn of run.conns) for (const token of [...conn.pending.keys()]) this.reply(conn, token, { error: "page gone" });
    }
  }

  private toPage(session: string, frame: Json): void {
    this.sessions.get(session)?.socket?.send(JSON.stringify(frame));
  }
}

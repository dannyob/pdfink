/**
 * User commands for the pen menu, read from a small text file:
 *
 *     # one section per menu item
 *     [Draw a star]
 *     command = tools/star.py "$PDF" "$PAGE" "$X" "$Y"
 *     reload = true          # reopen the notebook in the browser afterwards
 *     confirm = false        # ask before running
 *     timeout = 60           # seconds; 0 = no timeout (the default for detached commands)
 *     detach = false         # keep running after the menu returns
 *
 * The command runs under `sh -c` with the working directory set to the
 * folder holding the config file, and these variables in its environment
 * (so quote them as you would any shell variable):
 *
 *     PDF          absolute path of the notebook being edited
 *     NAME         its file name
 *     NOTEBOOKS    the notebooks folder
 *     PAGE         page number, 1-based
 *     PAGES        number of pages
 *     X, Y         pen position in PDF user space (points, origin bottom-left,
 *                  rotation already accounted for): what PDF tools expect
 *     DX, DY       the same point in display space (points, origin top-left)
 *     PAGE_WIDTH, PAGE_HEIGHT   the page's crop box size in PDF space
 *     ROTATE       the page's /Rotate (0, 90, 180, 270)
 *     SELECTED     number of selected items (strokes and images), or empty
 *                  when nothing is selected
 *     SEL_PAGE     page of the selection, 1-based (empty without a selection)
 *     SEL_X, SEL_Y, SEL_W, SEL_H   the selection's bounding box in PDF user
 *                  space (points, origin bottom-left; empty without a selection)
 *     PDFINK_SOCKET  where the command can talk back to the page, when the
 *                  server provides one
 *     PDFINK_RUN   identifier of this run, when the server provides one
 *
 * The file is re-read whenever the menu asks for it, so edits apply at once.
 *
 * Commands run headless. On macOS they must stay out of Desktop, Documents
 * and Downloads (and symlinks into them): the system gates those behind a
 * consent dialog that a child of a launchd service cannot show, so open()
 * blocks until the timeout kills the command.
 */
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

export interface CommandSpec {
  /** Stable identifier the client sends back: the label. */
  id: string;
  label: string;
  command: string;
  reload: boolean;
  confirm: boolean;
  /** Seconds before the command is killed; 0 = never. */
  timeout: number;
  /** Runs on after the menu returns, rather than being waited for. */
  detach: boolean;
}

/** The current selection's bounding box: PDF points, origin bottom-left. */
export interface SelectionContext {
  /** 1-based. */
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Number of selected items (strokes and images). */
  count: number;
}

export interface CommandContext {
  pdf: string;
  name: string;
  notebooks: string;
  page: number;
  pages: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  pageWidth: number;
  pageHeight: number;
  rotate: number;
  selection?: SelectionContext | null;
}

export interface CommandResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** A started command: its result arrives on `done`; `kill` ends it early. */
export interface RunningCommand {
  pid: number | undefined;
  done: Promise<CommandResult>;
  kill(): void;
}

const TRUE = new Set(["1", "true", "yes", "on"]);
const OUTPUT_CAP = 64 * 1024;

function flag(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  return TRUE.has(v.trim().toLowerCase());
}

/** Parse the config text. Malformed sections are skipped, never fatal. */
export function parseCommands(text: string): CommandSpec[] {
  const out: CommandSpec[] = [];
  const seen = new Set<string>();
  let cur: { label: string; kv: Record<string, string> } | null = null;
  const flush = () => {
    if (!cur) return;
    const command = cur.kv.command?.trim();
    if (command) {
      let id = cur.label;
      for (let n = 2; seen.has(id); n++) id = `${cur.label} (${n})`;
      seen.add(id);
      const t = Number(cur.kv.timeout);
      const detach = flag(cur.kv.detach, false);
      out.push({
        id,
        label: cur.label,
        command,
        reload: flag(cur.kv.reload, false),
        confirm: flag(cur.kv.confirm, false),
        timeout: Number.isFinite(t) && t >= 0 && cur.kv.timeout?.trim() ? t : detach ? 0 : 60,
        detach,
      });
    }
    cur = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      flush();
      cur = { label: sec[1].trim(), kv: {} };
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || !cur) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    // Trailing comments on flag lines only; a command line may contain '#'.
    if (key !== "command") value = value.replace(/\s+[#;].*$/, "");
    cur.kv[key] = value;
  }
  flush();
  return out;
}

/** Commands from `file`, or none when the file does not exist. */
export async function loadCommands(file: string | null): Promise<CommandSpec[]> {
  if (!file) return [];
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch {
    return [];
  }
  return parseCommands(text);
}

/** Start one command with the context in its environment; never throws. */
export function startCommand(spec: CommandSpec, ctx: CommandContext, cwd: string, extraEnv: Record<string, string> = {}): RunningCommand {
  const num = (n: number) => String(Math.round(n * 1000) / 1000);
  const sel = ctx.selection;
  const env = {
    ...process.env,
    PDF: ctx.pdf,
    NAME: ctx.name,
    NOTEBOOKS: ctx.notebooks,
    PAGE: String(ctx.page),
    PAGES: String(ctx.pages),
    X: num(ctx.x),
    Y: num(ctx.y),
    DX: num(ctx.dx),
    DY: num(ctx.dy),
    PAGE_WIDTH: num(ctx.pageWidth),
    PAGE_HEIGHT: num(ctx.pageHeight),
    ROTATE: String(ctx.rotate),
    SELECTED: sel ? String(sel.count) : "",
    SEL_PAGE: sel ? String(sel.page) : "",
    SEL_X: sel ? num(sel.x) : "",
    SEL_Y: sel ? num(sel.y) : "",
    SEL_W: sel ? num(sel.w) : "",
    SEL_H: sel ? num(sel.h) : "",
    ...extraEnv,
  };
  // Own process group, so a kill reaches the whole tree: killing just `sh`
  // would leave its child running and holding our pipes open.
  const child = spawn("/bin/sh", ["-c", spec.command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let finished = false;
  let killing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (r: CommandResult) => void;
  const done = new Promise<CommandResult>((r) => (resolve = r));
  const finish = (r: CommandResult) => {
    if (finished) return;
    finished = true;
    // The process group id may be reused once it has gone, and a live timer holds the loop open.
    clearTimeout(timer);
    clearTimeout(hardKill);
    clearTimeout(giveUp);
    resolve(r);
  };
  const take = (cur: string, chunk: Buffer) => (cur.length < OUTPUT_CAP ? cur + chunk.toString("utf8") : cur);
  child.stdout.on("data", (c: Buffer) => (stdout = take(stdout, c)));
  child.stderr.on("data", (c: Buffer) => (stderr = take(stderr, c)));
  const killTree = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      child.kill(sig);
    }
  };
  const kill = (note = "") => {
    if (finished || killing) return;
    killing = true;
    killTree("SIGTERM");
    hardKill = setTimeout(() => killTree("SIGKILL"), 2000);
    // Even if something survives and keeps a pipe open, answer the client.
    giveUp = setTimeout(() => finish({ status: null, signal: "SIGKILL", stdout, stderr: stderr + note, timedOut }), 4000);
  };
  if (spec.timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      kill(`\n(killed after ${spec.timeout}s)`);
    }, spec.timeout * 1000);
  }
  child.on("error", (err) => finish({ status: null, signal: null, stdout, stderr: stderr + err.message, timedOut }));
  child.on("close", (status, signal) => finish({ status, signal, stdout, stderr, timedOut }));
  return { pid: child.pid, done, kill: () => kill() };
}

/** Run one command to completion; never throws. */
export function runCommand(spec: CommandSpec, ctx: CommandContext, cwd: string, extraEnv?: Record<string, string>): Promise<CommandResult> {
  return startCommand(spec, ctx, cwd, extraEnv).done;
}

/** Default location: beside the notebooks. */
export function defaultCommandsFile(notebooksDir: string): string {
  return path.join(notebooksDir, "pdfink-commands.conf");
}

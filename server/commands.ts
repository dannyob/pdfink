/**
 * User commands for the pen menu, read from a small text file:
 *
 *     # one section per menu item
 *     [Draw a star]
 *     command = tools/star.py "$PDF" "$PAGE" "$X" "$Y"
 *     reload = true          # reopen the notebook in the browser afterwards
 *     confirm = false        # ask before running
 *     timeout = 60           # seconds
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
 *
 * The file is re-read whenever the menu asks for it, so edits apply at once.
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
  /** Seconds before the command is killed. */
  timeout: number;
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
}

export interface CommandResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
      out.push({
        id,
        label: cur.label,
        command,
        reload: flag(cur.kv.reload, false),
        confirm: flag(cur.kv.confirm, false),
        timeout: Number.isFinite(t) && t > 0 ? t : 60,
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

/** Run one command with the context in its environment; never throws. */
export function runCommand(spec: CommandSpec, ctx: CommandContext, cwd: string): Promise<CommandResult> {
  const num = (n: number) => String(Math.round(n * 1000) / 1000);
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
  };
  return new Promise((resolve) => {
    // Own process group, so a timeout can kill the whole tree: killing just
    // `sh` would leave its child running and holding our pipes open.
    const child = spawn("/bin/sh", ["-c", spec.command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const finish = (r: CommandResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
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
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 2000);
      // Even if something survives and keeps a pipe open, answer the client.
      setTimeout(() => finish({ status: null, signal: "SIGKILL", stdout, stderr: stderr + `\n(killed after ${spec.timeout}s)`, timedOut }), 4000);
    }, spec.timeout * 1000);
    child.on("error", (err) => finish({ status: null, signal: null, stdout, stderr: stderr + err.message, timedOut }));
    child.on("close", (status, signal) => finish({ status, signal, stdout, stderr, timedOut }));
  });
}

/** Default location: beside the notebooks. */
export function defaultCommandsFile(notebooksDir: string): string {
  return path.join(notebooksDir, "pdfink-commands.conf");
}

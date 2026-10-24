import { describe, expect, it, vi } from "vitest";
import { parseCommands, runCommand, startCommand, type CommandContext } from "../../server/commands";

const ctx: CommandContext = { pdf: "/tmp/n b.pdf", name: "n b.pdf", notebooks: "/tmp", page: 2, pages: 3, x: 100.5, y: 691.25, dx: 100.5, dy: 100.75, pageWidth: 612, pageHeight: 792, rotate: 0 };
const cwd = "/tmp";

describe("commands file", () => {
  it("parses sections, flags and comments", () => {
    const cmds = parseCommands(`
# comment
[Draw a star]
command = tools/star.py "$PDF" "$PAGE" "$X" "$Y"   # has a hash in it
reload = yes

[Quiet]
command = echo hi
confirm = true ; trailing comment
timeout = 5

[No command here]
reload = true

[Draw a star]
command = echo again
`);
    expect(cmds).toHaveLength(3);
    expect(cmds[0]).toMatchObject({ id: "Draw a star", label: "Draw a star", command: 'tools/star.py "$PDF" "$PAGE" "$X" "$Y"   # has a hash in it', reload: true, confirm: false, timeout: 60 });
    expect(cmds[1]).toMatchObject({ id: "Quiet", reload: false, confirm: true, timeout: 5 });
    expect(cmds[2].id).toBe("Draw a star (2)"); // duplicate labels stay addressable
  });

  it("runs under sh with the context in the environment", async () => {
    const spec = { id: "t", label: "t", command: 'printf "%s|%s|%s|%s|%s|%s" "$PDF" "$PAGE" "$PAGES" "$X" "$Y" "$NAME"', reload: false, confirm: false, timeout: 10, detach: false };
    const r = await runCommand(spec, ctx, "/tmp");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("/tmp/n b.pdf|2|3|100.5|691.25|n b.pdf");
  });

  it("reports failure and kills on timeout", async () => {
    const bad = await runCommand({ id: "b", label: "b", command: "echo oops >&2; exit 3", reload: false, confirm: false, timeout: 10, detach: false }, ctx, "/tmp");
    expect(bad.status).toBe(3);
    expect(bad.stderr.trim()).toBe("oops");
    const slow = await runCommand({ id: "s", label: "s", command: "sleep 5", reload: false, confirm: false, timeout: 0.3, detach: false }, ctx, "/tmp");
    expect(slow.timedOut).toBe(true);
    expect(slow.status).not.toBe(0);
    // A grandchild holding the pipes must not keep the request hanging.
    const t0 = Date.now();
    const tree = await runCommand({ id: "t", label: "t", command: "sh -c 'sleep 30' & wait", reload: false, confirm: false, timeout: 0.3, detach: false }, ctx, "/tmp");
    expect(tree.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("parses detach and gives detached commands no timeout by default", () => {
    const [a, b, c] = parseCommands("[A]\ncommand = true\ndetach = yes\n[B]\ncommand = true\n[C]\ncommand = true\ndetach = true\ntimeout = 5\n");
    expect(a.detach).toBe(true); expect(a.timeout).toBe(0);
    expect(b.detach).toBe(false); expect(b.timeout).toBe(60);
    expect(c.timeout).toBe(5);
  });

  it("puts the selection and extra env in the environment, empty when there is none", async () => {
    const spec = parseCommands('[E]\ncommand = printf "%s|%s|%s|%s|%s|%s|%s" "$SELECTED" "$SEL_PAGE" "$SEL_X" "$SEL_Y" "$SEL_W" "$SEL_H" "$PDFINK_RUN"')[0];
    const r1 = await runCommand(spec, { ...ctx, selection: { page: 2, x: 10, y: 20, w: 30.5, h: 40, count: 3 } }, cwd, { PDFINK_RUN: "abc123" });
    expect(r1.stdout).toBe("3|2|10|20|30.5|40|abc123");
    const r2 = await runCommand(spec, { ...ctx, selection: null }, cwd);
    expect(r2.stdout).toBe("||||||");
  });

  it("startCommand exposes pid and kill, and kill resolves done with a signal", async () => {
    const spec = parseCommands("[S]\ncommand = sleep 30")[0];
    const h = startCommand(spec, ctx, cwd);
    expect(h.pid).toBeGreaterThan(0);
    h.kill();
    const r = await h.done;
    expect(r.signal).toBe("SIGTERM");
  });

  it("timeout = 0 means no timeout for any command; absent or bad values keep the defaults", () => {
    const [zero, zeroDetached, absent, absentDetached, negative, junk] = parseCommands(
      "[Z]\ncommand = true\ntimeout = 0\n[ZD]\ncommand = true\ndetach = true\ntimeout = 0\n[A]\ncommand = true\n[AD]\ncommand = true\ndetach = true\n" +
        "[N]\ncommand = true\ntimeout = -5\n[J]\ncommand = true\ntimeout = soon",
    );
    expect(zero.timeout).toBe(0);
    expect(zeroDetached.timeout).toBe(0);
    expect(absent.timeout).toBe(60);
    expect(absentDetached.timeout).toBe(0);
    expect(negative.timeout).toBe(60);
    expect(junk.timeout).toBe(60);
  });

  it("startCommand with timeout 0 sets no timer", async () => {
    vi.useFakeTimers();
    try {
      const h = startCommand(parseCommands("[Z]\ncommand = sleep 30\ntimeout = 0")[0], ctx, cwd);
      let settled = false;
      void h.done.then(() => (settled = true));
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(61_000);
      await Promise.resolve();
      expect(settled).toBe(false);
      vi.useRealTimers();
      h.kill();
      expect((await h.done).timedOut).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

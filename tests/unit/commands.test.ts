import { describe, expect, it } from "vitest";
import { parseCommands, runCommand, type CommandContext } from "../../server/commands";

const ctx: CommandContext = { pdf: "/tmp/n b.pdf", name: "n b.pdf", notebooks: "/tmp", page: 2, pages: 3, x: 100.5, y: 691.25, dx: 100.5, dy: 100.75, pageWidth: 612, pageHeight: 792, rotate: 0 };

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
    const spec = { id: "t", label: "t", command: 'printf "%s|%s|%s|%s|%s|%s" "$PDF" "$PAGE" "$PAGES" "$X" "$Y" "$NAME"', reload: false, confirm: false, timeout: 10 };
    const r = await runCommand(spec, ctx, "/tmp");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("/tmp/n b.pdf|2|3|100.5|691.25|n b.pdf");
  });

  it("reports failure and kills on timeout", async () => {
    const bad = await runCommand({ id: "b", label: "b", command: "echo oops >&2; exit 3", reload: false, confirm: false, timeout: 10 }, ctx, "/tmp");
    expect(bad.status).toBe(3);
    expect(bad.stderr.trim()).toBe("oops");
    const slow = await runCommand({ id: "s", label: "s", command: "sleep 5", reload: false, confirm: false, timeout: 0.3 }, ctx, "/tmp");
    expect(slow.timedOut).toBe(true);
    expect(slow.status).not.toBe(0);
    // A grandchild holding the pipes must not keep the request hanging.
    const t0 = Date.now();
    const tree = await runCommand({ id: "t", label: "t", command: "sh -c 'sleep 30' & wait", reload: false, confirm: false, timeout: 0.3 }, ctx, "/tmp");
    expect(tree.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(6000);
  });
});

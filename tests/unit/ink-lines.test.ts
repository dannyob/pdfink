import { describe, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const haveUv = spawnSync("uv", ["--version"]).status === 0;

describe.skipIf(!haveUv)("tools/ink_lines.py", () => {
  it("passes its own unittest suite on synthetic strokes", () => {
    // Throws (failing the test) when the Python suite exits non-zero.
    execFileSync("uv", ["run", "--script", path.resolve("tools/tests/test_ink_lines.py")], { encoding: "utf8", stdio: "pipe", timeout: 120_000 });
  }, 130_000);
});

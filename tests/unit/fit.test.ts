import { describe, expect, it } from "vitest";
import { fitGroups } from "../../src/fit";

const MOVABLE = ["page", "clipboard", "style"];
// Widths as the toolbar measures them: each group with its separator and gap.
const widths = { file: 400, tools: 180, style: 70, clipboard: 240, history: 120, page: 60, commands: 90, spacer: 12, more: 60 };
const total = Object.values(widths).reduce((a, b) => a + b, 0);

describe("fitGroups", () => {
  it("moves nothing when everything fits", () => {
    expect(fitGroups(widths, total, MOVABLE)).toEqual([]);
    expect(fitGroups(widths, total + 500, MOVABLE)).toEqual([]);
  });

  it("moves the first movable group when 30 px short", () => {
    expect(fitGroups(widths, total - 30, MOVABLE)).toEqual(["page"]);
  });

  it("moves the next one when the first is not enough", () => {
    expect(fitGroups(widths, total - 61, MOVABLE)).toEqual(["page", "clipboard"]);
    expect(fitGroups(widths, total - 300, MOVABLE)).toEqual(["page", "clipboard"]);
  });

  it("moves all of them when even that does not fit", () => {
    expect(fitGroups(widths, total - 301, MOVABLE)).toEqual(["page", "clipboard", "style"]);
    expect(fitGroups(widths, 100, MOVABLE)).toEqual(["page", "clipboard", "style"]);
  });

  it("keeps the movable order, skipping names with no width", () => {
    expect(fitGroups({ a: 10, b: 10 }, 5, ["missing", "b"])).toEqual(["b"]);
  });
});

import { describe, expect, it } from "vitest";
import { barrelHeuristic, heuristicOnly, hoverErase, wantsErase, writingPressure } from "../../src/stylus";

const pen = (buttons: number, pressure: number) => ({ pointerType: "pen", buttons, pressure });

describe("erase intent from pen samples", () => {
  it("eraser end (buttons 32) always erases", () => {
    expect(wantsErase(pen(32, 0.4), false)).toBe(true);
    expect(wantsErase(pen(32, 0.4), true)).toBe(true);
  });

  it("spec barrel bit (2) always erases, touching or hovering", () => {
    expect(wantsErase(pen(3, 0.5), false)).toBe(true);
    expect(hoverErase(pen(2, 0), false)).toBe(true);
  });

  it("ordinary writing never erases", () => {
    for (const p of [0.05, 0.3, 0.6, 0.99]) {
      expect(wantsErase(pen(1, p), true)).toBe(false);
      expect(writingPressure(pen(1, p))).toBe(true);
    }
  });

  it("no-brand EMR pen: barrel while touching pins pressure to 1", () => {
    expect(barrelHeuristic(pen(1, 1))).toBe(true);
    expect(wantsErase(pen(1, 1), true)).toBe(true);
    expect(wantsErase(pen(1, 1), false)).toBe(false);
    expect(heuristicOnly(pen(1, 1), true)).toBe(true);
  });

  it("King Write: barrel while hovering gives contact bit with zero pressure", () => {
    expect(barrelHeuristic(pen(1, 0))).toBe(true);
    expect(hoverErase(pen(1, 0), true)).toBe(true);
    expect(hoverErase(pen(1, 0), false)).toBe(false);
  });

  it("hovering with no button is not an erase", () => {
    expect(hoverErase(pen(0, 0), true)).toBe(false);
    expect(wantsErase(pen(0, 0), true)).toBe(false);
  });

  it("mouse and touch are left alone", () => {
    expect(wantsErase({ pointerType: "mouse", buttons: 1, pressure: 1 }, true)).toBe(false);
    expect(wantsErase({ pointerType: "touch", buttons: 1, pressure: 0 }, true)).toBe(false);
    expect(hoverErase({ pointerType: "mouse", buttons: 2, pressure: 0 }, true)).toBe(false);
  });

  it("spec bits are not reported as heuristic-only", () => {
    expect(heuristicOnly(pen(32, 1), true)).toBe(false);
    expect(heuristicOnly(pen(3, 1), true)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { DOUBLE_PRESS_MS, DOUBLE_PRESS_SLOP, DoublePress } from "../../src/double-press";

describe("DoublePress", () => {
  it("a second press soon after and close by is a double press", () => {
    const d = new DoublePress();
    expect(d.press(1000, 100, 100)).toBe(false);
    expect(d.press(1000 + 300, 103, 98)).toBe(true);
  });

  it("uses the usual mouse limits: 500 ms and a few pixels", () => {
    expect(DOUBLE_PRESS_MS).toBe(500);
    expect(DOUBLE_PRESS_SLOP).toBe(8);
  });

  it("too slow is two single presses", () => {
    const d = new DoublePress();
    d.press(0, 50, 50);
    expect(d.press(DOUBLE_PRESS_MS + 1, 50, 50)).toBe(false);
  });

  it("too far apart is two single presses", () => {
    const d = new DoublePress();
    d.press(0, 50, 50);
    expect(d.press(100, 50 + DOUBLE_PRESS_SLOP + 1, 50)).toBe(false);
  });

  it("a third quick press does not make a second double press", () => {
    const d = new DoublePress();
    d.press(0, 50, 50);
    expect(d.press(100, 50, 50)).toBe(true);
    expect(d.press(200, 50, 50)).toBe(false);
    expect(d.press(300, 50, 50)).toBe(true);
  });

  it("a press after a too-slow one can start a new double press", () => {
    const d = new DoublePress();
    d.press(0, 50, 50);
    expect(d.press(900, 50, 50)).toBe(false);
    expect(d.press(1100, 50, 50)).toBe(true);
  });
});

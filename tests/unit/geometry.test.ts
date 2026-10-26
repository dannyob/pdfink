import { describe, expect, it } from "vitest";
import { strokeBounds, strokeHit, strokeInRect, translateStroke, normalizeRect } from "../../src/geometry";
import type { Stroke } from "../../src/model";

const s: Stroke = {
  id: "a",
  color: "#000000",
  width: 2,
  opacity: 1,
  points: [
    { x: 10, y: 10, p: 0.6 },
    { x: 50, y: 10, p: 0.6 },
    { x: 50, y: 40, p: 0.6 },
  ],
};

describe("geometry", () => {
  it("computes stroke bounds including width", () => {
    expect(strokeBounds(s)).toEqual({ x: 9, y: 9, w: 42, h: 32 });
  });
  it("hit-tests near a segment", () => {
    expect(strokeHit(s, { x: 30, y: 12, p: 0 }, 3)).toBe(true);
    expect(strokeHit(s, { x: 30, y: 20, p: 0 }, 3)).toBe(false);
    expect(strokeHit(s, { x: 52, y: 25, p: 0 }, 3)).toBe(true);
  });
  it("selects strokes with any point in rect", () => {
    expect(strokeInRect(s, { x: 0, y: 0, w: 20, h: 20 })).toBe(true);
    expect(strokeInRect(s, { x: 60, y: 60, w: 20, h: 20 })).toBe(false);
  });
  it("translates", () => {
    expect(translateStroke(s, 5, -5).points[0]).toEqual({ x: 15, y: 5, p: 0.6 });
  });
  it("normalizes rects", () => {
    expect(normalizeRect(10, 20, 0, 5)).toEqual({ x: 0, y: 5, w: 10, h: 15 });
  });
});

describe("strokeInRect with thinned strokes", () => {
  const s = (pts: [number, number][]) => ({ id: "s", color: "#000", width: 1, opacity: 1, points: pts.map(([x, y]) => ({ x, y, p: 0.6 })) });
  it("counts a stroke whose line crosses the rect even when no point is inside", () => {
    expect(strokeInRect(s([[0, 50], [300, 50]]), { x: 100, y: 40, w: 50, h: 20 })).toBe(true);
  });
  it("counts a diagonal crossing a corner of the rect", () => {
    expect(strokeInRect(s([[90, 50], [110, 30]]), { x: 100, y: 40, w: 50, h: 20 })).toBe(true);
  });
  it("does not count a line that passes beside the rect", () => {
    expect(strokeInRect(s([[0, 10], [300, 10]]), { x: 100, y: 40, w: 50, h: 20 })).toBe(false);
    expect(strokeInRect(s([[90, 30], [99, 39]]), { x: 100, y: 40, w: 50, h: 20 })).toBe(false);
  });
  it("still counts a single dot inside", () => {
    expect(strokeInRect(s([[120, 50]]), { x: 100, y: 40, w: 50, h: 20 })).toBe(true);
  });
});

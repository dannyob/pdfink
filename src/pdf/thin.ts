import type { Point } from "../model.ts";

/**
 * How far, in PDF points, a thinned stroke may stray from the pen's path.
 * A twentieth of a point is about 0.02 mm: invisible at any zoom a tablet uses,
 * and it removes most of the points a stylus samples along a smooth line.
 */
export const INK_TOLERANCE = 0.05;

/**
 * The `/PdfinkInk` value pdfink writes on its ink annotations: ink carrying it
 * was thinned before it was saved, so import leaves it as it is (thinning it
 * again after the save's rounding could drop a point and change the stroke).
 */
export const THINNED_INK_VERSION = 2;

const round = (v: number, places: number) => {
  const k = 10 ** places;
  return Math.round(v * k) / k;
};

/**
 * A point on the grid saves keep: hundredths of a point, thousandths of
 * pressure. Import re-rounds pdfink's own ink with it, so the float noise of
 * the page transform (792 − 59.05 = 732.9499999…) cannot change a stroke, or
 * its OCR line signature, across a save and reload.
 */
export function roundPoint(p: Point): Point {
  return { x: round(p.x, 2), y: round(p.y, 2), p: round(p.p, 3) };
}

/**
 * Drop the points a stroke does not need (Ramer–Douglas–Peucker), keeping every
 * point that moves the line, or its width, by more than `eps` points. Pressure
 * counts as a third dimension scaled by the pen width, since a pressure change
 * of dp widens the line by about dp × width. Coordinates come back rounded to
 * hundredths of a point and pressure to thousandths, which is what a save keeps.
 * Points that are not numbers are dropped. Thinning a thinned stroke again
 * changes nothing in practice (checked on 20,000 random strokes), though RDP
 * does not promise it; that is why pdfink marks its ink and does not re-thin it.
 */
export function thinPoints(points: Point[], width: number, eps: number = INK_TOLERANCE): Point[] {
  const rounded = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.p)).map(roundPoint);
  if (rounded.length <= 2) return rounded;
  const z = (p: Point) => p.p * width;
  const keep = new Uint8Array(rounded.length);
  keep[0] = keep[rounded.length - 1] = 1;
  const stack: [number, number][] = [[0, rounded.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = rounded[i], b = rounded[j];
    const dx = b.x - a.x, dy = b.y - a.y, dz = z(b) - z(a);
    const len2 = dx * dx + dy * dy + dz * dz;
    let worst = -1, at = -1;
    for (let k = i + 1; k < j; k++) {
      const p = rounded[k];
      const px = p.x - a.x, py = p.y - a.y, pz = z(p) - z(a);
      const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / len2)) : 0;
      const d = Math.hypot(px - t * dx, py - t * dy, pz - t * dz);
      if (d > worst) { worst = d; at = k; }
    }
    if (worst > eps) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return rounded.filter((_, k) => keep[k]);
}

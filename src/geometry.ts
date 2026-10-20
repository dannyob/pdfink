import type { Point, Rect, Stroke, ImageItem } from "./model.ts";
import { maxPressureFactor } from "./model.ts";

export function strokeBounds(s: Stroke): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of s.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const full = s.width * maxPressureFactor(s);
  const half = full / 2;
  return { x: minX - half, y: minY - half, w: maxX - minX + full, h: maxY - minY + full };
}

export function imageBounds(im: ImageItem): Rect {
  return { x: im.x, y: im.y, w: im.w, h: im.h };
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: x2 - x, h: y2 - y };
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

export function pointInRect(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A stroke is "in" a selection rect when any of its points lies inside it. */
export function strokeInRect(s: Stroke, r: Rect): boolean {
  return s.points.some((p) => pointInRect(p, r));
}

/** An image is "in" a selection rect when the rect covers its centre. */
export function imageInRect(im: ImageItem, r: Rect): boolean {
  return pointInRect({ x: im.x + im.w / 2, y: im.y + im.h / 2 }, r);
}

function distPointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** True when `p` is within `radius` of the stroke's centreline (plus half its width). */
export function strokeHit(s: Stroke, p: Point, radius: number): boolean {
  const r = radius + (s.width * maxPressureFactor(s)) / 2;
  const pts = s.points;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= r;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (distPointToSegment(p, pts[i], pts[i + 1]) <= r) return true;
  }
  return false;
}

export function translateStroke(s: Stroke, dx: number, dy: number): Stroke {
  return { ...s, points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy, p: p.p })) };
}

export function translateImage(im: ImageItem, dx: number, dy: number): ImageItem {
  return { ...im, x: im.x + dx, y: im.y + dy };
}

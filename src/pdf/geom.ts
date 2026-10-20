/**
 * Mapping between PDF user space (crop box, y up, possibly rotated) and
 * "display space" (what pdf.js shows: origin top-left, y down, in points).
 * Mirrors pdf.js PageViewport at scale 1.
 */
export interface PageGeom {
  cx: number;
  cy: number;
  cw: number;
  ch: number;
  /** 0 | 90 | 180 | 270 */
  rotate: number;
}

export function displaySize(g: PageGeom): { width: number; height: number } {
  return g.rotate % 180 === 0 ? { width: g.cw, height: g.ch } : { width: g.ch, height: g.cw };
}

export function normalizeRotate(angle: number): number {
  let r = Math.round(angle / 90) * 90;
  r = ((r % 360) + 360) % 360;
  return r;
}

export function pdfToDisplay(g: PageGeom, xp: number, yp: number): { x: number; y: number } {
  switch (g.rotate) {
    case 90:
      return { x: yp - g.cy, y: xp - g.cx };
    case 180:
      return { x: g.cx + g.cw - xp, y: yp - g.cy };
    case 270:
      return { x: g.cy + g.ch - yp, y: g.cx + g.cw - xp };
    default:
      return { x: xp - g.cx, y: g.cy + g.ch - yp };
  }
}

export function displayToPdf(g: PageGeom, x: number, y: number): { x: number; y: number } {
  switch (g.rotate) {
    case 90:
      return { x: g.cx + y, y: g.cy + x };
    case 180:
      return { x: g.cx + g.cw - x, y: g.cy + y };
    case 270:
      return { x: g.cx + g.cw - y, y: g.cy + g.ch - x };
    default:
      return { x: g.cx + x, y: g.cy + g.ch - y };
  }
}

/** Page-space point: PDF points, origin top-left, y down. */
export interface Point {
  x: number;
  y: number;
  /** Pen pressure 0..1. Drawn width is `stroke.width * pressureFactor(p)`. */
  p: number;
}

/** Pressure that gives exactly the nominal width (mouse, constant-width ink). */
export const DEFAULT_PRESSURE = 0.6;

/**
 * Width multiplier for a pressure value. Calibrated against Xodo (PDFTron-based) exports from a Daylight DC-1
 * (thickness ≈ nominal width × (0.4 + pressure)); 0.6 → 1.0.
 */
export function pressureFactor(p: number): number {
  return 0.4 + Math.max(0, Math.min(1, p));
}

export function isUniformPressure(s: Stroke): boolean {
  const p0 = s.points[0]?.p;
  return s.points.every((pt) => Math.abs(pt.p - p0) < 0.02);
}

export function maxPressureFactor(s: Stroke): number {
  let m = 0;
  for (const pt of s.points) if (pt.p > m) m = pt.p;
  return pressureFactor(m);
}

export interface Stroke {
  id: string;
  points: Point[];
  /** CSS hex colour, e.g. "#000000". */
  color: string;
  /** Line width in PDF points. */
  width: number;
  /** Opacity 0..1. */
  opacity: number;
}

export interface ImageItem {
  id: string;
  /** Top-left in page space. */
  x: number;
  y: number;
  /** Size in PDF points. */
  w: number;
  h: number;
  mime: "image/png" | "image/jpeg";
  /** Raw encoded image bytes. */
  bytes: Uint8Array;
}

/** A URI link: a clickable rectangle in page space (top-left origin, display points). */
export interface LinkItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** http:, https: or mailto: URL. */
  url: string;
  /** Optional text, stored as the annotation's /Contents. */
  label?: string;
}

/** One outline entry: a title, the 0-based page it opens (null when it has no destination in this document), and its depth (0 = top). */
export interface Bookmark {
  title: string;
  page: number | null;
  level: number;
}

export interface PageModel {
  /** Page size in PDF points, after rotation (what the viewer shows). */
  width: number;
  height: number;
  strokes: Stroke[];
  images: ImageItem[];
  links: LinkItem[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Content on the internal clipboard: strokes/images/links relative to their bbox origin. */
export interface ClipContent {
  strokes: Stroke[];
  images: ImageItem[];
  links: LinkItem[];
  width: number;
  height: number;
}

let counter = 0;
export function newId(prefix = "s"): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export const LETTER = { width: 612, height: 792 };

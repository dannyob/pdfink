import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { AnnotationMode } from "pdfjs-dist";
import type { ImageItem, PageModel, Rect, Stroke } from "../model.ts";
import { isUniformPressure, pressureFactor } from "../model.ts";

/** Keep canvas backing stores under this many pixels (Safari blanks larger ones). */
const MAX_CANVAS_PIXELS = 12_000_000;

/** Draws a stroke onto a 2D context already scaled to page space. */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, from = 0): void {
  const pts = s.points;
  if (!pts.length) return;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.globalAlpha = s.opacity;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const start = Math.max(0, from - 1);
  if (pts.length === 1) {
    ctx.lineWidth = s.width * pressureFactor(pts[0].p);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[0].x, pts[0].y);
    ctx.stroke();
  } else if (isUniformPressure(s)) {
    ctx.lineWidth = s.width * pressureFactor(pts[0].p);
    ctx.beginPath();
    ctx.moveTo(pts[start].x, pts[start].y);
    for (let i = start + 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  } else {
    // Pressure-sensitive: each segment at its own width (round caps hide the joins).
    for (let i = start; i + 1 < pts.length; i++) {
      ctx.lineWidth = s.width * pressureFactor((pts[i].p + pts[i + 1].p) / 2);
      ctx.beginPath();
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

const imageCache = new Map<string, HTMLImageElement>();

function imageElement(im: ImageItem, onLoad: () => void): HTMLImageElement {
  let el = imageCache.get(im.id);
  if (!el) {
    el = new Image();
    const blob = new Blob([im.bytes as BlobPart], { type: im.mime });
    el.onload = onLoad;
    el.src = URL.createObjectURL(blob);
    imageCache.set(im.id, el);
  }
  return el;
}

/** Forget cached decoded images that are no longer in any page. */
export function pruneImageCache(liveIds: Set<string>): void {
  for (const [id, el] of imageCache) {
    if (!liveIds.has(id)) {
      URL.revokeObjectURL(el.src);
      imageCache.delete(id);
    }
  }
}

export interface SelectionView {
  rect: Rect | null;
  strokeIds: Set<string>;
  imageIds: Set<string>;
}

export class PageView {
  readonly el: HTMLDivElement;
  readonly base: HTMLCanvasElement;
  readonly ink: HTMLCanvasElement;
  scale = 1;
  /** Device pixels per page point actually used for the backing stores. */
  private pixelRatio = 1;
  private renderTask: RenderTask | null = null;
  private rendering: Promise<void> | null = null;
  private renderedScale = 0;
  private pageProxy: PDFPageProxy | null = null;
  private dirty = true;
  /** Backing stores are released while the page is far off-screen. */
  private allocated = false;

  constructor(
    readonly index: number,
    readonly model: PageModel,
  ) {
    this.el = document.createElement("div");
    this.el.className = "page";
    this.el.dataset.page = String(index);
    this.base = document.createElement("canvas");
    this.base.className = "base";
    this.ink = document.createElement("canvas");
    this.ink.className = "ink";
    this.el.append(this.base, this.ink);
  }

  setScale(scale: number): void {
    this.scale = scale;
    const cssW = Math.round(this.model.width * scale);
    const cssH = Math.round(this.model.height * scale);
    this.el.style.width = `${cssW}px`;
    this.el.style.height = `${cssH}px`;
    for (const c of [this.base, this.ink]) {
      c.style.width = `${cssW}px`;
      c.style.height = `${cssH}px`;
    }
    this.renderedScale = 0;
    this.dirty = true;
    if (this.allocated) this.allocate();
  }

  /** Create the backing stores at the current scale (capped for huge zooms). */
  private allocate(): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.round(this.model.width * this.scale);
    const cssH = Math.round(this.model.height * this.scale);
    let ratio = dpr;
    if (cssW * cssH * ratio * ratio > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH));
    this.pixelRatio = ratio;
    for (const c of [this.base, this.ink]) {
      c.width = Math.round(cssW * ratio);
      c.height = Math.round(cssH * ratio);
    }
    this.allocated = true;
    this.renderedScale = 0;
    this.dirty = true;
  }

  /** Free the backing stores; they come back on the next render. */
  release(): void {
    if (!this.allocated) return;
    if (this.renderTask) {
      this.renderTask.cancel();
      this.renderTask = null;
    }
    for (const c of [this.base, this.ink]) {
      c.width = 0;
      c.height = 0;
    }
    this.allocated = false;
    this.renderedScale = 0;
    this.dirty = true;
  }

  /** Page-space coordinates from a client-space point. */
  toPage(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.ink.getBoundingClientRect();
    return { x: (clientX - r.left) / this.scale, y: (clientY - r.top) / this.scale };
  }

  toClient(x: number, y: number): { clientX: number; clientY: number } {
    const r = this.ink.getBoundingClientRect();
    return { clientX: r.left + x * this.scale, clientY: r.top + y * this.scale };
  }

  renderBase(doc: PDFDocumentProxy): Promise<void> {
    if (!this.allocated) this.allocate();
    if (this.renderedScale === this.scale) return Promise.resolve();
    if (this.rendering) return this.rendering;
    this.rendering = this.doRender(doc).finally(() => {
      this.rendering = null;
    });
    return this.rendering;
  }

  private async doRender(doc: PDFDocumentProxy): Promise<void> {
    const target = this.scale;
    if (!this.pageProxy) this.pageProxy = await doc.getPage(this.index + 1);
    if (!this.allocated || this.scale !== target) return; // released or rescaled while waiting
    const viewport = this.pageProxy.getViewport({ scale: target * this.pixelRatio });
    const ctx = this.base.getContext("2d");
    if (!ctx) return;
    const task = this.pageProxy.render({
      canvasContext: ctx,
      canvas: this.base,
      viewport,
      annotationMode: AnnotationMode.ENABLE,
    });
    this.renderTask = task;
    try {
      await task.promise;
      if (this.scale === target) this.renderedScale = target;
    } catch (e) {
      if (!(e instanceof Error && e.name === "RenderingCancelledException")) throw e;
    } finally {
      if (this.renderTask === task) this.renderTask = null;
    }
  }

  /** Mark the ink layer as needing a full redraw. */
  invalidate(): void {
    this.dirty = true;
  }

  private ctx(): CanvasRenderingContext2D | null {
    if (!this.allocated) this.allocate();
    const ctx = this.ink.getContext("2d");
    if (!ctx) return null;
    const k = this.scale * this.pixelRatio;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    return ctx;
  }

  /** Incrementally draw the tail of a stroke in progress (no full redraw). */
  drawStrokeTail(s: Stroke, from: number): void {
    const ctx = this.ctx();
    if (ctx) drawStroke(ctx, s, from);
  }

  drawInk(selection: SelectionView | null, live?: Stroke | null, force = false): void {
    if (!this.dirty && !force) return;
    this.dirty = false;
    const ctx = this.ctx();
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.ink.width, this.ink.height);
    ctx.restore();
    for (const im of this.model.images) {
      const el = imageElement(im, () => {
        this.dirty = true;
        this.drawInk(selection);
      });
      if (el.complete && el.naturalWidth) ctx.drawImage(el, im.x, im.y, im.w, im.h);
      if (selection?.imageIds.has(im.id)) {
        ctx.save();
        ctx.strokeStyle = "rgba(47,74,122,0.9)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(im.x, im.y, im.w, im.h);
        ctx.restore();
      }
    }
    for (const s of this.model.strokes) {
      drawStroke(ctx, s);
      if (selection?.strokeIds.has(s.id)) {
        ctx.save();
        ctx.strokeStyle = "rgba(47,74,122,0.35)";
        ctx.lineWidth = s.width + 6;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        const pts = s.points;
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        if (pts.length === 1) ctx.lineTo(pts[0].x, pts[0].y);
        ctx.stroke();
        ctx.restore();
      }
    }
    if (live) drawStroke(ctx, live);
    if (selection?.rect) {
      const r = selection.rect;
      ctx.save();
      ctx.strokeStyle = "rgba(47,74,122,0.9)";
      ctx.fillStyle = "rgba(47,74,122,0.06)";
      ctx.lineWidth = 1 / this.scale;
      ctx.setLineDash([4 / this.scale, 3 / this.scale]);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    }
  }

  destroy(): void {
    this.release();
    this.pageProxy?.cleanup();
    this.el.remove();
  }
}

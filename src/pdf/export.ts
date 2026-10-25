import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, degrees, type PDFFont } from "pdf-lib";
import type { Bookmark, ImageItem, PageModel, Stroke } from "../model.ts";
import { LETTER } from "../model.ts";
import { isUniformPressure, pressureFactor, maxPressureFactor } from "../model.ts";
import { hexToRgb } from "./color.ts";
import { displayToPdf, type PageGeom } from "./geom.ts";
import { pageGeom } from "./import.ts";
import { addLinkAnnotation } from "./links.ts";
import { writeOutline } from "./outline.ts";
import { addLayer, layerFont, notesText, stripLayer, writeNotebookTag, writeTexts } from "./text.ts";

function fmt(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

interface Group {
  color: string;
  width: number;
  opacity: number;
  strokes: Stroke[];
}

function groupStrokes(strokes: Stroke[]): Group[] {
  const map = new Map<string, Group>();
  for (const s of strokes) {
    const key = `${s.color}|${s.width}|${s.opacity}`;
    let g = map.get(key);
    if (!g) {
      g = { color: s.color, width: s.width, opacity: s.opacity, strokes: [] };
      map.set(key, g);
    }
    g.strokes.push(s);
  }
  return [...map.values()];
}

/** Add one /Ink annotation (with appearance stream) for a group of strokes. */
function addInkAnnotation(doc: PDFDocument, pageIndex: number, geom: PageGeom, g: Group): void {
  const page = doc.getPage(pageIndex);
  const [r, gg, b] = hexToRgb(g.color);
  let half = g.width / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const inkList: number[][] = [];
  const pressureList: number[][] = [];
  const ops: string[] = [];
  let anyPressure = false;
  for (const s of g.strokes) {
    const nums: number[] = [];
    const pts: { x: number; y: number }[] = [];
    for (const p of s.points) {
      const q = displayToPdf(geom, p.x, p.y);
      const x = Math.round(q.x * 1000) / 1000;
      const y = Math.round(q.y * 1000) / 1000;
      nums.push(x, y);
      pts.push({ x, y });
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    half = Math.max(half, (g.width * maxPressureFactor(s)) / 2);
    if (isUniformPressure(s)) {
      // Constant width: one path, one stroke operator.
      ops.push(`${fmt(g.width * pressureFactor(s.points[0].p))} w`);
      pts.forEach((q, i) => ops.push(`${fmt(q.x)} ${fmt(q.y)} ${i ? "l" : "m"}`));
      if (pts.length === 1) ops.push(`${fmt(pts[0].x)} ${fmt(pts[0].y)} l`); // a dot: round caps make a disc
      ops.push("S");
    } else {
      // Pressure: one short stroked segment per step, each at its own width.
      anyPressure = true;
      if (pts.length === 1) {
        ops.push(`${fmt(g.width * pressureFactor(s.points[0].p))} w`, `${fmt(pts[0].x)} ${fmt(pts[0].y)} m`, `${fmt(pts[0].x)} ${fmt(pts[0].y)} l`, "S");
      }
      for (let i = 0; i + 1 < pts.length; i++) {
        const w = g.width * pressureFactor((s.points[i].p + s.points[i + 1].p) / 2);
        ops.push(`${fmt(w)} w`, `${fmt(pts[i].x)} ${fmt(pts[i].y)} m`, `${fmt(pts[i + 1].x)} ${fmt(pts[i + 1].y)} l`, "S");
      }
    }
    inkList.push(nums);
    pressureList.push(s.points.map((p) => Math.round(p.p * 10000) / 10000));
  }
  if (!inkList.length) return;
  const rect = [minX - half, minY - half, maxX + half, maxY + half];

  const resources: { ExtGState?: { GS0: PDFDict } } = {};
  const head: string[] = [];
  if (g.opacity < 1) {
    const gs = doc.context.obj({ Type: "ExtGState", CA: g.opacity, ca: g.opacity });
    resources.ExtGState = { GS0: gs };
    head.push("/GS0 gs");
  }
  head.push(`${fmt(r)} ${fmt(gg)} ${fmt(b)} RG`, "1 J", "1 j", "[] 0 d");
  const content = ["q", ...head, ...ops, "Q"].join("\n");
  const ap = doc.context.flateStream(content, {
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: rect,
    Resources: resources,
  });
  const apRef = doc.context.register(ap);

  const now = PDFString.fromDate(new Date());
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Ink",
    Rect: rect,
    InkList: inkList,
    C: [r, gg, b],
    CA: g.opacity,
    ca: g.opacity,
    BS: { Type: "Border", S: "S", W: g.width },
    Border: [0, 0, g.width],
    F: 4,
    P: page.ref,
    M: now,
    CreationDate: now,
    NM: PDFString.of(`pdfink-${Math.random().toString(36).slice(2)}`),
    T: PDFString.of("pdfink"),
    AP: { N: apRef },
    ...(anyPressure ? { PDFTron_Pressure_Thickness: pressureList } : {}),
  });
  const annotRef = doc.context.register(annot);
  const existing = page.node.Annots();
  if (existing) {
    existing.push(annotRef);
  } else {
    page.node.set(PDFName.of("Annots"), doc.context.obj([annotRef]));
  }
}

async function drawImageItem(doc: PDFDocument, pageIndex: number, geom: PageGeom, im: ImageItem): Promise<void> {
  const page = doc.getPage(pageIndex);
  const img = im.mime === "image/png" ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
  // pdf-lib rotates counter-clockwise about the image's bottom-left corner.
  // Anchoring at the display-space bottom-left and rotating by the page's
  // /Rotate keeps the image upright for the viewer on every orientation.
  const q = displayToPdf(geom, im.x, im.y + im.h);
  page.drawImage(img, { x: q.x, y: q.y, width: im.w, height: im.h, rotate: degrees(geom.rotate) });
}

/** Put the page's notes on its first /Ink annotation as /Contents. */
function setInkContents(doc: PDFDocument, pageIndex: number, text: string): void {
  const annots = doc.getPage(pageIndex).node.Annots();
  if (!annots) return;
  for (let k = 0; k < annots.size(); k++) {
    const d = annots.lookup(k);
    if (d instanceof PDFDict && d.get(PDFName.of("Subtype")) === PDFName.of("Ink")) {
      d.set(PDFName.of("Contents"), PDFHexString.fromText(text));
      return;
    }
  }
}

export interface ExportOptions {
  /** The /PdfinkNotebook tag: undefined leaves it, null removes it, a boolean sets it. */
  notebook?: boolean | null;
  /** `textLayers[i]` writes page i's texts as an invisible text layer too. */
  textLayers?: boolean[];
}

/**
 * Write the model back into `baseBytes` (a PDF with no ink annotations) and
 * return the finished PDF bytes. `bookmarks` replaces the outline (an empty
 * array removes it); left undefined, the base's /Outlines stay untouched.
 */
export async function exportPdf(baseBytes: Uint8Array, pages: PageModel[], bookmarks?: Bookmark[], opts: ExportOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.load(baseBytes, { ignoreEncryption: true, updateMetadata: false });
  const count = doc.getPageCount();
  if (pages.length > count) {
    // Never drop ink silently: the caller's base is missing pages (for
    // example a page added in the browser that the server never received).
    throw new Error(`ink for ${pages.length} pages but the PDF has ${count}`);
  }
  let font: PDFFont | undefined;
  for (let i = 0; i < pages.length; i++) {
    const geom = pageGeom(doc.getPage(i));
    for (const im of pages[i].images) await drawImageItem(doc, i, geom, im);
    for (const ln of pages[i].links) addLinkAnnotation(doc, i, geom, ln);
    for (const g of groupStrokes(pages[i].strokes)) addInkAnnotation(doc, i, geom, g);
    const texts = pages[i].texts ?? []; // pages from older clients have none
    const page = doc.getPage(i);
    stripLayer(doc, page); // a base that still has one never gets two
    writeTexts(doc, page, geom, texts);
    if (texts.length) {
      setInkContents(doc, i, notesText(texts));
      if (opts.textLayers?.[i]) addLayer(doc, page, geom, texts, (font ??= await layerFont(doc)));
    }
  }
  if (bookmarks !== undefined) writeOutline(doc, bookmarks);
  doc.setProducer("pdfink");
  if (opts.notebook !== undefined) writeNotebookTag(doc, opts.notebook);
  doc.setModificationDate(new Date());
  return doc.save({ useObjectStreams: false });
}

export async function createBlankPdf(pageCount = 1, opts: { notebook?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([LETTER.width, LETTER.height]);
  doc.setProducer("pdfink");
  if (opts.notebook !== undefined) writeNotebookTag(doc, opts.notebook);
  return doc.save({ useObjectStreams: false });
}

/** Append a blank Letter page (same size as the last page, if any) and return new bytes. */
export async function appendBlankPage(baseBytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(baseBytes, { ignoreEncryption: true, updateMetadata: false });
  const n = doc.getPageCount();
  if (n > 0) {
    const last = doc.getPage(n - 1);
    const { width, height } = last.getSize();
    doc.addPage([width, height]);
  } else {
    doc.addPage([LETTER.width, LETTER.height]);
  }
  return doc.save({ useObjectStreams: false });
}

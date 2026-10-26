import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRef,
  PDFStream,
} from "pdf-lib";
import type { Bookmark, PageModel, Stroke } from "../model.ts";
import { DEFAULT_PRESSURE, newId } from "../model.ts";
import { rgbToHex } from "./color.ts";
import { displaySize, normalizeRotate, pdfToDisplay, type PageGeom } from "./geom.ts";
import { extractLinks } from "./links.ts";
import { readOutline } from "./outline.ts";
import { THINNED_INK_VERSION, thinPoints } from "./thin.ts";
import { readNotebookTag, readTexts, stripLayer } from "./text.ts";

export interface ImportedDocument {
  /** The original PDF with all /Ink and URI /Link annotations, /PdfinkText and the text layer removed. */
  baseBytes: Uint8Array;
  pages: PageModel[];
  geoms: PageGeom[];
  /** The document outline, depth-first. */
  bookmarks: Bookmark[];
  /** The /PdfinkNotebook tag: true, false, or null when the file has none. */
  notebook: boolean | null;
}

export function pageGeom(page: { getCropBox(): { x: number; y: number; width: number; height: number }; getRotation(): { angle: number } }): PageGeom {
  const cb = page.getCropBox();
  return { cx: cb.x, cy: cb.y, cw: cb.width, ch: cb.height, rotate: normalizeRotate(page.getRotation().angle) };
}

function numArray(doc: PDFDocument, obj: unknown): number[] {
  const arr = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  if (!(arr instanceof PDFArray)) return [];
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = arr.lookup(i);
    if (v instanceof PDFNumber) out.push(v.asNumber());
  }
  return out;
}

/** Pull /Ink annotations out of a page dict, returning strokes and the refs removed. */
function extractInk(doc: PDFDocument, annots: PDFArray, geom: PageGeom): { strokes: Stroke[]; kept: unknown[]; removed: PDFRef[] } {
  const strokes: Stroke[] = [];
  const kept: unknown[] = [];
  const removed: PDFRef[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = annots.lookup(i);
    if (!(dict instanceof PDFDict) || dict.get(PDFName.of("Subtype")) !== PDFName.of("Ink")) {
      kept.push(raw);
      continue;
    }
    const inkList = dict.lookup(PDFName.of("InkList"));
    const version = dict.lookup(PDFName.of("PdfinkInk"));
    const thinned = version instanceof PDFNumber && version.asNumber() >= THINNED_INK_VERSION;
    const color = rgbToHex(numArray(doc, dict.get(PDFName.of("C"))));
    let width = 1;
    const bs = dict.lookup(PDFName.of("BS"));
    if (bs instanceof PDFDict) {
      const w = bs.lookup(PDFName.of("W"));
      if (w instanceof PDFNumber) width = w.asNumber();
    } else {
      const border = numArray(doc, dict.get(PDFName.of("Border")));
      if (border.length >= 3) width = border[2];
    }
    const ca = dict.lookup(PDFName.of("CA"));
    const opacity = ca instanceof PDFNumber ? ca.asNumber() : 1;
    // Per-point pressure, as written by PDFTron-based apps such as Xodo (one array per path).
    const pressureList = dict.lookup(PDFName.of("PDFTron_Pressure_Thickness"));
    if (inkList instanceof PDFArray) {
      for (let j = 0; j < inkList.size(); j++) {
        const nums = numArray(doc, inkList.get(j));
        const pressures = pressureList instanceof PDFArray && j < pressureList.size() ? numArray(doc, pressureList.get(j)) : null;
        const points = [];
        for (let k = 0; k + 1 < nums.length; k += 2) {
          const d = pdfToDisplay(geom, nums[k], nums[k + 1]);
          const pr = pressures && pressures.length * 2 === nums.length ? pressures[k / 2] : DEFAULT_PRESSURE;
          points.push({ x: d.x, y: d.y, p: Math.max(0, Math.min(1, pr)) });
        }
        if (points.length) strokes.push({ id: newId("i"), points: thinned ? points : thinPoints(points, width), color, width, opacity });
      }
    }
    if (raw instanceof PDFRef) {
      removed.push(raw);
      const ap = dict.lookup(PDFName.of("AP"));
      if (ap instanceof PDFDict) {
        const n = ap.get(PDFName.of("N"));
        if (n instanceof PDFRef && doc.context.lookup(n) instanceof PDFStream) removed.push(n);
      }
      const popup = dict.get(PDFName.of("Popup"));
      if (popup instanceof PDFRef) removed.push(popup);
    }
  }
  // Drop popup annotations that belonged to removed ink from the kept list too.
  const removedSet = new Set(removed.map((r) => r.toString()));
  const keptFinal = kept.filter((k) => !(k instanceof PDFRef && removedSet.has(k.toString())));
  return { strokes, kept: keptFinal, removed };
}

/**
 * Delete every indirect object that cannot be reached from the trailer.
 * Files written with incremental updates (Xodo, Acrobat…) keep every
 * superseded object; a 300 MB notebook can be 90% such garbage.
 */
export function collectGarbage(doc: PDFDocument): number {
  const ctx = doc.context;
  const live = new Set<string>();
  const stack: PDFObject[] = [];
  const push = (o: PDFObject | undefined) => {
    if (o) stack.push(o);
  };
  push(ctx.trailerInfo.Root);
  push(ctx.trailerInfo.Info);
  push(ctx.trailerInfo.Encrypt);
  push(ctx.trailerInfo.ID);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      const key = o.toString();
      if (live.has(key)) continue;
      live.add(key);
      push(ctx.lookup(o));
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) push(o.get(i));
    } else if (o instanceof PDFStream) {
      for (const [, v] of o.dict.entries()) push(v);
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!live.has(ref.toString())) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}

export async function importPdf(bytes: Uint8Array): Promise<ImportedDocument> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new Error("This PDF is encrypted; pdfink can't edit encrypted PDFs.");
  const pages: PageModel[] = [];
  const geoms: PageGeom[] = [];
  for (const page of doc.getPages()) {
    const geom = pageGeom(page);
    geoms.push(geom);
    const size = displaySize(geom);
    const model: PageModel = { width: size.width, height: size.height, strokes: [], images: [], links: [], texts: readTexts(page, geom) };
    page.node.delete(PDFName.of("PdfinkText"));
    stripLayer(doc, page);
    const annots = page.node.Annots();
    if (annots) {
      const ink = extractInk(doc, annots, geom);
      const lifted = extractLinks(doc, ink.kept, geom);
      model.strokes = ink.strokes;
      model.links = lifted.links;
      const kept = lifted.kept;
      const removed = [...ink.removed, ...lifted.removed];
      if (kept.length !== annots.size()) {
        page.node.set(PDFName.of("Annots"), doc.context.obj(kept as never[]));
        for (const ref of removed) doc.context.delete(ref);
      }
    }
    pages.push(model);
  }
  const bookmarks = readOutline(doc);
  const notebook = readNotebookTag(doc);
  collectGarbage(doc);
  const baseBytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { baseBytes, pages, geoms, bookmarks, notebook };
}

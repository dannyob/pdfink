import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  type PDFFont,
} from "pdf-lib";
import type { TextItem } from "../model.ts";
import { newId } from "../model.ts";
import { displayToPdf, pdfToDisplay, type PageGeom } from "./geom.ts";

/** The page entry holding the handwriting text, the source of truth. */
const TEXT_KEY = PDFName.of("PdfinkText");
/** First line of the invisible text layer's content stream. */
export const LAYER_MARKER = "% pdfink handwriting text";
/** The layer's font resource name. */
const FONT_KEY = PDFName.of("PdfinkF1");

function fmt(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

function str(o: unknown): string | null {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : null;
}

/** The page's /PdfinkText as text items in display space; malformed entries are skipped. */
export function readTexts(page: PDFPage, geom: PageGeom): TextItem[] {
  const arr = page.node.lookup(TEXT_KEY);
  if (!(arr instanceof PDFArray)) return [];
  const out: TextItem[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const e = arr.lookup(i);
    if (!(e instanceof PDFArray) || e.size() < 5) continue;
    const r: number[] = [];
    for (let k = 0; k < 4; k++) {
      const v = e.lookup(k);
      if (v instanceof PDFNumber) r.push(v.asNumber());
    }
    const text = str(e.lookup(4));
    if (r.length !== 4 || text === null) continue;
    const a = pdfToDisplay(geom, r[0], r[1]);
    const b = pdfToDisplay(geom, r[2], r[3]);
    const item: TextItem = { id: newId("tx"), x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y), text };
    const sig = e.size() > 5 ? str(e.lookup(5)) : null;
    if (sig) item.sig = sig;
    const note = e.size() > 6 ? e.lookup(6) : undefined;
    if (note instanceof PDFNumber && note.asNumber() >= 0) item.note = note.asNumber();
    out.push(item);
  }
  return out;
}

/** Write `texts` as the page's /PdfinkText (removing the entry when there are none). */
export function writeTexts(doc: PDFDocument, page: PDFPage, geom: PageGeom, texts: TextItem[]): void {
  if (!texts.length) {
    page.node.delete(TEXT_KEY);
    return;
  }
  const entries = texts.map((t) => {
    const a = displayToPdf(geom, t.x, t.y);
    const b = displayToPdf(geom, t.x + t.w, t.y + t.h);
    return doc.context.obj([
      Number(fmt(Math.min(a.x, b.x))),
      Number(fmt(Math.min(a.y, b.y))),
      Number(fmt(Math.max(a.x, b.x))),
      Number(fmt(Math.max(a.y, b.y))),
      PDFHexString.fromText(t.text),
      PDFHexString.fromText(t.sig ?? ""),
      t.note ?? -1,
    ]);
  });
  page.node.set(TEXT_KEY, doc.context.obj(entries));
}

/** The marked leading stream, exactly. */
const LEAD_BODY = `${LAYER_MARKER}\nq`;
/** The layer stream: marker, Q, q, zero or more invisible text lines, Q. */
const LAYER_BODY = new RegExp(`^${LAYER_MARKER}\\nQ\\nq(\\nBT 3 Tr /PdfinkF1 [^\\n]* Tj ET)*\\nQ$`);

/**
 * True only for a stream that is wholly ours: the lead or the layer. A
 * stream that merely begins with the marker (another tool coalesced
 * /Contents into one stream) also holds the page's own content and stays.
 */
function isLayer(doc: PDFDocument, o: unknown): boolean {
  const s = o instanceof PDFRef ? doc.context.lookup(o) : o;
  if (!(s instanceof PDFRawStream)) return false;
  let data: Uint8Array;
  try {
    data = decodePDFRawStream(s).decode();
  } catch {
    return false;
  }
  const body = new TextDecoder("latin1").decode(data).replace(/\r\n?/g, "\n").trim();
  return body === LEAD_BODY || LAYER_BODY.test(body);
}

/**
 * Remove the invisible text layer (its marked leading `q` stream and the
 * trailing layer stream) and its font resource from the page. When one
 * stream is left it goes back to being /Contents on its own, as it was.
 */
export function stripLayer(doc: PDFDocument, page: PDFPage): void {
  const key = PDFName.of("Contents");
  const raw = page.node.get(key);
  const contents = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  let stripped = false;
  if (contents instanceof PDFArray) {
    const kept = [];
    for (let i = 0; i < contents.size(); i++) {
      const e = contents.get(i);
      if (isLayer(doc, e)) stripped = true;
      else kept.push(e);
    }
    if (stripped) {
      if (kept.length === 0) page.node.delete(key);
      else if (kept.length === 1) page.node.set(key, kept[0]);
      else page.node.set(key, doc.context.obj(kept));
    }
  } else if (isLayer(doc, raw)) {
    page.node.delete(key);
    stripped = true;
  }
  if (!stripped) return;
  const res = page.node.lookup(PDFName.of("Resources"));
  const fonts = res instanceof PDFDict ? res.lookup(PDFName.of("Font")) : undefined;
  if (fonts instanceof PDFDict) fonts.delete(FONT_KEY);
}

/** `text` with every character Helvetica/WinAnsi cannot encode replaced by "?". */
function encodable(font: PDFFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of text) out += set.has(ch.codePointAt(0)!) ? ch : "?";
  return out;
}

/** The Helvetica font for text layers, embedded once per document. */
export async function layerFont(doc: PDFDocument): Promise<PDFFont> {
  return doc.embedFont(StandardFonts.Helvetica);
}

/**
 * Give the page its own /Resources and /Font dicts (shallow copies, so
 * inherited or shared ones are left alone) holding the layer font. Done by
 * hand: pdf-lib's setFontDictionary would also wrap /Contents in unmarked
 * q/Q streams that stripLayer could never take out again.
 */
function setLayerFont(doc: PDFDocument, page: PDFPage, font: PDFFont): void {
  const ctx = doc.context;
  const resKey = PDFName.of("Resources");
  const fontKey = PDFName.of("Font");
  const inherited = ctx.lookupMaybe(page.node.getInheritableAttribute(resKey), PDFDict);
  const res = inherited ? inherited.clone(ctx) : ctx.obj({});
  const fonts = res.lookupMaybe(fontKey, PDFDict);
  const ownFonts = fonts ? fonts.clone(ctx) : ctx.obj({});
  ownFonts.set(FONT_KEY, font.ref);
  res.set(fontKey, ownFonts);
  page.node.set(resKey, res);
}

/**
 * Add the invisible text layer: one line of render-mode-3 Helvetica per
 * item, sized to the box height and stretched to its width, upright for the
 * viewer whatever the page's /Rotate. The page's own content is wrapped
 * between a marked `q` stream and the layer stream, which begins by
 * restoring that state, so the layer never inherits a changed graphics
 * state and both streams come out again on import.
 */
export function addLayer(doc: PDFDocument, page: PDFPage, geom: PageGeom, texts: TextItem[], font: PDFFont): void {
  if (!texts.length) return;
  const o = displayToPdf(geom, 0, 0);
  const xAxis = displayToPdf(geom, 1, 0);
  const up = displayToPdf(geom, 0, -1);
  const [a, b] = [xAxis.x - o.x, xAxis.y - o.y];
  const [c, d] = [up.x - o.x, up.y - o.y];
  const lines = [LAYER_MARKER, "Q", "q"];
  for (const t of texts) {
    if (!(t.h > 0)) continue;
    const text = encodable(font, t.text);
    const natural = font.widthOfTextAtSize(text, t.h);
    const tz = natural > 0 ? (100 * t.w) / natural : 100;
    const bl = displayToPdf(geom, t.x, t.y + t.h);
    const e = bl.x + 0.2 * t.h * c;
    const f = bl.y + 0.2 * t.h * d;
    lines.push(`BT 3 Tr /PdfinkF1 ${fmt(t.h)} Tf ${fmt(tz)} Tz ${[a, b, c, d, e, f].map(fmt).join(" ")} Tm ${font.encodeText(text).toString()} Tj ET`);
  }
  lines.push("Q");
  const ctx = doc.context;
  const lead = ctx.register(ctx.flateStream(`${LAYER_MARKER}\nq`));
  const layer = ctx.register(ctx.flateStream(lines.join("\n")));
  setLayerFont(doc, page, font);
  const key = PDFName.of("Contents");
  const raw = page.node.get(key);
  const contents = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
  const own = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.get(i)) : raw ? [raw] : [];
  page.node.set(key, ctx.obj([lead, ...own, layer]));
}

/**
 * The page's handwriting as plain text for an annotation's /Contents: one
 * paragraph per note (its lines top to bottom, joined by spaces), notes in
 * reading order (top edge, then left edge), separated by blank lines.
 */
export function notesText(texts: TextItem[]): string {
  const notes = new Map<number, TextItem[]>();
  const loose: TextItem[][] = [];
  for (const t of texts) {
    if (t.note === undefined) loose.push([t]);
    else {
      const n = notes.get(t.note);
      if (n) n.push(t);
      else notes.set(t.note, [t]);
    }
  }
  const groups = [...notes.values(), ...loose].map((lines) => {
    lines.sort((p, q) => p.y - q.y || p.x - q.x);
    return { top: Math.min(...lines.map((l) => l.y)), left: Math.min(...lines.map((l) => l.x)), text: lines.map((l) => l.text).join(" ") };
  });
  groups.sort((p, q) => p.top - q.top || p.left - q.left);
  return groups.map((g) => g.text).join("\n\n");
}

/** The tag in the document information dictionary: true, false, or null when absent. */
export function readNotebookTag(doc: PDFDocument): boolean | null {
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (!(info instanceof PDFDict)) return null;
  const v = info.lookup(PDFName.of("PdfinkNotebook"));
  return v instanceof PDFBool ? v.asBoolean() : null;
}

/** Set the tag (`null` removes it). */
export function writeNotebookTag(doc: PDFDocument, value: boolean | null): void {
  const ctx = doc.context;
  let info = ctx.lookup(ctx.trailerInfo.Info);
  if (!(info instanceof PDFDict)) {
    if (value === null) return;
    info = ctx.obj({});
    ctx.trailerInfo.Info = ctx.register(info as PDFDict);
  }
  const key = PDFName.of("PdfinkNotebook");
  if (value === null) (info as PDFDict).delete(key);
  else (info as PDFDict).set(key, value ? PDFBool.True : PDFBool.False);
}

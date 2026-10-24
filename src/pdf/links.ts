import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from "pdf-lib";
import type { LinkItem } from "../model.ts";
import { newId } from "../model.ts";
import { displayToPdf, pdfToDisplay, type PageGeom } from "./geom.ts";

/** Schemes pdfink will follow or write: http, https and mailto. */
export function linkUrlOk(url: string): boolean {
  return /^(https?|mailto):/i.test(url);
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function escapeLiteral(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** /URI is a byte string: plain ASCII as a literal, anything else as UTF-8 bytes (pdf.js decodes those). */
function encodeUri(url: string): PDFString | PDFHexString {
  if (PRINTABLE_ASCII.test(url)) return PDFString.of(escapeLiteral(url));
  let hex = "";
  for (const b of new TextEncoder().encode(url)) hex += b.toString(16).padStart(2, "0");
  return PDFHexString.of(hex);
}

function decodeUri(o: unknown): string | null {
  if (!(o instanceof PDFString || o instanceof PDFHexString)) return null;
  const bytes = o.asBytes();
  const bom = bytes.length >= 2 && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe));
  if (!bom) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // not UTF-8: fall through to PDFDocEncoding
    }
  }
  return o.decodeText();
}

/** /Contents is a text string: ASCII literal, or UTF-16BE hex for anything else. */
function encodeText(s: string): PDFString | PDFHexString {
  return PRINTABLE_ASCII.test(s) ? PDFString.of(escapeLiteral(s)) : PDFHexString.fromText(s);
}

function rectNumbers(dict: PDFDict): number[] | null {
  const arr = dict.lookup(PDFName.of("Rect"));
  if (!(arr instanceof PDFArray) || arr.size() < 4) return null;
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const v = arr.lookup(i);
    if (!(v instanceof PDFNumber)) return null;
    out.push(v.asNumber());
  }
  return out;
}

/** The link a /Link annotation with a URI action describes, or null to leave it in the base. */
function readLink(dict: PDFDict, geom: PageGeom): LinkItem | null {
  if (dict.get(PDFName.of("Subtype")) !== PDFName.of("Link")) return null;
  const action = dict.lookup(PDFName.of("A"));
  if (!(action instanceof PDFDict) || action.get(PDFName.of("S")) !== PDFName.of("URI")) return null;
  const url = decodeUri(action.lookup(PDFName.of("URI")));
  if (url === null || !linkUrlOk(url)) return null;
  const r = rectNumbers(dict);
  if (!r) return null;
  const a = pdfToDisplay(geom, r[0], r[1]);
  const b = pdfToDisplay(geom, r[2], r[3]);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  if (!(w > 0 && h > 0)) return null;
  const link: LinkItem = { id: newId("ln"), x, y, w, h, url };
  const contents = dict.lookup(PDFName.of("Contents"));
  if (contents instanceof PDFString || contents instanceof PDFHexString) {
    const label = contents.decodeText();
    if (label) link.label = label;
  }
  return link;
}

/**
 * Lift /Link annotations with a URI action out of `items` (the /Annots
 * entries extractInk kept). Everything else, including GoTo links and
 * named destinations, stays in `kept` untouched.
 */
export function extractLinks(doc: PDFDocument, items: unknown[], geom: PageGeom): { links: LinkItem[]; kept: unknown[]; removed: PDFRef[] } {
  const links: LinkItem[] = [];
  const kept: unknown[] = [];
  const removed: PDFRef[] = [];
  for (const raw of items) {
    const dict = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
    const link = dict instanceof PDFDict ? readLink(dict, geom) : null;
    if (!link) {
      kept.push(raw);
      continue;
    }
    links.push(link);
    if (raw instanceof PDFRef) removed.push(raw);
  }
  return { links, kept, removed };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Add one /Link annotation with a URI action for `link`; a url linkUrlOk refuses is skipped. */
export function addLinkAnnotation(doc: PDFDocument, pageIndex: number, geom: PageGeom, link: LinkItem): void {
  if (!linkUrlOk(link.url)) return;
  const page = doc.getPage(pageIndex);
  const a = displayToPdf(geom, link.x, link.y);
  const b = displayToPdf(geom, link.x + link.w, link.y + link.h);
  const rect = [round(Math.min(a.x, b.x)), round(Math.min(a.y, b.y)), round(Math.max(a.x, b.x)), round(Math.max(a.y, b.y))];
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: rect,
    Border: [0, 0, 1],
    C: [0, 0, 1],
    A: { S: "URI", URI: encodeUri(link.url) },
    ...(link.label ? { Contents: encodeText(link.label) } : {}),
    NM: PDFString.of(`pdfink-${Math.random().toString(36).slice(2)}`),
    F: 4,
  });
  const annotRef = doc.context.register(annot);
  const existing = page.node.Annots();
  if (existing) {
    existing.push(annotRef);
  } else {
    page.node.set(PDFName.of("Annots"), doc.context.obj([annotRef]));
  }
}

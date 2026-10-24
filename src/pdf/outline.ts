import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, type PDFObject, PDFRef, PDFString } from "pdf-lib";
import type { Bookmark } from "../model.ts";

/** How many indirections (name → dict → /D → …) a destination may take before it counts as unresolvable. */
const MAX_DEST_HOPS = 8;

const OUTLINES = PDFName.of("Outlines");

function deref(doc: PDFDocument, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? doc.context.lookup(o) : o;
}

function textOf(o: PDFObject | undefined): string | null {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : null;
}

/** Look `name` up in a name tree (/Names pairs, /Kids subtrees), guarding against cycles. */
function lookupNameTree(doc: PDFDocument, node: PDFObject | undefined, name: string, seen = new Set<PDFObject>()): PDFObject | undefined {
  const dict = deref(doc, node);
  if (!(dict instanceof PDFDict) || seen.has(dict)) return undefined;
  seen.add(dict);
  const names = deref(doc, dict.get(PDFName.of("Names")));
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      if (textOf(deref(doc, names.get(i))) === name) return names.get(i + 1);
    }
  }
  const kids = deref(doc, dict.get(PDFName.of("Kids")));
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.size(); i++) {
      const hit = lookupNameTree(doc, kids.get(i), name, seen);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** The destination a name stands for: the catalog's /Dests dict, then the /Names → /Dests tree. */
function lookupNamedDest(doc: PDFDocument, name: string): PDFObject | undefined {
  const dests = deref(doc, doc.catalog.get(PDFName.of("Dests")));
  if (dests instanceof PDFDict) {
    const hit = dests.get(PDFName.of(name));
    if (hit !== undefined) return hit;
  }
  const names = deref(doc, doc.catalog.get(PDFName.of("Names")));
  if (!(names instanceof PDFDict)) return undefined;
  return lookupNameTree(doc, names.get(PDFName.of("Dests")), name);
}

/** The 0-based page a destination points at, or null when it can't be resolved in this document. */
function resolveDest(doc: PDFDocument, dest: PDFObject | undefined, hops = 0): number | null {
  if (hops > MAX_DEST_HOPS) return null;
  const d = deref(doc, dest);
  if (d instanceof PDFArray) {
    const target = d.size() ? d.get(0) : undefined;
    if (!(target instanceof PDFRef)) return null;
    const key = target.toString();
    const index = doc.getPages().findIndex((p) => p.ref.toString() === key);
    return index >= 0 ? index : null;
  }
  if (d instanceof PDFDict) return resolveDest(doc, d.get(PDFName.of("D")), hops + 1);
  const name = d instanceof PDFName ? d.decodeText() : textOf(d);
  if (name === null) return null;
  return resolveDest(doc, lookupNamedDest(doc, name), hops + 1);
}

/** An outline item's page: its /Dest, else a GoTo action's /D. */
function itemPage(doc: PDFDocument, item: PDFDict): number | null {
  const dest = item.get(PDFName.of("Dest"));
  if (dest !== undefined) return resolveDest(doc, dest);
  const action = deref(doc, item.get(PDFName.of("A")));
  if (action instanceof PDFDict && action.get(PDFName.of("S")) === PDFName.of("GoTo")) {
    return resolveDest(doc, action.get(PDFName.of("D")));
  }
  return null;
}

/** Depth-first walk of `parent`'s children; /Count is ignored and `seen` breaks cycles. */
function walk(doc: PDFDocument, parent: PDFDict, level: number, seen: Set<PDFObject | string>, out: Bookmark[]): void {
  let next = parent.get(PDFName.of("First"));
  while (next !== undefined) {
    const key = next instanceof PDFRef ? next.toString() : next;
    const item = deref(doc, next);
    if (seen.has(key) || !(item instanceof PDFDict)) return;
    seen.add(key);
    out.push({ title: textOf(item.lookup(PDFName.of("Title"))) ?? "", page: itemPage(doc, item), level });
    walk(doc, item, level + 1, seen, out);
    next = item.get(PDFName.of("Next"));
  }
}

/** The document's bookmarks, depth-first. Never throws on a malformed outline. */
export function readOutline(doc: PDFDocument): Bookmark[] {
  const rootRef = doc.catalog.get(OUTLINES);
  const root = deref(doc, rootRef);
  if (!(root instanceof PDFDict)) return [];
  const out: Bookmark[] = [];
  const seen = new Set<PDFObject | string>([rootRef instanceof PDFRef ? rootRef.toString() : root]);
  walk(doc, root, 0, seen, out);
  return out;
}

interface Node {
  bookmark: Bookmark;
  level: number;
  ref: PDFRef;
  children: Node[];
}

/** Nest `bookmarks` by level; a jump of more than one level becomes a child of the item before it. */
function buildTree(doc: PDFDocument, bookmarks: Bookmark[]): Node[] {
  const top: Node[] = [];
  const stack: Node[] = [];
  for (const bookmark of bookmarks) {
    while (stack.length && stack[stack.length - 1].level >= bookmark.level) stack.pop();
    const parent = stack[stack.length - 1];
    const node: Node = { bookmark, level: parent ? parent.level + 1 : 0, ref: doc.context.nextRef(), children: [] };
    (parent ? parent.children : top).push(node);
    stack.push(node);
  }
  return top;
}

function descendants(nodes: Node[]): number {
  return nodes.reduce((n, c) => n + 1 + descendants(c.children), 0);
}

/** Assign the dicts for `nodes` (siblings under `parentRef`), every item open. */
function writeNodes(doc: PDFDocument, nodes: Node[], parentRef: PDFRef): void {
  const pages = doc.getPages();
  nodes.forEach((node, i) => {
    const dict = doc.context.obj({}) as PDFDict;
    dict.set(PDFName.of("Title"), PDFHexString.fromText(node.bookmark.title));
    dict.set(PDFName.of("Parent"), parentRef);
    if (i > 0) dict.set(PDFName.of("Prev"), nodes[i - 1].ref);
    if (i + 1 < nodes.length) dict.set(PDFName.of("Next"), nodes[i + 1].ref);
    if (node.children.length) {
      dict.set(PDFName.of("First"), node.children[0].ref);
      dict.set(PDFName.of("Last"), node.children[node.children.length - 1].ref);
    }
    dict.set(PDFName.of("Count"), doc.context.obj(descendants(node.children)));
    const page = node.bookmark.page;
    if (page !== null && Number.isInteger(page) && page >= 0 && page < pages.length) {
      dict.set(PDFName.of("Dest"), doc.context.obj([pages[page].ref, PDFName.of("XYZ"), PDFNull, PDFNull, PDFNull]));
    }
    doc.context.assign(node.ref, dict);
    writeNodes(doc, node.children, node.ref);
  });
}

/**
 * Replace the catalog's /Outlines with `bookmarks` (none removes it). The
 * old tree is left unreferenced; the next import's garbage collection drops it.
 */
export function writeOutline(doc: PDFDocument, bookmarks: Bookmark[]): void {
  if (!bookmarks.length) {
    doc.catalog.delete(OUTLINES);
    return;
  }
  const rootRef = doc.context.nextRef();
  const top = buildTree(doc, bookmarks);
  writeNodes(doc, top, rootRef);
  doc.context.assign(
    rootRef,
    doc.context.obj({ Type: "Outlines", First: top[0].ref, Last: top[top.length - 1].ref, Count: descendants(top) }),
  );
  doc.catalog.set(OUTLINES, rootRef);
}

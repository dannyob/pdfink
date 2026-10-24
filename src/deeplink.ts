/**
 * Deep links: the URL names the notebook and the place in it.
 *
 *     ?f=2026-10.pdf#page=3
 *     ?f=2026-10.pdf#page=3;x=323pdf;y=400pdf;w=200pdf;h=200pdf
 *
 * `page` is 1-based. The rectangle is a selection in PDF points, origin at
 * the page's bottom-left (the same space pen-menu commands get in $X/$Y),
 * and is present only while something is selected. The app rewrites the URL
 * with `history.replaceState` as you move, so Back is not flooded, and on
 * load it opens the notebook, scrolls to the page and restores the selection.
 */
import type { App } from "./app";
import { normalizeRect } from "./geometry";
import type { Rect } from "./model";
import { pdfToDisplay } from "./pdf/geom";

export interface DeepLink {
  /** 0-based page index. */
  page: number;
  /** Selection in PDF points, bottom-left origin. */
  rect?: Rect;
}

export function formatHash(link: DeepLink): string {
  let h = `#page=${link.page + 1}`;
  if (link.rect) {
    const r = link.rect;
    h += `;x=${Math.round(r.x)}pdf;y=${Math.round(r.y)}pdf;w=${Math.round(r.w)}pdf;h=${Math.round(r.h)}pdf`;
  }
  return h;
}

export function parseHash(hash: string): DeepLink | null {
  const kv = new Map<string, string>();
  for (const part of hash.replace(/^#/, "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) kv.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const page = Number(kv.get("page"));
  if (!Number.isInteger(page) || page < 1) return null;
  const link: DeepLink = { page: page - 1 };
  const num = (k: string): number | null => {
    const v = kv.get(k);
    if (v === undefined) return null;
    const n = Number(v.replace(/pdf$/, ""));
    return Number.isFinite(n) ? n : null;
  };
  const x = num("x"), y = num("y"), w = num("w"), h = num("h");
  if (x !== null && y !== null && w !== null && h !== null && w > 0 && h > 0) link.rect = { x, y, w, h };
  return link;
}

/** Display-space rect for a PDF-space selection on a page. */
function toDisplayRect(app: App, page: number, r: Rect): Rect {
  const g = app.pageGeom(page);
  const a = pdfToDisplay(g, r.x, r.y);
  const b = pdfToDisplay(g, r.x + r.w, r.y + r.h);
  return normalizeRect(a.x, a.y, b.x, b.y);
}

/** Keep the URL in step with the app, and apply the URL's hash once a notebook is open. */
export function installDeepLinks(app: App, initialHash: string = location.hash): void {
  let pending: DeepLink | null = parseHash(initialHash);

  const write = (): void => {
    const u = new URL(location.href);
    if (app.source.kind === "server") {
      u.searchParams.set("f", app.source.name);
      u.searchParams.delete("open");
      u.searchParams.delete("new");
    } else {
      u.searchParams.delete("f");
    }
    const sel = app.selectionInfo();
    u.hash = formatHash(sel ? { page: sel.page, rect: sel.pdfRect } : { page: app.currentPage });
    if (u.href !== location.href) history.replaceState(history.state, "", u);
  };

  app.on("notebook", () => {
    const link = pending;
    pending = null;
    if (link && link.page < app.pages.length) {
      if (link.rect) app.selectRect(link.page, toDisplayRect(app, link.page, link.rect));
      app.scrollToPage(link.page);
    }
    write();
  });
  app.on("page", write);
  app.on("selection", write);
}

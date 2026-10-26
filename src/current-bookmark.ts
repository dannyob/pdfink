import type { Bookmark } from "./model";

/**
 * Which bookmark is "current": the last one, in outline order, opening a page
 * at or before `inkPage` (where the pen last touched). With no ink yet, the
 * one last `picked` from the menu; failing that, the one covering page 0.
 * Returns an index into `bookmarks`, or null when none qualifies.
 */
export function currentBookmark(bookmarks: Bookmark[], inkPage: number | null, picked: number | null): number | null {
  if (inkPage === null && picked !== null && Number.isInteger(picked) && picked >= 0 && picked < bookmarks.length) return picked;
  const page = inkPage ?? 0;
  let found: number | null = null;
  bookmarks.forEach((b, i) => {
    if (b.page !== null && b.page <= page) found = i;
  });
  return found;
}

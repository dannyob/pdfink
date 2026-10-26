import { describe, expect, it } from "vitest";
import { currentBookmark } from "../../src/current-bookmark";
import type { Bookmark } from "../../src/model";

const bm = (page: number | null, level = 0, title = `p${page}`): Bookmark => ({ title, page, level });

describe("currentBookmark", () => {
  const outline = [bm(1), bm(5), bm(6), bm(6, 1, "p6 inside"), bm(9)];

  it("is null with no bookmarks, whatever the ink or pick", () => {
    expect(currentBookmark([], null, null)).toBeNull();
    expect(currentBookmark([], 4, null)).toBeNull();
    expect(currentBookmark([], null, 0)).toBeNull();
  });

  it("is the last bookmark in outline order at or before the ink page", () => {
    expect(currentBookmark(outline, 7, null)).toBe(3);
    expect(currentBookmark(outline, 6, null)).toBe(3);
    expect(currentBookmark(outline, 5, null)).toBe(1);
    expect(currentBookmark(outline, 100, null)).toBe(4);
  });

  it("is null when the ink is before the first bookmark", () => {
    expect(currentBookmark(outline, 0, null)).toBeNull();
  });

  it("ignores the pick once there is ink", () => {
    expect(currentBookmark(outline, 7, 0)).toBe(3);
  });

  it("with no ink, is the picked bookmark", () => {
    expect(currentBookmark(outline, null, 3)).toBe(3);
    expect(currentBookmark(outline, null, 0)).toBe(0);
  });

  it("with no ink and no pick, is the bookmark covering page 0, or null", () => {
    expect(currentBookmark([bm(0), bm(0, 1), bm(2)], null, null)).toBe(1);
    expect(currentBookmark(outline, null, null)).toBeNull();
  });

  it("skips bookmarks with no page", () => {
    const withNull = [bm(0), bm(null), bm(3), bm(null, 1)];
    expect(currentBookmark(withNull, 2, null)).toBe(0);
    expect(currentBookmark(withNull, 5, null)).toBe(2);
    expect(currentBookmark([bm(null)], 5, null)).toBeNull();
  });

  it("falls back to the page-0 rule when the pick is out of range", () => {
    const zero = [bm(0), bm(4)];
    expect(currentBookmark(zero, null, 2)).toBe(0);
    expect(currentBookmark(zero, null, -1)).toBe(0);
    expect(currentBookmark(zero, null, 0.5)).toBe(0);
    expect(currentBookmark(outline, null, 5)).toBeNull();
  });
});

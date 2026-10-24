import { describe, expect, it } from "vitest";
import { formatHash, parseHash } from "../../src/deeplink";

describe("deep-link hash", () => {
  it("formats the current page, 1-based", () => {
    expect(formatHash({ page: 0 })).toBe("#page=1");
  });

  it("formats a selection in PDF points, rounded", () => {
    expect(formatHash({ page: 1, rect: { x: 323.4, y: 400, w: 200.49, h: 200 } })).toBe("#page=2;x=323pdf;y=400pdf;w=200pdf;h=200pdf");
  });

  it("parses a page and a selection", () => {
    expect(parseHash("#page=2;x=323pdf;y=400pdf;w=200pdf;h=200pdf")).toEqual({ page: 1, rect: { x: 323, y: 400, w: 200, h: 200 } });
  });

  it("parses a bare page and drops an incomplete rectangle", () => {
    expect(parseHash("#page=3")).toEqual({ page: 2 });
    expect(parseHash("#page=1;x=5pdf")).toEqual({ page: 0 });
  });

  it("returns null for no page, a bad page or an empty hash", () => {
    expect(parseHash("")).toBeNull();
    expect(parseHash("#page=0")).toBeNull();
    expect(parseHash("#x=1pdf")).toBeNull();
  });
});

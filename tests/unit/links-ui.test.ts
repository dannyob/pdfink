import { afterEach, describe, expect, it } from "vitest";
import { normalizeUrl, todayIso } from "../../src/links-ui";
import { linkUrlOk } from "../../src/pdf/links";

describe("normalizeUrl", () => {
  it("prepends https:// to a bare host and path", () => {
    expect(normalizeUrl("example.com/x")).toBe("https://example.com/x");
    expect(normalizeUrl("example.com:8080/x")).toBe("https://example.com:8080/x");
    expect(normalizeUrl("localhost:5173")).toBe("https://localhost:5173");
  });

  it("keeps a url that already has a scheme", () => {
    expect(normalizeUrl("https://example.org/")).toBe("https://example.org/");
    expect(normalizeUrl("HTTP://example.org")).toBe("HTTP://example.org");
    expect(normalizeUrl("mailto:me@example.com")).toBe("mailto:me@example.com");
  });

  it("trims whitespace; blank input stays empty", () => {
    expect(normalizeUrl("  example.com \n")).toBe("https://example.com");
    expect(normalizeUrl("   ")).toBe("");
    expect(normalizeUrl("")).toBe("");
  });

  it("leaves other schemes alone so linkUrlOk can refuse them", () => {
    expect(normalizeUrl("JAVASCRIPT:alert(1)")).toBe("JAVASCRIPT:alert(1)");
    expect(linkUrlOk(normalizeUrl("JAVASCRIPT:alert(1)"))).toBe(false);
    expect(normalizeUrl("data:text/html,hi")).toBe("data:text/html,hi");
    expect(linkUrlOk(normalizeUrl("example.com/x"))).toBe(true);
  });
});

describe("todayIso", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it("formats a local date as YYYY-MM-DD with zero padding", () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(todayIso(new Date(2026, 10, 30, 0, 0))).toBe("2026-11-30");
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uses local time, not UTC", () => {
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14
    expect(todayIso(new Date("2026-01-01T12:00:00Z"))).toBe("2026-01-02");
    process.env.TZ = "Pacific/Pago_Pago"; // UTC-11
    expect(todayIso(new Date("2026-01-01T05:00:00Z"))).toBe("2025-12-31");
  });
});

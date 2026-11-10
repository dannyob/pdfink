import { describe, expect, it } from "vitest";
import { checkImportUrl, fetchPdf, importParam, nameFromUrl } from "../../src/import-url";

describe("importParam", () => {
  it("is null without an import parameter", () => {
    expect(importParam("")).toBeNull();
    expect(importParam("?f=a.pdf&new=1")).toBeNull();
    expect(importParam("?reimport=x")).toBeNull();
  });

  it("takes a percent-encoded URL", () => {
    expect(importParam("?import=https%3A%2F%2Fexample.com%2Fa%20b.pdf%3Fx%3D1%26y%3D2")).toBe("https://example.com/a b.pdf?x=1&y=2");
  });

  it("takes everything after import= so an unencoded URL keeps its own query", () => {
    expect(importParam("?import=https://example.com/get?id=3&fmt=pdf")).toBe("https://example.com/get?id=3&fmt=pdf");
    expect(importParam("?nofs=1&import=https://example.com/a.pdf")).toBe("https://example.com/a.pdf");
  });

  it("leaves an unencoded URL's own escapes alone", () => {
    expect(importParam("?import=https://example.com/a%20b.pdf")).toBe("https://example.com/a%20b.pdf");
  });

  it("stops an encoded URL at the next parameter", () => {
    expect(importParam("?import=https%3A%2F%2Fexample.com%2Fa.pdf&nofs=1")).toBe("https://example.com/a.pdf");
  });

  it("is null when import= is empty", () => {
    expect(importParam("?import=")).toBeNull();
  });
});

describe("checkImportUrl", () => {
  it("accepts http and https", () => {
    expect(checkImportUrl(" https://example.com/a.pdf ").href).toBe("https://example.com/a.pdf");
    expect(checkImportUrl("http://example.com/a.pdf").protocol).toBe("http:");
  });

  it("adds https:// to a bare host and path", () => {
    expect(checkImportUrl("example.com/a.pdf").href).toBe("https://example.com/a.pdf");
  });

  it("refuses other schemes and junk", () => {
    expect(() => checkImportUrl("file:///etc/passwd")).toThrow(/http/);
    expect(() => checkImportUrl("javascript:alert(1)")).toThrow(/http/);
    expect(() => checkImportUrl("")).toThrow();
    expect(() => checkImportUrl("not a url at all")).toThrow();
  });
});

describe("nameFromUrl", () => {
  it("uses the last path segment, decoded", () => {
    expect(nameFromUrl("https://www.ntk.net/foo.pdf")).toBe("foo.pdf");
    expect(nameFromUrl("https://example.com/papers/My%20Paper%20(v2).pdf?dl=1")).toBe("My Paper (v2).pdf");
  });

  it("adds .pdf when the path has none", () => {
    expect(nameFromUrl("https://arxiv.org/pdf/2401.12345")).toBe("2401.12345.pdf");
    expect(nameFromUrl("https://example.com/download/")).toBe("download.pdf");
  });

  it("replaces characters a notebook name can't have", () => {
    expect(nameFromUrl("https://example.com/r%C3%A9sum%C3%A9%2Bnotes.pdf")).toBe("r-sum--notes.pdf");
    expect(nameFromUrl("https://example.com/.hidden.pdf")).toBe("hidden.pdf");
  });

  it("falls back to the host name", () => {
    expect(nameFromUrl("https://example.com/")).toBe("example.com.pdf");
    expect(nameFromUrl("https://example.com")).toBe("example.com.pdf");
  });
});

const pdfBytes = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");

describe("fetchPdf", () => {
  it("returns the bytes of a PDF", async () => {
    const fake = async () => new Response(pdfBytes, { status: 200 });
    expect(await fetchPdf("https://example.com/a.pdf", fake as typeof fetch)).toEqual(pdfBytes);
  });

  it("says what went wrong on an HTTP error", async () => {
    const fake = async () => new Response("nope", { status: 404, statusText: "Not Found" });
    await expect(fetchPdf("https://example.com/a.pdf", fake as typeof fetch)).rejects.toThrow(/example\.com.*404/);
  });

  it("refuses something that isn't a PDF", async () => {
    const fake = async () => new Response("<html>log in</html>", { status: 200 });
    await expect(fetchPdf("https://example.com/a.pdf", fake as typeof fetch)).rejects.toThrow(/not a PDF/);
  });

  it("explains a blocked or failed fetch and suggests downloading", async () => {
    const fake = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(fetchPdf("https://example.com/a.pdf", fake as typeof fetch)).rejects.toThrow(/example\.com.*download/i);
  });
});

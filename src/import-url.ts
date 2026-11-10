/**
 * Importing a PDF from a web address, from File › Open from URL… /
 * Import from URL… or from the page's own address:
 *
 *     /?import=https://www.example.com/paper.pdf
 *     /?import=https://www.example.com/paper.pdf#page=3
 *
 * In browser-only mode the browser fetches the PDF itself, which works only
 * when the other site allows cross-origin requests. In server mode the
 * server fetches it (see POST /api/notebooks/<name>/import).
 */

/**
 * The URL in `?import=`. A percent-encoded value ends at the next `&`, like
 * any parameter. An unencoded one runs to the end of the query string, so
 * `?import=https://example.com/get?id=3&fmt=pdf` keeps its own `&fmt=pdf`.
 */
export function importParam(search: string): string | null {
  const m = /(?:^\?|[?&])import=/.exec(search);
  if (!m) return null;
  const rest = search.slice(m.index + m[0].length);
  if (/^https?%3A/i.test(rest)) {
    const amp = rest.indexOf("&");
    try {
      return decodeURIComponent(amp < 0 ? rest : rest.slice(0, amp)) || null;
    } catch {
      return null;
    }
  }
  return rest || null;
}

/** Parse a typed or linked address; a bare `host/path` gets https://. Throws a readable error. */
export function checkImportUrl(raw: string): URL {
  let s = raw.trim();
  if (!s) throw new Error("No address given.");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`"${raw.trim()}" is not a web address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https addresses can be imported, not ${url.protocol}`);
  return url;
}

/** A notebook-safe file name for the PDF at `url`: its last path segment, else the host. */
export function nameFromUrl(url: string | URL): string {
  const u = typeof url === "string" ? new URL(url) : url;
  const segs = u.pathname.split("/").filter(Boolean);
  let stem = segs.length ? segs[segs.length - 1] : "";
  try {
    stem = decodeURIComponent(stem);
  } catch {
    // keep it as it is
  }
  const clean = (s: string) =>
    s
      .replace(/[^A-Za-z0-9 ._()-]/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[^A-Za-z0-9]+/, "")
      .trim();
  let name = clean(stem);
  if (!name || /^\.?pdf$/i.test(name)) name = clean(u.hostname) || "imported";
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

/** True if `bytes` start like a PDF (the header may follow up to 1 KB of junk, as readers allow). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

/**
 * Fetch a PDF from the browser. A network error here is nearly always the
 * other site refusing cross-origin requests (CORS); the browser does not say
 * which, so the message covers both.
 */
export async function fetchPdf(url: string | URL, fetchFn: typeof fetch = fetch): Promise<Uint8Array> {
  const u = typeof url === "string" ? new URL(url) : url;
  let res: Response;
  try {
    res = await fetchFn(u.href, { credentials: "omit" });
  } catch {
    throw new Error(`Could not fetch from ${u.host}: the site does not let other web pages fetch its files, or it could not be reached. Download the PDF and open it with File › Open… instead.`);
  }
  if (!res.ok) throw new Error(`Could not fetch from ${u.host}: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!looksLikePdf(bytes)) throw new Error(`${nameFromUrl(u)} from ${u.host} is not a PDF.`);
  return bytes;
}

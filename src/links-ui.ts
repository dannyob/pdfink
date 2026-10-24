/** Small helpers for the link and bookmark menu entries. */

/**
 * Tidy what someone typed as a link: trim it, and give it `https://` when it
 * has no scheme. A `host:port` is not taken for a scheme. Other schemes are
 * kept as typed so `linkUrlOk` can refuse them. Blank input gives "".
 */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return "";
  return /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) ? s : `https://${s}`;
}

/** A date as `YYYY-MM-DD` in local time (today by default). */
export function todayIso(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

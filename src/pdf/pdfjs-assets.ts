/**
 * Where pdf.js finds the support files it loads on demand: Adobe CMaps (text in
 * non-embedded CJK fonts), the standard fonts (non-embedded Helvetica, Times
 * and the like), wasm decoders (JPEG 2000 and JBIG2 scans, ICC colour) and ICC
 * profiles. vite.config.ts serves them from pdfjs-dist in development and copies
 * them into the build under pdfjs/.
 */
export function pdfjsAssetOptions(base: string = import.meta.env.BASE_URL, origin: string = location.href) {
  const at = (dir: string) => new URL(`${base}pdfjs/${dir}/`, origin).href;
  return {
    cMapUrl: at("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: at("standard_fonts"),
    wasmUrl: at("wasm"),
    iccUrl: at("iccs"),
  };
}

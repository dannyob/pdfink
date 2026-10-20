export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(rgb: number[]): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  if (rgb.length >= 3) return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
  if (rgb.length === 1) return `#${c(rgb[0])}${c(rgb[0])}${c(rgb[0])}`;
  if (rgb.length === 4) {
    // CMYK → RGB (naive)
    const [cc, mm, yy, kk] = rgb;
    return `#${c((1 - cc) * (1 - kk))}${c((1 - mm) * (1 - kk))}${c((1 - yy) * (1 - kk))}`;
  }
  return "#000000";
}

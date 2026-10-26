/**
 * Inline SVG icons for the bar's and the pen menu's tiles. Each is a 24-unit viewBox drawn
 * with `currentColor` strokes, so the tile's CSS sets size and colour.
 */
const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  pen: svg('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>'),
  eraser: svg('<path d="M3 17l7 3 10-10-7-7L3 13z"/><path d="M10 20h11"/>'),
  select: svg('<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/>'),
  cut: svg('<circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8 16L20 4M16 16L4 4"/>'),
  paste: svg('<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5h6v3H9z"/>'),
  trash: svg('<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  addPage: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M12 11v6M9 14h6"/>'),
  commands: svg('<path d="M4 6l5 5-5 5"/><path d="M11 18h9"/>'),
  more: svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  bookmark: svg('<path d="M6 3h12v18l-6-5-6 5z"/>'),
  bookmarkAdd: svg('<path d="M6 3h8M6 3v18l6-5 6 5V11"/><path d="M18 2v6M15 5h6"/>'),
  folder: svg('<path d="M3 6h6l2 2h10v11H3z"/>'),
  fileNew: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'),
  save: svg('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3"/><rect x="8" y="13" width="8" height="8"/>'),
  import: svg('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v4h16v-4"/>'),
  export: svg('<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 17v4h16v-4"/>'),
  zoomIn: svg('<circle cx="10" cy="10" r="6"/><path d="M15 15l5 5M10 7v6M7 10h6"/>'),
  zoomOut: svg('<circle cx="10" cy="10" r="6"/><path d="M15 15l5 5M7 10h6"/>'),
  fitWidth: svg('<path d="M4 4v16M20 4v16"/><path d="M7 12h10M10 9l-3 3 3 3M14 9l3 3-3 3"/>'),
} as const;

/**
 * The bar across the top: one row of labelled icon tiles in groups, built
 * here from data and wired to the App. Its menus (File under the notebook's
 * name, Bookmarks under the current bookmark, Pen style, Commands, More) open
 * through the app's one ContextMenu, so only one menu is ever open.
 *
 * Buttons are made once and updated in place: the menu's toggle works by the
 * identity of the button that opened it, so a button must not be replaced
 * while its menu is open.
 *
 * The bar never wraps or scrolls. When it is too narrow, whole groups move to
 * the top of the More menu (see `fit`), in MOVABLE order; labels never drop.
 */
import type { App } from "./app";
import type { NotebookInfo } from "./api";
import { fitGroups } from "./fit";
import { icons } from "./icons";
import type { IconAction, MenuItem } from "./menu";

export const SWATCHES: readonly [string, string][] = [
  ["Black", "#000000"],
  ["Grey", "#7a7a7a"],
  ["Blue", "#2f4a7a"],
  ["Red", "#b3261e"],
  ["Green", "#2e7d32"],
  ["Yellow", "#f5e04a"],
];

/** Name, width in points, stroke width of its icon in the menu, and on the bar's Pen style tile. */
export const WIDTHS: readonly [string, number, number, number][] = [
  ["Thin", 0.7, 1, 1.4],
  ["Normal", 1, 2, 2.6],
  ["Thick", 2, 3.5, 4],
  ["Marker", 4, 7, 6],
];

/**
 * Groups that may leave the bar for More, first to leave first. "page" is the
 * Add page tile alone: Commands, command buttons and run chips share its
 * group but never leave.
 */
export const MOVABLE = ["page", "clipboard", "style"];

const SOURCE_URL = "https://github.com/dannyob/pdfink";

const BARREL_KEY = "pdfink.barrelErase";
const FINGER_KEY = "pdfink.fingerDraws";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

const strokeIcon = (color: string, width: number, d = "M4 15c4-6 8 4 16-4"): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${d}" stroke="${color}" stroke-width="${width}"/></svg>`;

const swatchIcon = (color: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="4" fill="${color}" stroke="#8a9099" stroke-width="1"/></svg>`;

function megabytes(size: number): string {
  const mb = size / (1024 * 1024);
  return `${mb < 1 ? mb.toFixed(2) : mb.toFixed(0)} MB`;
}

export class Toolbar {
  private notebooks: NotebookInfo[] = [];
  private readonly fileBtn: HTMLButtonElement;
  private readonly bookmarkBtn: HTMLButtonElement;
  private readonly styleBtn: HTMLButtonElement;
  private readonly commandsBtn: HTMLButtonElement;
  private readonly moreBtn: HTMLButtonElement;
  private readonly tiles = new Map<string, HTMLButtonElement>();
  private readonly colorInput: HTMLInputElement;
  private readonly groups = new Map<string, HTMLDivElement>();
  /** Groups now in More rather than on the bar, in MOVABLE order. */
  private moved: string[] = [];

  constructor(
    private readonly app: App,
    private readonly root: HTMLElement,
  ) {
    const group = (name: string, ...children: HTMLElement[]): HTMLDivElement => {
      const g = document.createElement("div");
      g.className = "group";
      g.dataset.group = name;
      g.append(...children);
      this.groups.set(name, g);
      return g;
    };

    this.fileBtn = this.nameButton("bar-file", "name", null, () => this.openMenu(this.fileBtn, () => this.fileItems()));
    this.fileBtn.addEventListener("click", () => void this.refreshNotebooks(true));
    this.bookmarkBtn = this.nameButton("bar-bookmark", "name bm", icons.bookmark, () => this.openMenu(this.bookmarkBtn, () => this.bookmarkItems()));
    this.styleBtn = this.tile("bar-style", "Normal", "", () => this.openMenu(this.styleBtn, () => this.styleItems()), true);
    this.styleBtn.title = "Pen style";
    this.commandsBtn = this.tile("bar-commands", "Commands", icons.commands, () => this.openCommands(), true);
    this.commandsBtn.classList.add("server-only");
    this.moreBtn = this.tile("bar-more", "More", icons.more, () => this.openMenu(this.moreBtn, () => this.moreItems()), true);

    this.colorInput = document.createElement("input");
    this.colorInput.type = "color";
    this.colorInput.id = "pen-color";
    this.colorInput.className = "visually-hidden";
    this.colorInput.tabIndex = -1;
    this.colorInput.setAttribute("aria-hidden", "true");
    this.colorInput.addEventListener("input", () => this.setColor(this.colorInput.value));

    const cmdButtons = document.getElementById("cmd-buttons") ?? Object.assign(document.createElement("div"), { id: "cmd-buttons" });
    const runs = document.getElementById("runs") ?? Object.assign(document.createElement("div"), { id: "runs" });
    cmdButtons.classList.add("server-only");
    runs.classList.add("server-only");

    const spacer = document.createElement("span");
    spacer.className = "grow";

    root.replaceChildren(
      group("file", this.fileBtn, this.bookmarkBtn),
      group(
        "tools",
        this.tile("tool-pen", "Pen", icons.pen, () => app.setTool("pen"), false, "Pen (P)"),
        this.tile("tool-eraser", "Eraser", icons.eraser, () => app.setTool("eraser"), false, "Eraser (E)"),
        this.tile("tool-select", "Select", icons.select, () => app.setTool("select"), false, "Select rectangle (S)"),
      ),
      group("style", this.styleBtn, this.colorInput),
      group(
        "clipboard",
        this.tile("btn-copy", "Copy", icons.copy, () => app.copy(), false, "Copy selection (Ctrl+C)"),
        this.tile("btn-cut", "Cut", icons.cut, () => app.cut(), false, "Cut selection (Ctrl+X)"),
        this.tile("btn-paste", "Paste", icons.paste, () => void app.pasteFromButton(), false, "Paste (Ctrl+V)"),
        this.tile("btn-delete", "Delete", icons.trash, () => app.deleteSelection(), false, "Delete selection (Delete)"),
      ),
      group(
        "history",
        this.tile("btn-undo", "Undo", icons.undo, () => app.undo(), false, "Undo (Ctrl+Z)"),
        this.tile("btn-redo", "Redo", icons.redo, () => app.redo(), false, "Redo (Ctrl+Shift+Z)"),
      ),
      group("page", this.tile("btn-addpage", "Add page", icons.addPage, () => void app.addPage(), false, "Add a blank page at the end"), this.commandsBtn, cmdButtons, runs),
      spacer,
      group("more", this.moreBtn),
    );
    for (const t of ["pen", "eraser", "select"]) this.tiles.get(`tool-${t}`)?.classList.add("tool");

    // Pen options, remembered on this device.
    app.setBarrelHeuristic(stored(BARREL_KEY) !== "0");
    const finger = stored(FINGER_KEY);
    app.fingerDrawsPinned = finger === "1";
    // Default on where there is nothing finer than a finger (phones, pen-less tablets).
    app.setFingerDraws(finger !== null ? finger === "1" : !matchMedia("(any-pointer: fine)").matches);

    app.onState = () => this.refresh();
    app.onNotebooksChanged = () => void this.refreshNotebooks();
    for (const ev of ["selection", "bookmarks", "notebook", "currentBookmark", "page", "save"] as const) app.on(ev, () => this.refresh());
    app.setTool(app.tool); // paint the tool tiles
    this.refresh();

    // Refit when the bar's width changes, and when its contents do: the name
    // and bookmark text, the pen style label, command buttons and run chips.
    // `fit` changes only classes and attributes, which these do not watch.
    new ResizeObserver(() => this.fit()).observe(root);
    new MutationObserver(() => this.fit()).observe(root, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", () => this.fit());
    void document.fonts?.ready.then(() => this.fit());
    this.fit();
  }

  /**
   * Measure every group with all of them shown, then hide the movable ones
   * that must go for the rest to fit on one row. A hidden group takes its
   * separator with it (the separator is the group's own ::before).
   */
  fit(): void {
    const bar = this.root;
    const addPage = this.tiles.get("btn-addpage")!;
    bar.classList.add("measuring");
    for (const el of bar.querySelectorAll(".moved")) el.classList.remove("moved");

    const css = getComputedStyle(bar);
    const gap = parseFloat(css.columnGap) || 0;
    const width = (el: Element): number => (el instanceof HTMLElement && el.offsetParent === null ? 0 : el.getBoundingClientRect().width + gap);
    const widths: Record<string, number> = {};
    for (const child of bar.children) {
      const name = child instanceof HTMLElement ? (child.dataset.group ?? "grow") : "other";
      // The spacer stretches; it needs only its minimum.
      widths[name] = (widths[name] ?? 0) + (name === "grow" ? (parseFloat(getComputedStyle(child).flexBasis) || 0) + gap : width(child));
    }
    // Add page leaves on its own; when it is all its group shows (browser-only storage), the whole group goes.
    const pageGroup = this.groups.get("page")!;
    const pageAlone = ![...pageGroup.children].some((c) => c !== addPage && c instanceof HTMLElement && c.offsetParent !== null);
    const pageAll = widths.page ?? 0;
    widths.page = pageAlone ? pageAll : width(addPage);
    widths["page-rest"] = pageAll - widths.page;
    // n groups have n - 1 gaps; half a pixel absorbs sub-pixel widths that would not show.
    const available = bar.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight) + gap + 0.5;

    const moved = fitGroups(widths, available, MOVABLE);
    for (const name of moved) {
      if (name === "page") (pageAlone ? pageGroup : addPage).classList.add("moved");
      else this.groups.get(name)?.classList.add("moved");
    }
    bar.classList.remove("measuring");
    if (bar.dataset.moved !== moved.join(" ")) bar.dataset.moved = moved.join(" ");
    this.moved = moved;
    // A menu opened from a tile that just left the bar would hang from nothing.
    const menu = this.app.menu;
    if (menu.open && menu.owner && menu.owner !== this.moreBtn && menu.owner.offsetParent === null) menu.hide();
  }

  /** Bring every button's label, icon and enabled state up to date, in place. */
  refresh(): void {
    const app = this.app;
    this.setText(this.fileBtn, app.fileName);
    const i = app.currentBookmarkIndex;
    const b = i === null ? null : app.bookmarks[i];
    this.setText(this.bookmarkBtn, b ? b.title : "Bookmarks");
    this.bookmarkBtn.classList.toggle("none", !b);

    const { label, icon } = this.styleLook();
    const key = `${label}|${icon}`;
    if (this.styleBtn.dataset.shown !== key) {
      this.styleBtn.dataset.shown = key;
      this.styleBtn.querySelector("svg")?.remove();
      this.styleBtn.insertAdjacentHTML("afterbegin", icon);
      this.styleBtn.querySelector(".tl")!.textContent = label;
      this.styleBtn.setAttribute("aria-label", `Pen style: ${label}`);
    }
    if (this.colorInput.value !== app.penColor && /^#[0-9a-f]{6}$/i.test(app.penColor)) this.colorInput.value = app.penColor;

    const sel = app.hasSelection;
    for (const id of ["btn-copy", "btn-cut", "btn-delete"]) this.tiles.get(id)!.disabled = !sel;
    this.tiles.get("btn-undo")!.disabled = app.undoStack.length === 0;
    this.tiles.get("btn-redo")!.disabled = app.redoStack.length === 0;
  }

  /** The Pen style tile's label (the width's name) and icon (a stroke in the pen's colour and width). */
  private styleLook(): { label: string; icon: string } {
    const app = this.app;
    const width = WIDTHS.find((w) => w[1] === app.penWidth);
    return {
      label: width ? width[0] : `${app.penWidth} pt`,
      icon: strokeIcon(app.penColor, width ? width[3] : Math.min(7, 1 + app.penWidth * 1.5)),
    };
  }

  /** Fetch the notebook list for the File menu; `redraw` reopens a File menu still showing its top level. */
  async refreshNotebooks(redraw = false): Promise<void> {
    if (this.app.storage !== "server") return;
    try {
      const list = await this.app.refreshNotebooks();
      const changed = JSON.stringify(list) !== JSON.stringify(this.notebooks);
      this.notebooks = list;
      if (redraw && changed) this.redraw(this.fileBtn, () => this.fileItems());
    } catch (err) {
      this.app.setStatus((err as Error).message);
    }
  }

  // ------------------------------------------------------------ menus

  private openMenu(button: HTMLButtonElement, items: () => MenuItem[]): void {
    this.app.menu.showFor(button, items());
  }

  /** Re-render `button`'s menu if it is open at its top level (its items changed). */
  private redraw(button: HTMLButtonElement, items: () => MenuItem[]): void {
    const menu = this.app.menu;
    if (!menu.open || menu.owner !== button || menu.depth !== 0) return;
    menu.hide();
    menu.showFor(button, items());
  }

  private openCommands(): void {
    const items = this.app.barCommandItems();
    this.openMenu(this.commandsBtn, () => (items.length ? items : [{ label: "No commands", disabled: true }]));
    void this.app.refreshCommands(); // for next time; the file may have been edited
  }

  private fileItems(): MenuItem[] {
    const app = this.app;
    const notebookPages = app.notebookMenuItem(app.currentPage, "Notebook pages", () => this.redraw(this.fileBtn, () => this.fileItems()));
    const head: MenuItem = { kind: "label", label: app.fileName };
    if (app.storage !== "server") {
      return [
        head,
        { label: "Open…", icon: icons.folder, detail: "Ctrl+O", action: () => void app.open() },
        { label: "New", icon: icons.fileNew, action: () => void app.newDocument() },
        { separator: true },
        { label: "Save", icon: icons.save, detail: "Ctrl+S", action: () => void app.save() },
        { label: "Save as…", action: () => void app.saveAs() },
        notebookPages,
      ];
    }
    const current = app.source.kind === "server" ? app.source.name : null;
    const list: MenuItem[] = this.notebooks.length
      ? this.notebooks.map((n) => ({ label: n.name, detail: megabytes(n.size), current: n.name === current, action: () => void app.openNotebook(n.name) }))
      : [{ label: "No notebooks yet", disabled: true }];
    return [
      head,
      { kind: "submenu", label: "Open notebook…", heading: "Notebooks", items: list },
      { label: "New notebook", icon: icons.fileNew, action: () => void app.newNotebook() },
      { separator: true },
      { label: "Save", icon: icons.save, detail: "Ctrl+S", action: () => void app.save() },
      notebookPages,
      { separator: true },
      { label: "Import a PDF…", icon: icons.import, detail: "Ctrl+O", action: () => void app.importLocal() },
      { label: "Export as PDF…", icon: icons.export, action: () => void app.exportLocal() },
    ];
  }

  private bookmarkItems(): MenuItem[] {
    const app = this.app;
    const cur = app.currentBookmarkIndex;
    const items: MenuItem[] = app.bookmarks.map((b, i) => ({
      label: b.title,
      indent: b.level,
      detail: b.page === null ? undefined : `p. ${b.page + 1}`,
      current: i === cur,
      disabled: b.page === null,
      action: () => app.pickBookmark(i),
    }));
    if (items.length) items.push({ separator: true });
    items.push({ label: "Bookmark this page…", icon: icons.bookmarkAdd, action: () => void app.bookmarkMenuPage(app.currentPage) });
    const here = app.bookmarkOnPage(app.currentPage);
    if (here !== null) items.push({ label: `Remove "${app.bookmarks[here].title}"`, action: () => app.removeBookmark(here) });
    return items;
  }

  private styleItems(): MenuItem[] {
    const app = this.app;
    const color = app.penColor.toLowerCase();
    return [
      { kind: "row", items: SWATCHES.map(([label, c]): IconAction => ({ label, icon: swatchIcon(c), checked: c === color, action: () => this.setColor(c) })) },
      { label: "Custom colour…", action: () => this.colorInput.click() },
      {
        kind: "row",
        labelled: true,
        items: WIDTHS.map(([label, w, iw]): IconAction => ({ label, icon: strokeIcon("currentColor", iw, "M3 12h18"), checked: w === app.penWidth, action: () => this.setWidth(w) })),
      },
    ];
  }

  /** Rows for the groups that left the bar: Pen style and Add page share one, the clipboard has its own. */
  private movedRows(): MenuItem[] {
    const app = this.app;
    const rows: MenuItem[] = [];
    const first: IconAction[] = [];
    if (this.moved.includes("style")) {
      const { label, icon } = this.styleLook();
      first.push({ label, icon, action: () => this.openMenu(this.moreBtn, () => this.styleItems()) });
    }
    if (this.moved.includes("page")) first.push({ label: "Add page", icon: icons.addPage, action: () => void app.addPage() });
    if (first.length) rows.push({ kind: "row", labelled: true, items: first });
    if (this.moved.includes("clipboard")) {
      const none = !app.hasSelection;
      rows.push({
        kind: "row",
        labelled: true,
        items: [
          { label: "Copy", icon: icons.copy, disabled: none, action: () => app.copy() },
          { label: "Cut", icon: icons.cut, disabled: none, action: () => app.cut() },
          { label: "Paste", icon: icons.paste, action: () => void app.pasteFromButton() },
          { label: "Delete", icon: icons.trash, disabled: none, action: () => app.deleteSelection() },
        ],
      });
    }
    return rows;
  }

  private moreItems(): MenuItem[] {
    const app = this.app;
    return [
      ...this.movedRows(),
      { kind: "label", label: "View" },
      {
        kind: "row",
        labelled: true,
        items: [
          { label: "Smaller", icon: icons.zoomOut, action: () => app.zoom(0.8) },
          { label: "Fit width", icon: icons.fitWidth, action: () => app.fitWidth() },
          { label: "Larger", icon: icons.zoomIn, action: () => app.zoom(1.25) },
        ],
      },
      { kind: "label", label: "Pen" },
      { label: "Barrel button erases", checked: app.barrelHeuristic, action: () => this.setBarrel(!app.barrelHeuristic) },
      { label: "Finger draws", checked: app.fingerDraws, action: () => this.setFinger(!app.fingerDraws) },
      { separator: true },
      { label: "Source code on GitHub", action: () => void window.open(SOURCE_URL, "_blank", "noopener") },
    ];
  }

  // ------------------------------------------------------------ settings

  private setColor(c: string): void {
    this.app.penColor = c.toLowerCase();
    this.refresh();
  }

  private setWidth(w: number): void {
    this.app.penWidth = w;
    this.refresh();
  }

  private setBarrel(on: boolean): void {
    this.app.setBarrelHeuristic(on);
    store(BARREL_KEY, on ? "1" : "0");
  }

  private setFinger(on: boolean): void {
    this.app.setFingerDraws(on);
    this.app.fingerDrawsPinned = on;
    store(FINGER_KEY, on ? "1" : "0");
  }

  // ------------------------------------------------------------ buttons

  /** A labelled tile; `menu` marks it as opening a menu. */
  private tile(id: string, label: string, icon: string, onClick: () => void, menu = false, title = label): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.className = "tile labelled";
    b.title = title;
    b.innerHTML = icon;
    const l = document.createElement("span");
    l.className = "tl";
    l.textContent = label;
    b.appendChild(l);
    if (menu) {
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
    }
    b.addEventListener("click", onClick);
    this.tiles.set(id, b);
    return b;
  }

  /** The name and bookmark buttons: text (ellipsised) and ▾, opening a menu. */
  private nameButton(id: string, className: string, icon: string | null, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.id = id;
    b.className = `tile ${className}`;
    if (icon) b.innerHTML = icon;
    const t = document.createElement("span");
    t.className = "txt";
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.setAttribute("aria-hidden", "true");
    chev.textContent = "▾";
    b.append(t, chev);
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.addEventListener("click", onClick);
    return b;
  }

  private setText(button: HTMLButtonElement, text: string): void {
    const t = button.querySelector(".txt")!;
    if (t.textContent !== text) t.textContent = text;
    if (button.title !== text) button.title = text;
  }
}

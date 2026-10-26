/**
 * The pen's context menu: opened at the pen tip by the barrel button (when
 * the button is not set to erase) and by a mouse right-click.
 *
 * Built for a stylus: every row and tile is at least 44 px tall, nothing
 * opens on hover, and a submenu drills down *in place* (the panel's contents
 * swap, a Back row appears at the top) rather than cascading beside the
 * parent, so the pen never has to cross a gap or hold still.
 */
export interface MenuAction {
  label: string;
  action?: () => void;
  disabled?: boolean;
  /**
   * Tiles: shown as the current choice (filled). Text rows: a boolean makes
   * the row a toggle with a box, empty when false and ticked when true;
   * leave it undefined on plain actions.
   */
  checked?: boolean;
  /** Background tint: rows about the thing under the pen, or user commands. */
  tint?: "context" | "command";
  /** Text rows: inline SVG markup drawn before the label. */
  icon?: string;
  /** Text rows: short text at the right, such as a shortcut or a page number. */
  detail?: string;
  /** Text rows: nesting depth, 18 px per level (bookmark levels). */
  indent?: number;
  /** Text rows: the entry that is current now (ticked, with an ink bar on its left). */
  current?: boolean;
}

export interface IconAction extends MenuAction {
  /** Inline SVG markup drawn in the tile; the label becomes the tooltip. */
  icon: string;
}

export type MenuItem =
  | MenuAction
  | { separator: true; label?: string }
  /** `labelled` puts each tile's label under its icon instead of only in its tooltip. */
  | { kind: "row"; items: IconAction[]; labelled?: boolean }
  | { kind: "submenu"; label: string; heading?: string; items: MenuItem[] }
  | { kind: "label"; label: string };

export class ContextMenu {
  readonly el: HTMLDivElement;
  private openedAt = 0;
  private triggerPointer: number | null = null;
  /** Levels of the drill-down; the last one is showing. */
  private stack: { items: MenuItem[]; heading?: string }[] = [];
  /** Where the menu was asked to appear; each render re-clamps from here. */
  private anchor = { x: 0, y: 0 };
  /** The button that opened the menu with `showFor`, while it is open. */
  owner: HTMLElement | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.id = "ctx-menu";
    this.el.setAttribute("role", "menu");
    this.el.hidden = true;
    document.body.appendChild(this.el);
    // Close on anything outside, but not on the very press that opened it.
    // The closing press is swallowed: a pen tap that closes the menu must not
    // also draw, erase or select, and a palm must not act. A press on the
    // owning button is left alone; its click toggles the menu shut.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (this.el.hidden) return;
        if (this.el.contains(e.target as Node)) return;
        if (this.owner && this.owner.contains(e.target as Node)) return;
        if (e.pointerId === this.triggerPointer && performance.now() - this.openedAt < 1500) return;
        e.stopPropagation();
        e.preventDefault();
        this.hide();
      },
      { capture: true },
    );
    // The opening press stops being exempt once that pointer is released:
    // pens keep one pointerId across lifts, so a fresh tap right after must
    // close the menu (and be swallowed), not slip through and ink. A barrel
    // held while hovering ends with a buttonless move rather than a pointerup.
    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.triggerPointer) return;
      if (e.type === "pointermove" && e.buttons !== 0) return;
      this.triggerPointer = null;
    };
    for (const t of ["pointerup", "pointercancel", "pointermove"] as const) document.addEventListener(t, release, { capture: true });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.el.hidden) {
        // Other document-level handlers (the app clears the selection on Escape) must not see it.
        e.stopImmediatePropagation();
        if (this.depth > 0) this.back();
        else this.hide();
      }
    });
    window.addEventListener("resize", () => this.hide());
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  /** 0 at the top level, 1 inside a submenu, and so on. */
  get depth(): number {
    return Math.max(0, this.stack.length - 1);
  }

  show(x: number, y: number, items: MenuItem[], triggerPointer: number | null = null): void {
    this.setOwner(null);
    this.openAt(x, y, items, triggerPointer);
  }

  /**
   * Open under a button (its bottom-left, 4 px below). Called again for the
   * same button while its menu is open, it closes the menu instead.
   */
  showFor(button: HTMLElement, items: MenuItem[]): void {
    if (this.open && this.owner === button) {
      this.hide();
      return;
    }
    const r = button.getBoundingClientRect();
    this.openAt(r.left, r.bottom + 4, items, null);
    this.setOwner(button);
  }

  private setOwner(button: HTMLElement | null): void {
    this.owner?.setAttribute("aria-expanded", "false");
    this.owner = button;
    button?.setAttribute("aria-expanded", "true");
  }

  private openAt(x: number, y: number, items: MenuItem[], triggerPointer: number | null): void {
    this.stack = [{ items }];
    this.anchor = { x, y };
    this.triggerPointer = triggerPointer;
    this.openedAt = performance.now();
    this.el.hidden = false;
    this.render();
  }

  /** Leave the current submenu; nothing happens at the top level. */
  back(): void {
    if (this.stack.length <= 1) return;
    this.stack.pop();
    this.render();
  }

  hide(): void {
    this.setOwner(null);
    this.el.hidden = true;
    this.triggerPointer = null;
    this.stack = [];
  }

  private enter(items: MenuItem[], heading?: string): void {
    this.stack.push({ items, heading });
    this.render();
  }

  private render(): void {
    const level = this.stack[this.stack.length - 1] ?? { items: [] };
    this.el.replaceChildren();
    if (this.stack.length > 1) {
      const b = this.button("‹ Back", "back");
      b.addEventListener("click", () => this.back());
      this.el.appendChild(b);
      if (level.heading) this.el.appendChild(this.node({ kind: "label", label: level.heading }));
    }
    for (const it of level.items) this.el.appendChild(this.node(it));
    this.place();
  }

  private node(it: MenuItem): HTMLElement {
    if ("separator" in it) return Object.assign(document.createElement("hr"), { className: "sep" });
    if ("kind" in it) {
      if (it.kind === "label") {
        const d = document.createElement("div");
        d.className = "lbl";
        d.textContent = it.label;
        return d;
      }
      if (it.kind === "row") {
        const row = document.createElement("div");
        row.className = "row";
        for (const t of it.items) row.appendChild(this.tile(t, !!it.labelled));
        return row;
      }
      const b = this.button(it.label, "menuitem submenu");
      b.setAttribute("aria-haspopup", "menu");
      const chev = document.createElement("span");
      chev.className = "chev";
      chev.textContent = "›";
      b.appendChild(chev);
      b.addEventListener("click", () => this.enter(it.items, it.heading));
      return b;
    }
    const b = this.button(it.label, "menuitem");
    if (it.icon || it.detail || it.indent) {
      b.replaceChildren();
      if (it.icon) {
        const ico = document.createElement("span");
        ico.className = "ico";
        ico.innerHTML = it.icon;
        b.appendChild(ico);
      }
      const text = document.createElement("span");
      text.className = "text";
      text.textContent = it.label;
      b.appendChild(text);
      if (it.detail) {
        const d = document.createElement("span");
        d.className = "detail";
        d.textContent = it.detail;
        b.appendChild(d);
      }
      if (it.indent) b.style.setProperty("--indent", String(it.indent));
    }
    if (it.current) {
      b.classList.add("current");
      b.setAttribute("aria-current", "true");
    }
    this.decorate(b, it);
    b.addEventListener("click", () => this.choose(it));
    return b;
  }

  private tile(t: IconAction, labelled = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = labelled ? "tile labelled" : "tile";
    b.setAttribute("role", "menuitem");
    b.setAttribute("aria-label", t.label);
    b.title = t.label;
    b.innerHTML = t.icon;
    if (labelled) {
      const l = document.createElement("span");
      l.className = "tl";
      l.textContent = t.label;
      b.appendChild(l);
    }
    this.decorate(b, t);
    b.addEventListener("click", () => this.choose(t));
    return b;
  }

  private decorate(b: HTMLButtonElement, it: MenuAction): void {
    b.disabled = !!it.disabled;
    if (it.checked) b.classList.add("checked");
    // Text rows whose `checked` is a boolean are toggles and draw a box; plain actions leave it undefined.
    if (it.checked !== undefined && !b.classList.contains("tile")) b.classList.add("toggle");
    if (it.tint) b.classList.add(it.tint);
  }

  private choose(it: MenuAction): void {
    if (it.disabled) return;
    this.hide();
    it.action?.();
  }

  private button(label: string, className: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.setAttribute("role", "menuitem");
    b.textContent = label;
    return b;
  }

  /** Keep the panel on screen, preferring the point it was opened at. */
  private place(): void {
    const r = this.el.getBoundingClientRect();
    const left = Math.max(4, Math.min(this.anchor.x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(this.anchor.y, window.innerHeight - r.height - 4));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }
}

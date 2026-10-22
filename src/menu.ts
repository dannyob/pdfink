/**
 * A small context menu for the pen: opened at the pen tip by the barrel
 * button (when the button is not set to erase) and by a mouse right-click.
 * Items are big enough for a stylus and mirror the toolbar.
 */
export interface MenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  /** Shown with a tick: the current tool. */
  checked?: boolean;
  separator?: boolean;
}

export class ContextMenu {
  readonly el: HTMLDivElement;
  private openedAt = 0;
  private triggerPointer: number | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.id = "ctx-menu";
    this.el.setAttribute("role", "menu");
    this.el.hidden = true;
    document.body.appendChild(this.el);
    // Close on anything outside, but not on the very press that opened it.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (this.el.hidden) return;
        if (this.el.contains(e.target as Node)) return;
        if (e.pointerId === this.triggerPointer && performance.now() - this.openedAt < 1500) return;
        this.hide();
      },
      { capture: true },
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.el.hidden) {
        e.stopPropagation();
        this.hide();
      }
    });
    window.addEventListener("resize", () => this.hide());
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  show(x: number, y: number, items: MenuItem[], triggerPointer: number | null = null): void {
    this.el.replaceChildren();
    for (const it of items) {
      if (it.separator) {
        this.el.appendChild(Object.assign(document.createElement("hr"), { className: "sep" }));
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = it.label;
      b.disabled = !!it.disabled;
      if (it.checked) b.classList.add("checked");
      b.addEventListener("click", () => {
        this.hide();
        it.action?.();
      });
      this.el.appendChild(b);
    }
    this.triggerPointer = triggerPointer;
    this.openedAt = performance.now();
    this.el.hidden = false;
    // Keep it on screen.
    const r = this.el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  hide(): void {
    this.el.hidden = true;
    this.triggerPointer = null;
  }
}

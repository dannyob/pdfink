/**
 * In-page replacements for window.prompt and window.confirm, plus a pick-one
 * list. Native dialogs block the page and are clumsy with a stylus and on iOS;
 * these are big enough to tap. One shows at a time: later requests queue and
 * are answered in order. Enter confirms, Escape cancels. A tap outside the box
 * does nothing, so a stray pen touch never throws away typed text.
 */
type Kind = "ask" | "confirm" | "choose";

interface Request {
  kind: Kind;
  message: string;
  suggestion: string;
  options: string[];
  /** Called with the typed text, true for OK, the picked option, or null to cancel. */
  done: (answer: string | true | null) => void;
}

export class Dialog {
  private queue: Request[] = [];
  private current: Request | null = null;
  private input: HTMLInputElement | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(readonly root: HTMLElement = document.getElementById("dialog") as HTMLElement) {
    root.hidden = true;
    document.addEventListener(
      "keydown",
      (e) => {
        if (!this.current) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.finish(null);
        } else if (e.key === "Enter") {
          // A focused button answers for itself (Enter on Cancel cancels).
          if ((e.target as HTMLElement)?.tagName === "BUTTON" && root.contains(e.target as Node)) return;
          e.preventDefault();
          e.stopPropagation();
          if (this.current.kind !== "choose") this.ok();
        }
      },
      { capture: true },
    );
  }

  ask(message: string, suggestion = ""): Promise<string | null> {
    return new Promise((resolve) =>
      this.enqueue({ kind: "ask", message, suggestion, options: [], done: (a) => resolve(typeof a === "string" ? a : null) }),
    );
  }

  confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => this.enqueue({ kind: "confirm", message, suggestion: "", options: [], done: (a) => resolve(a === true) }));
  }

  choose(message: string, options: string[]): Promise<string | null> {
    return new Promise((resolve) =>
      this.enqueue({ kind: "choose", message, suggestion: "", options, done: (a) => resolve(typeof a === "string" ? a : null) }),
    );
  }

  private enqueue(req: Request): void {
    this.queue.push(req);
    if (!this.current) this.next();
  }

  private next(): void {
    const req = this.queue.shift();
    if (!req) {
      this.current = null;
      this.input = null;
      this.root.hidden = true;
      this.root.replaceChildren();
      this.returnFocus?.focus?.();
      this.returnFocus = null;
      return;
    }
    if (!this.current) this.returnFocus = document.activeElement as HTMLElement | null;
    this.current = req;
    this.render(req);
  }

  private render(req: Request): void {
    const el = (tag: string, className: string, text?: string) => {
      const e = document.createElement(tag);
      e.className = className;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const box = el("div", "dialog-box");
    box.appendChild(el("div", "dialog-message", req.message));
    this.input = null;
    if (req.kind === "ask") {
      const input = el("input", "dialog-input") as HTMLInputElement;
      input.type = "text";
      input.value = req.suggestion;
      input.autocomplete = "off";
      box.appendChild(input);
      this.input = input;
    }
    let first: HTMLElement | null = null;
    if (req.kind === "choose") {
      const list = el("div", "dialog-options");
      for (const opt of req.options) {
        const b = el("button", "dialog-option", opt) as HTMLButtonElement;
        b.type = "button";
        b.addEventListener("click", () => this.finish(opt));
        list.appendChild(b);
        first ??= b;
      }
      box.appendChild(list);
    }
    const buttons = el("div", "dialog-buttons");
    const ok = el("button", "dialog-ok", "OK") as HTMLButtonElement;
    ok.type = "button";
    ok.hidden = req.kind === "choose"; // picking an option is the answer
    ok.addEventListener("click", () => this.ok());
    const cancel = el("button", "dialog-cancel", "Cancel") as HTMLButtonElement;
    cancel.type = "button";
    cancel.addEventListener("click", () => this.finish(null));
    buttons.append(cancel, ok);
    box.appendChild(buttons);
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", req.message);
    this.root.replaceChildren(box);
    this.root.hidden = false;
    if (this.input) {
      this.input.focus();
      this.input.select();
    } else {
      (req.kind === "confirm" ? ok : (first ?? cancel)).focus();
    }
  }

  private ok(): void {
    if (!this.current) return;
    this.finish(this.current.kind === "ask" ? (this.input?.value ?? "") : true);
  }

  private finish(answer: string | true | null): void {
    const req = this.current;
    if (!req) return;
    req.done(answer);
    this.next();
  }
}

let instance: Dialog | null = null;

/** The page's dialog, created on first use (after #dialog is in the document).
 *  Its methods are bound, so `dialog.confirm` can be passed around on its own. */
export const dialog: Pick<Dialog, "ask" | "confirm" | "choose"> = {
  ask: (message: string, suggestion?: string) => get().ask(message, suggestion),
  confirm: (message: string) => get().confirm(message),
  choose: (message: string, options: string[]) => get().choose(message, options),
};

function get(): Dialog {
  return (instance ??= new Dialog());
}

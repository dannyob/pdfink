/**
 * Synthesises Pointer Events the way a stylus produces them, so the app can be
 * driven from tests (Playwright) or the devtools console without hardware.
 *
 * Real pens: pointerType "pen", pressure > 0 while touching, buttons = 1 while
 * the tip is down, 32 when the eraser end is down, 2 (hover) / 3 (down) when
 * the barrel button is held. Coalesced events are empty for synthetic events.
 */
export interface SimOptions {
  pointerType?: "pen" | "mouse" | "touch";
  pointerId?: number;
  pressure?: number;
  /** `buttons` bitmask while down: 1 tip, 2 barrel, 32 eraser. */
  buttons?: number;
  /** Extra modifier keys. */
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/** [x, y] or [x, y, pressure] to override the pressure for that sample. */
export type SimPoint = [number, number] | [number, number, number];

function fire(target: Element, type: string, x: number, y: number, o: Required<Pick<SimOptions, "pointerType" | "pointerId">> & SimOptions, down: boolean, pointPressure?: number): void {
  const buttons = down ? (o.buttons ?? 1) : 0;
  // 0.6 is the pressure that gives a stroke its nominal width.
  const pressure = down ? (pointPressure ?? o.pressure ?? 0.6) : 0;
  let button = -1;
  if (type === "pointerdown" || type === "pointerup") {
    button = buttons & 32 ? 5 : buttons & 2 ? 2 : 0;
  }
  const ev = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    pointerType: o.pointerType,
    pointerId: o.pointerId,
    isPrimary: true,
    pressure,
    buttons,
    button,
    width: o.pointerType === "touch" ? 20 : 1,
    height: o.pointerType === "touch" ? 20 : 1,
    ctrlKey: o.ctrlKey ?? false,
    shiftKey: o.shiftKey ?? false,
  });
  target.dispatchEvent(ev);
}

function elementAt(x: number, y: number): Element {
  return document.elementFromPoint(x, y) ?? document.body;
}

function defaults(opts: SimOptions): Required<Pick<SimOptions, "pointerType" | "pointerId">> & SimOptions {
  return { pointerType: "pen", pointerId: opts.pointerType === "touch" ? 7 : 2, ...opts };
}

/** Hover the pen (no contact) over a point. */
export function hover(x: number, y: number, opts: SimOptions = {}): void {
  const o = defaults(opts);
  const el = elementAt(x, y);
  fire(el, "pointerover", x, y, o, false);
  fire(el, "pointerenter", x, y, o, false);
  fire(el, "pointermove", x, y, o, false);
}

/**
 * Hover with a button held: pressure 0 and `buttons` set (default 2, the spec's
 * barrel bit; pass 1 for pens that only toggle the contact bit).
 */
export function barrelHover(path: SimPoint[], opts: SimOptions = {}): void {
  const o = defaults({ ...opts, buttons: opts.buttons ?? 2 });
  for (const [x, y] of path) {
    const ev = new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
      pointerType: o.pointerType, pointerId: o.pointerId, isPrimary: true,
      pressure: 0, buttons: o.buttons, button: -1,
    });
    elementAt(x, y).dispatchEvent(ev);
  }
}

/** Press down, move through the points, lift. */
export function stroke(path: SimPoint[], opts: SimOptions = {}): void {
  if (!path.length) return;
  const o = defaults(opts);
  const [x0, y0, p0] = path[0];
  const target = elementAt(x0, y0);
  hover(x0, y0, o);
  fire(target, "pointerdown", x0, y0, o, true, p0);
  for (let i = 1; i < path.length; i++) {
    const [x, y, p] = path[i];
    // After pointer capture the browser would keep delivering to `target`;
    // synthetic events need to be sent there explicitly.
    fire(target, "pointermove", x, y, o, true, p);
  }
  const [xn, yn] = path[path.length - 1];
  fire(target, "pointerup", xn, yn, o, false);
}

/** Eraser-end stroke (buttons = 32). */
export function erase(path: SimPoint[], opts: SimOptions = {}): void {
  stroke(path, { ...opts, buttons: 32 });
}

/** A single tap (down + up at one point). */
export function tap(x: number, y: number, opts: SimOptions = {}): void {
  stroke([[x, y]], opts);
}

/** Generate a wiggly "handwriting-like" path between two points. */
export function scribble(x0: number, y0: number, x1: number, y1: number, steps = 40, amp = 6): SimPoint[] {
  const out: SimPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t + Math.sin(t * Math.PI * 6) * amp;
    out.push([x, y]);
  }
  return out;
}

export const stylusSim = { hover, barrelHover, stroke, erase, tap, scribble };
export type StylusSim = typeof stylusSim;

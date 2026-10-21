/**
 * Reading erase intent from pen events.
 *
 * The Pointer Events spec says a pen's eraser end sets bit 32 of `buttons` and
 * its barrel button sets bit 2. Many EMR pens on Android do neither for the
 * barrel button. Observed on a Daylight DC-1 in Chrome:
 *
 * - King Write pen, eraser end down: buttons = 32. Spec-compliant.
 * - King Write pen, barrel pressed while hovering: buttons = 1, pressure = 0.
 *   A "contact" bit with no pressure at all.
 * - No-brand EMR pen (no eraser end), barrel pressed while touching:
 *   buttons = 1, pressure = 1 exactly. Writing never otherwise reaches 1.
 * - King Write pen, barrel pressed while touching: nothing distinctive.
 *
 * The heuristic therefore treats "contact bit with pressure pinned to 0 or 1"
 * as a barrel press. It can be switched off for hardware that genuinely
 * reports full pressure when pressed hard.
 */

export interface PenSample {
  pointerType: string;
  buttons: number;
  pressure: number;
}

/** Eraser end of the pen is down (spec: bit 32). */
export function eraserEnd(s: PenSample): boolean {
  return s.pointerType === "pen" && (s.buttons & 32) !== 0;
}

/** Barrel button reported the way the spec says (bit 2). */
export function barrelBit(s: PenSample): boolean {
  return s.pointerType === "pen" && (s.buttons & 2) !== 0;
}

/**
 * Barrel press inferred from a pen that only toggles the contact bit:
 * pressure pinned to exactly 0 (hovering) or saturated at 1 (touching).
 */
export function barrelHeuristic(s: PenSample): boolean {
  if (s.pointerType !== "pen" || (s.buttons & 1) === 0) return false;
  return s.pressure >= 1 || s.pressure === 0;
}

/** Pressure that says the tip is simply writing: present but not saturated. */
export function writingPressure(s: PenSample): boolean {
  return s.pointerType === "pen" && s.pressure > 0 && s.pressure < 1 && (s.buttons & 34) === 0;
}

/** Should this sample erase rather than draw? */
export function wantsErase(s: PenSample, heuristic: boolean): boolean {
  return eraserEnd(s) || barrelBit(s) || (heuristic && barrelHeuristic(s));
}

/** True when the signal comes only from the heuristic, not from a spec bit. */
export function heuristicOnly(s: PenSample, heuristic: boolean): boolean {
  return heuristic && !eraserEnd(s) && !barrelBit(s) && barrelHeuristic(s);
}

/** Pen is off the surface (pressure 0) with a button held: erase under the hover point. */
export function hoverErase(s: PenSample, heuristic: boolean): boolean {
  if (s.pointerType !== "pen" || s.pressure !== 0) return false;
  return (s.buttons & 2) !== 0 || (heuristic && (s.buttons & 1) !== 0);
}

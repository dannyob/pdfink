/**
 * Double-click detection for the pen's barrel button, with the usual mouse
 * rules: the second press starts within DOUBLE_PRESS_MS of the first and no
 * more than DOUBLE_PRESS_SLOP CSS pixels away. A double press consumes both
 * presses, so a third quick press starts afresh (as a triple click is not two
 * double clicks).
 */
export const DOUBLE_PRESS_MS = 500;
export const DOUBLE_PRESS_SLOP = 8;

export class DoublePress {
  private last: { t: number; x: number; y: number } | null = null;

  /** Record a press at time `t` (ms) and point (x, y); true when it completes a double press. */
  press(t: number, x: number, y: number): boolean {
    const prev = this.last;
    if (prev && t - prev.t <= DOUBLE_PRESS_MS && Math.hypot(x - prev.x, y - prev.y) <= DOUBLE_PRESS_SLOP) {
      this.last = null;
      return true;
    }
    this.last = { t, x, y };
    return false;
  }
}

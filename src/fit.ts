/**
 * Which of the bar's groups must move into the More menu for the rest to fit.
 *
 * `widths` holds every group's measured width (with its separator and gap),
 * `movable` the groups allowed to leave, first to leave first. Returns those
 * that leave, in `movable` order: `[]` when everything fits, all of them when
 * even that is not enough. Groups missing from `widths` take no room and
 * never need to move.
 */
export function fitGroups(widths: Record<string, number>, available: number, movable: string[]): string[] {
  let used = Object.values(widths).reduce((a, b) => a + b, 0);
  const moved: string[] = [];
  for (const name of movable) {
    if (used <= available) break;
    if (!(name in widths)) continue;
    used -= widths[name];
    moved.push(name);
  }
  return moved;
}

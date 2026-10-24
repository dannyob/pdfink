# Compact Pen Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pen menu shows tools, clipboard and undo/redo as rows of 44 px icon tiles, keeps the other actions as text rows, and folds the commands behind one "Commands ›" row that drills down in place.

**Architecture:** `ContextMenu` (`src/menu.ts`) gains two item kinds, an icon row and a submenu, plus a level stack with a Back row; `penMenuItems()` in `src/app.ts` builds the new structure from inline SVG icons in a new `src/icons.ts`. No new DOM root, no new dependency.

**Tech Stack:** TypeScript, Vite, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-compact-pen-menu-design.md`

## Global Constraints

- Tiles and rows ≥ 44 px tall, 8 px gaps between tiles; every tile has `aria-label` and `title`.
- Nothing opens on hover; drill-down swaps the panel in place; Escape steps back before closing; choosing an action closes the menu, Back and "Commands ›" do not.
- The "Commands ›" row is hidden when there are no commands and no attached-command menu buttons.
- Opening, outside-tap close, the 1.5 s trigger-pointer guard and resize-to-close are unchanged.
- No new dependencies. `npm run typecheck`, `npm test`, `npm run test:e2e` green; existing e2e tests that drive the menu are updated, not deleted.

## Review Focus

1. A menu that grows after drilling down near the bottom edge must be re-clamped so the Back row stays on screen. (Task 1)
2. A disabled tile must not act or close the menu when tapped. (Task 1)
3. Escape with a level open goes back, not closed; a second Escape closes. (Task 1)
4. With no commands and no attached buttons, there is no "Commands ›" row and no empty second level. (Task 2)
5. The outside-tap guard still ignores the opening pen press after the menu has drilled down (same `triggerPointer`). (Task 1)

---

### Task 1: `ContextMenu` with icon rows, a submenu level and Back

**Files:**
- Modify: `src/menu.ts`, `src/style.css`
- Modify: `src/app.ts` (make `menu` public readonly so tests can drive it)
- Test: `tests/e2e/menu.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MenuAction { label: string; action?: () => void; disabled?: boolean; checked?: boolean; tint?: "context" | "command"; }
  export interface IconAction extends MenuAction { icon: string /* inline SVG markup */ }
  export type MenuItem =
    | MenuAction
    | { separator: true; label?: string }
    | { kind: "row"; items: IconAction[] }
    | { kind: "submenu"; label: string; heading?: string; items: MenuItem[] }
    | { kind: "label"; label: string };
  export class ContextMenu {
    show(x, y, items: MenuItem[], triggerPointer?: number | null): void;   // resets to level 0
    hide(): void;
    get open(): boolean;
    get depth(): number;                                                     // 0 at top level
    back(): void;                                                            // no-op at depth 0
  }
  ```
  DOM: `#ctx-menu` > (`button.menuitem[role=menuitem]` | `hr.sep` | `div.row > button.tile[role=menuitem][aria-label][title]` | `button.menuitem.submenu` with a trailing `›` | `div.lbl`); at depth > 0 the first child is `button.back` ("‹ Back"). `button.checked` marks the active tool on tiles and rows; `button.context`/`button.command` carry the tints.

- [ ] **Step 1: Write the failing e2e tests** `tests/e2e/menu.spec.ts`, opening the menu with `window.__pdfink.menu.show(200, 200, items)` where `items` are built inside `page.evaluate` and record actions into `window.__hits`:

```ts
test("icon tiles are 44 px with 8 px gaps and act once", …)      // row of 3 tiles: each boundingBox height ≥ 44, horizontal gap ≈ 8; click tile 2 → hits ["b"], menu hidden
test("a disabled tile neither acts nor closes", …)
test("a submenu drills down in place with a Back row and keeps its position", …) // left/top unchanged after drilling; .back visible; depth 1; Back → depth 0, same items
test("Escape steps back then closes", …)
test("a menu that grows near the bottom is re-clamped on screen", …)  // show at (innerWidth-50, innerHeight-50); drill into a 10-row submenu; bottom of #ctx-menu ≤ innerHeight
test("the opening pointer is still ignored after drilling down", …)   // show with triggerPointer 7; drill; dispatch pointerdown with pointerId 7 outside → still open
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test tests/e2e/menu.spec.ts`
Expected: FAIL (`menu` not exposed / kinds unknown).

- [ ] **Step 3: Implement** `src/menu.ts` (a `stack: MenuItem[][]` with `render(level)`; `show` resets the stack; `back()` pops; Escape → `back()` if depth > 0 else `hide()`; after every render re-clamp with the same left/top preference), styles in `src/style.css` (`.row { display:flex; gap:8px }`, `.tile { flex:1; min-height:44px }`, `.menuitem { min-height:44px }`, `.back`, `.lbl`, `.context`, `.command`, `.checked` fill for tiles), and `readonly menu` on `App`.

- [ ] **Step 4: Run**

Run: `npm run typecheck && npx playwright test tests/e2e/menu.spec.ts tests/e2e/drawing.spec.ts`
Expected: PASS (drawing.spec still uses the flat items at this point).

- [ ] **Step 5: Commit**

```bash
git add src/menu.ts src/style.css src/app.ts tests/e2e/menu.spec.ts
git commit -m "ContextMenu: icon rows, an in-place submenu level with Back"
```

### Task 2: The pen menu uses the new shape; icons; existing tests updated; docs

**Files:**
- Create: `src/icons.ts` (`export const icons = { pen, eraser, select, copy, cut, paste, trash, undo, redo } as const`, each an inline SVG string, 24-unit viewBox, `stroke="currentColor" fill="none" stroke-width="1.8"`)
- Modify: `src/app.ts` (`penMenuItems()`, `menuButtonItems()` folds into the Commands level)
- Modify: tests that drive the menu: `tests/e2e/drawing.spec.ts`, `notebooks.spec.ts`, `bridge.spec.ts`, `app-api.spec.ts`, `bookmarks.spec.ts`, `links.spec.ts`; add a shared helper `menuAction(page, label)` in `tests/e2e/helpers.ts` that clicks a text row, or a tile by `aria-label`, or drills into "Commands ›" first when the label is a command/button
- Modify: `README.md` (pen-menu paragraph), `docs/design.md` (one sentence)

**Interfaces:**
- Consumes: Task 1's `MenuItem` kinds.
- Produces: `penMenuItems()` returns, in order: link context rows (tint `context`) + separator when over a link; `{kind:"row"}` of Pen/Eraser/Select (checked = current tool); `{kind:"row"}` of Copy/Cut/Paste/Delete (disabled as today); `{kind:"row"}` of Undo/Redo (disabled as today); separator; Add link…, Bookmark this page…, Add page, Save; then, only if `this.commands.length || menu buttons exist`, a separator and `{kind:"submenu", label:"Commands", heading:"Commands", items:[…command rows with tint "command", then per attached run `{kind:"label", label:"Attached: <run label>"}` and its button rows]}`.

- [ ] **Step 1: Update the existing tests first and watch them fail**: in `drawing.spec.ts` the checked assertion becomes `#ctx-menu .tile.checked` with `aria-label` "Pen" and the Eraser click uses `.tile[aria-label="Eraser"]`; `Copy` disabled check uses the tile; every command/button click goes through `menuAction(page, label)` which drills into Commands; `links.spec.ts`/`bookmarks.spec.ts` label-list assertions use `allTextContents()` of `.menuitem` plus `aria-label`s of tiles. Add in `drawing.spec.ts`: `"the pen menu has three icon rows and a Commands level"` (3 `.row`s with 3/4/2 tiles; `Commands ›` present in server mode with the fixture commands; absent in local mode with no buttons).

Run: `npx playwright test tests/e2e/drawing.spec.ts`
Expected: FAIL (flat text items).

- [ ] **Step 2: Implement** `src/icons.ts`, the new `penMenuItems()`, and fold `menuButtonItems()` into the Commands level.

- [ ] **Step 3: Run the whole suite**

Run: `npm run typecheck && npm test && npm run test:e2e`
Expected: PASS

- [ ] **Step 4: Docs.** README pen-menu paragraph: three icon rows, text rows, "Commands ›" drill-down with Back, attached-command buttons live there (toolbar buttons unchanged). `docs/design.md`: one sentence under the pen menu.

- [ ] **Step 5: Commit**

```bash
git add src/icons.ts src/app.ts tests/e2e README.md docs/design.md
git commit -m "Pen menu: icon rows for tools, clipboard and undo; commands behind an in-place level"
```

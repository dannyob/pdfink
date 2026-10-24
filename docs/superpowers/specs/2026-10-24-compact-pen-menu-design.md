# Compact pen menu: icon rows and an in-place Commands level

Status: approved by Danny 2026-10-24 (small change; short design).

## Intent

The pen menu had grown to about twenty flat text rows. Danny wanted it
grouped without the finickiness of desktop cascading menus. Chosen shape:
tools, clipboard and undo/redo become three rows of icon tiles; the
remaining actions stay as text rows; the pen-menu commands fold behind one
"Commands ›" row that drills down in place, iPadOS-style.

## Layout, top to bottom

1. Context rows when the menu opens over a link: "Open <short url>",
   "Edit URL…" (tinted), then a separator.
2. Icon row: Pen, Eraser, Select (active tool filled).
3. Icon row: Copy, Cut, Paste, Delete.
4. Icon row: Undo, Redo.
5. Separator; text rows: Add link…, Bookmark this page…, Add page, Save.
6. Separator; "Commands ›" (hidden when there are no commands and no
   attached-command buttons).

Second level (after tapping "Commands ›"): "‹ Back", a small "Commands"
label, one row per command, then for each attached run that added menu
buttons an "Attached: <label>" label and its buttons.

## Behaviour

- Every tile and row is at least 44 px tall with 8 px gaps between tiles;
  tiles carry `aria-label` and `title`; icons are inline SVG (no dependency).
- Unavailable tiles (Copy/Cut/Delete with nothing selected, Undo/Redo with
  nothing to do) are dimmed and inert, as the text rows were.
- Nothing opens on hover. Tapping "Commands ›" swaps the panel's contents;
  the panel keeps its top-left position, re-clamped to the screen if it
  grew; it stays open until a choice, Back, Escape or an outside tap.
- Escape goes back one level when a level is open, else closes.
- Choosing any action closes the menu, as today. "‹ Back" and "Commands ›"
  do not close it.
- Opening (barrel press, right-click), the outside-tap close, the 1.5 s
  guard against the opening press, resize-to-close, and the toolbar buttons
  of attached commands are unchanged.

## Approaches

1. Extend `ContextMenu` with two item kinds (icon row, submenu) and a level
   stack. Chosen: one component, one DOM root, the existing open/close
   plumbing.
2. A cascading child panel beside the parent. Rejected: diagonal moves and
   pen hover make it finicky, which is what Danny asked to avoid.
3. A separate toolbar strip instead of a menu. Not asked for.

## Left to the builder

Icon drawings, exact tints, the slide animation (if any), and how tests
reach the menu component.

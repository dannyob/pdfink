# Toolbar: icon tiles, File and Bookmarks as the bar's title

Status: draft for approval, 2026-10-26, revised after a UX review. A mockup was reviewed privately.

## Intent

Make the toolbar look and work like the compact pen menu: labelled icon tiles
with 44 px+ targets, in clear groups, on one row, instead of a wrap of text
buttons, selects and checkboxes over two or three rows. It must read well on
the Daylight DC-1's reflective screen and work by stylus with no hover.

## Layout, left to right

1. **The notebook's name ▾** (max ≈190 px, ellipsis) opens the File menu:
   Open notebook… (Ctrl+O), New notebook, Save (Ctrl+S), ✓ Notebook pages,
   Import a PDF…, Export as PDF…. In browser-only storage: Open…, New, Save,
   Save as…, ✓ Notebook pages. Shortcuts show at the right of each row.
2. **The current bookmark ▾** (max ≈210 px, ellipsis) opens the Bookmarks
   menu: the outline (nested entries indented, page numbers at the right, the
   current one ticked and marked with an ink bar), then "Bookmark this
   page…". With no current bookmark it reads "Bookmarks", greyed.
   - *Current bookmark*: the last bookmark at or before the page the pen last
     touched (several on that page: the last of them). Until the pen touches
     a page, the one last picked from this menu; on opening a notebook, the
     one covering page 1. Scrolling does not change it.
3. separator · **Pen, Eraser, Select** (the selected tool filled).
4. separator · **Pen style**: one tile whose icon is a stroke in the current
   colour and width, labelled with the width ("Normal"). It opens a menu: six
   swatches (black, grey, blue, red, green, yellow), "Custom colour…" (the
   system picker), and Thin / Normal / Thick / Marker tiles drawn at their
   real widths. Replaces the colour input and width select.
5. separator · **Copy, Cut, Paste, Delete** (the pen menu's row, same order).
6. separator · **Undo, Redo**.
7. separator · **Add page**, **Commands** (opens the same list as the pen
   menu's Commands level; marked by its icon), then attached-run chips.
8. right: **More ⋯**: View (Smaller, Fit width, Larger as tiles), Pen
   (✓ Barrel button erases, ✓ Finger draws), then the source link.

**Status line** under the bar, one fixed-height line spanning the width: on
the left, status messages (command results, errors) and the progress line; on
the right, the save state ("Saving…", "Saved 10:42", "Unsaved") and the page
count ("page 6 of 19"), plus "writing on 6" while the page in view is not the
one the bookmark button follows. No save state on the buttons.

## Fitting the width

Labels never drop. When the bar is too narrow, whole groups move into the top
of the More menu, as tile rows with their labels, in this order: Add page,
then Copy/Cut/Paste/Delete, then Pen style. The name, bookmark, tools,
Undo/Redo, Commands and More never leave the bar. The steps are set by
measuring the bar, not by fixed breakpoints. Where a tile ever shows no label,
pressing and holding it for 500 ms shows its label, and lifting there does
nothing.

## Look (shared with the pen menu)

For a reflective screen, every state change uses shape or weight as well as
shade: resting tiles white with a 1 px #8a9099 edge on the #f3f3f1 bar;
disabled tiles lose fill and edge, icon and label at 35%; the selected tool
solid #2f4a7a with white; separators a 1 px #9aa0a8 rule 28 px tall with
12–14 px gaps; ▾ in full ink; current menu entries ticked. The pen menu
takes the same tile styles.

## Behaviour

- Bar menus reuse the pen menu component, one open at a time, anchored under
  their button; tapping the open button closes it; Escape and outside taps
  close it. A pen tap that closes a menu never leaves ink, and a palm touch
  while a menu is open closes it without acting.
- Every control keeps its keyboard shortcut. Existing element ids used by
  tests keep working where practical. Buttons commands add with
  `addButton(…, {where: "toolbar"})` appear in the Commands group.
- The empty-page hint names More ⋯ › Finger draws. No separator is left
  dangling where a group is hidden (Commands in browser-only mode).

## Approaches considered

- Hamburger menu: for app navigation, poorly discovered; not for document
  actions. Rejected.
- A labelled "File" tile (Google Docs, Figma): clear, but spends a tile.
  Rejected for:
- The document's name as its menu (Pages, Notes, Freeform): no extra tile,
  and the name already looks like a heading. **Chosen**, and extended to the
  current bookmark beside it (Danny's idea).
- Dropping labels when narrow: rejected after the UX review, since stylus
  and finger never see hover tooltips; whole groups move into More instead.

## Open

- Measured on the DC-1 (Chrome, 1.25× pixels): landscape 1267 × 783, portrait
  947 × 1103 CSS px. The full bar with today's names (≈1,200 px) fits in
  landscape; portrait moves Add page and the clipboard into More. Today's bar
  takes 82 px in landscape and 120 px (two rows) in portrait; the new bar
  plus status line is about 90 px in both.
- Whether browser-only mode should autosave somewhere (it does not today).

## Left to the builder

Icon drawings, the measuring/overflow mechanics, the swatch colours' exact
values, test updates for moved controls.

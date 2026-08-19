---
name: strays-pet
description: Draw a custom pixel pet for strays — a new animal for the lane, or a fix to one that already exists. Use when asked to "make a pet", "add a <thing> pet", "draw a stray", "make me a Yoda/dog/robot pet", or to adjust a pet's sprite, palette, phrases, walk frames, or sit/sleep poses. Renders the sprite through the real engine and looks at the pixels before calling it done.
---

# Drawing a pet for strays

A pet is JSON: `{ name, speed, phrases, palette, grids }`. The hard part is not the
format, it is that **a grid that looks right as characters routinely looks wrong as
pixels**. So the loop is: build → ASCII preview → render for real → look → iterate.

## Never do this

- **Never draw the outline.** A 1px dark outline is generated around every sprite.
  Drawing your own doubles it.
- **Never count row widths by hand.** Build the grid from a script that computes
  them and throws on a ragged row. Every early mistake in practice was a width.
- **Never ship without looking at rendered pixels.** ASCII is necessary and not
  sufficient — see *What only the pixels show*, below.

## The format

`grids.walk1` and `palette` are required. `walk2`, `sit`, `sleep` fall back to
`walk1`. Every row in a grid must be the same length; `.` is transparent; every
other character is a key into `palette`.

Convention: `1`/`2`/`3` light/mid/dark body, `k` black, `w` the white eye glint,
`p` pink, `s` stripes, `n` nose. Any character you define works. Built-ins are 16
wide and 7–10 tall — a good size to copy. Sprites are **bottom-anchored to the
floor per grid**, so `sit` and `sleep` should simply be *shorter* grids, not tall
ones padded with blank rows.

## The loop

**1. Build it from a script.** Write `build.js` that emits the JSON and validates
itself. Centre rows with a helper rather than typing padding:

```js
const W = 16;
const mid = (body) => {                       // centre a run in a W-wide row
  const pad = W - body.length;
  if (pad < 0 || pad % 2) throw new Error(`cannot centre "${body}" in ${W}`);
  return '.'.repeat(pad / 2) + body + '.'.repeat(pad / 2);
};
const at = (cells) => {                       // sparse row: {columnIndex: char}
  const s = '.'.repeat(W).split('');
  for (const [i, ch] of Object.entries(cells)) s[i] = ch;
  return s.join('');
};
// then, before writing: every row === W, every non-'.' char is in the palette
```

**2. ASCII-preview with the generated outline.** `#` is outline the engine will
add. This is where you see that a gap you meant as a gap has filled in solid dark.

```bash
node scripts/preview.js path/to/pet.json
```

**3. Render through the real engine and look at it.** This is the step that finds
the actual problems. It drives `strays.js` in an offscreen Electron window and
writes a PNG — the same draw path the lane uses.

```bash
# from the repo root, so ./node_modules/.bin/electron exists
CUSTOM_PETS=~/.strays/custom-pets.json SCALE=6 \
  ./node_modules/.bin/electron .claude/skills/strays-pet/scripts/shot.js
# then crop/zoom and actually view it:
magick pet.png -gravity SouthWest -crop 200x130+15+0 +repage -filter point -resize 450% one.png
```

Read the PNG. Then render at `SCALE=4 BUILTINS=1` to check it beside the built-ins
— a pet that reads at 6× can be mush at the size it actually ships.

## What only the pixels show

Every one of these passed ASCII review and was wrong on screen.

- **A limb that stops short of the sprite's edge is not a limb.** Yoda's ears
  first spanned columns 1–3 and read as a squarish head with two notches. They only
  became ears when they reached columns 0 and 15 at the eye line and tapered a row
  above and below. If a feature is the animal's silhouette, push it to the edge.
- **A body made of horizontal bands reads as a plank.** Two full-width rows of
  robe looked like a table. It needed a vertical dark seam down the middle and a
  taper — narrow shoulders, flared hem — before it read as a garment.
- **Dark fill next to the outline disappears into it.** Feet drawn in `3` (dark)
  under a dark hem outline were invisible; `2` (mid) fixed it. Never put your
  darkest tone against the sprite's own edge.
- **The outline is 8-connected, so small gaps fill in solid.** Single-cell
  "wispy hair" pixels with 1-cell gaps became a dark band with three light dots.
  Detail needs 2+ contiguous cells to survive.
- **Check the states you did not think about.** Render `walk1`, `walk2`, `sit` and
  `sleep`; `DOG` defines neither `sit` nor `sleep` and once drew nothing at all.

## Installing it

- Browser: `Strays.addCustomPet(def, true)` — persists to `localStorage`.
- Desktop: append to the array in `~/.strays/custom-pets.json`. It appears in
  🐾 → **Pets…** marked `CUSTOM`, and joins the lane once that window has been
  focused — no restart.
- **Order matters.** The Pets window's order is the order sessions are handed out,
  so drag a new pet up if it should be the one you see first. By default customs sit
  between the land pets and Heisenbug.

## If you are editing strays.js rather than adding JSON

Anything passed to `drawGrid()` must be a **module-level constant**. The sprite
cache is keyed by object identity, so a palette written inline at a call site mints
a new offscreen canvas every frame, kept for ever — that once reached 854 MB and
killed the renderer. See `GLITCH_RED` / `GLITCH_BLUE`.

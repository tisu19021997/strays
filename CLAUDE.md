# strays — agent guide

Pixel-art pets that live in a lane at the bottom of the screen and react to
Claude Code sessions. Zero runtime dependencies; Electron only for the desktop
shell. Single source of truth: this file. `AGENTS.md` is a symlink to it.

## Layout

```
strays/
├── package.json        the published package: the `strays` command and Electron
├── bin/strays.js       that command — start, stop, restart, hooks, editor
├── strays.js           the whole engine — sprites, behaviour, canvas, public API
├── index.html          demo / landing page
├── editor.html         pixel editor + PNG import for custom pets
├── desktop/            Electron overlay: window, tray, watcher, approval gate
│   ├── hooks/          the Claude Code hooks (gate + session-host recorder)
│   └── test/           node:test suite, no framework
├── docs/               approvals, custom pets, development notes, specs
├── CLAUDE.md           this file
└── AGENTS.md -> CLAUDE.md
```

## Run

Everything runs from the repo root — Electron and the `strays` command both
live in the root package, and `desktop/package.json` is only there to tell
Electron which file to start.

- Overlay:   `npm start` (foreground; `STRAYS_DEBUG=1` for logs)
- Stop:      `npm run stop`
- Tests:     `npm test` (bare `node --test`; a directory argument does not work)
- One file:  `node --test desktop/test/rules.test.js`
- Approvals: `npm run hooks` (`npm run unhook` removes them)
- Installed: `npx claude-strays`, or `npm i -g claude-strays` — `bin/strays.js`
  is that entry. **The package is `claude-strays`; the command is `strays`.**
  npm refuses the name `strays` as too close to the existing `stres`, so the two
  differ on purpose — `test/cli.test.js` pins both, do not "tidy" them together.

## Adding or customising a pet

The most common request. A pet is JSON: `{ name, speed, phrases, palette, grids }`.

- `grids.walk1` and `palette` are required. `walk2`, `sit` and `sleep` are
  optional and fall back to `walk1`.
- Every row in a grid must be the same length. `.` is transparent; every other
  character is a key into `palette`. Convention: `1`/`2`/`3` are light/mid/dark
  body tones, `k` black, `w` the white glint in an eye, `p` pink, `s` stripes,
  `n` nose. Any character you define in `palette` works. The built-ins are 16
  wide — a good size to copy.
- **IMPORTANT: never draw the outline.** A 1px dark outline is generated around
  every sprite. Drawing your own doubles it.
- Adopt in a browser with `Strays.addCustomPet(def, true)` — persists to
  `localStorage` under `strays.custom`. For the desktop overlay, append to the
  array in `~/.strays/custom-pets.json`; it is read **at launch only**, so
  restart the overlay after editing.
- Copy the `CAT`, `DOG` or `FISH` grids at the top of `strays.js` as a starting
  point; per-pet behaviour lives further down in the same file.

## Gotchas

- **The renderer's files are classic scripts sharing one global scope.**
  `overlay.html` loads `requests.js`, `strays.js` and `overlay.js` with plain
  `<script src>`. A top-level `const` in one that re-declares a top-level
  `function` from another is a parse-time SyntaxError that silently kills the
  entire overlay — and `require()`-based tests cannot see it, because CommonJS
  gives each file its own scope. `test/renderer-scripts.test.js` catches it.
- **An unrecognised Claude Code permission mode MUST stay silent.** Gating
  unknown modes once put a card and a 20-second hold on every tool call. Failing
  toward silence is deliberate; do not "fix" it.
- **A session's age comes from the timestamps inside its transcript, never from
  the file's mtime.** Claude Code appends `last-prompt`, `ai-title`,
  `custom-title` and `mode` records long after a conversation ends, and none of
  them carry a timestamp. Judging age by mtime therefore gave pets to
  conversations whose last real message was *days* old, and they took slots from
  the sessions actually running. `BOOKKEEPING` in `watcher.js` names the line
  types that are writes but not activity; mtime is the fallback only for
  transcripts that carry no timestamps at all.

- **Nudging and having a pet are two different questions.** A trailing assistant
  message only proves the turn ended; whether you are still in that window is not
  written down anywhere. `waiting` is the nudge — it makes the pet hop and wear a
  ❗ — and expires after `WAITING_MS`, or it cries wolf. The session then goes
  `resting` until `RESTING_MS`: same pet, same name, no hopping. Conflating the
  two broke it in both directions — every finished conversation nagged forever,
  and then, once that was bounded, the conversation you were sitting there
  reading lost its pet and its name after five minutes.

- **Jump resolution must consult the desktop session index before falling back
  to `claude://resume`.** Resume derives the desktop session id by prefixing the
  uuid, which is right for a small minority of sessions; for the rest it creates
  a duplicate conversation instead of focusing the existing one.

- **The `epitaxy` deep link navigates, which collapses a multi-pane layout into
  the one conversation.** So a session that looks like it is already on screen
  gets the app activated instead — see `LAYOUT_WINDOW_MS` and `looksOnScreen` in
  `sessions.js`. Which panes are actually open lives in `extraPanesByMode` in the
  desktop app's Chromium leveldb, snappy compressed and with no compatibility
  promise; `lastFocusedAt` on each session record is the honest proxy. The tray's
  "Clicking a pet" submenu writes `jumpMode` for anyone the heuristic misjudges.
- **Hooks are read at session start.** After `npm run hooks`, already-open
  Claude Code sessions keep the hooks they started with.
- **The lane's chrome is one column per pet, two tiers at most.** A pet's
  nameplate *expands in place* on hover — it never raises a second label. The
  speech bubble sits above the nameplate, anchored to `pet.chromeTop`. Three
  boxes over one pet is how the quote ended up drawn straight through the
  session name. All chrome is drawn in its own pass after the world, so a
  drifting particle cannot land on a label.

- **A click is a press that stays put; anything else is a carry.** Dragging a
  pet and opening its conversation are different intentions, so the jump moved
  from `mousedown` to the release and only fires when the press never travelled
  `DRAG_SLOP`. Firing on the press cannot tell the two apart even in principle,
  so every drag was also a navigation. The carry then has to hold the lane for
  its whole length: the overlay makes its window click-through the moment
  nothing is hovered, so if hover drops mid-carry — by lifting the pet clear of
  the band `hitTest` catches it in, or by holding still through the idle hover
  timeout — the `mouseup` lands in the app underneath and the pet is stuck to
  the cursor with nothing that can put it down. `liftCeiling()` is the other
  half: a pet held higher than the lane wears a nameplate clipped off the top of
  the screen.

- **A carried pet is drawn turned, and that is the lane's only transform.**
  `tiltAbout()` saves the context and the caller restores it; leave that
  unbalanced and it is not one bad frame, it is every later frame drawn at an
  angle that `clearRect` cannot take off. `draw()` therefore re-applies the base
  transform each frame rather than trusting the stack, and
  `test/pets-binding.test.js` counts saves against restores. The wiggle itself
  costs nothing in the sprite cache — it is a `rotate`, not a new bitmap — and
  it must stay that way; see the cache note above.

- **`hitTest` searches the pet list backwards.** Pets are drawn in array order,
  so the last one drawn is the one on top and the one being pointed at.
  Forwards returns the pet *behind* it, which a click could get away with and a
  carry cannot: the wrong animal comes away in your hand.

- **Nothing in the lane may be white or translucent.** It floats over whatever
  window happens to be underneath: the old white speech bubble was invisible
  over a light one. Surfaces are opaque, built with `pixelPlate()` — flat fill,
  1px dark edge, corners knocked out by a pixel, same as the sprites. A bubble
  takes its fill from the speaking pet's own `pal[1]`, which is also what says
  who is talking.

- **Paths are matched in POSIX form, and platform branches need three arms.**
  `permissions.js` normalises rules and files through `toPosix()` and counts
  `C:/…` as absolute; matching goes case-insensitive only when the path carries a
  drive letter. A Windows path rule that cannot match is a `deny` that is not in
  force, and the card wrongly raised in its place lets a click on **Allow** past
  it. Relatedly, `if darwin … else …` sends Windows down the Linux path — that is
  how managed settings ended up being read from `C:\etc\claude-code\…`.

- **"Is anyone watching?" cannot be answered from the lane.** Heisenbug only
  misbehaves unobserved, and the engine infers that from a mousemove over its own
  canvas — fine on a web page, exactly backwards in the overlay, where the canvas
  is a 190px strip nobody points at. Someone working all day never counted, so
  the fish teleported across the screen every couple of seconds for the whole
  session. `main.js` answers it from `powerMonitor.getSystemIdleTime()` and pushes
  it in via `Strays.setObserved()`. Keep `AWAY_SECONDS` generous: idle time
  measures input, not attention, and reading a long reply is minutes of it.

- **A throw inside the draw loop used to blank the whole lane, silently.** `tick`
  re-arms itself through `requestAnimationFrame`, and the re-arm was the last
  statement, so one exception ended the animation for good — the canvas kept
  whatever half-frame had been painted, and nothing on screen said why. It is now
  in a `finally`, so a bad frame costs one frame and is logged (rate-limited to
  one line per 300, counted in `world.badFrames`). **That is a net, not a
  licence**: the three faults it has caught were all real bugs, and all of them
  presented as *"the pets disappeared, only their shadows are left"* — the shadow
  is painted before the sprite, so the freeze lands between them. Keep every
  sprite set going through `spriteSet()`, and if you add a state to `drawPet`'s
  switch, add it to `DRAWN_STATES` in `test/pets-binding.test.js`.

- **The sprite cache is keyed by object identity, not by content.**
  `spriteBitmap()` stamps a lazy `_k` on each grid and palette, so a palette
  written inline at a call site is a *new* key every frame — a fresh offscreen
  canvas, cached forever. Segfault's glitch did this with its two chromatic
  ghosts and leaked ~265 canvases a minute; after 77 minutes the renderer was at
  854 MB, Chromium stopped handing out 2D contexts, and `getContext('2d')`
  returning null threw the loop dead. Palettes and grids passed to `drawGrid()`
  must be module-level constants — `GLITCH_RED`/`GLITCH_BLUE` exist for that
  reason alone. The cache clears itself past `SPRITE_CACHE_MAX` and warns, so the
  next one degrades to a slow frame instead of a dead lane, but the cap is a
  backstop and not the fix. `test/render-loop.test.js` draws for a simulated hour
  and asserts the count never moves after the warm-up.

- **A pet only sleeps when the rollup is exactly `idle`.** That made the bug
  above invisible for months: the stale-session bug kept something in `waiting`
  almost permanently, so `idle` was nearly unreachable and no pet ever slept.
  Fixing session liveness is what exposed it. Expect latent render bugs when
  changing which states the watcher emits.

- **Verify tests by mutation, not by a green run.** An audit of this suite found
  34 surviving mutants, several of them tests that could not fail at all. Break
  the code a new test covers and confirm it goes red.

## Pointers

- Overview: @README.md
- Pet format: @docs/custom-pets.md
- Approvals and permission modes: @docs/approvals.md
- Development notes and specs: @docs/development.md

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
- **`update.js` holds the only network request in the project.** It asks npm for
  `dist-tags.latest` once a day, sends nothing else, resolves to `null` on any
  failure, cannot throw, and installs nothing — a line in the tray, not a
  self-replacing app that takes the user's pets away mid-session. It is the one
  thing here that can make the README's privacy claim untrue, so keep that claim
  and the code in step, and keep the network behind the seam that lets the rest
  be tested offline. A negative answer is cached deliberately, and a stamp dated
  in the future is re-checked rather than trusted.

- **The dice are seeded in `render-loop.test.js` and `pets-binding.test.js`.**
  Random pet states and start positions failed about one process in four: a
  sprite first drawn after the warm-up looks exactly like the canvas leak, and a
  fish starting against the far wall cannot move. Nine CI legs turn that into a
  red on nearly every push. Exhaustive coverage comes from `DRAWN_STATES`, not
  from the dice.

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

- **The lane is the window, and the window is now the whole display.** A pet can
  be carried to the top of the screen, which works only because every bound in
  the carry is measured down from `floorY` — `liftCeiling`, the chrome above the
  sprite, `hitTest`'s band — so nothing needed a second constant kept in step.
  `height: 'fill'` makes `mount()` *measure* its window instead of being told a
  number, so a resolution change or a dock appearing resizes the lane on its own.
  Two things follow. `FALL_MAX` caps the drop: free fall from 800px arrives at
  ~1200px/s, which crosses the sprite's own height in a frame and a half and
  reads as a dropped stone. And **`setIgnoreMouseEvents` stopped being a small
  promise** — a claim that is never withdrawn used to cost the bottom inch of the
  screen and now costs every click on the machine, including the one that would
  reach the tray to quit. So it is a lease, not a switch: a beat that **always
  runs** carries the renderer's current answer, and `pointer-guard.js` drops the
  claim when renewals stop — which turns a crashed, wedged or merely buggy
  renderer into two seconds of a stiff desktop that then fixes itself. The beat
  is unconditional on purpose. One armed and disarmed alongside hover is a thing
  that can be left armed, and a card answered under the pointer never fires its
  own `mouseleave` — that alone would renew a stale claim for ever, which is the
  failure the lease exists to prevent. Do not shorten the lease to
  "tighten" it — hover dropping mid-carry sends the `mouseup` underneath and the
  pet sticks to the cursor, which is the failure below, not a smaller one.
  `laneHeight` in `~/.strays/config.json` puts the 190px strip back.

- **A release is a throw, and the throw is the gesture rather than a frame.**
  `throwFrom()` measures the displacement across the last `THROW_WINDOW` of
  pointer history over that window's own duration. The carry's smoothed `pet.vx`
  is deliberately *not* used: it is an exponential average that converges over
  about five frames, so the same flick let go of after three frames and after
  twelve gives two different throws — a throw you cannot repeat, for a reason
  nothing on screen explains. It also fools a test into passing, because a
  smoothed average is still bigger for a fast drag than a slow one; the property
  that separates them is *"the same gesture throws the same"*, not *"a flick
  throws harder"*. The cap is a **speed**, not a per-axis clamp — clamped per axis
  the hardest throw available is a diagonal one, at √2 times the limit.
  **The flight is a parabola, and that is two statements: horizontal speed never
  changes, vertical speed changes by the same amount every frame.** So there is
  deliberately **no horizontal drag in flight** — drag makes the pet stall
  forward and the arc lean, which is a falling leaf, not a ball. `FALL_MAX` is
  the only thing allowed to bend it, and it is a backstop, not physics: a
  built-in sprite is 40px tall, so past 2400px/s successive frames stop
  overlapping and a fall reads as a jump cut. A normal throw never reaches it.
  `DROP_GRAVITY` is what sets how *big* the arc is, and the parabola property
  holds at any value — so the size is pinned by its own test (a hard 45° throw is
  back down inside two seconds). At 900 it hung for three seconds and outranged
  the screen, so every throw died against a wall.
  Then the flight has to end. Floor bounces at `BOUNCE` terminate on
  `BOUNCE_MIN` (halving converges only in the limit); the walls and the ceiling
  *reflect* rather than clamp, and the ceiling is not optional — 1800px/s upward
  leaves the screen, nameplate and all. Out of bounces is not the same as
  stopped: a level throw never earns a bounce, so without the `SLIDE_MIN` skid
  every throw across the lane ended with the pet standing exactly where it was
  let go.
  **Friction on the floor is a constant deceleration (`GROUND_FRICTION`), not a
  proportion of the speed.** It was `vx *= (1 - 3.0·dt)`, and both halves were
  wrong: far too strong, and the wrong curve — a proportional decay sheds most of
  the speed at once and then crawls towards zero, so what you saw was a lurch and
  a drift where sliding should be an even slowing to a definite stop. And
  `FLOOR_GRIP` is 0.92, not 0.75: a bounce is the floor pushing *up*, so it
  barely touches sideways speed — that is what lets a ball skip on across a room,
  and at 0.75 four hops threw away three quarters of the throw.
  **Tune these against a hand, not against the cap.** The bug was invisible for a
  release because the test flicked hard enough to saturate `THROW_MAX`: at
  1800px/s the pet carried 582px and looked fine, while an ordinary 600px/s sweep
  carried 181px — under three body lengths, which reads as stopping dead. The
  distances are quadratic in release speed, so the top of the range tells you
  almost nothing about the middle of it. Assert in body lengths at a stated
  speed well clear of the cap.
  And the tumble is a **leaky** integrator pulled back to upright, capped
  at `TUMBLE_MAX`: an angle that only accumulates has to be snapped upright on the
  frame it lands, which is a visible pop on every throw, and pixel art rotated far
  off-axis is stair-steps. The tumble costs nothing in the sprite cache — it is a
  `rotate` — and it must stay that way.

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

- **Windows is in CI now, and it found four things reasoning had not.** Two were
  real. A source-anchored path rule matched *nothing at all* there: `settings.js`
  built the `//abs` form from one slash plus a source that happens to start with
  another — true of every POSIX path, false of every drive letter — and
  `permissions.js` unwrapped `//abs` by dropping one slash, which is right only
  when the marker and the path share it. And the desktop session index is cached
  on directory mtime, which on Windows does not reliably move when a record is
  added, so a new session stayed invisible and its pet fell back to
  `claude://resume`. The other two were tests assuming POSIX: the installer
  writes a *native* path into a shell command (`hooks\gate.js` is correct there —
  only path **rules** are normalised), and a killed gate cannot clean up on a
  platform with no catchable signals, so that guarantee is POSIX-only and the
  request's expiry is what covers Windows. Reproduce this class of bug on any
  platform rather than only where it bites — a relative source has the same shape
  as a drive letter, and a pinned mtime is the same as one that will not move.

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

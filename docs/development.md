# Development

Zero runtime dependencies. The engine is one vanilla-canvas file; the desktop
app is Electron and nothing else.

## Layout

```
package.json         the published package: the `strays` command and Electron
bin/strays.js        that command — start, stop, restart, hooks, editor
strays.js            the whole engine — zero dependencies, vanilla canvas
index.html           demo / landing page
editor.html          pixel editor + PNG import for custom pets
desktop/main.js      Electron overlay window, tray, IPC
desktop/preload.js   the only bridge between the window and the main process
desktop/overlay.js   renderer: pets + Allow/Deny cards
desktop/watcher.js   per-session states from ~/.claude/projects
desktop/approvals.js the pending/replies directories, watched
desktop/permissions.js  would Claude Code prompt? (pure — the heart of it)
desktop/settings.js     finds and merges Claude Code's permission rules
desktop/requests.js     how long an approval request still means anything
desktop/sessions.js     where a pet click should land (pure)
desktop/usage.js        Heisenbug's token and cost tracker
desktop/hooks/gate.js            the PreToolUse approval gate
desktop/hooks/session-start.js   records which terminal launched a session
desktop/setup-hooks.js  installs/removes the hooks in ~/.claude/settings.json
desktop/stop.js         quits a running overlay, cross-platform
desktop/test/           node:test suite — no test framework, no dependencies
```

`desktop/test/render-loop.test.js` is the odd one out: it drives `strays.js`
itself for a simulated hour to catch the failures that only appear over time.

## Running

```bash
npm install      # from the repo root; Electron installs here
npm start        # run the overlay (foreground; Ctrl+C quits)
npm run stop     # quit a running overlay
npm run restart
npm test         # bare `node --test` — a directory argument does not work
```

`STRAYS_DEBUG=1 npm start` logs watcher status, usage and approval traffic.

## Releasing

The repo root **is** the npm package `claude-strays`. The package name and the
command name differ on purpose: npm's typosquatting guard rejects `strays` as
too close to the existing `stres`, so the registry name is `claude-strays` and
the thing people type stays `strays`. `test/cli.test.js` pins both, because the
obvious "cleanup" is to make them match, and doing so either breaks the publish
or silently renames the command out from under everyone who installed it.

`bin/strays.js` is the command
people get from `npx claude-strays` or a global install, and Electron is a real
dependency rather than a dev one so that `npx` can start the app on its own.
`desktop/package.json` carries no dependencies and exists only to tell Electron
which file is `main`.

```bash
npm pack                  # inspect exactly what would ship, first
npm version patch         # commits and tags
git push --follow-tags    # the tag triggers .github/workflows/publish.yml
```

The workflow runs the suite, checks the tag matches `package.json`, and
publishes with provenance. It needs an `NPM_TOKEN` secret on the repository.
Publishing by hand is `npm publish` after `npm test`.

`files` in package.json is a **whitelist**. Anything left out of it is simply
missing for everyone who installed from npm while working perfectly in the
checkout it was tested in — `test/cli.test.js` asserts the runtime pieces are
listed, and `npm pack` shows the real answer.

## Tests

Node's built-in runner, no framework. The suite concentrates on the two things
that are easy to get quietly wrong: whether a call would really have prompted,
and where a pet click should land. Both are pure functions, so the whole matrix
runs without Electron or a live Claude Code.

**Verify tests by mutation, not by a green run.** A mutation audit of this suite
once found 34 mutants surviving, including several tests that could not fail
under any implementation. Before trusting a new test, break the code it covers
and confirm it goes red.

## The lane's chrome

Three things want the space above a pet: the session name, whatever the pet is
saying, and the detail you get on hover. They used to be three independent
boxes at three fixed heights, which collided — the quote was drawn straight
through the session name, and hover added a third tier on top.

The rules that replaced them:

- **One column per pet, two tiers at most.** The nameplate **expands in place**
  on hover (a second, dimmer line) rather than raising another label. Speech
  sits above the nameplate, anchored to `pet.chromeTop`, which each pet records
  as it draws.
- **Chrome is drawn in its own pass, after the whole world.** Otherwise a
  drifting particle lands on a session name, which is the same failure as the
  quote covering it.
- **Nothing is white and nothing is translucent.** The lane floats over whatever
  window you have open; the old white bubble was invisible over a light one.
  Surfaces come from `pixelPlate()` — flat opaque fill, 1px dark edge, corners
  knocked out by a single pixel, built the way the sprites are.
- **A bubble is filled with the speaking pet's own `pal[1]`.** It makes the
  bubble legible on any backdrop, and it is what says who is talking.
- **The hover line never restates the plate above it.** The name is already
  there, so the line is `project · state` — and the session id only when the
  session has no title, which is the one case where two sessions in the same
  repo cannot otherwise be told apart.

`test/pets-binding.test.js` holds these as assertions, including that nothing
in the lane is painted white.

## Things that will bite you

- **The renderer's files are classic scripts sharing one global scope.**
  `requests.js`, `strays.js` and `overlay.js` are loaded by `overlay.html` with
  plain `<script src>`. A top-level `const` in one that re-declares a top-level
  `function` from another is a parse-time SyntaxError that kills the entire
  overlay silently — and `require()`-based tests cannot see it, because CommonJS
  gives each file its own scope. `test/renderer-scripts.test.js` loads them the
  way a browser does. Keep it.

- **An unrecognised permission mode must stay silent.** See
  [approvals.md](approvals.md). Never "fix" the unknown-mode branch to gate.

- **How old a session is comes from the timestamps inside its transcript, not
  from the file's mtime.** Claude Code rewrites a transcript to record a
  generated title, the last prompt and the current mode long after the
  conversation ended, and none of those records carry a timestamp. Judging age
  by mtime gave pets to conversations last spoken in over a week earlier, which
  crowded out the sessions actually running. See `BOOKKEEPING` and
  `activityAt` in `watcher.js`; mtime remains the fallback for transcripts with
  no timestamps at all, which is what pre-timestamp releases wrote.

- **Nudging and having a pet are separate, and conflating them broke both.** A
  trailing assistant message means the turn ended, not that you are still in that
  window — the second is not recorded anywhere. `waiting` is the nudge (the pet
  hops and wears a ❗) and expires after `WAITING_MS`; the session then goes
  `resting` until `RESTING_MS`, keeping its pet and its name without shouting.
  First every finished conversation nagged indefinitely; then, once `waiting` was
  bounded, dropping the session with it took the pet away from the conversation
  the user was reading — the names vanished a few minutes into every reply.

- **Rendering is verifiable: `STRAYS_SNAPSHOT=<file> npm start`** writes a PNG of
  the lane every couple of seconds via `capturePage`, which — unlike
  `screencapture(1)` — needs no Screen Recording permission. The window is
  transparent, so composite the capture onto a background before looking at it.
  A headless harness can only prove `fillText` was called; this proves the pets
  and their names are actually on screen.

- **Jump resolution must consult the desktop session index before falling back
  to the resume deep link.** `claude://resume?session=<uuid>` derives the
  desktop id by prefixing the uuid, which is right for a tiny minority of
  sessions; for the rest it creates a duplicate conversation instead of focusing
  the existing one.

- **The `epitaxy` deep link navigates, and navigating collapses a multi-pane
  layout down to the single conversation.** `looksOnScreen` in `sessions.js`
  therefore activates the app instead when the record's `lastFocusedAt` is
  inside `LAYOUT_WINDOW_MS`, on the reasoning that in a split layout you are
  moving between the visible panes constantly. The set of open panes is not
  readable: the desktop app keeps it in `extraPanesByMode` inside its Chromium
  Local Storage leveldb, snappy compressed, in a private format that can change
  in any release. `jumpMode` in `~/.strays/config.json` (`auto` | `never` |
  `always`) overrides the guess, and the tray writes it.

- **Paths are matched in POSIX form, always.** `permissions.js` normalises both
  the rule and the file through `toPosix()` and treats `C:/…` as absolute
  alongside `/…`, and `settings.js` anchors rules with `path.posix.join`. This is
  load-bearing rather than tidy: on Windows a path rule spelled with backslashes
  matches nothing, so a `deny` the user wrote is silently not in force — and
  because the gate answers PreToolUse with an explicit decision, the card it then
  wrongly raises lets a click on **Allow** walk straight past that rule. Matching
  is case-insensitive when the path carries a drive letter, because Windows
  filenames are, and case-sensitive otherwise, because POSIX ones are. The shape
  of the path decides, so it all stays pure and testable.

- **Platform-specific paths and APIs need three branches, not two.** An
  `if darwin … else …` sends Windows down the Linux path: the managed-settings
  location did exactly that and read `C:\etc\claude-code\…`, which cannot exist,
  so every enterprise rule was silently dropped. Same for Electron APIs that
  quietly no-op — `Tray.setTitle` and `setTemplateImage` are macOS-only, and an
  untinted template icon is invisible in the Windows tray, which is the only UI
  the app has.

- **"Is anyone watching?" is not a question the lane can answer.** Heisenbug only
  misbehaves when unobserved, and `strays.js` works that out from a `mousemove`
  over its own canvas. On a web page that is a fair proxy. In the overlay it is
  inverted: the canvas is a 190px strip along the bottom of the screen that
  nobody ever points at, so a developer sitting there working all day never
  registered as watching, and the fish teleported across the screen roughly
  thirty times a minute for the entire session — reported as *"the pet
  disappears and appears in a totally different position"*.

  `main.js` polls `powerMonitor.getSystemIdleTime()` and pushes the answer in
  through `Strays.setObserved(bool)`; `null` hands the decision back to the
  pointer heuristic, which is still right for the browser build. **Keep
  `AWAY_SECONDS` generous** — idle time measures input, not attention, and
  reading a long reply is a minute or two of it. The first attempt used 90
  seconds and set the fish off in front of someone plainly sitting there.
  `STRAYS_DEBUG=1` logs every poll as `[presence] 74s idle -> watching`.

- **One throw inside the draw loop used to blank the entire lane, and say
  nothing.** `tick` re-arms itself via `requestAnimationFrame`, and the re-arm
  was the last statement in the function, so an exception stopped the animation
  dead: the canvas held whatever had been painted before the throw, and no error
  reached anywhere the user could see. This shipped twice. First `DOG` defines
  neither `sit` nor `sleep`, `sleep` fell back only as far as `sit`, so Grep
  falling asleep selected `undefined` and drew nothing ever again — `spriteSet()`
  now resolves the optional grids for every pet, built-in and custom alike, and
  `test/pets-binding.test.js` draws every pet in every state in `DRAWN_STATES`.
  Then the sprite cache below exhausted the renderer's canvases.

  The re-arm is now in a `finally`, so a bad frame costs one frame; it is logged
  once per 300 (a permanent fault would otherwise write sixty lines a second) and
  counted in `world.badFrames`. Treat that as a net rather than a licence — both
  faults it has caught were real bugs.

  The first hid for so long because a pet only falls asleep when the rollup is
  exactly `idle`, and the stale-session bug above kept something in `waiting`
  almost permanently. Changing which states the watcher emits can uncover render
  paths that have never actually run.

- **Both of those bugs present identically: the pets vanish and their shadows
  stay.** `drawPet` lays the shadow down before the sprite, so a frozen frame
  keeps every shadow and loses every pet above it. The tell that it is a freeze
  and not a drawing bug is that the renderer's CPU time stops advancing —
  `ps -o time -p <renderer pid>` sampled twice, a few seconds apart, reads the
  same number.

- **The sprite cache is keyed by object identity, not by content.**
  `spriteBitmap()` stamps a lazily-assigned `_k` on each grid and palette and
  keys on `grid._k:pal._k:scale`, so a palette written inline at the call site is
  a brand-new key on every single call — a fresh offscreen canvas, cached
  forever. Segfault's pre-crash glitch drew two chromatic ghosts that way and
  leaked around 265 canvases a minute. After 77 minutes the renderer's physical
  footprint was 854 MB for a 190px strip drawing four sprites; Chromium stopped
  granting 2D contexts, `getContext('2d')` returned null, and the first
  `fillStyle` after it threw the draw loop dead.

  So: **anything handed to `drawGrid()` must be a module-level constant.**
  `GLITCH_RED` and `GLITCH_BLUE` exist for no other reason. Past
  `SPRITE_CACHE_MAX` the cache drops everything and warns, which bounds the next
  offender at a slow frame rather than a dead lane — a backstop, not the fix.

  `test/render-loop.test.js` is the guard: it drives the real engine for a
  simulated hour through a canvas-counting DOM and asserts the count does not
  move after the five-minute warm-up (it saturates at 22 by the second minute;
  the last entry to appear is Heisenbug's spooked helmet, which needs the lane to
  decide nobody is watching). Restoring the inline palette takes it from 22 to
  ~7,500.

- **A click is a press that stays put, and a carry has to hold the lane for its
  whole length.** Picking a pet up and opening its conversation are different
  intentions, and the jump used to fire on `mousedown`, which cannot separate
  them even in principle — every drag would also be a navigation. It now fires
  on the release, and only when the press never travelled `DRAG_SLOP`.

  The rest of it is the click-through window. `main.js` calls
  `setIgnoreMouseEvents` from `onHoverChange`, so the instant nothing is hovered
  the lane stops receiving anything — including the `mouseup` that ends a carry,
  which then goes to whatever application is underneath and leaves a pet stuck
  to the cursor with nothing on screen that can put it down. Two things would
  otherwise drop hover mid-carry, and both are handled in `mount()`: lifting a
  pet clear of the band `hitTest` catches it in (so the band travels with
  `pet.lift`), and holding still long enough for the 2.5s idle timeout to fire
  `onLeave` (so it is not armed while `world.grab` is set). Every other way a
  carry can end without a release — the pointer leaving the document, a session
  ending and taking its pet off screen — goes through `releaseGrab()`.

  `liftCeiling()` bounds how high a pet goes, and it is not about taste: the
  nameplate hangs above the sprite and grows a second line on hover, so a pet
  held near the top of a 190px lane wears a label clipped off the screen.

  A carried pet struggles, which is an envelope (`pet.squirm` — full on pickup,
  settling to a sulk, spiking when it is swung about and at random) over a pair
  of waves at unrelated frequencies (`pet.tilt`). One wave is a buzz; two is an
  animal that cannot decide which way to twist. `hitTest` deliberately ignores
  all of it — a rotating hitbox makes a pet slippery to hold.

- **The tilt is the lane's only transform, and it must balance.** `tiltAbout()`
  saves the context and its caller restores it. An unbalanced save is not one
  spoiled frame: every later frame draws under a rotation that `clearRect` will
  not remove, and nothing on screen says why. `draw()` re-applies the base
  transform each frame instead of trusting the stack, and the fake canvas in
  `test/pets-binding.test.js` counts saves against restores so a missing one
  fails rather than merely looking odd. The wiggle adds nothing to the sprite
  cache — rotation is a context transform, not a new bitmap — and that is not
  incidental: see the cache section above for what a per-frame bitmap costs.

- **`hitTest` walks the pet list backwards.** Pets are drawn in array order, so
  the last one drawn is on top, and that is the one under the pointer. Searching
  forwards returns the pet *behind* the visible one. A click could get away with
  that; a carry cannot, because the wrong animal comes away in your hand and the
  one you aimed at does not move.

- **Hooks are read at session start.** After `npm run hooks`, already-open
  Claude Code sessions keep the hooks they started with.

- **The installer identifies its own entries by a path-independent
  `--strays-hook` sentinel**, so moving or renaming the checkout is safe. Two
  legacy markers are kept deliberately so pre-rename installs are still
  recognised and replaced rather than duplicated.

## Specs

Feature specs live in [specs/](specs/).

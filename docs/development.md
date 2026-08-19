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
desktop/preload.js   the lane's bridge to the main process
desktop/overlay.js   renderer: pets + Allow/Deny cards
desktop/pets-window.html/.js  the Pets window: who's on the team, in what order
desktop/pets-preload.js       its bridge — deliberately not the lane's
desktop/pet-roster.js         config + what exists -> the ordered team (pure)
desktop/watcher.js   per-session states from ~/.claude/projects
desktop/approvals.js the pending/replies directories, watched
desktop/permissions.js  would Claude Code prompt? (pure — the heart of it)
desktop/settings.js     finds and merges Claude Code's permission rules
desktop/requests.js     how long an approval request still means anything
desktop/sessions.js     where a pet click should land (pure)
desktop/pointer-guard.js who holds the pointer, and for how long (pure)
desktop/usage.js        Heisenbug's token and cost tracker
desktop/update.js       is there a newer strays? (the only network call there is)
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

### It releases itself

Merging to `main` is the whole ritual. `release.yml` reads the commits since the
last `v*` tag, works out the bump, tags it, and hands the tag to `publish.yml`:

| commits since the last tag | what happens |
| --- | --- |
| `feat!:` anywhere, or `BREAKING CHANGE` in a body | major |
| `feat:` | minor |
| `fix:` or `perf:` | patch |
| only `docs:`, `chore:`, `test:`, `refactor:`, `style:` | **nothing at all** |

That last row is the point. Every merge cutting a release would mean a version
of the package for every typo fixed in the README, so a commit that changes
nothing anyone installs releases nothing. To release anyway — or to force a
particular part — run **release** from the Actions tab and pick the bump.

**`release.yml` is the only way anything reaches npm**, and that is npm's rule
rather than a preference. Trusted publishing matches the OIDC `workflow_ref`
claim, which names the workflow that *started the run* — not the file the running
job lives in, which is `job_workflow_ref`. So the trusted publisher registered
for `claude-strays` names `release.yml`, and `publish.yml` is `workflow_call`
only.

**This was wrong for four releases and nobody noticed.** `publish.yml` used to
carry `push: tags` and its own `workflow_dispatch`, and the publisher was
registered against `publish.yml` — so every *manual* publish authenticated and
every *automatic* one failed. It hid because the release job still tagged
correctly, and the tag is the part anyone looks at; the only symptom was npm
staying a version behind the tags. The error does not help either: a
trusted-publishing identity mismatch comes back as `404 Not Found - PUT
https://registry.npmjs.org/claude-strays`, which mentions neither OIDC nor
workflows and reads exactly like a missing package or a typo'd name. npm answers
404 rather than 403 so that it does not leak whether a package exists.

`publish.yml` now fails on its *first* step if the entry workflow is not
`release.yml`, printing both claims and the command to use instead, so the next
time this is wrong it says so before it spends a job on tests.

**Publishing a tag that already exists** — a registry outage, an expired
credential, a fault in the workflow, or a hand-cut `npm version`:

```bash
npm pack                  # inspect exactly what would ship, first
npm version patch         # commits and tags
git push --follow-tags
gh workflow run release.yml -f publish_tag=v1.5.1
```

That last line is needed because a tag can only trigger its own push once, and
because the bump job deliberately skips a head commit that is itself a release.
`publish_tag` skips the bump and publishes the tag as given; the `.dmg` is not
rebuilt, since that tag's asset was built when it was cut.

**The tag is passed in as an input** rather than inferred: a called workflow
otherwise checks out the commit that triggered the *caller*, which is the one
before the version bump, and would test the new version while publishing the old
one. And it is *called* rather than left to the tag because a tag pushed by a
workflow using `GITHUB_TOKEN` deliberately does not trigger another workflow —
GitHub's guard against a run that starts itself for ever.

Nothing installs anything on CI. The engine and the whole desktop app are
dependency-free, so `node --test` runs the suite against a bare checkout, and
Electron — a real dependency of the *package*, so that `npx claude-strays` can
start the app — is never fetched to run tests that open no window.

### Credentials

`publish.yml` uses an `NPM_TOKEN` secret if the repository has one, and
otherwise expects **trusted publishing**: npm verifies the run cryptographically
against a publisher you register at npmjs.com naming this repo and
**`.github/workflows/release.yml`** — the entry workflow, for the reason above —
so no long-lived secret exists to leak. That is the better of the two, and it is
why the workflow pins Node 24: trusted publishing needs npm 11.5.1 or newer, and
Node 20 ships npm 10. There is currently no `NPM_TOKEN` in the repository, so
trusted publishing is not a fallback here, it is the mechanism.

Neither can do the *first* publish: a package has to exist before it can have a
trusted publisher, and the account's 2FA covers the first write. So publish
`1.0.0` by hand, then tag it — `git tag v1.0.0 && git push origin v1.0.0` — so
the automatic bump has a baseline to count from. Without that tag the first
automatic run reads the entire history.

`files` in package.json is a **whitelist**. Anything left out of it is simply
missing for everyone who installed from npm while working perfectly in the
checkout it was tested in — `test/cli.test.js` asserts the runtime pieces are
listed, and `publish.yml` re-checks the real tarball with `npm pack` before it
uploads anything.

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

- **`bindSessions` has two orderings, and the second one exists so the Pets
  window is not lying.** Sessions are handed to the first free pet in
  `world.pets` order, and that order used to be reshuffled on the way in —
  `filter(kind !== 'heisenbug')` then the fish — because she is the fallback pet.
  A user who drags Heisenbug to the top of the Pets window and watches her stay
  last has been told the list is theirs and then shown it is not. So an explicit
  roster is honoured **verbatim** and the reshuffle only applies when
  `world.roster` is null, which is the browser build. Nothing moved for existing
  users because the default roster `pet-roster.js` builds already ends with the
  fish — that equivalence is pinned by *"customs sit between the land pets and the
  fish, as the old filter had it"*, and it is the assertion to look at first if
  anyone's team ever reorders on upgrade.

- **A reorder the user performed has to re-deal the sessions; one the host
  re-applies must not.** The array order sets draw order and who takes the *next*
  session — not where a pet stands — and `bindSessions` is sticky, so a drag with
  conversations already live changed nothing anybody could see. It read as the Pets
  window being broken, and the workaround people found was toggling *Follow Claude
  Code sessions*, which clears the session list and re-announces it, re-dealing
  everyone by accident. `setRoster(ids, { rebind: true })` is the fix and it is
  opt-in: `applyRoster()` also runs at launch and on every focus of the Pets
  window, and re-dealing conversations because a window got focus is worse than the
  bug it would be fixing. The lesson is that the two halves are separate
  requirements that look like one — the suite had only the sticky half, and it
  passed.

- **Reordering the roster must still not be a remount.** `setRoster` reuses the
  pets already out and only builds genuinely new ones, because a settings change
  that teleports four pets is worse than no setting.
  Three references are kept *outside* `world.pets` and all three go stale when a
  pet is switched off: the ball, a deadlock, and the pointer's grab. The guards
  next to `bindSessions` do not cover it — they fire on `hidden`, and a pet off the
  roster is not hidden, it is gone, so nothing will ever set that flag on it
  again. The deadlock case has to free the pet that *stayed*, or a cat stands
  there in `deadlock` for ever waiting for an animal that no longer exists.

  Worth knowing how that one was found. The first version of the test set up all
  three references and then picked the pet up — and passed with the cleanup
  deleted, because `grabPet` already drops the ball and breaks the deadlock. Two
  thirds of it was checking work the drag had done. Three separate tests, none of
  which carries the pet, is what actually killed the mutants.

- **Registering a custom pet and putting it out are separate calls.**
  `registerCustomPet` only remembers the def; the roster decides who is on the
  lane. One thing deciding rather than two is the whole point: with
  `addCustomPet` on that path, a pet switched off in the window would be added on
  load and removed a frame later, and re-sending the defs — which `applyRoster`
  does every time, so a pet drawn in the editor appears without a restart — would
  double it up.

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

- **Windows runs in CI, and the first run found four faults in code that had
  only ever been reasoned about.** Two were real:

  *Every source-anchored path rule was inert.* `settings.js` rewrites a
  single-leading-slash rule into the filesystem-absolute `//abs` form, and built
  it from one slash plus the source — which lands on `//` only because a POSIX
  source starts with a slash of its own. A drive letter does not, so the result
  was `/C:/project/src/**`: the single-slash form again, read as relative to the
  working directory, matching nothing. `permissions.js` had the mirror of it,
  unwrapping `//abs` by dropping one slash, which leaves `/C:/…` against a file
  always spelled `C:/…`. Either alone is a `deny` that is not in force.

  *A new session record hid behind a stale cache.* The desktop index is keyed on
  the store's directory mtime; on Windows that does not reliably move when an
  entry is added, so a session written moments after the last read was invisible
  and its pet fell back to the resume deep link — a duplicate conversation, which
  is the failure the index exists to prevent. The stamp now carries the entry
  count too, which is free because the listing is already read to recurse.

  The other two were the tests being wrong about Windows. `setup-hooks` writes a
  *native* path into a shell command line, so `hooks\gate.js` is correct there —
  only path **rules** are normalised to POSIX — and a killed gate cannot clean up
  after itself on a platform with no catchable signals, so that guarantee is
  marked POSIX-only and the request expiry covers Windows.

  **Reproduce this class of fault where it does not bite.** A relative source has
  the same shape as a drive letter, and a directory mtime pinned to a fixed
  instant is the same as one that will not move — so both regressions are caught
  on every platform. Pin such a timestamp to a literal rather than reading and
  restoring it: a stat reports sub-millisecond precision that `utimes` cannot put
  back, and the first attempt passed against the unfixed code for that reason.

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
  held at the very top of the lane wears a label clipped off the screen.

- **The lane is its window, and the window is the display.** Dragging a pet
  around a 190px strip is dragging it an inch off the floor, so the overlay's
  window now covers the primary display's work area and a pet can be carried to
  the top of the screen. Almost none of the engine had to change for that,
  because every bound in a carry is measured down from `floorY` — `liftCeiling`,
  the chrome above the sprite, the band `hitTest` catches a pet in — and
  `floorY` is the bottom of the canvas. The one new mechanism is `height: 'fill'`
  in `mount()`, which *measures* the window rather than being told a number, so
  the lane follows a resolution change, a dock appearing, or the tray putting the
  strip back. `laneHeight` in `~/.strays/config.json` takes a pixel count for
  anyone who would rather the overlay did not cover the screen.

  Three things did have to change, and all of them are about scale rather than
  geometry — the pattern to look for when the lane grows is code that was
  written against the *top* edge of a canvas that used to be a few pixels above
  the pets' ears.

  `confettiTop()` is the plainest case. Confetti was spawned just off the top of
  the canvas and falls at 30–130px/s, which is a brisk burst over a 190px strip
  and a fifteen-second drizzle over an entire display — every time a session
  finishes, and permanently while party mode is on. It now falls `CONFETTI_FALL`
  onto the pets whatever the lane is doing, which leaves the strip and the
  browser build bit-for-bit as they were.

  `FALL_MAX` caps the drop. Free fall from ~800px arrives at about 1200px/s,
  which crosses the sprite's own height in a frame and a half: the pet stops
  reading as an animal landing and reads as a dropped stone, past its own dust
  before the dust is drawn. The cap sits above anything a 190px strip could reach
  (~480px/s from its ceiling), so the old lane cannot tell it is there.

  **And the click-through flag stopped being a small promise.** While the lane
  was a strip, a claim the renderer never withdrew cost the bottom inch of the
  screen — strange, survivable, and obvious. At the size of a display the same
  claim swallows every click on the machine, including the ones that would reach
  the menu bar to quit strays, so the only way out is a terminal you can no
  longer click on. `pointer-guard.js` makes a claim a **lease**: a 500ms beat in
  the renderer carries whether anything on the lane is under the cursor, and the
  host drops the claim when renewals stop. Every way the renderer can go quiet —
  crashed, wedged in a loop, or buggy enough never to say `false` — becomes at
  most `HOLD_MS` of a stiff desktop that then fixes itself, and
  `render-process-gone`, `unresponsive` and hiding the lane short-circuit even
  that.

  **The beat always runs, and carries the current answer rather than a hardcoded
  `true`.** One armed and disarmed alongside the hover state is a thing that can
  be left armed, and the case that leaves it armed already exists: a card
  answered under the pointer can never fire its own `mouseleave`. That is the bug
  `removeCard` was written for, and an armed beat would have renewed the claim it
  clears — forever, over the whole screen. Being wrong now costs one beat.

  The same residue is why `overlay.test.js` empties its cards through
  `onApprovalRemove` rather than removing the elements: pulling them out leaves
  the renderer believing the pointer is on a card it no longer has, so the lane
  started every later test already interactive and an assertion about handing the
  pointer back could not fail.

  **Do not shorten the lease to "tighten" it.** The two failures are not
  symmetrical but neither is small: never expiring costs the whole screen, and
  expiring while a claim is still live drops hover mid-carry, which sends the
  `mouseup` to the application underneath and sticks the pet to the cursor. Two
  seconds is four missed beats of slack. `set()` also applies only on a change,
  so the heartbeat is not a native call twice a second.

  A carried pet struggles, which is an envelope (`pet.squirm` — full on pickup,
  settling to a sulk, spiking when it is swung about and at random) over a pair
  of waves at unrelated frequencies (`pet.tilt`). One wave is a buzz; two is an
  animal that cannot decide which way to twist. `hitTest` deliberately ignores
  all of it — a rotating hitbox makes a pet slippery to hold.

- **Letting go is a throw, and the throw is the gesture, not a frame.**
  `throwFrom()` takes the displacement across the last `THROW_WINDOW` of pointer
  history over that window's own duration. The obvious alternative is the
  velocity the carry is already smoothing, and it is wrong in a way that hides:
  an exponential average converges over about five frames, so the *same* flick
  released after three frames and after twelve produces two different throws.
  The gesture is repeatable and the result is not, and nothing on screen says why.

  That distinction also caught a bad test. "A flick throws harder than a slow
  drag" passes under the smoothed implementation too — a converging average is
  still larger for a fast drag. The property that actually separates them is
  *"the same gesture throws the same, however long you have been dragging"*, and
  only after writing that did the mutant die. Both tests are kept; only one of
  them was ever load-bearing.

  **The window is wall clock, so stopping before you let go means no throw — and
  that is the current intent.** Since `THROW_WINDOW` is 90ms and that is inside
  ordinary button-release latency, most releases contain only stationary samples
  and the pet just drops. Which is what is wanted: drop and bounce.

  It was briefly the other way. Recording movement only, and fading the throw by
  how long the hand had rested, removed the dead zone completely — and made every
  release carry the full speed of the sweep, which read as firing a cannon. That
  is `bdfa0ad`, since reverted, and the numbers are in both commit messages if
  it is ever worth revisiting.

  **The rough edge is worth knowing about before you trip over it.** The cutoff is
  abrupt, and it sits inside human latency: a release made while the hand is still
  moving throws at up to 1800px/s, and the same intended gesture a tenth of a
  second later throws nothing at all. The stillness fade is the right shape for
  fixing that, but only together with a much lower `THROW_MAX` — putting the fade
  back on its own is the cannon again.

  **And no test can see any of it.** Every test here releases on the same frame as
  its last `mousemove`, because that is what `dragTo()` does and what a fixed-step
  harness makes easy — so they all measure a gesture no hand performs. Both throw
  faults in this file's history were found instead by driving the real `tick()`
  from a simulated `requestAnimationFrame` with pointer events on their own 125Hz
  clock. The bug lived in the gap between the pointer's clock and the render
  loop's, and nothing that ties those two together can show it to you. Be
  suspicious of any input test whose events are synchronised to frames.

  The cap is a **speed**, not a clamp per axis. Clamped per axis, the hardest
  throw in the lane is a diagonal one at √2 times the limit — a limit that only
  applies to people who throw in straight lines.

  **The flight itself is a parabola, which is two statements and only two:** the
  horizontal speed does not change, and the vertical speed changes by the same
  amount every frame. Both had something in the way.

  There is now deliberately **no horizontal drag in flight**. Drag breaks the
  first statement — the pet stalls forward, the arc leans, and it comes down
  steeper than it went up, which reads as a falling leaf rather than a thrown
  ball. Over a few hundred pixels at these speeds real drag is invisible anyway.
  Friction on the *floor* is visible, and that is `GROUND_DRAG`, which is a
  different thing in a different place.

  `DROP_GRAVITY` is the other half, and with the throw speed capped it is the
  only thing deciding how *big* an arc is. At 900 a hard 45° throw hung for three
  seconds and ranged about 3600px — further than the display it was thrown
  across, so nearly every throw ended against a wall, slowly. 2000 puts it at
  about 1600px and 1.3s, and it visibly bends instead of drifting.

  Worth knowing when tuning it: **the parabola property holds at any gravity**,
  because the shape of the curve is set by the launch angle. So the test for the
  curve cannot see a bad gravity value at all — the arc's *size* needed its own
  assertion, and it is deliberately a floor ("back down inside two seconds")
  rather than a tuning fork.

  Then the flight has to end, in four different ways:

  - **Floor.** `BOUNCE` of the impact comes back up, and `BOUNCE_MIN` is what
    terminates it. Halving converges only in the limit, and a pet that never
    quite settles is a pet that never gets back to walking.
  - **Walls and ceiling reflect** rather than clamp. The old `clamp` on `pet.x`
    silently ate the whole throw. The ceiling is not decoration either:
    `liftCeiling` bounds a *carry*, and 1800px/s upward is well past the top of a
    display, so a thrown pet left the screen with its nameplate.
  - **Out of bounces is not stopped.** A level throw never earns an impact worth
    bouncing, so it lands on the frame it was released — without the `SLIDE_MIN`
    skid, every throw along the lane ended with the pet standing exactly where it
    was let go, which is the one case that read as a bug rather than as physics.
  - **Friction is a constant deceleration, and a bounce hardly touches sideways
    speed.** `GROUND_FRICTION` is px/s² rather than a proportion, and
    `FLOOR_GRIP` is 0.92. See below — this was wrong twice.
  - **`FALL_MAX`** is terminal velocity, and it is about legibility rather than
    realism: past it a pet crosses its own height in under two frames and is gone
    before its dust is drawn.

  **Momentum, and the reason it took three goes.** The report was that dragging a
  pet left to right and letting go dropped it more or less vertically instead of
  carrying it on. Both mechanisms that decide that were wrong:

  - **Sliding friction was `vx *= (1 - 3.0 · dt)`** — a proportion of the current
    speed. Wrong rate and wrong curve. Real sliding friction is a constant
    deceleration, so it slows evenly to a definite stop; a proportional decay
    sheds most of the speed in the first fraction of a second and then crawls
    towards zero, which looks like a lurch followed by a drift. It is now
    `GROUND_FRICTION` in px/s².
  - **`FLOOR_GRIP` was 0.75**, so a quarter of the forward speed went into every
    hop. A bounce is the floor pushing *up*; it should barely touch how fast the
    thing is already travelling sideways, which is what lets a thrown ball skip
    on and on across a room. Four hops at 0.75 threw away three quarters of the
    throw, so a thrown pet spent nearly all its travel before its first contact.

  **The lesson worth keeping is about the test, not the constants.** There *was*
  a skid test, and it passed throughout: it flicked hard enough to saturate
  `THROW_MAX`, and at 1800px/s the pet carried 582px, which is plainly momentum.
  An ordinary hand sweep is about 600px/s, and that carried 181px — under three
  of the pet's own body lengths. Carry distance goes as the square of release
  speed, so the top of the range says almost nothing about the middle of it, and
  the middle is the only part anyone's hand actually produces.

  So the tests now name a speed (`~600px/s`, stated and asserted to be clear of
  the cap) and measure in body lengths, and the bounce case is expressed as a
  *ratio* — ground covered after the first touch against ground covered before it
  — so it needs no absolute distance and does not have to be retuned whenever
  gravity or the friction moves. It also runs in a lane wide enough that the pet
  never reaches a side, because `WALL_BOUNCE` takes 40% of the forward speed and
  would otherwise be most of what the test measured. `laneW` in the harness is
  settable for that reason, exactly as `laneH` is.

  **The tumble is a leaky integrator, not an accumulating angle.** `pet.spin`
  comes off the release speed and drives `pet.tumble`, which is pulled back
  towards upright every frame (`TUMBLE_RETURN`) and capped (`TUMBLE_MAX`). Two
  reasons, and neither is taste. An angle that only accumulates has to be zeroed
  on the frame the pet lands, which is a visible pop out of nowhere on every
  single throw; and pixel art rotated far off its axis is a mess of stair-steps.
  A pet that rights itself on the way down has neither problem — and a cat
  righting itself is not exactly unobservable behaviour. It adds nothing to the
  sprite cache, because it is a `rotate` and not a new bitmap; see the cache
  section above for what breaking that costs.

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

- **The update check is the only network request in the project, and it is the
  one thing here that can make a promise in the README untrue.** So it is built
  to be defensible rather than merely to work: it asks `registry.npmjs.org` for
  `dist-tags.latest` at most once a day, sends nothing but the request, resolves
  to `null` on absolutely anything (offline, a proxy, a 500, a timeout, a body
  that is not JSON), and can never throw — an update check that can fail is one
  that can take the overlay down, and the overlay is the product. It installs
  nothing: replacing the app underneath a running session takes the user's pets
  away, which is worse than being a version behind, so the answer becomes a line
  in the tray and a command on the clipboard.

  `update.js` keeps the network behind a seam — everything but `fetchLatest()` is
  pure and takes the fetch as an argument — which is what lets the whole matrix
  be tested offline. Two of those cases are not obvious. A **negative** answer is
  cached too: the interval exists to make one request a day, not one request a
  day that happens to find something, and caching only the good answers means
  asking on every launch for everyone who is up to date, which is nearly
  everyone. And a stamp dated in the *future* is re-checked rather than trusted,
  because that is a clock that moved — for a machine set years ahead, "fresh"
  would otherwise mean forever.

  The command it offers depends on how the copy was installed: `npx` resolves
  `latest` on every run, so an npx user is told there is nothing to do rather
  than given a command that does nothing; a global install gets
  `npm install -g claude-strays@latest`; a checkout gets `git pull`.

- **The dice are seeded in `render-loop.test.js` and `pets-binding.test.js`.**
  Pets choose their next state at random and start at random positions, so
  roughly one process in four failed for reasons that had nothing to do with the
  code: a sprite whose state was first reached *after* the render-loop warm-up
  mints a canvas late and looks exactly like the leak that file exists to catch,
  and a fish that starts pinned against the far wall facing outward is clamped
  back to the same x, so "she moved" is false. With nine CI legs a one-in-four
  flake is a near-certain red on every push. The trade is deliberate: exhaustive
  state coverage comes from `DRAWN_STATES`, which draws every pet in every state
  on purpose instead of hoping to wander into them.

- **Hooks are read at session start.** After `npm run hooks`, already-open
  Claude Code sessions keep the hooks they started with.

- **The installer identifies its own entries by a path-independent
  `--strays-hook` sentinel**, so moving or renaming the checkout is safe. Two
  legacy markers are kept deliberately so pre-rename installs are still
  recognised and replaced rather than duplicated.

## Specs

Feature specs live in [specs/](specs/).

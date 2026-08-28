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
├── pets/bundled.json   the five guests that ship — built by pets/build.js
├── desktop/            Electron overlay: window, tray, watcher, approval gate
│   ├── pets-window.*   the Pets window — who is on the team, in what order
│   ├── pet-roster.js   config + what exists -> the ordered team (pure)
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
  array in `~/.strays/custom-pets.json`; it is re-read at launch **and** whenever
  the Pets window is focused, so a pet drawn in the editor joins the lane without
  a restart. (It used to be launch-only; `applyRoster` re-sends the defs.)
- Copy the `CAT`, `DOG` or `FISH` grids at the top of `strays.js` as a starting
  point; per-pet behaviour lives further down in the same file.

## The team, and its order

`~/.strays/config.json` → `pets: { order, off }`, edited by the Pets window
(🐾 → **Pets…**), resolved by `pet-roster.js`, applied by `Strays.setRoster(ids)`.

- **The order is the order sessions are handed out in.** Position one is the pet
  you see when one Claude window is open. `pet-roster.js` names built-ins by kind
  and customs by name.
- **`bindSessions` has two orderings on purpose.** It used to reshuffle the fish
  to the end on the way in, which would silently override anything a user drags.
  An explicit roster is honoured **verbatim**; the reshuffle survives only when
  `world.roster` is null, which is the browser build. Nothing moved for existing
  users because the default roster already ends with the fish — pinned by the test
  *"customs sit between the land pets and the fish, as the old filter had it"*.
- **A stated reorder needs `setRoster(ids, { rebind: true })`, or it does nothing
  visible.** The order sets draw order and who takes the **next** session — it does
  not decide where a pet stands, and `bindSessions` is sticky. So dragging a row
  with conversations already live changed nothing at all, and the way round it was
  to toggle *Follow Claude Code sessions*, which clears the session list and
  re-announces it. `rebind` drops the bindings so the next frame deals them down
  the new list. It is set **only** by a save from the Pets window: `applyRoster()`
  also runs at launch and on every window focus, and re-dealing conversations
  because a window got focus is worse than the original bug. Both directions are
  pinned — the missing re-deal *and* the always-re-deal.
- **Reordering is still not a remount.** `setRoster` reuses pets already out, so
  nobody moves and no carry is reset. Three references live *outside*
  `world.pets` and all go stale when a pet is switched off — the ball, a deadlock,
  the pointer's grab — and the guards next to `bindSessions` do not cover them
  because those fire on `hidden`, which a removed pet will never have set again.
  The deadlock case must free the pet that **stayed**, or a cat stands there for
  ever waiting for an animal that no longer exists.
- **`registerCustomPet` remembers a def without putting a pet out**, and the
  overlay uses that rather than `addCustomPet` so exactly one thing decides who is
  on the lane. `applyRoster` re-sends the defs every time, which is what lets a pet
  drawn in the editor join without a restart — and would double every pet up if
  registering also adopted.

- **A guest is one idea with two halves: switched off, and last.** `guests` in
  `pet-roster.js` — the five in `pets/bundled.json`. Off, because the four animals
  are the story and a bundled pet letting itself out on install is a surprise
  rather than a present. Last, because five of them sitting between Mutex and
  Heisenbug pushed the fish off the bottom of the window and the four stopped
  reading as a set. Deliberately *not* two settings: they cannot then disagree.
  - Guests are **appended**, not anchored the way a new custom pet is. Anchoring
    drops them wherever Heisenbug happens to sit in the user's own order, which
    for anyone who has dragged the list is the middle of their team.
  - A **user-drawn** custom still lands among the team, before the fish. That is
    the old `filter(kind !== 'heisenbug')` position and moving it would silently
    reorder every existing user.
  - The default only applies while the config has never *placed* the pet — being
    in the saved `order` is the test. The window writes the whole list on every
    change, so keying it on anything else forces a guest the user asked in back
    off at the next launch, which reads as the checkbox not working.
  - A guest naming a pet that did not load is **inert**. It reaches the resolver
    through the same list as a custom pet, so an id with no def would otherwise
    draw a row for a pet the lane silently skips for having no art.
  - The order must contain no id twice — a pet can arrive by two routes, and the
    roster keys by id, so a duplicate shadows the original.
  - Badged `GUEST` rather than `CUSTOM`: a pet the user never touched is not
    theirs.
- **The pet loader keys on name, user file second.** `readPetDefs()` merges
  `pets/bundled.json` then `~/.strays/custom-pets.json`, so editing a bundled pet
  in your own file *replaces* it. Concatenating would put two animals with one name
  on the lane, and a custom pet's name is its roster id — the roster could not tell
  them apart.
- **Regenerate rather than hand-edit.** `node pets/build.js` writes
  `bundled.json` and throws on a ragged row or an unknown palette character. Only
  `pets/bundled.json` is in the npm `files` whitelist; the generator is not.

## The Pets window is Nothing-styled

`pets-window.html` follows the Nothing design system: monochrome, typographic,
three layers (display title / body names / mono ALL CAPS metadata), 1px borders,
no radius on rows, no gradients, no shadows, opacity-only transitions on
`cubic-bezier(0.25, 0.1, 0.25, 1)`, dot-matrix background at 0.14. Light and dark
are both authored, not derived.

- **Red (`#D71921`) is an interrupt, not a colour.** The only thing allowed to use
  it is an empty lane. A checked toggle is grayscale, because a pet being switched
  on is not an event.
- **The fonts are named but never fetched.** Space Grotesk / Space Mono / Doto sit
  first in each stack so a machine that has them uses them, then it falls back to
  the system stacks. Do not add a webfont link: `update.js` holds *the* only
  network request in the project and the README's privacy claim depends on that
  staying true. Everything else in the system is structural and survives the
  substitution.
- The lane itself is **not** Nothing-styled and must not be — it floats over other
  people's windows, so its own rules (nothing white, nothing translucent,
  `pixelPlate()`) win there.

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

- **The app's version comes from `desktop/version.js`, never `app.getVersion()`.**
  `bin/strays.js` starts Electron with `desktop/` as the app directory, so
  `getVersion()` reads `desktop/package.json` — which existed only to name an entry
  point and carried a placeholder `1.0.0` through four releases. The update check
  therefore compared **1.0.0** against npm's latest and told every `npx` and global
  install, once a day for ever, that there was an update to fetch. The packaged app
  was correct purely by accident, because its manifest is the real one. So
  `desktop/package.json` now declares **no version at all** — a second copy of a
  number the release workflow does not bump is a number that will be wrong — and
  `desktop/test/version.test.js` holds both halves. A wrong version here does not
  fail, it lies, which is why it went unnoticed.

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
  **The window is a window of *movement*, and the throw is then faded by how long
  the hand has rested.** This is the third answer to *did that release mean
  throw*, and the first two were both bugs anyone could feel.
  Measured over the last `THROW_WINDOW` of **wall clock**, a stop of 90ms left the
  window holding nothing but stationary samples, so the throw was exactly zero.
  Nobody releases the button mid-sweep — you sweep, you stop, you let go — and
  90ms is inside ordinary release latency, so most releases silently were not
  throws: a 600px/s sweep let go of 66ms later carried **16px**. Removing that
  dead zone *alone* (`bdfa0ad`, then reverted) was the other failure: every
  release carried the full sweep speed against a cap of 1800px/s, and putting a
  pet down looked like firing it.
  So a frame in which **the hand** did not move records nothing and accumulates
  `g.still` instead, and `throwFrom()` scales the result by it: full for a 33ms
  plateau (two frames of genuine button latency, which is what keeps the throw
  repeatable), then **halving every `THROW_HALF_LIFE`**, and nothing by
  `THROW_GRACE_ZERO`. That reads three intentions off one gesture: let go while
  moving and it is a throw; slow down first and the window averages the slowing,
  so it is a lob; hold it still and it is a person putting a pet down.
  **The decay replaced a plateau of 80ms and a linear ramp, which was the next
  report: *"it freezes for 0.1s then it flies"*.** A hand that had visibly
  stopped still threw at *full* speed, so the pet sat frozen and then launched.
  A decay is the shape that fixes that in principle rather than by tuning,
  because the discontinuity the eye objects to is proportional to what is thrown:
  freeze for longer and less is left, so the hitch shrinks with its own cause —
  at whatever release latency the hardware has. That matters because we do not
  get to know it. **A trackpad suppresses the end of a flick as the finger
  lifts**, by an amount that is a property of the pad.
  **And "did the hand move" is asked of the pointer, while "where has the pet
  been" is answered by the pet.** Those look like one question. The case that
  separates them is a pet pinned against the edge of the lane while the finger
  carries on past it — which a trackpad flick does constantly, because it runs
  the cursor into the edge of the screen. Asking the *pet*, a pinned frame looks
  like a resting hand: it records nothing, the pre-pin samples stand as the
  gesture, and a pet that sat motionless against the wall for 100ms left it at
  **1676px/s**. Asking the pointer, those frames are samples that happen to
  record a position that has not changed, so the measured speed bleeds to nothing
  over `THROW_WINDOW` — per axis, so a pet dragged along the ceiling still throws
  sideways — and the same pin now throws **0**.
  **And the case none of that can fix: the gesture can end long before the button
  does.** Measured on a Force Touch trackpad, the pointer stops reporting
  movement **158–200ms** before the mouseup — ten to twelve frames at 60Hz,
  twice that at 120Hz — and for all of it the pet is glued to a finger that has
  already stopped. Faithful, and horrible: *"it freezes for 0.1s then it
  flies"*. No tuning helps, because the freeze **is** the pet honouring a hand
  that is no longer moving it: throw hard at the end of the pause and it is a
  jump cut, throw softly and there was no point flicking.
  So a flick is released when the **flick** ends — `FLICK_SETTLE` of stillness
  behind a gesture faster than `FLICK_MIN`, and the pet leaves then and there.
  The mouseup that eventually arrives finds no grab, so `releaseGrab` returns
  null and `onUp` cannot read it as a click. Which is also what throwing *is*:
  the ball leaves your hand while your hand is still moving, and does not wait
  for you to finish the gesture. On the trackpad above that turns a 158ms freeze
  and no throw into a 42ms freeze and 2152px/s.
  **`FLICK_MIN` is what keeps a carry a carry.** Placing a pet means aiming, and
  aiming means slowing down, so the window averages the slowing tail: a carry
  that is aimed measures ~75px/s however fast it started, against 1560 and 6900
  for the two real flicks. Without the threshold a pet launches itself out of a
  hand that paused to think — pinned by *"but a carry that is merely paused is
  still a carry"*.
  **`world.pressed` is the pointer lease held past the grab**, and it is not
  optional: between the flick leaving and the button coming up there is no grab
  but the finger is still down and still moving, and handing that half of a drag
  to whatever is underneath is the stuck-pet failure in someone else's window.
  Both directions are pinned, because never *clearing* it is the far worse bug —
  a claim the renderer never withdraws costs every click on the machine, not just
  the lane.
  **Do not "restore the old behaviour" here.** Replaying that logged gesture
  against every published version: v1.3.0, v1.3.1, v1.3.3 and v1.6.1 all throw
  **0px/s** for it, and the only one that threw at all was v1.3.2, the one
  reverted for being a cannon. There is nothing behind us to go back to; a
  remembered good throw on this hardware was not this code.
  **`STRAYS_DEBUG=1` makes every release explain itself** (`[throw] still 104ms
  gesture 1820px/s x0.43 -> 780px/s over 5 samples of 84ms`). Both numbers that
  decide how a release feels are invisible from the outside, and release latency
  belongs to the pointing device, so a throw that feels wrong on someone's
  machine is measurable rather than guessable — a release with the button still
  down is marked `flick`. `preload.js` carries the flag in because the renderer
  cannot read the environment. **Two rounds of tuning by reasoning were spent
  before this existed, and both were wrong for hardware nobody had measured.**
  **The cap is applied first and the fade second, and that order is the point of
  the fade.** Fading the raw speed hides the fade behind the cap for exactly the
  gestures that need it: a 2500px/s flick is still over `THROW_MAX` after two
  thirds of the fade, so a visible pause would do nothing at all until it was
  nearly over.
  **How fast a throw leaves and how far it goes are two levers, and using one
  for the other is the mistake that has now been made in both directions.**
  Lowering `THROW_MAX` to 1000 to bound the travel is what produced the next
  report — *"when I release there is a delay, not like throwing a ball"*. A
  carried pet sits **exactly** under the pointer, so a release slower than the
  hand lets the cursor visibly pull away from the pet, and that does not read as
  a gentle throw, it reads as the pet hanging back. At a cap of 1000 a 2000px/s
  flick left at 40% of the hand's speed. It is also the worst possible lever for
  distance: travel goes as the *square* of release speed, so the cap costs the
  feel of every throw under it to bound the few over it.
  So **`THROW_MAX` is `FALL_MAX`** — derived rather than tuned. A sprite height a
  frame is where successive positions stop touching and motion becomes a jump
  cut, and a throw is no more legible than a fall, so the lane has one speed
  limit in every direction. Nothing below it is held back (a 2500px/s flick now
  leaves at 96% of the hand); a hand faster than the lane can draw is the only
  thing clipped.
  **Distance is `GROUND_GOVERNOR`'s job: a cubic term on the floor, `5e-7·v³`.**
  Constant friction alone means quadratic carry distance, so at the full cap the
  hardest flat flick slid **4528px over 3.9s** — across the display and back off
  both walls at a barely-changing speed, which is the least ball-like thing the
  lane can do. The cubic makes it 1631px and 2.4s while costing an ordinary
  600px/s sweep 34px of its 394 (a ninth). It is a **governor, not physics**, and
  the exponent is the whole point: v² was tried and took a *quarter* off the
  ordinary sweep, because the term has to be invisible where hands actually live
  and decisive only at the top of the range. `GROUND_FRICTION` stays 450 and
  keeps its own job — the even slowing to a definite stop.
  `SPIN_PER_SPEED` is per px/s of release speed and so has to be revisited
  **whenever the cap moves**: 0.0035 leaned 0.4rad at a cap of 1000, and the
  0.0065 that fixed it puts an *ordinary* sweep into `TUMBLE_MAX` at a cap of
  2400 — a pet spinning like a top for having been moved across a desk. Neither
  end shows it: a hard throw saturates `SPIN_MAX` at any sane value and a gentle
  set-down turns at none, so it is pinned in the middle (*"an ordinary sweep does
  not somersault"*, 0.45rad against 0.75).
  **The known extreme is the hard 45° lob**, which is flight rather than skid and
  so is bounded by gravity and the ceiling instead: about 3.8s and three screens
  of travel on a laptop, five seconds on a big monitor. If that ever needs to
  come down, the lever is a `FLOOR_GRIP` that falls off with impact speed — a
  hard landing should scuff rather than skip — and *not* the cap.
  And **no test can see any of this if it releases on the same frame as its last
  `mousemove`**, which is what `dragTo()` does and what a fixed-step harness
  makes easy: those tests measure a gesture no hand performs. The pause is the
  test. All three faults here were found by driving the real `tick()` from a
  simulated rAF with pointer events on their own clock, because the bug lives in
  the gap between the pointer's clock and the render loop's.
  **The flight is a parabola, and that is two statements: horizontal speed never
  changes, vertical speed changes by the same amount every frame.** So there is
  deliberately **no horizontal drag in flight** — drag makes the pet stall
  forward and the arc lean, which is a falling leaf, not a ball. `FALL_MAX` is
  the only thing allowed to bend it, and it is a backstop, not physics: a
  built-in sprite is 40px tall, so past 2400px/s successive frames stop
  overlapping and a fall reads as a jump cut. A normal throw never reaches it.
  `DROP_GRAVITY` is what sets how *big* the arc is, and the parabola property
  holds at any value — so the size is pinned by its own test (a hard 45° throw is
  back down inside a second and a quarter). At 900 it hung for three seconds and
  outranged the screen, so every throw died against a wall. That bound used to be
  two seconds, and lowering `THROW_MAX` quietly made it unfailable: hang time is
  linear in release speed, so the same wrong gravity that hung for 2.8s at the
  old cap hangs for 1.8s at this one. **A cap change is a re-audit of every test
  that names a distance or a duration.**
  Then the flight has to end. Floor bounces at `BOUNCE` terminate on
  `BOUNCE_MIN` (halving converges only in the limit); the walls and the ceiling
  *reflect* rather than clamp, and the ceiling is not optional — a hard throw
  upward leaves the screen, nameplate and all. Out of bounces is not the same as
  stopped: a level throw never earns a bounce, so without the `SLIDE_MIN` skid
  every throw across the lane ended with the pet standing exactly where it was
  let go.
  **Friction on the floor is a constant deceleration (`GROUND_FRICTION`) plus the
  cubic governor above it, and never a proportion of the speed.** It was `vx *= (1 - 3.0·dt)`, and both halves were
  wrong: far too strong, and the wrong curve — a proportional decay sheds most of
  the speed at once and then crawls towards zero, so what you saw was a lurch and
  a drift where sliding should be an even slowing to a definite stop. And
  `FLOOR_GRIP` is 0.92, not 0.75: a bounce is the floor pushing *up*, so it
  barely touches sideways speed — that is what lets a ball skip on across a room,
  and at 0.75 four hops threw away three quarters of the throw.
  **Tune these against a hand, not against the cap.** The bug was invisible for a
  release because the test flicked hard enough to saturate `THROW_MAX`: at the
  1800px/s cap of the time the pet carried 582px and looked fine, while an
  ordinary 600px/s sweep carried 181px — under three body lengths, which reads as
  stopping dead. The distances are quadratic in release speed, so the top of the
  range tells you almost nothing about the middle of it. Assert in body lengths
  at a stated speed well clear of the cap.
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

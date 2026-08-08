# strays — agent guide

Pixel-art pets that live in a lane at the bottom of the screen and react to
Claude Code sessions. Zero runtime dependencies; Electron only for the desktop
shell. Single source of truth: this file. `AGENTS.md` is a symlink to it.

## Layout

```
strays/
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

- Overlay:   `cd desktop && npm start` (foreground; `STRAYS_DEBUG=1` for logs)
- Stop:      `cd desktop && npm run stop`
- Tests:     `cd desktop && npm test`
- One file:  `cd desktop && node --test test/rules.test.js`
- Approvals: `cd desktop && npm run hooks` (`npm run unhook` removes them)

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
- **Jump resolution must consult the desktop session index before falling back
  to `claude://resume`.** Resume derives the desktop session id by prefixing the
  uuid, which is right for a small minority of sessions; for the rest it creates
  a duplicate conversation instead of focusing the existing one.
- **Hooks are read at session start.** After `npm run hooks`, already-open
  Claude Code sessions keep the hooks they started with.
- **Verify tests by mutation, not by a green run.** An audit of this suite found
  34 surviving mutants, several of them tests that could not fail at all. Break
  the code a new test covers and confirm it goes red.

## Pointers

- Overview: @README.md
- Pet format: @docs/custom-pets.md
- Approvals and permission modes: @docs/approvals.md
- Development notes and specs: @docs/development.md

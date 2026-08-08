# Development

Zero runtime dependencies. The engine is one vanilla-canvas file; the desktop
app is Electron and nothing else.

## Layout

```
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
desktop/test/           node:test suite — no test framework, no dependencies
```

## Running

```bash
cd desktop
npm install
npm start        # run the overlay (foreground; Ctrl+C quits)
npm run stop     # quit a running overlay
npm run restart
npm test
```

`STRAYS_DEBUG=1 npm start` logs watcher status, usage and approval traffic.

## Tests

Node's built-in runner, no framework. The suite concentrates on the two things
that are easy to get quietly wrong: whether a call would really have prompted,
and where a pet click should land. Both are pure functions, so the whole matrix
runs without Electron or a live Claude Code.

**Verify tests by mutation, not by a green run.** A mutation audit of this suite
once found 34 mutants surviving, including several tests that could not fail
under any implementation. Before trusting a new test, break the code it covers
and confirm it goes red.

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

- **Jump resolution must consult the desktop session index before falling back
  to the resume deep link.** `claude://resume?session=<uuid>` derives the
  desktop id by prefixing the uuid, which is right for a tiny minority of
  sessions; for the rest it creates a duplicate conversation instead of focusing
  the existing one.

- **Hooks are read at session start.** After `npm run hooks`, already-open
  Claude Code sessions keep the hooks they started with.

- **The installer identifies its own entries by a path-independent
  `--strays-hook` sentinel**, so moving or renaming the checkout is safe. Two
  legacy markers are kept deliberately so pre-rename installs are still
  recognised and replaced rather than duplicated.

## Specs

Feature specs live in [specs/](specs/).

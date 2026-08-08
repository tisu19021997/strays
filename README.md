# strays 🐾

A tiny team of debugging pets that live along the bottom of your screen while
Claude Code works. A birthday gift for Claude, open-sourced so everyone's
terminal can have a small disaster of its own.

Nothing on screen but the pets themselves. The one prop is Grep's ball, and
there is only ever one ball.

| pet | species | pathology |
| --- | --- | --- |
| **Segfault** | cat | Everything's fine, everything's fine, then SIGSEGV. Crashes for no discernible reason, respawns elsewhere like nothing happened. |
| **Grep** | dog | Finds everything, including things you didn't ask it to find. Also: the ball. Fetch always completes with exactly 1 result. |
| **Mutex** | cat | Two cats can never pass each other without lock contention. Both freeze until the scheduler preempts one at random. |
| **Heisenbug** | fish | Floats by in a space helmet, like the kid in *Wonder*. Only misbehaves when you're not looking. Cannot reproduce. Also your **usage tracker**: hover her for today's tokens and estimated cost, watch her get agitated as the burn rate climbs, and hear about every dollar you didn't watch — *"that's $12 today. i saw nothing."* The menu bar shows a `Today: 1.2M tok · ~$4.20` line. Costs are estimates from a built-in pricing table; token counts are exact. |

## Install

### Desktop overlay (macOS, Windows, Linux)

A transparent, click-through lane above all your windows.

```bash
git clone https://github.com/tisu19021997/strays
cd strays/desktop
npm install
npm start
```

A 🐾 appears in your menu bar (approvals, party mode, pause, quit live there).

### Any web page, one script tag

```html
<script src="strays.js" data-auto></script>        <!-- add data-party for confetti -->
```

Or mount manually:

```js
Strays.mount({ height: 170, party: true });
Strays.setStatus('working');       // 'working' | 'needs-you' | 'idle' | null
Strays.setSessions([...]);         // per-session states (the desktop feeds this)
Strays.celebrate();                // confetti burst
```

## Claude Code features

The desktop app watches `~/.claude/projects` locally — only transcript
timestamps and each file's last line. Nothing leaves your machine.

- **One pet per session** — Crew-style: three sessions open, three pets out.
  With zero sessions the whole team hangs out anyway (they live here).
- **Live states** — a badge above each pet shows 💭 thinking, 🔧 running a
  tool, ❗ waiting on you, ✓ done.
- **Needs-you alerts** — a blocked session makes its pet hop until you deal
  with it. The menu bar shows 🐾❗.
- **Tap to jump** — click a pet and you land on *that pet's session*, not just
  its application. A pet keeps its session for as long as the session exists,
  so the pet you aim at is the pet you click. Sessions living in the Claude
  desktop app are opened by deep link straight to that conversation; sessions
  started from a terminal bring their own terminal forward — the one that
  actually launched them, recorded at session start. Pin a destination with
  `{ "jumpApp": "iTerm2" }` in `~/.strays/config.json`. macOS only for
  now; elsewhere a click does nothing rather than guessing.
- **Done → confetti** — when a session finishes, the team celebrates.

### Allow / Deny from the overlay (optional)

When Claude Code is about to stop and ask your permission, a card rises above
the pets with **Allow** / **Deny**, and clicking it answers the prompt without
switching windows.

```bash
cd strays/desktop
npm run hooks        # installs the hooks into ~/.claude/settings.json
                     # (backs the file up first; npm run unhook removes them)
```

Then enable it in the tray: **🐾 → Command approvals (Allow/Deny)**. Already-open
Claude Code sessions keep the hooks they started with, so restart them.

**When you will and will not see a card.** The overlay predicts whether Claude
Code would actually prompt you, and stays quiet otherwise — a card for a command
that was never going to stop is worse than no card at all, because the pets have
to hold the tool call while they wait for a click you have no reason to make.

| permission mode | card? |
| --- | --- |
| `default` / manual | yes, unless your own rules already cover the command |
| `acceptEdits` | only for commands the mode does not auto-approve |
| `auto` | no — a classifier vets each action and you are never asked |
| `plan`, `bypassPermissions`, `dontAsk` | no |
| anything newer than this project knows about | no |

**If you work in `auto` mode you will essentially never see a card. That is the
feature working, not a bug.** Cards are for manual-mode sessions and for anyone
whose rules force an ask.

Your own permission rules are honoured, merged across managed, user, project and
local settings in Claude Code's precedence: `deny` first, then `ask`, then
`allow`. A command already covered by your allow list raises nothing; an `ask`
rule raises a card in *every* mode, including `auto`. Compound commands are
split the way Claude Code splits them, so `git status && npm test` is judged one
sub-command at a time.

That last row of the table is deliberate. An earlier version gated any mode it
did not recognise, met a Claude Code release that reported a new mode, and held
every single tool call for twenty seconds. Unknown now means silent.

**Troubleshooting.** `~/.strays/gate.log` records a line for every call
with the reason it did or did not raise a card, so a missing card is
explainable rather than mysterious:

```
skip: auto mode: a classifier vets the call, the user is never asked (tool=Bash)
skip: an allow rule covers this call (tool=Bash)
gate: mode default: Claude Code may prompt tool=Bash terraform apply
```

The log rotates to `gate.log.1` rather than being deleted.

## Design your own pet

Open `editor.html`:

- paint two walk frames on the pixel grid (a Crew-style dark outline is added
  automatically), or **import a PNG** — it gets quantized onto the grid
- name it, give it things to say, hit **adopt** — it joins the team on every
  page in that browser
- **export JSON** and save it to `~/.strays/custom-pets.json` for the
  desktop overlay

A pet is just JSON:

```json
{
  "name": "Nullptr",
  "speed": 30,
  "phrases": ["i am also a bug"],
  "palette": { "1": "#8fd977", "2": "#5cb85c", "3": "#3d8b3d", "k": "#17181c", "w": "#f5f7fb" },
  "grids": {
    "walk1": ["..11..", ".1111k", ".2222.", ".3.3.."],
    "walk2": ["..11..", ".1111k", ".2222.", "3...3."]
  }
}
```

`grids.walk1` is required; `walk2`, `sit`, `sleep` are optional. Chars map into
`palette`; `.` is transparent; the outline is generated for you.

## Repo layout

```
strays.js            the whole engine — zero dependencies, vanilla canvas
index.html           demo / landing page
editor.html          pixel editor + PNG import for custom pets
desktop/main.js      Electron overlay window, tray, IPC
desktop/preload.js   the only bridge between the window and the main process
desktop/watcher.js   per-session states from ~/.claude/projects
desktop/overlay.js   renderer: pets + Allow/Deny cards
desktop/approvals.js        the pending/replies directories, watched
desktop/permissions.js      would Claude Code prompt? (pure, the heart of it)
desktop/settings.js         finds and merges Claude Code's permission rules
desktop/requests.js         how long an approval request still means anything
desktop/sessions.js         where a pet click should land (pure)
desktop/usage.js            Heisenbug's token and cost tracker
desktop/hooks/gate.js       the PreToolUse approval gate
desktop/hooks/session-start.js   records which terminal launched a session
desktop/setup-hooks.js      installs/removes the hooks in ~/.claude/settings.json
desktop/test/               node:test suite — no test framework, no dependencies
```

## Tests

```bash
cd strays/desktop
npm test
```

Node's built-in runner, no dependencies. The suite concentrates on the two
things that are easy to get quietly wrong: whether a call would really have
prompted, and where a pet click should land. Both are pure functions, so the
whole matrix runs without Electron or a live Claude Code.

## License

MIT. The pets remain unfixable.

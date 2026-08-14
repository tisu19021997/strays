# Spec: trustworthy permission cards and exact session jumps

    status: ready-for-agent
    area: desktop overlay (Electron main, PreToolUse gate, watcher)
    supersedes: the mode-blind gate shipped in the first Allow/Deny pass

## Problem Statement

Two features that look finished are, in daily use, actively harmful.

**Permission cards fire on everything.** The user runs Claude Code in `auto`
permission mode — the mode where a classifier vets each action and the user is
essentially never prompted. Despite that, a pet raises an Allow/Deny card for
*every single tool call*. Worse than the visual noise: each ungated call is held
for twenty seconds waiting for a click that the user has no reason to make,
because Claude Code never asked them anything. A five-minute task becomes a
half-hour task. The gate has turned a decorative feature into a throttle on the
user's real work, and the only escape is to turn approvals off entirely.

The root cause is that the gate reasons about permission modes it does not know.
It recognises `default`, `acceptEdits`, `bypassPermissions` and `plan`; the
mode it actually receives is `auto`, and its fallback policy for an unrecognised
mode is *gate anyway*. The blast radius of that one wrong default is every tool
call in every session.

Even in the modes the gate does understand, it is wrong in the same direction.
It has never read the user's permission rules, so a command sitting safely in
their `allow` list — `grep`, `ls`, `cat`, `git`, `npm` — still raises a card
even though Claude Code would have run it silently. The user's experience of the
feature is "it asks me for permission for every tool call", and that is an
accurate description of the code.

**Pet clicks go to the wrong place.** Clicking a pet is supposed to take the
user to the session that pet represents. What it actually does is bring an
*application* to the front — the first name on a hardcoded list that happens to
be running. It never looks at which session was clicked, never distinguishes a
session hosted in the Claude desktop app from one running in a terminal, and
cannot land on a specific session inside the app that hosts a dozen of them. A
user with three sessions open gets the same result from all three pets.

Underneath that, the pet→session binding is not even stable. Sessions are sorted
by most-recent-activity and pets are assigned to that ordering by position, so a
pet's identity silently reassigns whenever another session becomes busier. The
pet the user aims at and the pet they click can be two different sessions. The
same instability decides which pet an approval card is drawn above, so cards
appear over the wrong animal.

## Solution

**The gate becomes a predictor, not a broadcaster.** Before it holds anything,
it answers one question: *would Claude Code actually stop and ask the user about
this call?* It answers by modelling what Claude Code itself does — the
permission mode's behaviour, then the user's own deny/ask/allow rules merged
across every settings scope, then the built-in read-only command set. Only when
the honest answer is "yes, the user is about to be interrupted" does a card
appear, and only then does anything wait. When the answer is no — which in `auto`
mode is nearly always — the gate exits in milliseconds and Claude Code proceeds
as if the hook did not exist.

The failure direction is inverted. Today an unrecognised mode means *gate*;
after this change it means *stay silent*. A missed card costs the user one
context switch to a window they were going to look at anyway. A false card costs
them twenty seconds of a tool call that needed nothing from them. Those are not
symmetric, and the code should stop pretending they are.

**Pet clicks resolve to a real destination.** Each session carries the identity
of its host, read from its own transcript: sessions started in the Claude
desktop app are marked as such, sessions started from a terminal are marked as
such. Desktop sessions are focused by deep link — the app exposes a URL that
navigates its window straight to a named session — after looking the session up
in the desktop app's own session index, so the link lands on the existing
conversation instead of importing a duplicate copy of it. Terminal sessions
activate the terminal that actually launched them, recorded at session start
rather than guessed from a list.

And a pet keeps its session. Once a pet is bound to a session it holds that
binding until the session goes away, regardless of which session is busiest.
What the user aims at is what they click, and cards appear over the pet that
asked.

## User Stories

1. As a developer running Claude Code in `auto` mode, I want no approval cards at all, so that a mode whose entire purpose is "stop asking me" is not turned back into a mode that asks me constantly.
2. As a developer running Claude Code in `auto` mode, I want tool calls to run at full speed, so that enabling desk pets does not add twenty seconds of latency to every command.
3. As a developer in `default`/manual mode, I want a card when Claude Code genuinely blocks on a permission prompt, so that I can answer it without leaving what I am looking at.
4. As a developer in `default` mode with `Bash(grep:*)` in my allow list, I want no card for a `grep` command, so that rules I already configured are respected rather than re-litigated.
5. As a developer in `acceptEdits` mode, I want no card when Claude edits a file, so that the mode I chose actually takes effect.
6. As a developer in `acceptEdits` mode, I want no card for `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` or `sed`, so that the filesystem commands the mode auto-approves do not appear to need me.
7. As a developer in `acceptEdits` mode, I want a card for an arbitrary Bash command that is not in my allow list, so that the one case the mode still prompts for is still answerable from the overlay.
8. As a developer in `bypassPermissions` mode, I want no cards, so that a mode that skips prompts is not reintroducing them.
9. As a developer in `plan` mode, I want no cards, so that planning is not interrupted by approvals for work that has not been agreed yet.
10. As a developer in `dontAsk` mode, I want no cards, so that an automation mode stays non-interactive.
11. As a developer, I want a card whenever an explicit `ask` rule matches, in every mode including `auto` and `bypassPermissions`, so that the one rule type designed to force a prompt keeps forcing one.
12. As a developer, I want no card when a `deny` rule matches, so that a call that will be refused outright does not ask me to approve it.
13. As a developer whose command is a compound like `a && b`, I want a card only if at least one sub-command would prompt, so that a pipeline of allow-listed commands stays silent.
14. As a developer, I want wrapper prefixes like `timeout`, `nice` and `env VAR=x` to be seen through when matching my rules, so that a wrapped allow-listed command does not spuriously prompt.
15. As a developer, I want commands that Claude Code can never statically approve — `watch`, `flock`, `find -exec` — to be treated as prompting, so that the overlay agrees with the tool rather than contradicting it.
16. As a developer, I want built-in read-only commands to never raise a card, so that inspection commands stay frictionless.
17. As a developer who upgrades Claude Code and gets a permission mode this project has never heard of, I want silence rather than a card, so that a future release cannot re-break my workflow the way `auto` did.
18. As a developer, I want the gate to exit immediately when it is not going to show a card, so that the hook's cost is unmeasurable in normal use.
19. As a developer, I want the gate to never hold a call longer than its own advertised budget, so that a hung overlay can never block Claude Code.
20. As a developer running several sessions at once, I want each card to name the session and project it came from, so that I can tell two concurrent prompts apart.
21. As a developer, I want each card to appear above the pet for its own session, so that the overlay's spatial cue is trustworthy.
22. As a developer, I want a card to disappear when its session is answered elsewhere, so that I never click Allow on a call that already ran.
23. As a developer, I want stale requests from crashed or cancelled calls pruned, so that restarting the overlay does not resurrect cards for commands that finished long ago.
24. As a developer, I want a reply to only ever answer the request it was written for, so that a click cannot approve a different session's command.
25. As a developer, I want every gate decision logged with the reason it did or did not show a card, so that when it misbehaves I can tell you exactly why.
26. As a developer, I want that log to rotate rather than be deleted at a size threshold, so that evidence of a rare bug survives.
27. As a developer, I want approvals to stay entirely off when the tray toggle is off or the overlay is not running, so that uninstalling the pets is as simple as quitting them.
28. As a developer with several projects open, I want clicking a pet to focus that pet's session, so that the feature does something more useful than "raise some app".
29. As a developer whose session runs in the Claude desktop app, I want the click to navigate the app to that exact conversation, so that I land on the session rather than on whatever it last displayed.
30. As a developer, I want that navigation to open the existing conversation rather than importing a second copy of it, so that my session list does not fill with duplicates.
31. As a developer whose session runs in a terminal, I want the click to activate the terminal that launched it, so that a desktop-app session and a terminal session go to different places.
32. As a developer with both the Claude desktop app and a terminal running, I want the destination chosen from the session's own recorded host, so that it is not a coin flip decided by process-list ordering.
33. As a developer, I want to pin a destination application in config and have that win, so that an unusual setup has an escape hatch.
34. As a developer, I want a pet to keep representing the same session for as long as that session exists, so that clicking is aimed rather than lucky.
35. As a developer, I want a freed pet to be reused when a new session starts, so that the one-pet-per-session rule still holds after sessions come and go.
36. As a developer, I want a pet whose session ended to stop being clickable as that session, so that a click cannot resurrect a dead conversation.
37. As a developer, I want the click to work when the target app is running but hidden, minimised or on another Space, so that "focus it" means focus it.
38. As a developer, I want a click that cannot be resolved to fall back to the previous behaviour of activating a likely app, so that the feature degrades instead of dying.
39. As a developer on macOS without accessibility permissions granted, I want jumping to still work, so that the feature does not depend on a prompt most users will never accept.
40. As a developer on Windows or Linux, I want the click to do nothing rather than misbehave, so that the unimplemented case is honest.
41. As a developer, I want hovering a pet to show which session it holds, so that I can confirm the target before clicking.
42. As a maintainer, I want permission prediction to be one pure function over a payload and a settings object, so that the whole matrix can be tested without Electron, a hook, or a running Claude Code.
43. As a maintainer, I want jump resolution to be one pure function returning a described action, so that destination logic is tested as data and only the final side effect is untestable.
44. As a maintainer, I want the mode table and rule semantics captured as fixtures drawn from real captured data, so that a future Claude Code change surfaces as a failing test.
45. As a maintainer, I want tests to run with no new runtime dependencies, so that the project's zero-dependency promise survives.
46. As a user of the open-source project, I want documentation that states plainly when a card will and will not appear, so that silence is understood as correct behaviour rather than a bug.

## Implementation Decisions

### A permission-prediction module

A new dependency-free module owns the entire question "would Claude Code
prompt?". Its single public entry point takes a PreToolUse payload and a
resolved settings object and returns a verdict plus a human-readable reason. It
performs no I/O, so it is fully testable.

Verdict shape, which the gate logs verbatim:

    { prompts: boolean, reason: string }

Evaluation order mirrors Claude Code's own documented order, and short-circuits:

1. **Deny rules** — a match means the call is refused without a prompt: no card.
2. **Ask rules** — a match means a prompt is forced in *every* mode: card.
3. **Mode policy** — see the table below.
4. **Allow rules** — a match means no prompt: no card.
5. **Read-only command set** — a match means no prompt: no card.
6. Otherwise: card.

The mode policy table is the correction at the heart of this spec:

| mode | prompts? |
| --- | --- |
| `auto` | no — a classifier decides, and a block is a notification, not a prompt |
| `bypassPermissions` | no |
| `dontAsk` | no — non-matching calls are denied outright, never prompted |
| `plan` | no — edits are blocked and shell defers to the classifier |
| `acceptEdits` | no for edit tools; no for the seven auto-approved filesystem commands; otherwise fall through to rules |
| `default` (and its `manual` alias) | fall through to rules |
| anything unrecognised | **no** |

That last row is the policy inversion. An unknown mode is silent. The cost
asymmetry is documented inline so a future contributor does not "fix" it back.

### Rule loading and merging

A settings loader merges, in Claude Code's documented precedence, the managed
policy file, user settings, project settings, local project settings, and any
explicitly passed settings file. Deny is union-across-scopes and wins
everywhere: a deny in any scope cannot be overridden by an allow in another.
Loading is separated from evaluation so evaluation stays pure, and results are
cached against file mtimes so the gate does not re-read and re-parse on every
tool call.

### Rule matching semantics

Bash rules are matched the way Claude Code matches them, and this is where most
of the test surface lives:

- The command is split on the recognised separators — `&&`, `||`, `;`, `|`,
  `|&`, `&`, and newlines — and **every** sub-command must clear a rule for the
  call to be silent. One unmatched sub-command means a prompt.
- Fixed process wrappers (`timeout`, `time`, `nice`, `nohup`, `stdbuf`,
  `command`, `builtin`, `noglob`) and safe leading environment assignments are
  stripped before matching.
- A trailing `:*` is a trailing wildcard and is only meaningful at the end of a
  pattern; a colon elsewhere is a literal. A space before a trailing `*`
  enforces a word boundary, so a rule for `ls` does not match `lsof`.
- Exec wrappers that Claude Code refuses to statically validate — `watch`,
  `setsid`, `ionice`, `flock`, and `find` carrying `-exec` or `-delete` — are
  classified as always-prompting regardless of any allow rule.

File-tool rules use gitignore-style matching with Claude Code's four path
forms: `//` for filesystem-absolute, `~/` for home-relative, a leading `/` for
relative-to-the-settings-source, and a bare path for cwd-relative. Single-segment
allow patterns anchor at the working directory; deny and ask patterns match at
any depth.

The built-in read-only command set is encoded as data, not scattered
conditionals, so it can be diffed against future Claude Code releases.

### The gate becomes an I/O shell

The gate keeps its existing early exits (toggle off, overlay heartbeat stale,
tool not gateable) and gains the prediction call before it creates any state. A
request file is written only when the verdict is "prompts". This is the change
that removes the twenty-second stall: a call that was never going to prompt now
touches no filesystem state and waits for nothing.

Other gate corrections:

- **Request lifetime.** Pending requests carry a creation timestamp and a
  time-to-live. The gate prunes expired requests on entry and always removes its
  own request on exit, including on early termination, so a cancelled tool call
  cannot leave a card behind for the next overlay launch to resurrect.
- **Reply pairing.** A reply is only honoured for the request id it names, and
  is consumed and deleted atomically. Orphan replies are swept.
- **Bounded wait.** The hold stays strictly below the hook's configured timeout,
  and the margin is derived from the configured timeout rather than hardcoded, so
  the two cannot drift apart.
- **Logging.** Every decision records mode, tool, verdict and reason. The log
  rotates to a `.1` file at its size cap instead of being deleted.

### Session identity in the watcher

The watcher additionally extracts, per session, the transcript's `entrypoint`
field (which distinguishes a desktop-app session from a CLI session) and its
recorded permission mode, and includes both in each emitted session object
alongside the existing id, state and cwd. Both are read from the same tail scan
already being performed, so this adds no I/O.

### A jump-resolution module

A second dependency-free module owns destination choice. Its public entry point
takes the session, a desktop-session index, the set of running processes, and
user config, and returns a described action rather than performing one:

    { kind: 'open-url', url }      // focus a specific desktop-app session
    { kind: 'activate', app }      // bring a terminal application forward
    { kind: 'none', reason }       // nothing sensible to do

Resolution order:

1. A `jumpApp` pinned in config wins outright.
2. A hit in the desktop-session index whose record looks like it is already on
   screen activates the desktop app without navigating, so that a multi-pane
   layout survives the click.
3. Any other hit in the index produces a deep link addressed to the desktop app's
   own session identifier.
4. A desktop-hosted session with no index entry falls back to the resume-style
   deep link keyed by the Claude Code session id.
5. A CLI session activates its recorded host terminal, or the first running
   terminal from the known list.
6. Anything else degrades to today's behaviour.

Step 2 exists because the deep link *navigates*: it replaces whatever the window
is showing with the one conversation, which is the right thing when the session is
somewhere else and destructive when it was already in front of you. Which panes
are currently open cannot be read — the desktop app keeps that in
`extraPanesByMode` inside its Chromium Local Storage leveldb, snappy compressed,
in a private format with no compatibility promise, so building a click on it would
break on a release nobody can see coming. Each session record does carry
`lastFocusedAt`, and in a split layout the visible panes are all focused within
minutes of each other, so a recent focus is treated as "probably on screen". It is
a heuristic, and `jumpMode` (`auto` | `never` | `always`) is the escape hatch for
anyone it misjudges. An archived conversation is never on screen whatever its
focus timestamp says.

**The index lookup is load-bearing and must not be skipped.** The desktop app's
resume link imports a CLI session by deriving an identifier from the session
uuid; that derivation only coincides with the real identifier for sessions that
were themselves imported from the CLI. On the development machine that is 5
records out of 670. For the other 665, following the resume link would create a
duplicate conversation instead of focusing the existing one. The index — the
desktop app's own per-session records, which carry both identifiers plus cwd and
title — is therefore consulted first, keyed on the Claude Code session id, and
cached against directory mtime because it holds hundreds of files.

Electron's role shrinks to performing a described action and reporting failure.

### A session-host recorder

A small SessionStart hook records, per session, the terminal that launched it —
program name, bundle identifier, parent pid and tty — so CLI sessions can be
returned to their own window rather than to whichever terminal sorts first. It
is installed alongside the existing gate by the same installer, is inert if the
overlay is absent, and its absence degrades resolution to the existing guess.

### Stable pet↔session binding

Pet assignment changes from positional-over-a-sorted-list to sticky. A pet
holds its session id until that session disappears from the watcher's emission;
new sessions are given the first unbound pet; a pet whose session ends is
released and stops reporting that session on click. Approval-card placement uses
the same binding, so a card is drawn above the pet that actually asked. Hover
surfaces the bound session so the target is confirmable before clicking.

### Installer

The hook installer registers both hooks, records the timeout it configured so
the gate can derive its own budget from it, and continues to identify its own
entries for clean reinstall and removal. Because installed hook configuration is
only read at session start, the installer states plainly that open sessions must
be restarted.

## Testing Decisions

**What a good test looks like here.** Tests exercise external behaviour: given
a payload and settings, does the predictor say prompt or not, and for the stated
reason; given a session and an index, what destination is produced. Tests do not
reach into rule-matching internals, cache structures, or file layouts. Every
test must be able to fail for a real reason — a test that merely restates the
mode table in a second place is not carrying weight.

The work is done test-first, per the project's TDD practice: a failing test that
reproduces the reported behaviour precedes each fix.

**Modules under test.**

*The permission predictor* is the primary target and gets table-driven coverage
of the full matrix: every permission mode crossed with every gateable tool,
crossed with the rule situations (no rules, matching allow, matching deny,
matching ask, allow-in-one-scope-deny-in-another). Bash matching gets its own
table: compound commands where all sub-commands are allowed and where one is
not, wrapper stripping, word-boundary behaviour, trailing-wildcard placement,
and the never-statically-approvable wrappers. The unknown-mode case is tested
explicitly as a named behaviour, not an incidental default, because it is the
regression that caused this spec.

*The jump resolver* gets a table over the combinations of entrypoint, index hit
or miss, pinned config, and running-process sets — with an explicit test that an
index hit never produces a resume-style link, since that is the duplicate-session
bug.

*The gate* gets a small number of subprocess tests: spawn it, write a payload to
stdin, assert on stdout and on the fact that a non-prompting payload exits
promptly and creates no files. This is the seam where the twenty-second stall
actually manifested, so it is asserted directly rather than inferred from the
predictor's verdict.

*The watcher* gets a parse test over a synthetic transcript asserting that
entrypoint and permission mode are surfaced.

*Pet binding* is tested through the engine's existing manual-stepping entry
point, which already exists for headless verification: drive a sequence of
session sets and assert that a pet's session id is unchanged when activity order
changes, and released when its session ends.

**Prior art and infrastructure.** The project has no tests today, so this
establishes the pattern. The runner is Node's built-in test runner, invoked by a
new package script — chosen because it adds no dependency and the project's
distinguishing promise is that it has none. Fixtures are captured from the real
machine rather than invented: the actual user settings allow list, real gate log
lines showing the observed `auto` mode, and real desktop-session records with
identifiers and titles anonymised.

**End-to-end verification.** Beyond unit coverage, the fix is verified against
live Claude Code: confirm from the gate log that `auto`-mode calls are skipped
with a stated reason and that a manual-mode call still produces a card, and
confirm that a pet click lands on the correct session in the correct host.

## Out of Scope

- Jump support on Windows and Linux; resolution returns "nothing to do" there.
- Focusing an individual popped-out session window. The desktop app records
  pop-outs only for restore at next launch and exposes no focus-by-session API,
  so the main window is the finest available target.
- Reimplementing the `auto` mode classifier. The overlay predicts whether a
  *prompt* occurs, never whether the classifier will allow the action.
- Reproducing Claude Code's permission matching to the character. The goal is to
  be right on the cases users actually hit and to fail toward silence.
- Any change to pixel art, the pet editor, usage tracking, party mode, or the
  landing page.
- Accessibility-based window targeting. It requires a permission grant most
  users will decline, and the deep link makes it unnecessary for the common case.
- Publishing the project to GitHub and replacing the remaining name placeholders.

## Further Notes

The behaviour that motivated this spec is preserved as evidence: the gate log
shows 47 decisions at `mode=auto`, nearly all of them followed twenty seconds
later by "no click, falling through" — the gate silently taxing every tool call
in an unrelated project's session while the user worked.

Two facts about the environment are worth recording because they are not
guessable from the code. Claude Code reports the permission mode as `auto`,
which no released version of this project has ever recognised. And AppleScript
window enumeration is unavailable — System Events returns "not allowed
assistive access" — which is what makes the deep link the right mechanism rather
than a convenience.

A consequence of doing this correctly is that the feature becomes almost
invisible to this particular user, who works in `auto` mode. That is the correct
outcome and the documentation should say so, so that "I never see cards" is not
filed as a bug. The cards remain valuable for manual-mode users and for anyone
whose rules force an ask.

# Allow / Deny cards

Approve a command without switching windows: when Claude Code is about to stop
and ask your permission, a card rises above the pets with **Allow** / **Deny**,
and clicking it answers the prompt.

```bash
cd strays/desktop
npm run hooks        # installs the hooks into ~/.claude/settings.json
                     # (backs the file up first; npm run unhook removes them)
```

Then enable it in the tray: **🐾 → Approvals**. Already-open
Claude Code sessions keep the hooks they started with, so restart them.

## When you will and will not see a card

The overlay predicts whether Claude Code would actually prompt you, and stays
quiet otherwise. A card for a command that was never going to stop is worse than
no card at all, because the pets hold the tool call while they wait for a click
you have no reason to make.

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

## Your own rules are honoured

Rules are merged across managed, user, project and local settings in Claude
Code's precedence: `deny` first, then `ask`, then `allow`. A command already
covered by your allow list raises nothing; an `ask` rule raises a card in
*every* mode, including `auto`. Compound commands are split the way Claude Code
splits them, so `git status && npm test` is judged one sub-command at a time.

That last row of the table is deliberate. An earlier version gated any mode it
did not recognise, met a Claude Code release that reported a new mode, and held
every single tool call for twenty seconds. Unknown now means silent.

## Troubleshooting

`~/.strays/gate.log` records a line for every call with the reason it did or did
not raise a card, so a missing card is explainable rather than mysterious:

```
skip: auto mode: a classifier vets the call, the user is never asked (tool=Bash)
skip: an allow rule covers this call (tool=Bash)
gate: mode default: Claude Code may prompt tool=Bash terraform apply
```

The log rotates to `gate.log.1` rather than being deleted.

## Privacy

Everything is local. The desktop app reads `~/.claude/projects` — only
transcript timestamps and each file's last line — and the hooks talk to the
overlay through files in `~/.strays/`. Nothing leaves your machine.

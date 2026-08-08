<div align="center">

# strays 🐾

**A tiny team of pets that live at the bottom of your screen and keep you company while Claude Code works.**

<img src="docs/team.png" alt="Segfault, Grep, Mutex and Heisenbug wandering along the bottom of a screen" width="620">

Free, open source, and quietly useful.

</div>

---

They wander around above your other windows. When Claude is thinking, they're
busy. When Claude needs you, they hop up and down until you look. When it's all
done, there's confetti.

They're strays because that's what they are twice over: a *stray pointer* is a
bug, and a stray is something you take in. Each one is a bug you have personally
met. None of them can be fixed. That's fine — they're not here to be fixed.

## Meet the team

|     | who | what they're like |
| --- | --- | --- |
| 🐈‍⬛ | **Segfault** | A cat. Everything's fine, everything's fine, then he crashes through something for no reason and reappears across the room like nothing happened. |
| 🐕 | **Grep** | A dog. Finds everything, including the things you didn't ask him to find. He has the ball. There is only one ball. |
| 🐈 | **Mutex** | Also a cat. Two cats cannot pass each other, so when he meets Segfault they both freeze until one of them gives up. Otherwise: asleep. |
| 🐠 | **Heisenbug** | A fish in a little space helmet. Only misbehaves when you're not looking. She also quietly counts what today has cost you, and will mention it. |

Want a fifth? [Draw one.](#make-your-own)

## What they actually do

- **One pet per session.** Three windows of Claude open, three pets out.
- **You can see what's going on** without reading anything — a small badge shows
  thinking, working, waiting on you, or done.
- **They nudge you** when Claude is stuck waiting for an answer.
- **Click a pet to go to it.** You land in that pet's conversation, not just
  somewhere in the app.
- **Say yes without switching windows.** When Claude asks permission for
  something, a little card pops up over the pets. Click Allow and carry on.
- **Heisenbug keeps the receipts.** Hover her for today's tokens and roughly
  what they cost.

Everything happens on your own machine. Nothing is sent anywhere.

## Get them

**On your desktop** (macOS, Windows, Linux):

```bash
git clone https://github.com/tisu19021997/strays
cd strays/desktop
npm install
npm start
```

A 🐾 appears in your menu bar — that's where pause, party mode and quit live.

**Or on any web page**, with one line:

```html
<script src="strays.js" data-auto></script>
```

## Make your own

Open `editor.html`, draw a creature on the pixel grid — or drop in a PNG and let
it be squashed into pixels for you — give it a name and a few things to say, and
hit **adopt**. It joins the team.

More in [docs/custom-pets.md](docs/custom-pets.md).

## Free, and open source

All of it. There is no paid tier, no accounts, no telemetry, nothing to unlock.
The "pro" version is just the one where you drew your own pet.

strays owes its existence to [Crew Deskmates](https://crew-deskmates.vercel.app),
a lovely paid desk-pet app that got there first and did it beautifully. If you
want something polished and supported by people whose job it is to support it,
buy theirs — it's good. This one exists because some of us wanted the same idea
wired into Claude Code, and because a present you can read the source of is a
better present.

It started as a birthday gift for Claude. It seemed unfair to keep it.

## Documentation

- [Allow / Deny cards](docs/approvals.md) — how the permission prompts work
- [Designing your own pet](docs/custom-pets.md) — the pixel format
- [Development](docs/development.md) — layout, tests, and what will bite you

## License

MIT. The pets remain unfixable.

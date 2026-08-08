#!/usr/bin/env node
/*
 * strays session-host recorder — a Claude Code SessionStart hook.
 *
 * A pet click for a command-line session should return to the terminal that
 * actually launched it, not to whichever terminal happens to sort first in a
 * hardcoded list. Only the session's own process knows which that is, and only
 * at the moment it starts, so this hook writes it down: <home>/sessions/<id>.json.
 *
 * What it records is deliberately a short allowlist — the terminal's name and
 * bundle id, the parent pid, the controlling tty. No environment dump, no
 * command line, nothing that could carry a secret.
 *
 * It is inert when the overlay is not running: no overlay, nobody to click, no
 * reason to leave files on disk. Its absence is not a failure either — the jump
 * resolver falls back to guessing, which is what it did before this existed.
 *
 * Installed into ~/.claude/settings.json by `npm run hooks` (remove with
 * `npm run unhook`). Hook configuration is read at session start, so an
 * already-open session keeps whatever it was launched with.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const tty = require('tty');

// STRAYS_HOME lets the tests drive a throwaway state directory
const BASE = process.env.STRAYS_HOME || path.join(os.homedir(), '.strays');
const ALIVE = path.join(BASE, 'overlay.alive');
const SESSIONS = path.join(BASE, 'sessions');

function overlayAlive() {
  try { return Date.now() - fs.statSync(ALIVE).mtimeMs < 15 * 1000; }
  catch { return false; }
}

/* the controlling terminal device, when there is one */
function controllingTty() {
  for (const fd of [2, 1, 0]) {
    try { if (tty.isatty(fd)) return fs.readlinkSync('/dev/fd/' + fd); } catch { /* not a tty */ }
  }
  return null;
}

/*
 * A session whose transcript is gone is a session that no longer exists, so
 * its record is dead weight. Records written before transcriptPath existed are
 * kept until they age out, since there is nothing better to test them against.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function prune(keep) {
  let entries = [];
  try { entries = fs.readdirSync(SESSIONS); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith('.json') || name === keep + '.json') continue;
    const file = path.join(SESSIONS, name);
    let dead = true;
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      dead = rec.transcriptPath
        ? !fs.existsSync(rec.transcriptPath)
        : !(Date.now() - (rec.recordedAt || 0) < MAX_AGE_MS);
    } catch { /* unreadable or half-written — it is of no use to anyone */ }
    if (dead) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let req;
  try { req = JSON.parse(input); } catch { return; }

  const id = req.session_id;
  if (!id || !/^[\w-]+$/.test(String(id))) return;
  if (!overlayAlive()) return;

  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS, id + '.json'), JSON.stringify({
    sessionId: String(id),
    termProgram: process.env.TERM_PROGRAM || null,
    bundleId: process.env.__CFBundleIdentifier || null,
    ppid: process.ppid,
    tty: controllingTty(),
    transcriptPath: req.transcript_path || null,
    recordedAt: Date.now(),
  }));

  prune(id);
}

main().then(() => process.exit(0), () => process.exit(0));

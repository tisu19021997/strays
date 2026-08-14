#!/usr/bin/env node
/*
 * Quit a running overlay.
 *
 * This used to be a one-line npm script — kill "$(cat …/overlay.alive)" — which
 * is a POSIX shell command and simply fails on Windows, where npm runs scripts
 * through cmd. Node can do the same job on every platform, so it does.
 *
 * The overlay writes its pid into ~/.strays/overlay.alive and refreshes the file
 * every few seconds; the approval gate reads the same file's mtime to decide
 * whether anyone is listening.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.STRAYS_HOME || path.join(os.homedir(), '.strays');
const ALIVE = path.join(HOME, 'overlay.alive');

/*
 * The overlay refreshes this file every five seconds, so a heartbeat older than
 * this means it is not running — however tidy the file looks. The pid inside a
 * stale file is worse than useless: the operating system will have handed that
 * number to something else by now, and killing it would stop a stranger's
 * process. The approval gate judges the overlay alive by the same window.
 */
const HEARTBEAT_STALE_MS = 15 * 1000;

let pid = null;
let beat = 0;
try {
  pid = parseInt(fs.readFileSync(ALIVE, 'utf8').trim(), 10);
  beat = fs.statSync(ALIVE).mtimeMs;
} catch {
  console.log('no overlay running');
  process.exit(0);
}

if (!Number.isInteger(pid) || pid <= 0) {
  console.log('no overlay running (' + ALIVE + ' holds no pid)');
  process.exit(0);
}

const age = Date.now() - beat;
if (age > HEARTBEAT_STALE_MS) {
  console.log('no overlay running (last heartbeat ' + Math.round(age / 1000) + 's ago)');
  try { fs.unlinkSync(ALIVE); } catch { /* already tidy */ }
  process.exit(0);
}

try {
  process.kill(pid);
  console.log('asked overlay ' + pid + ' to quit');
} catch (err) {
  // ESRCH means it died without cleaning up after itself; anything else is
  // worth saying out loud rather than reporting success
  if (err.code === 'ESRCH') console.log('overlay ' + pid + ' was already gone');
  else console.log('could not stop overlay ' + pid + ': ' + err.message);
  try { fs.unlinkSync(ALIVE); } catch { /* already tidy */ }
  process.exit(0);
}

/*
 * `--wait` holds until the process is really gone, so `restart` can start the
 * next one without racing the old one's shutdown. Electron takes a moment to
 * close its windows, and a new overlay launched inside that moment loses the
 * single-instance lock to the copy that is still quitting — and exits.
 */
if (process.argv.includes('--wait')) {
  const deadline = Date.now() + 10 * 1000;
  const gone = () => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  };
  const poll = () => {
    if (gone()) return;
    if (Date.now() > deadline) {
      console.log('overlay ' + pid + ' is taking its time; carrying on anyway');
      return;
    }
    setTimeout(poll, 150);
  };
  poll();
}

/*
 * Stopping the overlay.
 *
 * The pid lives in ~/.strays/overlay.alive, which the overlay rewrites every few
 * seconds. That file outlives a hard kill or a crash, and by then the operating
 * system has handed the number to something else — so the interesting case is
 * not "does it stop the overlay" but "what does it do when the file is lying".
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STOP = path.join(__dirname, '..', 'stop.js');

/* a throwaway ~/.strays holding an overlay.alive of our choosing */
function home(pid, ageMs = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strays-stop-'));
  const file = path.join(dir, 'overlay.alive');
  if (pid !== null) {
    fs.writeFileSync(file, String(pid));
    if (ageMs) {
      const then = new Date(Date.now() - ageMs);
      fs.utimesSync(file, then, then);
    }
  }
  return { dir, file };
}

const run = (dir, args = []) => spawnSync(process.execPath, [STOP, ...args], {
  env: { ...process.env, STRAYS_HOME: dir },
  encoding: 'utf8',
});

const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  // EPERM is a process that exists and will not take our signals, which is
  // still very much alive. Only ESRCH means gone.
  catch (err) { return err.code === 'EPERM'; }
};

/*
 * Block for a moment without spawning anything.
 *
 * This used to run `node -e 'setTimeout(…)'` in a loop as "a short, portable
 * pause", which is up to a hundred processes per wait — enough contention, with
 * the rest of the suite running in parallel, to make the *next* spawn fail with
 * EAGAIN and the test blame a perfectly good stop.js. Atomics.wait blocks the
 * main thread in Node, which is exactly what a synchronous test wants.
 */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* poll a predicate until it is truthy, or give up; never throws out of fn */
function waitFor(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { const v = fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() >= deadline) return null;
    sleep(25);
  }
}

/*
 * A process that is nobody's child, the way a running overlay is nobody's child
 * of `npm run stop`.
 *
 * It matters: a child this test spawned stays a zombie after it dies until this
 * process reaps it, and a zombie still answers kill(pid, 0). Testing against one
 * would report a process that had plainly exited as still running. Launching it
 * through a middleman that immediately exits orphans it, so the system reaps it
 * properly and its pid stops resolving the moment it dies.
 *
 * The stand-in announces itself by writing its own pid, and the pid it writes is
 * the one under test. Taking the pid from the middleman instead left a window
 * where a spawn that had failed — or simply not finished booting — was
 * indistinguishable from a process that had died, and the failure it produced
 * pointed at stop.js rather than at the harness.
 */
function spawnOrphan(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strays-orphan-'));
  const file = path.join(dir, 'pid');
  const standIn = 'require("fs").writeFileSync(process.argv[1], String(process.pid));'
                + 'setInterval(() => {}, 1000);';

  const out = spawnSync(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const c = spawn(process.execPath, ['-e', ${JSON.stringify(standIn)}, ${JSON.stringify(file)}],
      { detached: true, stdio: 'ignore' });
    c.unref();
  `], { encoding: 'utf8' });
  assert.equal(out.status, 0,
    'could not launch the stand-in: ' + (out.stderr || out.error || 'no reason given'));

  const pid = waitFor(() => {
    const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  assert.ok(pid, 'the stand-in never reported a pid, so it never started');
  assert.ok(alive(pid), 'the stand-in reported pid ' + pid + ' and then died');

  t.after(() => {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return pid;
}

const waitGone = (pid, ms = 5000) => Boolean(waitFor(() => !alive(pid), ms));

test('a stale heartbeat is never acted on, however alive the pid looks', () => {
  /*
   * The dangerous case. This test's own process is definitely running, so if
   * stop.js trusted the pid it would signal it. A heartbeat older than the
   * overlay's refresh interval means the overlay is gone and the number in the
   * file now belongs to somebody else — here, to the test runner.
   */
  const { dir, file } = home(process.pid, 60 * 1000);
  const out = run(dir);

  assert.match(out.stdout, /no overlay running/);
  assert.match(out.stdout, /heartbeat/, 'and it should say why it did nothing');
  assert.ok(alive(process.pid), 'it must not have signalled the pid it found');
  assert.ok(!fs.existsSync(file), 'a heartbeat that stale should be tidied away');
});

test('a fresh heartbeat stops the process it names', (t) => {
  const pid = spawnOrphan(t);
  const out = run(home(pid).dir);
  assert.match(out.stdout, new RegExp('asked overlay ' + pid));
  assert.ok(waitGone(pid), 'the overlay it named should have been stopped');
});

test('no file, or a file with nothing useful in it, is not an error', () => {
  // `npm run stop` runs on machines where the overlay has never been started,
  // and in `restart` ahead of the first launch
  const empty = home(null);
  const none = run(empty.dir);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /no overlay running/);

  const junk = home('not-a-pid');
  const out = run(junk.dir);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /no overlay running/);
});

test('--wait does not return until the process is really gone', (t) => {
  // restart launches the next overlay as soon as this exits, and a copy started
  // while the old one is still quitting loses the single-instance lock to it
  const pid = spawnOrphan(t);
  run(home(pid).dir, ['--wait']);
  assert.ok(!alive(pid), '--wait returned while the process was still up');
});

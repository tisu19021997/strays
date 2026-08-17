/*
 * Where a pet click should land.
 *
 * resolveJumpTarget is pure: a session, an index, a running-process set and
 * user config in, a described action out. Nothing here activates anything.
 */
const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { resolveJumpTarget, loadDesktopIndex, readSessionHost } = require('../sessions');
const { jsonFixture } = require('./helpers');

/* the desktop app's own store: <root>/<accountId>/<orgId>/<desktopId>.json */
function sessionStore(records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strays-store-'));
  const dir = path.join(root, 'account-1', 'org-1');
  fs.mkdirSync(dir, { recursive: true });
  for (const r of records) {
    const name = (typeof r === 'string' ? 'broken-' + Math.random() : r.sessionId) + '.json';
    fs.writeFileSync(path.join(dir, name), typeof r === 'string' ? r : JSON.stringify(r));
  }
  return { root, dir };
}

/* the desktop app's records, keyed the way the resolver expects */
const indexFromFixture = () =>
  Object.fromEntries(jsonFixture('desktop-sessions.json').map((r) => [r.cliSessionId, r]));

/* the fixture record whose desktop id is NOT derivable from the CLI id */
const UNDERIVABLE = {
  cli: '5e2955b9-58ee-ed30-3d38-6ee0b37efe64',
  desktop: 'local_f9e12694-b57e-c05d-c08e-52b311883313',
};

const resolve = (over = {}) => resolveJumpTarget({
  session: { id: UNDERIVABLE.cli, entrypoint: 'claude-desktop' },
  desktopIndex: indexFromFixture(),
  running: ['Claude', 'Ghostty'],
  config: {},
  platform: 'darwin',
  ...over,
});

test('a desktop session in the index resolves to a link addressed to its own desktop id', () => {
  assert.deepEqual(resolve(), {
    kind: 'open-url',
    url: 'claude://claude.ai/epitaxy/' + UNDERIVABLE.desktop,
  });
});

test('an index hit never produces a resume-style link', () => {
  // The duplicate-conversation bug. claude://resume imports a CLI session and
  // derives the desktop id as "local_" + cliSessionId; on the real machine that
  // guess is right for 5 records out of 670. For the rest it would create a
  // second conversation instead of focusing the one the user pointed at — so
  // every record in the index, derivable or not, must take the epitaxy route.
  const desktopIndex = indexFromFixture();
  for (const record of Object.values(desktopIndex)) {
    const action = resolve({ session: { id: record.cliSessionId, entrypoint: 'claude-desktop' } });
    assert.equal(action.kind, 'open-url');
    assert.ok(
      !/resume/.test(action.url),
      `${record.cliSessionId} took the resume route and would duplicate the conversation`,
    );
    assert.ok(
      action.url.endsWith(record.sessionId),
      `${record.cliSessionId} must be addressed by the record's own desktop id`,
    );
  }
});

test('a desktop session with no index entry falls back to the resume link', () => {
  const action = resolve({
    session: { id: 'c0ffee00-0000-0000-0000-000000000000', entrypoint: 'claude-desktop' },
  });
  assert.deepEqual(action, {
    kind: 'open-url',
    url: 'claude://resume?session=c0ffee00-0000-0000-0000-000000000000',
  });
});

test('a destination pinned in config wins over the index', () => {
  // the session below would otherwise resolve to a deep link
  assert.deepEqual(resolve({ config: { jumpApp: 'iTerm2' } }), { kind: 'activate', app: 'iTerm2' });
});

// ------------------------------------------------------- keeping the layout
/*
 * The deep link navigates: it replaces whatever the window is showing with the
 * one conversation, collapsing a multi-pane layout into a single session. That
 * is right when the session is somewhere else and destructive when it was
 * already in front of you. `lastFocusedAt` is the only thing in a record that
 * speaks to it — which panes are open is not readable at all.
 */
const focused = (over = {}, msAgo = 30 * 1000) => {
  const index = indexFromFixture();
  const record = index[UNDERIVABLE.cli];
  index[UNDERIVABLE.cli] = { ...record, lastFocusedAt: Date.now() - msAgo, ...over };
  return index;
};

test('a session focused moments ago is brought forward, not navigated to', () => {
  const action = resolve({ desktopIndex: focused() });
  assert.equal(action.kind, 'activate', 'navigating would collapse the panes it is sitting in');
  assert.equal(action.app, 'Claude');
});

test('a session nobody has looked at in a while is navigated to', () => {
  const action = resolve({ desktopIndex: focused({}, 60 * 60 * 1000) });
  assert.equal(action.kind, 'open-url', 'it is not on screen, so there is a layout to change');
  assert.ok(action.url.endsWith(UNDERIVABLE.desktop));
});

test('an archived conversation is navigated to however recently it was focused', () => {
  const action = resolve({ desktopIndex: focused({ isArchived: true }) });
  assert.equal(action.kind, 'open-url', 'an archived conversation cannot be the one on screen');
});

test('a record with no focus timestamp is navigated to, as it always was', () => {
  // every record written before the app tracked focus, and the fixture's own
  assert.equal(resolve().kind, 'open-url');
  assert.equal(resolve({ desktopIndex: focused({ lastFocusedAt: 0 }) }).kind, 'open-url');
});

test('jumpMode never navigates, and always navigates', () => {
  // for people who live in a multi-pane layout, and for anyone who wants the
  // behaviour from before the layout was worth protecting
  const stale = focused({}, 60 * 60 * 1000);
  assert.equal(resolve({ desktopIndex: stale, config: { jumpMode: 'never' } }).kind, 'activate',
    'never must hold the layout even for a session that is certainly not on screen');

  assert.equal(resolve({ desktopIndex: focused(), config: { jumpMode: 'always' } }).kind, 'open-url',
    'always must navigate even to the session already in front of you');
});

test('the layout window is measured against an injected clock, not the wall', () => {
  // otherwise this whole behaviour is untestable without waiting ten minutes
  const at = 1_700_000_000_000;
  const index = focused({ lastFocusedAt: at });
  assert.equal(resolve({ desktopIndex: index, now: at + 1000 }).kind, 'activate');
  assert.equal(resolve({ desktopIndex: index, now: at + 60 * 60 * 1000 }).kind, 'open-url');
});

test('a platform with no way to reach the destination resolves to nothing to do', () => {
  for (const platform of ['win32', 'linux']) {
    const action = resolve({ platform, config: { jumpApp: 'iTerm2' } });
    assert.equal(action.kind, 'none', `${platform} must not claim a destination`);
    assert.match(action.reason, /macOS/);
  }
});

test('a session of unknown host degrades to the old activate-an-application guess', () => {
  const unknown = { session: { id: 'c0ffee00-0000-0000-0000-000000000000' } };

  // the old behaviour, unchanged: the first running app from the known list...
  assert.deepEqual(
    resolve({ ...unknown, running: ['zsh', 'ghostty', 'Terminal'] }),
    { kind: 'activate', app: 'Ghostty' },
    'ps reports lowercase process names and they must still match',
  );
  assert.deepEqual(
    resolve({ ...unknown, running: ['Claude', 'Ghostty'] }),
    { kind: 'activate', app: 'Claude' },
  );
  // ...and Terminal when nothing on the list is running
  assert.deepEqual(resolve({ ...unknown, running: [] }), { kind: 'activate', app: 'Terminal' });
  // a click with no session at all must still land somewhere
  assert.deepEqual(resolve({ session: null, running: ['Warp'] }), { kind: 'activate', app: 'Warp' });
});

test('the index is read from the desktop app per-session records, keyed by CLI session id', () => {
  const { root } = sessionStore(jsonFixture('desktop-sessions.json'));
  const index = loadDesktopIndex(root);
  assert.equal(Object.keys(index).length, 7);
  assert.equal(index[UNDERIVABLE.cli].sessionId, UNDERIVABLE.desktop);
});

test('a malformed, unreadable or absent store degrades to an empty index', () => {
  const missing = path.join(os.tmpdir(), 'strays-store-that-is-not-there-' + Date.now());
  assert.deepEqual(loadDesktopIndex(missing), {});

  const good = jsonFixture('desktop-sessions.json')[0];
  const { root } = sessionStore([good, '{ "sessionId": "local_x", trunca', '[]', 'null']);
  const index = loadDesktopIndex(root);
  assert.deepEqual(Object.keys(index), [good.cliSessionId], 'good records survive bad neighbours');
});

test('the index is cached against the store mtime and refreshed when it changes', () => {
  const first = jsonFixture('desktop-sessions.json')[0];
  const { root, dir } = sessionStore([first]);
  assert.equal(Object.keys(loadDesktopIndex(root)).length, 1);

  // rewriting a record in place leaves the directory mtime alone: still cached
  fs.writeFileSync(
    path.join(dir, first.sessionId + '.json'),
    JSON.stringify({ ...first, cliSessionId: 'rewritten-in-place' }),
  );
  assert.ok(!loadDesktopIndex(root)['rewritten-in-place'], 'a cached read should not re-parse');

  // adding a record does move the directory mtime, so the index must catch up
  const second = jsonFixture('desktop-sessions.json')[1];
  fs.writeFileSync(path.join(dir, second.sessionId + '.json'), JSON.stringify(second));
  const refreshed = loadDesktopIndex(root);
  assert.ok(refreshed[second.cliSessionId], 'a new record must appear');
  assert.ok(refreshed['rewritten-in-place'], 'and the refresh must re-read everything');
});

const CLI = { id: 'c0ffee00-0000-0000-0000-000000000000', entrypoint: 'cli' };

test('a command-line session returns to the terminal that launched it', () => {
  for (const [host, app] of [
    [{ bundleId: 'com.googlecode.iterm2', termProgram: 'iTerm.app' }, 'iTerm2'],
    // The two signals disagree when TERM_PROGRAM is inherited rather than set
    // by the terminal in front of you — a tmux server first started under
    // Terminal.app, or a dotfile that exports it. The launching application
    // wins, and this is the only row where that choice is observable.
    [{ bundleId: 'com.mitchellh.ghostty', termProgram: 'Apple_Terminal' }, 'Ghostty'],
    [{ bundleId: 'com.mitchellh.ghostty' }, 'Ghostty'],
    [{ termProgram: 'Apple_Terminal' }, 'Terminal'],
    [{ termProgram: 'WarpTerminal' }, 'Warp'],
  ]) {
    assert.deepEqual(
      resolve({ session: CLI, host, running: ['Claude', 'Ghostty', 'iTerm2'] }),
      { kind: 'activate', app },
      JSON.stringify(host),
    );
  }
});

test('a command-line session with no recorded host takes the first running terminal', () => {
  // never the desktop app: this session demonstrably does not live there
  assert.deepEqual(
    resolve({ session: CLI, running: ['Claude', 'Ghostty'] }),
    { kind: 'activate', app: 'Ghostty' },
  );
  // an unrecognised terminal in the record is no better than no record at all
  assert.deepEqual(
    resolve({ session: CLI, host: { termProgram: 'tmux' }, running: ['Claude', 'Warp'] }),
    { kind: 'activate', app: 'Warp' },
  );
});

// ---------------------------------------------------- the SessionStart recorder
const RECORDER = path.join(__dirname, '..', 'hooks', 'session-start.js');

/* a throwaway ~/.strays, with or without a live overlay heartbeat */
function petsHome({ alive = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strays-home-'));
  if (alive) fs.writeFileSync(path.join(home, 'overlay.alive'), String(Date.now()));
  return home;
}

function runRecorder(home, payload, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath, [RECORDER],
      { env: { ...process.env, STRAYS_HOME: home, ...env } },
      () => resolve(),
    );
    child.stdin.end(JSON.stringify(payload));
  });
}

const record = (home, id) => {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'sessions', id + '.json'), 'utf8')); }
  catch { return null; }
};

test('the recorder writes the host that launched a session, and nothing else', async () => {
  const home = petsHome();
  const id = '11111111-2222-3333-4444-555555555555';
  await runRecorder(
    home,
    { session_id: id, transcript_path: __filename, cwd: '/Users/testuser/Projects/demo' },
    { TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: 'com.mitchellh.ghostty' },
  );

  const host = record(home, id);
  assert.ok(host, 'the recorder should have written a record');
  assert.equal(host.termProgram, 'ghostty');
  assert.equal(host.bundleId, 'com.mitchellh.ghostty');
  assert.equal(typeof host.ppid, 'number');
  assert.deepEqual(
    Object.keys(host).sort(),
    ['bundleId', 'ppid', 'recordedAt', 'sessionId', 'termProgram', 'transcriptPath', 'tty'],
    'the record is an allowlist: no environment dump, no command line, no secrets',
  );
});

test('the recorder is inert when the overlay is not running', async () => {
  const home = petsHome({ alive: false });
  const id = '22222222-2222-2222-2222-222222222222';
  await runRecorder(home, { session_id: id, transcript_path: __filename });
  assert.equal(record(home, id), null, 'no overlay means nobody to click, so no record');
  assert.equal(fs.existsSync(path.join(home, 'sessions')), false, 'and no directory either');
});

test('records for sessions that no longer exist are pruned', async () => {
  const home = petsHome();
  fs.mkdirSync(path.join(home, 'sessions'));
  const stale = path.join(home, 'sessions', 'gone.json');
  const live = path.join(home, 'sessions', 'still-here.json');
  fs.writeFileSync(stale, JSON.stringify({
    sessionId: 'gone', transcriptPath: path.join(home, 'no-such-transcript.jsonl'),
  }));
  fs.writeFileSync(live, JSON.stringify({ sessionId: 'still-here', transcriptPath: __filename }));

  await runRecorder(home, { session_id: 'fresh', transcript_path: __filename });

  assert.equal(fs.existsSync(stale), false, 'a record whose transcript is gone must go too');
  assert.equal(fs.existsSync(live), true, 'a record whose session still exists must stay');
  assert.ok(record(home, 'fresh'), 'and the session being recorded is untouched');
});

test('a recorded host is read back for the resolver, and its absence is not an error', async () => {
  const home = petsHome();
  const id = '33333333-3333-3333-3333-333333333333';
  await runRecorder(home, { session_id: id, transcript_path: __filename },
    { TERM_PROGRAM: 'iTerm.app', __CFBundleIdentifier: 'com.googlecode.iterm2' });

  const host = readSessionHost(id, home);
  assert.deepEqual(
    resolve({ session: { id, entrypoint: 'cli' }, host, running: ['Claude'] }),
    { kind: 'activate', app: 'iTerm2' },
  );
  assert.equal(readSessionHost('never-recorded', home), null);
  assert.equal(readSessionHost('../escape', home), null, 'a session id is not a path');
});

test('a session id that describes a path is refused even when the target is there', () => {
  // The guard used to be covered by a null that came from a missing file
  // rather than from the guard, so reducing the guard to nothing survived.
  // Put a perfectly readable record exactly where the traversal would land.
  const home = petsHome();
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'escape.json'),
    JSON.stringify({ termProgram: 'Apple_Terminal', bundleId: 'com.apple.Terminal' }),
  );
  assert.equal(fs.existsSync(path.join(home, 'escape.json')), true, 'the bait must exist');

  assert.equal(readSessionHost('../escape', home), null, 'a session id is not a path');
  assert.equal(readSessionHost('..%2Fescape', home), null, 'nor an encoded one');
  assert.equal(readSessionHost('sessions/../../escape', home), null, 'nor a nested one');

  // and the refusal is the guard, not a broken reader: a real id still reads
  fs.writeFileSync(
    path.join(home, 'sessions', 'plain-id.json'),
    JSON.stringify({ termProgram: 'ghostty' }),
  );
  assert.deepEqual(readSessionHost('plain-id', home), { termProgram: 'ghostty' });
});

test('the recorder refuses a session id that describes a path', async () => {
  // The reader only leaks; this one WRITES, so a hole here creates a file at a
  // path the payload chose. Same coverage hole, so the same fix: leave
  // something at the traversal target and prove it survives untouched.
  const home = petsHome();
  const target = path.join(home, 'escape.json');
  fs.writeFileSync(target, 'not written by the recorder');

  await runRecorder(
    home,
    { session_id: '../escape', transcript_path: __filename },
    { TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: 'com.mitchellh.ghostty' },
  );

  assert.equal(fs.readFileSync(target, 'utf8'), 'not written by the recorder',
    'the recorder must not write outside its own sessions directory');
  assert.equal(fs.existsSync(path.join(home, 'sessions')), false,
    'a refused id must not even cause the directory to be created');
});

test('a record added while the directory mtime stands still is still noticed', () => {
  /*
   * The cache is keyed on the store's directory stamp, and a directory's mtime
   * is supposed to move when an entry is added. Windows does not reliably do so
   * straight away, so a session record written moments after the last read
   * stayed behind a stale cache — and a click on that session fell back to the
   * resume link, opening a duplicate conversation instead of the one already
   * there, which is the whole reason this index is consulted first.
   *
   * The mtime is pinned back by hand here. That is the same condition, and it
   * reproduces on every platform rather than only where it bit.
   */
  const [first, second] = jsonFixture('desktop-sessions.json');
  const { root, dir } = sessionStore([first]);

  /*
   * Pinned to one fixed instant on both sides of the write, rather than read
   * and restored: a stat gives sub-millisecond precision that utimes cannot put
   * back, so "restoring" the old mtime quietly changes it and the cache is
   * invalidated for the very reason the test means to rule out.
   */
  const standstill = new Date(1_700_000_000_000);
  fs.utimesSync(dir, standstill, standstill);
  assert.equal(Object.keys(loadDesktopIndex(root)).length, 1);
  const pinned = fs.statSync(dir).mtimeMs;

  fs.writeFileSync(path.join(dir, second.sessionId + '.json'), JSON.stringify(second));
  fs.utimesSync(dir, standstill, standstill);
  assert.equal(fs.statSync(dir).mtimeMs, pinned,
    'the mtime really must be unchanged, or this test proves nothing');

  assert.ok(loadDesktopIndex(root)[second.cliSessionId],
    'a new record must appear even when the mtime says nothing happened');
});

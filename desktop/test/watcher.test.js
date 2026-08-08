/*
 * The watcher at the seam that matters: the session objects it emits.
 *
 * The transcripts are real-shaped fixtures copied into a throwaway projects
 * directory, because the tail scan's behaviour depends on file mtime and on
 * which line each field happens to sit on — neither of which survives being
 * mocked out.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ClaudeWatcher } = require('../watcher');
const { readFixture } = require('./helpers');

/* a ~/.claude/projects lookalike holding the given <name>.jsonl contents */
function projects(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strays-projects-'));
  const dir = path.join(root, '-Users-testuser-Projects-demo');
  fs.mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return root;
}

/* one poll, no timers: the emitted status */
function pollOnce(projectsDir) {
  let status = null;
  const w = new ClaudeWatcher((s) => { status = s; }, null, { projectsDir });
  w.poll();
  return status;
}

const DESKTOP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LEGACY_ID = 'ffffffff-0000-1111-2222-333333333333';

test('the watcher scans the projects directory it is given', () => {
  const root = projects({
    [DESKTOP_ID + '.jsonl']: readFixture('transcript-desktop.jsonl'),
  });
  const status = pollOnce(root);
  assert.deepEqual(status.sessions.map((s) => s.id), [DESKTOP_ID]);
});

test('an emitted session carries the host entrypoint and permission mode', () => {
  const root = projects({
    [DESKTOP_ID + '.jsonl']: readFixture('transcript-desktop.jsonl'),
  });
  const [session] = pollOnce(root).sessions;
  assert.equal(session.entrypoint, 'claude-desktop');
  assert.equal(session.permissionMode, 'auto');
});

test('a transcript that records neither field still emits, with the field absent', () => {
  // the legacy fixture carries entrypoint on the assistant line only and has
  // no permissionMode anywhere; an older release is not a parse failure
  const root = projects({
    [LEGACY_ID + '.jsonl']: readFixture('transcript-cli-legacy.jsonl'),
  });
  const [session] = pollOnce(root).sessions;
  assert.equal(session.id, LEGACY_ID);
  assert.equal(session.cwd, '/Users/testuser/Projects/legacy');
  assert.equal(session.entrypoint, 'cli');
  assert.ok(!('permissionMode' in session), 'an unrecorded mode must be absent, not null');
});

test('the host fields are found even when they sit above the line that ends the transcript', () => {
  const id = '99999999-8888-7777-6666-555555555555';
  const root = projects({
    [id + '.jsonl']: [
      JSON.stringify({
        type: 'user', cwd: '/Users/testuser/Projects/deep',
        entrypoint: 'claude-desktop', permissionMode: 'acceptEdits',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant', cwd: '/Users/testuser/Projects/deep',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      }),
      JSON.stringify({ type: 'summary', summary: 'a chat', leafUuid: 'x' }),
    ].join('\n') + '\n',
  });
  const [session] = pollOnce(root).sessions;
  assert.equal(session.entrypoint, 'claude-desktop');
  assert.equal(session.permissionMode, 'acceptEdits');
});

test('the existing session fields and the rollup state are unchanged', () => {
  const root = projects({
    [DESKTOP_ID + '.jsonl']: readFixture('transcript-desktop.jsonl'),
    [LEGACY_ID + '.jsonl']: readFixture('transcript-cli-legacy.jsonl'),
  });
  const status = pollOnce(root);
  const byId = Object.fromEntries(status.sessions.map((s) => [s.id, s]));

  assert.equal(status.state, 'working');
  // the desktop transcript ends on a tool_use, the legacy one on plain text
  assert.equal(byId[DESKTOP_ID].state, 'tool');
  assert.equal(byId[DESKTOP_ID].cwd, '/Users/testuser/Projects/demo');
  assert.equal(byId[LEGACY_ID].state, 'thinking');
});

test('host identity costs no extra file reads', () => {
  // the whole point of piggybacking on the tail scan: one open per transcript,
  // on a poll that happens every couple of seconds
  const root = projects({
    [DESKTOP_ID + '.jsonl']: readFixture('transcript-desktop.jsonl'),
    [LEGACY_ID + '.jsonl']: readFixture('transcript-cli-legacy.jsonl'),
  });
  const fs_ = require('node:fs');
  const real = { openSync: fs_.openSync, readFileSync: fs_.readFileSync };
  let opens = 0;
  let wholeFileReads = 0;
  fs_.openSync = (...a) => { opens++; return real.openSync(...a); };
  fs_.readFileSync = (...a) => { wholeFileReads++; return real.readFileSync(...a); };
  try {
    pollOnce(root);
  } finally {
    Object.assign(fs_, real);
  }
  assert.equal(opens, 2, 'one tail read per transcript and no more');
  assert.equal(wholeFileReads, 0, 'a transcript must never be slurped whole');
});

test('an unchanged status is not re-announced, but the watcher can be forced to', () => {
  // C1. Turning "Follow Claude Code sessions" off sends the renderer an empty
  // session list, which unbinds every pet. Turning it back on must re-announce
  // the sessions or the pets stay unbound — unclickable, and with nowhere to
  // anchor an approval card. Emissions are deduplicated, and a session parked
  // in `waiting` (exactly the one a user reaches for) emits the identical
  // status indefinitely, so without a way to force it this never recovers.
  const root = projects({
    [DESKTOP_ID + '.jsonl']: readFixture('transcript-desktop.jsonl'),
  });
  const seen = [];
  const w = new ClaudeWatcher((s) => seen.push(s), null, { projectsDir: root });

  w.poll();
  w.poll();
  assert.equal(seen.length, 1, 'an unchanged status must not be re-sent');

  w.forceNextEmit();
  w.poll();
  assert.equal(seen.length, 2, 'a forced emission must go out even though nothing changed');
  assert.deepEqual(seen[1].sessions.map((s) => s.id), [DESKTOP_ID],
    'and it must carry the sessions, not the empty list the renderer already has');

  w.poll();
  assert.equal(seen.length, 2, 'the force covers the next emission only');
});

/* the transcript the projects() helper wrote, so a test can age it */
const transcript = (root, name) =>
  path.join(root, '-Users-testuser-Projects-demo', name);

const ageTo = (file, ms) => {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(file, t, t);
};

test('a transcript nobody has touched for a quarter of an hour is not a live session', () => {
  // without the staleness filter every transcript ever written comes back as a
  // `waiting` session, and the lane fills with pets for work that ended weeks ago
  const root = projects({
    [DESKTOP_ID + '.jsonl']: readFixture('transcript-desktop.jsonl'),
  });
  ageTo(transcript(root, DESKTOP_ID + '.jsonl'), 20 * 60 * 1000);

  const status = pollOnce(root);
  assert.deepEqual(status.sessions, [], 'a session abandoned 20 minutes ago has no pet');
  assert.equal(status.state, null, 'and nothing to roll up either');
});

test('only the eight most recently active sessions get a pet', () => {
  // the cap decides who has a pet at all, and a session with no pet has nowhere
  // to anchor its approval card
  const files = {};
  for (let i = 0; i < 10; i++) files['s' + i + '.jsonl'] = readFixture('transcript-desktop.jsonl');
  const root = projects(files);
  for (let i = 0; i < 10; i++) ageTo(transcript(root, 's' + i + '.jsonl'), (i + 1) * 60 * 1000);

  const ids = pollOnce(root).sessions.map((s) => s.id);
  assert.equal(ids.length, 8, 'a ninth session must not push the lane wider');
  assert.deepEqual(ids, ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'],
    'and the ones kept are the most recently active, newest first');
});

/* backdate a transcript so the watcher sees it as that old */
function age(root, name, ms) {
  const file = path.join(root, '-Users-testuser-Projects-demo', name);
  const then = new Date(Date.now() - ms);
  fs.utimesSync(file, then, then);
}

/* a transcript stalled mid-turn: the user spoke last and no reply has landed */
const MID_TURN = JSON.stringify({
  type: 'user', sessionId: DESKTOP_ID, cwd: '/Users/testuser/Projects/demo',
  entrypoint: 'claude-desktop', permissionMode: 'auto',
  message: { role: 'user', content: 'run the whole suite' },
}) + '\n';

test('a session stalled mid-turn keeps its pet while the tool call runs', () => {
  // A long tool call writes nothing for minutes: the transcript goes quiet with
  // no trailing assistant message. Dropping the session takes away its pet, and
  // with it the sticky binding a click and an approval card both depend on.
  const root = projects({ [DESKTOP_ID + '.jsonl']: MID_TURN });
  age(root, DESKTOP_ID + '.jsonl', 20 * 1000);

  const [session] = pollOnce(root).sessions;
  assert.ok(session, 'a session mid-tool-call must still be on screen');
  assert.equal(session.state, 'thinking');
});

test('a session abandoned mid-turn eventually lets its pet go', () => {
  const root = projects({ [DESKTOP_ID + '.jsonl']: MID_TURN });
  age(root, DESKTOP_ID + '.jsonl', 5 * 60 * 1000);

  assert.deepEqual(pollOnce(root).sessions, [],
    'a turn nobody has advanced in five minutes is not a live session');
});

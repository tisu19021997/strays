/*
 * The watcher at the seam that matters: the session objects it emits.
 *
 * The transcripts are real-shaped fixtures copied into a throwaway projects
 * directory, because the tail scan's behaviour depends on which line each field
 * happens to sit on — which does not survive being mocked out.
 *
 * How old a session is comes from the timestamps inside its transcript, so a
 * test ages one with ageTranscript(). Touching mtime instead exercises only the
 * fallback for transcripts that carry no timestamps at all.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ClaudeWatcher } = require('../watcher');
const { readFixture, ageTranscript } = require('./helpers');

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

/* the fixtures, live: their newest entry a couple of seconds old */
const live = (name, msAgo = 2000) => ageTranscript(readFixture(name), msAgo);
const desktop = (msAgo) => live('transcript-desktop.jsonl', msAgo);
const legacy = (msAgo) => live('transcript-cli-legacy.jsonl', msAgo);

test('the watcher scans the projects directory it is given', () => {
  const root = projects({ [DESKTOP_ID + '.jsonl']: desktop() });
  const status = pollOnce(root);
  assert.deepEqual(status.sessions.map((s) => s.id), [DESKTOP_ID]);
});

test('an emitted session carries the host entrypoint and permission mode', () => {
  const root = projects({ [DESKTOP_ID + '.jsonl']: desktop() });
  const [session] = pollOnce(root).sessions;
  assert.equal(session.entrypoint, 'claude-desktop');
  assert.equal(session.permissionMode, 'auto');
});

test('a transcript that records neither field still emits, with the field absent', () => {
  // the legacy fixture carries entrypoint on the assistant line only and has
  // no permissionMode anywhere; an older release is not a parse failure
  const root = projects({ [LEGACY_ID + '.jsonl']: legacy() });
  const [session] = pollOnce(root).sessions;
  assert.equal(session.id, LEGACY_ID);
  assert.equal(session.cwd, '/Users/testuser/Projects/legacy');
  assert.equal(session.entrypoint, 'cli');
  assert.ok(!('permissionMode' in session), 'an unrecorded mode must be absent, not null');
});

test('the host fields are found even when they sit above the line that ends the transcript', () => {
  const id = '99999999-8888-7777-6666-555555555555';
  const now = new Date().toISOString();
  const root = projects({
    [id + '.jsonl']: [
      JSON.stringify({
        type: 'user', cwd: '/Users/testuser/Projects/deep', timestamp: now,
        entrypoint: 'claude-desktop', permissionMode: 'acceptEdits',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant', cwd: '/Users/testuser/Projects/deep', timestamp: now,
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
    [DESKTOP_ID + '.jsonl']: desktop(),
    [LEGACY_ID + '.jsonl']: legacy(),
  });
  const status = pollOnce(root);
  const byId = Object.fromEntries(status.sessions.map((s) => [s.id, s]));

  assert.equal(status.state, 'working');
  // the desktop transcript ends on a tool_use, the legacy one on plain text
  assert.equal(byId[DESKTOP_ID].state, 'tool');
  assert.equal(byId[DESKTOP_ID].cwd, '/Users/testuser/Projects/demo');
  assert.equal(byId[LEGACY_ID].state, 'thinking');
});

test('a transcript is read once and not again until it changes', () => {
  // Deciding which eight sessions get a pet needs every candidate's real
  // activity time, which means reading every candidate's tail. On a machine with
  // a few hundred live-looking transcripts that is only affordable because an
  // unchanged file is never re-read — and it polls every two seconds.
  const root = projects({
    [DESKTOP_ID + '.jsonl']: desktop(),
    [LEGACY_ID + '.jsonl']: legacy(),
  });
  const fs_ = require('node:fs');
  const real = { openSync: fs_.openSync, readFileSync: fs_.readFileSync };
  let opens = 0;
  let wholeFileReads = 0;
  fs_.openSync = (...a) => { opens++; return real.openSync(...a); };
  fs_.readFileSync = (...a) => { wholeFileReads++; return real.readFileSync(...a); };
  try {
    const w = new ClaudeWatcher(() => {}, null, { projectsDir: root });
    w.poll();
    assert.equal(opens, 2, 'one tail read per transcript and no more');
    w.poll();
    w.poll();
    assert.equal(opens, 2, 'an unchanged transcript must not be read again');

    fs.appendFileSync(
      path.join(root, '-Users-testuser-Projects-demo', LEGACY_ID + '.jsonl'),
      JSON.stringify({
        type: 'assistant', timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'more' }] },
      }) + '\n',
    );
    w.poll();
    assert.equal(opens, 3, 'a transcript that grew must be re-read, and only that one');
  } finally {
    Object.assign(fs_, real);
  }
  assert.equal(wholeFileReads, 0, 'a transcript must never be slurped whole');
});

test('an unchanged status is not re-announced, but the watcher can be forced to', () => {
  // C1. Turning "Follow Claude Code sessions" off sends the renderer an empty
  // session list, which unbinds every pet. Turning it back on must re-announce
  // the sessions or the pets stay unbound — unclickable, and with nowhere to
  // anchor an approval card. Emissions are deduplicated, and a session parked
  // in `waiting` (exactly the one a user reaches for) emits the identical
  // status indefinitely, so without a way to force it this never recovers.
  const root = projects({ [DESKTOP_ID + '.jsonl']: desktop(30 * 1000) });
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

test('a conversation that ended long ago is not a live session', () => {
  // without this every transcript ever written comes back as a session, and the
  // lane fills with pets for work that ended weeks ago
  const root = projects({ [DESKTOP_ID + '.jsonl']: desktop(2 * 60 * 60 * 1000) });

  const status = pollOnce(root);
  assert.deepEqual(status.sessions, [], 'a session abandoned two hours ago has no pet');
  assert.equal(status.state, null, 'and nothing to roll up either');
});

test('a quiet session keeps its pet after it stops being worth a nudge', () => {
  /*
   * Two questions, not one. `waiting` is the nudge — it makes the pet hop and
   * wear a ❗ — so it has to expire or it cries wolf. But dropping the session
   * when the nudge expires takes the pet away from the conversation you are
   * sitting there reading, and its name with it. Both of those shipped.
   */
  const fresh = projects({ [DESKTOP_ID + '.jsonl']: desktop(60 * 1000) });
  assert.equal(pollOnce(fresh).sessions[0].state, 'waiting',
    'a minute-old question is still worth answering');

  const quiet = projects({ [DESKTOP_ID + '.jsonl']: desktop(9 * 60 * 1000) });
  const [session] = pollOnce(quiet).sessions;
  assert.equal(session.state, 'resting',
    'nine minutes on it should still be your session, just not a nagging one');
  assert.equal(session.title, undefined);
  assert.equal(session.cwd, '/Users/testuser/Projects/demo',
    'and it must still carry what the pet needs to name itself');

  const stale = projects({ [DESKTOP_ID + '.jsonl']: desktop(45 * 60 * 1000) });
  assert.deepEqual(pollOnce(stale).sessions, [],
    'three quarters of an hour later it is finished work, not a session');
});

test('a resting session does not raise the needs-you rollup', () => {
  // needs-you drives the tray's ❗ and the hop. A session nobody is being asked
  // about must not set it, or the nudge means nothing.
  const root = projects({ [DESKTOP_ID + '.jsonl']: desktop(9 * 60 * 1000) });
  const status = pollOnce(root);
  assert.equal(status.sessions[0].state, 'resting');
  assert.equal(status.state, 'idle', 'resting is not needs-you');

  const nudging = projects({ [DESKTOP_ID + '.jsonl']: desktop(60 * 1000) });
  assert.equal(pollOnce(nudging).state, 'needs-you', 'a real question still is');
});

test('bookkeeping writes do not make a dead conversation look live', () => {
  /*
   * The bug this exists for. Claude Code appends `last-prompt`, `ai-title`,
   * `custom-title` and `mode` records to a transcript long after the
   * conversation ended, and none of them carry a timestamp. Judging age by the
   * file's mtime therefore resurrected sessions whose last real message was
   * days old — on the machine this was found on, eight days old — and they took
   * pet slots away from the sessions actually running.
   */
  const body = ageTranscript(readFixture('transcript-desktop.jsonl'), 8 * 24 * 60 * 60 * 1000)
    + JSON.stringify({ type: 'ai-title', aiTitle: 'Old work', sessionId: DESKTOP_ID }) + '\n'
    + JSON.stringify({ type: 'last-prompt', leafUuid: 'x', sessionId: DESKTOP_ID }) + '\n';
  const root = projects({ [DESKTOP_ID + '.jsonl']: body });

  // exactly the state the bug presented in: freshly written file, ancient content
  const file = path.join(root, '-Users-testuser-Projects-demo', DESKTOP_ID + '.jsonl');
  const now = new Date();
  fs.utimesSync(file, now, now);

  assert.deepEqual(pollOnce(root).sessions, [],
    'a transcript touched now but last spoken in eight days ago has no pet');
});

test('a bookkeeping line is not activity even if it starts carrying a timestamp', () => {
  /*
   * Today `last-prompt` and the title records carry no timestamp, so ignoring
   * their *type* is belt and braces over ignoring their missing timestamp. It is
   * the belt that matters: the day a release stamps the record it writes when a
   * conversation is named, judging age by "the newest timestamp in the file"
   * silently resurrects every conversation the app has ever titled. That is this
   * bug a second time, and it would look like a regression with no cause.
   */
  const body = ageTranscript(readFixture('transcript-desktop.jsonl'), 3 * 60 * 60 * 1000)
    + JSON.stringify({
      type: 'last-prompt', leafUuid: 'x', sessionId: DESKTOP_ID,
      timestamp: new Date().toISOString(),
    }) + '\n';
  const root = projects({ [DESKTOP_ID + '.jsonl']: body });

  assert.deepEqual(pollOnce(root).sessions, [],
    'the conversation last moved three hours ago, whatever the bookkeeping says');
});

test('the sessions kept are the ones most recently active, not most recently written', () => {
  const files = {};
  for (let i = 0; i < 10; i++) files['s' + i + '.jsonl'] = desktop((i + 1) * 20 * 1000);
  const root = projects(files);
  // touch them in the opposite order, so mtime and real activity disagree
  for (let i = 9; i >= 0; i--) {
    const t = new Date(Date.now() - i * 1000);
    fs.utimesSync(path.join(root, '-Users-testuser-Projects-demo', 's' + i + '.jsonl'), t, t);
  }

  const ids = pollOnce(root).sessions.map((s) => s.id);
  assert.equal(ids.length, 8, 'a ninth session must not push the lane wider');
  assert.deepEqual(ids, ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'],
    'and the ones kept are the most recently active, newest first');
});

/* a transcript stalled mid-turn: the user spoke last and no reply has landed */
const MID_TURN = JSON.stringify({
  type: 'user', sessionId: DESKTOP_ID, cwd: '/Users/testuser/Projects/demo',
  entrypoint: 'claude-desktop', permissionMode: 'auto',
  message: { role: 'user', content: 'run the whole suite' },
}) + '\n';

/* backdate a transcript's mtime, the only age a timestampless transcript has */
function age(root, name, ms) {
  const file = path.join(root, '-Users-testuser-Projects-demo', name);
  const then = new Date(Date.now() - ms);
  fs.utimesSync(file, then, then);
}

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

test('a transcript with no timestamps at all still falls back to its mtime', () => {
  // MID_TURN carries none, which is what pre-timestamp releases wrote. Refusing
  // to guess would drop those sessions entirely; mtime is wrong only when
  // something rewrote the file, and there is nothing better available.
  const root = projects({ [DESKTOP_ID + '.jsonl']: MID_TURN });
  age(root, DESKTOP_ID + '.jsonl', 2 * 1000);
  assert.equal(pollOnce(root).sessions.length, 1);
});

// ------------------------------------------------------------------- titles
test('a session carries the name Claude Code gave the conversation', () => {
  const body = desktop()
    + JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the flaky watcher test', sessionId: DESKTOP_ID }) + '\n';
  const root = projects({ [DESKTOP_ID + '.jsonl']: body });
  assert.equal(pollOnce(root).sessions[0].title, 'Fix the flaky watcher test');
});

test('a name the user typed outranks the generated one', () => {
  const body = desktop()
    + JSON.stringify({ type: 'ai-title', aiTitle: 'Generated', sessionId: DESKTOP_ID }) + '\n'
    + JSON.stringify({ type: 'custom-title', customTitle: 'Mine', sessionId: DESKTOP_ID }) + '\n';
  const root = projects({ [DESKTOP_ID + '.jsonl']: body });
  assert.equal(pollOnce(root).sessions[0].title, 'Mine');
});

test('a session with no title says so by leaving the field out', () => {
  const root = projects({ [DESKTOP_ID + '.jsonl']: desktop() });
  const [session] = pollOnce(root).sessions;
  assert.ok(!('title' in session), 'an untitled session must be absent, not empty');
  assert.equal(session.cwd, '/Users/testuser/Projects/demo',
    'the renderer falls back to the project, so the cwd has to be there');
});

test('a title written before the tail window is still found', () => {
  /*
   * A conversation is named once, early. On a long session that record is a long
   * way above the last 64KB, which is all the state scan reads — so the title
   * has to be looked for at the head too, or every session that has run for a
   * while shows its project instead of its name.
   */
  const filler = [];
  for (let i = 0; i < 900; i++) {
    filler.push(JSON.stringify({
      type: 'assistant', cwd: '/Users/testuser/Projects/demo',
      timestamp: '2026-08-08T04:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(100) }] },
    }));
  }
  const body = JSON.stringify({ type: 'ai-title', aiTitle: 'Named early on', sessionId: DESKTOP_ID })
    + '\n' + filler.join('\n') + '\n' + desktop();
  const root = projects({ [DESKTOP_ID + '.jsonl']: body });

  const file = path.join(root, '-Users-testuser-Projects-demo', DESKTOP_ID + '.jsonl');
  assert.ok(fs.statSync(file).size > 64 * 1024, 'the fixture has to outgrow the tail window');
  assert.equal(pollOnce(root).sessions[0].title, 'Named early on');
});

/*
 * The approvals plumbing: pending requests in, replies out.
 *
 * This used to live inside main.js, where nothing could reach it — main.js
 * requires electron at the top, so no test ever loaded the file. An audit then
 * deleted the liveness check, the toggle check, the pruning, the id in the
 * reply body and the reply-id validation, one at a time, and the suite stayed
 * green for all five. Everything below exists to make one of those bite.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Approvals } = require('../approvals');

/* a throwaway ~/.strays with the plumbing pointed at it */
function harness({ enabled = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'strays-approvals-'));
  const pendingDir = path.join(base, 'pending');
  const repliesDir = path.join(base, 'replies');
  const shown = [];
  const retracted = [];
  let on = enabled;

  const approvals = new Approvals({
    pendingDir,
    repliesDir,
    enabled: () => on,
    onRequest: (req) => shown.push(req),
    onRemove: (id) => retracted.push(id),
  });
  approvals.ensureDirs();

  return {
    base, pendingDir, repliesDir, shown, retracted, approvals,
    toggle: (v) => { on = v; },
    pendingFile: (id) => path.join(pendingDir, id + '.json'),
    replyFile: (id) => path.join(repliesDir, id + '.json'),
    write: (req) => fs.writeFileSync(path.join(pendingDir, req.id + '.json'), JSON.stringify(req)),
  };
}

/* fs.watch reports on its own schedule, so poll for the effect rather than sleep */
async function settle(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/*
 * fs.watch arms asynchronously: an event fired in the same tick as the call is
 * simply lost, which would make these two tests coin flips. Poke the directory
 * with a file the handler ignores until an event comes back, and only then act.
 */
async function armed(h) {
  const watcher = h.approvals.watch();
  let delivering = false;
  watcher.on('change', () => { delivering = true; });
  const probe = path.join(h.pendingDir, 'probe.txt');
  await settle(() => {
    fs.writeFileSync(probe, String(Date.now()));
    return delivering;
  });
  assert.ok(delivering, 'the directory watch never came up');
  fs.rmSync(probe, { force: true });
}

/* what the gate writes: live until its own deadline passes */
const live = (id, over = {}) => ({
  id, tool: 'Bash', command: 'rm -rf build', session_id: 'session-a', cwd: '/tmp',
  ts: Date.now(), expires_at: Date.now() + 30_000, ...over,
});

/* the wreckage a killed gate leaves behind: an answer nobody can hear */
const dead = (id) => live(id, { ts: Date.now() - 90_000, expires_at: Date.now() - 60_000 });

test('a request whose command has already finished gets no card, and is swept off disk', () => {
  // The reported bug. At launch no gate has run, so gate-side pruning cannot
  // help: an abandoned request would earn a card for a command that is over.
  const h = harness();
  h.write(dead('finished'));
  h.approvals.scanPending();

  assert.deepEqual(h.shown, [], 'a finished command must not be offered for approval');
  assert.equal(fs.existsSync(h.pendingFile('finished')), false,
    'and it must be cleared out rather than re-read on every scan');
});

test('a request still inside its deadline is surfaced and left alone', () => {
  const h = harness();
  h.write(live('waiting'));
  h.approvals.scanPending();

  assert.deepEqual(h.shown.map((r) => r.id), ['waiting']);
  assert.equal(h.shown[0].command, 'rm -rf build', 'the card needs the whole request');
  assert.equal(fs.existsSync(h.pendingFile('waiting')), true, 'the gate is still waiting on it');
});

test('nothing is surfaced while the approvals toggle is off', () => {
  const h = harness({ enabled: false });
  h.write(live('waiting'));
  h.approvals.scanPending();

  assert.deepEqual(h.shown, [], 'the user opted out of cards');
  assert.equal(fs.existsSync(h.pendingFile('waiting')), true,
    'but a live request must survive to be shown if the toggle comes back');
});

test('a request that arrives while the overlay is up is surfaced without a rescan', async () => {
  const h = harness();
  await armed(h);
  try {
    h.write(live('arrived'));
    assert.ok(await settle(() => h.shown.length), 'no card appeared for a request in the directory');
    assert.equal(h.shown[0].id, 'arrived');
    assert.equal(h.shown[0].command, 'rm -rf build');
  } finally {
    h.approvals.stop();
  }
});

test('when the gate takes its request back the card is retracted', async () => {
  // the gate times out and removes its own file; the card must go with it,
  // or the user is left clicking Allow on a question nobody is asking
  const h = harness();
  h.write(live('held'));
  await armed(h);
  try {
    fs.unlinkSync(h.pendingFile('held'));
    assert.ok(await settle(() => h.retracted.length), 'the card was never retracted');
    assert.deepEqual(h.retracted, ['held'], 'and it must name the card to take down');
  } finally {
    h.approvals.stop();
  }
});

test('a click is written under the request id, and names that id inside', () => {
  // The cross-session hazard. The gate refuses a reply whose id is not its
  // own, which it can only do if the id travels in the body as well as in the
  // filename — otherwise one session's Allow answers another session's command.
  const h = harness();
  assert.equal(h.approvals.reply('1700000000000-4242', 'allow'), true);

  const body = JSON.parse(fs.readFileSync(h.replyFile('1700000000000-4242'), 'utf8'));
  assert.equal(body.decision, 'allow');
  assert.equal(body.id, '1700000000000-4242', 'the gate has nothing to pair on without this');
});

test('only an explicit allow allows; everything else denies', () => {
  const h = harness();
  const decisionFor = (input) => {
    h.approvals.reply('req-1', input);
    return JSON.parse(fs.readFileSync(h.replyFile('req-1'), 'utf8')).decision;
  };
  assert.equal(decisionFor('allow'), 'allow');
  for (const input of ['deny', 'Allow', 'yes', '', undefined]) {
    assert.equal(decisionFor(input), 'deny', JSON.stringify(input) + ' must not approve anything');
  }
});

test('a reply id that could name another file is refused outright', () => {
  const h = harness();
  for (const bad of ['../escape', 'a b', 'x/y', '', 'sub/../../out', 'x.json']) {
    assert.equal(h.approvals.reply(bad, 'allow'), false, JSON.stringify(bad) + ' is not an id');
  }
  assert.deepEqual(fs.readdirSync(h.repliesDir), [], 'nothing may be written for a bad id');
  assert.equal(fs.existsSync(path.join(h.base, 'escape.json')), false,
    'and certainly nothing outside the replies directory');
});

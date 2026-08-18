/*
 * The gate as Claude Code actually runs it: a subprocess fed hook stdin.
 *
 * The reported bug was not a wrong verdict in the abstract — it was twenty
 * seconds of real latency on every tool call. That only shows up here, so it
 * is asserted here rather than inferred from the predictor's return value.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GATE = path.join(__dirname, '..', 'hooks', 'gate.js');
const { maxHoldMs, hookTimeoutMs } = require(GATE);

/*
 * A checkout path with no "claude-pet" in it. The installer stopped depending
 * on the clone's name, so every settings fixture here uses the form it emits:
 * the script path plus the --strays-hook sentinel.
 */
const INSTALLED_SCRIPT = '/opt/renamed-checkout/desktop/hooks/gate.js';

/*
 * A throwaway ~/.strays with approvals on and a fresh overlay heartbeat.
 * heartbeatAgeMs backdates that heartbeat instead of removing it: a crashed
 * overlay leaves its last one on disk, so absence is not the only failure.
 */
function sandbox({ approvals = true, alive = true, heartbeatAgeMs = 0 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strays-test-'));
  fs.mkdirSync(path.join(home, 'pending'), { recursive: true });
  fs.mkdirSync(path.join(home, 'replies'), { recursive: true });
  // an empty settings directory, so no test ever reads the real ~/.claude
  fs.mkdirSync(path.join(home, 'claude-config'), { recursive: true });
  if (approvals) fs.writeFileSync(path.join(home, 'approvals-on'), '');
  if (alive) {
    const beat = path.join(home, 'overlay.alive');
    fs.writeFileSync(beat, String(Date.now()));
    if (heartbeatAgeMs) {
      const then = new Date(Date.now() - heartbeatAgeMs);
      fs.utimesSync(beat, then, then);
    }
  }
  return home;
}

/* write a permissions block into the sandbox's settings directory */
function userSettings(home, permissions) {
  fs.writeFileSync(path.join(home, 'claude-config', 'settings.json'), JSON.stringify({ permissions }));
}

const pendingFiles = (home) =>
  fs.readdirSync(path.join(home, 'pending')).filter((f) => f.endsWith('.json'));

/* the request the gate raised, once it has landed */
async function raisedRequest(home) {
  for (let i = 0; i < 100; i++) {
    const [f] = pendingFiles(home);
    if (f) return JSON.parse(fs.readFileSync(path.join(home, 'pending', f), 'utf8'));
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/* run the gate to completion, reporting stdout and how long it took */
function runGate(home, payload, { killAfterMs, killWith = 'SIGTERM', env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(
      process.execPath, [GATE],
      {
        env: {
          ...process.env,
          STRAYS_HOME: home,
          CLAUDE_CONFIG_DIR: path.join(home, 'claude-config'),
          ...env,
        },
      },
      (_err, stdout) => resolve({ stdout, ms: Date.now() - started }),
    );
    if (killAfterMs) setTimeout(() => child.kill(killWith), killAfterMs);
    child.stdin.end(JSON.stringify(payload));
  });
}

const base = {
  session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  cwd: '/Users/testuser/Projects/demo',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'terraform apply' },
};

test('an auto-mode call is not held and leaves no request behind', async () => {
  // The bug, at the seam where it hurt: 47 auto-mode calls in the captured log
  // were each held for 20 seconds waiting for a click nobody owed.
  const home = sandbox();
  const { stdout, ms } = await runGate(home, { ...base, permission_mode: 'auto' });

  assert.equal(stdout.trim(), '', 'the gate must express no opinion');
  assert.deepEqual(pendingFiles(home), [], 'no card should have been requested');
  assert.ok(ms < 2000, `the gate took ${ms}ms; it must not hold an auto-mode call`);
});

test('a manual-mode call raises a request and honours the reply', async () => {
  const home = sandbox();
  const run = runGate(home, { ...base, permission_mode: 'default' });

  // wait for the request to land, then answer it the way the overlay would
  let id = null;
  for (let i = 0; i < 100 && !id; i++) {
    const [f] = pendingFiles(home);
    if (f) id = path.basename(f, '.json');
    else await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(id, 'a manual-mode call should have raised a request');

  fs.writeFileSync(path.join(home, 'replies', id + '.json'), JSON.stringify({ decision: 'allow' }));
  const { stdout } = await run;

  const decision = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(decision.hookEventName, 'PreToolUse');
  assert.equal(decision.permissionDecision, 'allow');
  assert.deepEqual(pendingFiles(home), [], 'the request should be cleaned up');
});

test('approvals stay inert when the toggle is off or the overlay is gone', async () => {
  for (const opts of [{ approvals: false }, { alive: false }]) {
    const home = sandbox(opts);
    const { stdout, ms } = await runGate(home, { ...base, permission_mode: 'default' });
    assert.equal(stdout.trim(), '', `${JSON.stringify(opts)} should produce no decision`);
    assert.deepEqual(pendingFiles(home), []);
    assert.ok(ms < 2000, `${JSON.stringify(opts)} took ${ms}ms`);
  }
});

test('the gate reads the settings the user actually wrote', async () => {
  // The other half of "it asks me for permission for every tool call": the
  // gate had never opened the settings file its rules live in.
  const home = sandbox();
  userSettings(home, { allow: ['Bash(npm:*)'] });

  const allowed = await runGate(home, {
    ...base, permission_mode: 'default', tool_input: { command: 'npm test' },
  });
  assert.equal(allowed.stdout.trim(), '', 'an allow-listed command needs no card');
  assert.deepEqual(pendingFiles(home), []);
  assert.ok(allowed.ms < 2000, `the gate took ${allowed.ms}ms on an allow-listed command`);

  // and a command outside those rules still raises one
  const other = sandbox();
  userSettings(other, { allow: ['Bash(npm:*)'] });
  const held = runGate(other, { ...base, permission_mode: 'default' });
  let raised = false;
  for (let i = 0; i < 60 && !raised; i++) {
    if (pendingFiles(other).length) raised = true;
    else await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(raised, 'terraform apply is not allow-listed and should still raise a card');

  const [file] = pendingFiles(other);
  fs.writeFileSync(path.join(other, 'replies', file), JSON.stringify({ decision: 'deny' }));
  await held;
});

test('the maximum hold is derived from the configured hook timeout', () => {
  // The stall was 20s sitting next to a 30s timeout, two numbers with no
  // relationship. Changing one must now move the other.
  for (const timeout of [1000, 5000, 10000, 30000, 60000]) {
    const hold = maxHoldMs(timeout);
    assert.ok(hold < timeout, `a ${timeout}ms timeout must not be held for ${hold}ms`);
    assert.ok(hold >= 500, `a ${timeout}ms timeout should still leave a usable hold, got ${hold}ms`);
    assert.ok(hold <= timeout - Math.min(3000, timeout / 2),
      `a ${timeout}ms timeout leaves too small a margin at ${hold}ms`);
  }
  assert.equal(maxHoldMs(30000), 22500, 'the installed 30s timeout yields a 22.5s hold');
});

test('the hook timeout is read from the settings it was installed into', () => {
  const home = sandbox();
  const config = path.join(home, 'claude-config');
  // The form the installer actually writes. The path is deliberately not one
  // containing "claude-pet": the sentinel is what marks the entry as ours, so
  // this fixture is only recognised if the sentinel is being looked for.
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /somewhere/else.js', timeout: 90 }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${INSTALLED_SCRIPT}" --strays-hook`, timeout: 12 }] },
      ],
    },
  }));

  assert.equal(hookTimeoutMs(config), 12000, "our own entry's timeout, not another hook's");
  assert.equal(hookTimeoutMs(path.join(home, 'nothing-here')), 30000, 'a safe default when nothing is discoverable');
});

test('a pre-sentinel entry is still ours, and the sentinel outranks it', () => {
  // Identifying our entry by the "claude-pet" path only worked while the
  // checkout kept that name. A renamed clone left the gate reading a 30s
  // default inside an 8s timeout: Claude Code kills the hook mid-hold while the
  // card is still advertising an expiry it will never reach.
  const home = sandbox();
  const config = path.join(home, 'claude-config');
  const entry = (command, timeout) =>
    ({ matcher: 'Bash', hooks: [{ type: 'command', command, timeout }] });
  const write = (entries) => fs.writeFileSync(path.join(config, 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: entries } }));

  const legacy = entry('node "/opt/claude-pet/desktop/hooks/gate.js"', 20);
  const current = entry(`node "${INSTALLED_SCRIPT}" --strays-hook`, 8);

  write([legacy]);
  assert.equal(hookTimeoutMs(config), 20000, 'an installation predating the sentinel still reads back');

  // the legacy entry is written first, so position cannot be what decides
  write([legacy, current]);
  assert.equal(hookTimeoutMs(config), 8000, 'the sentinel identifies the entry the installer wrote');
});

test('an unanswered call is released inside the configured timeout', async () => {
  // Not just exported: the derived budget has to be the one the gate waits for.
  const home = sandbox();
  const timeoutSeconds = 4;
  fs.writeFileSync(path.join(home, 'claude-config', 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `node "${INSTALLED_SCRIPT}" --strays-hook`, timeout: timeoutSeconds }],
      }],
    },
  }));

  const { stdout, ms } = await runGate(home, { ...base, permission_mode: 'default' });

  assert.equal(stdout.trim(), '', 'nobody clicked, so the gate expresses no opinion');
  assert.ok(ms < timeoutSeconds * 1000,
    `the gate held for ${ms}ms, which is not inside the ${timeoutSeconds}s hook timeout`);
  assert.ok(ms >= maxHoldMs(timeoutSeconds * 1000),
    `the gate gave up after ${ms}ms, before its own ${maxHoldMs(timeoutSeconds * 1000)}ms budget`);
});

test('a request carries the moment it was made and the moment it stops meaning anything', async () => {
  const home = sandbox();
  const run = runGate(home, { ...base, permission_mode: 'default' });

  let request = null;
  for (let i = 0; i < 100 && !request; i++) {
    const [f] = pendingFiles(home);
    if (f) request = JSON.parse(fs.readFileSync(path.join(home, 'pending', f), 'utf8'));
    else await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(request, 'a request should have been raised');

  // Without the session there is no pet to draw the card above, and without the
  // command the card asks the user to approve a blank.
  assert.equal(request.session_id, base.session_id, 'a request names the session that asked');
  assert.equal(request.tool, 'Bash');
  assert.equal(request.command, base.tool_input.command, 'a request carries what it is asking about');
  assert.ok(request.command.length > 0, 'and it is never empty');

  assert.ok(Number.isFinite(request.ts), 'a request records when it was made');
  assert.ok(request.expires_at > request.ts, 'a request records when it expires');
  // Exactly the hold, not merely "no longer than" it. The overlay sizes the
  // card's life from this number and main.js decides liveness from it, so a
  // published expiry shorter than the real wait tears the card away while the
  // call is still answerable, and a longer one leaves a card nobody can answer.
  assert.equal(request.expires_at - request.ts, maxHoldMs(30000),
    "a request's expiry must be exactly how long the gate will wait");

  fs.writeFileSync(path.join(home, 'replies', request.id + '.json'), JSON.stringify({ decision: 'deny' }));
  await run;
});

test('expired requests are pruned when the gate next runs', async () => {
  // A real stale request from a killed gate is sitting on the reporter's
  // machine right now; the overlay resurrects it as a card on every restart.
  const home = sandbox();
  const write = (id, request) =>
    fs.writeFileSync(path.join(home, 'pending', id + '.json'), JSON.stringify(request));

  write('stale', { id: 'stale', ts: Date.now() - 600000, expires_at: Date.now() - 580000 });
  // written by a version that recorded no time: judged on the file's own age
  write('ancient', { id: 'ancient' });
  const longAgo = new Date(Date.now() - 600000);
  fs.utimesSync(path.join(home, 'pending', 'ancient.json'), longAgo, longAgo);
  write('live', { id: 'live', ts: Date.now(), expires_at: Date.now() + 60000 });

  await runGate(home, { ...base, permission_mode: 'auto' });

  assert.deepEqual(pendingFiles(home), ['live.json'], 'only the request still in flight survives');
});

/*
 * Windows has no signal to catch. `child.kill('SIGTERM')` there is
 * TerminateProcess: no handler runs, no `finally` runs, and nothing the gate
 * could be written to do would change that. So the guarantee below is a POSIX
 * one, and on Windows a cancelled call leaves its request until it expires —
 * which is what the expiry is for, and what 'expired requests are pruned when
 * the gate next runs' covers on every platform.
 */
test('a killed gate takes its request with it', { skip: process.platform === 'win32' && 'no catchable signals on Windows' }, async () => {
  // A cancelled tool call kills the hook outright: try/finally never runs, and
  // the request it leaves behind becomes a card for a command nobody is waiting
  // on. There is one of these on the reporter's machine as this is written.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const home = sandbox();
    const run = runGate(home, { ...base, permission_mode: 'default' }, { killAfterMs: 1000, killWith: signal });

    let raised = false;
    for (let i = 0; i < 40 && !raised; i++) {
      if (pendingFiles(home).length) raised = true;
      else await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(raised, `${signal}: the gate should have raised a request before being killed`);

    await run;
    assert.deepEqual(pendingFiles(home), [], `${signal} must not leave a request behind`);
  }
});

/* a settings file that shortens the hook timeout, so held tests stay quick */
function shortTimeout(home, seconds) {
  fs.writeFileSync(path.join(home, 'claude-config', 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `node "${INSTALLED_SCRIPT}" --strays-hook`, timeout: seconds }],
      }],
    },
  }));
}

test('a reply is only applied to the request whose identifier it carries', async () => {
  // Two sessions, two cards, one click: the click must not answer the other
  // session's command just because it landed in the same directory.
  const home = sandbox();
  shortTimeout(home, 4);
  const run = runGate(home, { ...base, permission_mode: 'default' });

  let id = null;
  for (let i = 0; i < 60 && !id; i++) {
    const [f] = pendingFiles(home);
    if (f) id = path.basename(f, '.json');
    else await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(id, 'a request should have been raised');

  // right filename, wrong request: an answer to somebody else's card
  fs.writeFileSync(path.join(home, 'replies', id + '.json'),
    JSON.stringify({ id: 'a-different-request', decision: 'allow' }));

  const { stdout } = await run;
  assert.equal(stdout.trim(), '', 'a mismatched reply must not decide this call');
});

test('a deny click is reported as a denial', async () => {
  // Reporting "allow" here runs the command the user just refused, and
  // reporting nothing falls through to the terminal prompt as if no one clicked
  // — so the click has to arrive at Claude Code as a decision of its own.
  const home = sandbox();
  shortTimeout(home, 4);
  const run = runGate(home, { ...base, permission_mode: 'default' });

  const request = await raisedRequest(home);
  assert.ok(request, 'a request should have been raised');
  fs.writeFileSync(path.join(home, 'replies', request.id + '.json'),
    JSON.stringify({ id: request.id, decision: 'deny' }));

  const { stdout } = await run;
  const decision = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(decision.hookEventName, 'PreToolUse');
  assert.equal(decision.permissionDecision, 'deny', 'a deny click must deny the call');
  assert.match(decision.permissionDecisionReason, /deni/i);
});

test('a heartbeat a crashed overlay left behind is not a running overlay', async () => {
  // Removing the file is not the only way an overlay stops answering. A crash
  // leaves the last heartbeat on disk, so only its age tells the gate that
  // nobody is there to click — and a card nobody can answer is a full hold.
  // no shortTimeout here on purpose: the failure being guarded against is the
  // full default hold, and it has to be the one the gate would actually take
  const home = sandbox({ heartbeatAgeMs: 60 * 1000 });
  assert.ok(fs.existsSync(path.join(home, 'overlay.alive')), 'the heartbeat file is still there');

  const { stdout, ms } = await runGate(home, { ...base, permission_mode: 'default' });

  assert.equal(stdout.trim(), '', 'a stale heartbeat must not earn a card');
  assert.deepEqual(pendingFiles(home), []);
  assert.ok(ms < 2000, `the gate held for ${ms}ms behind an overlay that had crashed`);
});

test('the rules in the project the call came from are the ones that count', async () => {
  // The gate scopes settings to the directory of the call, not to whatever
  // directory Claude Code happened to launch it from. Reading its own working
  // directory instead ignores every rule in the user's project settings.
  // the default hold again: an ignored project rule costs the full 22.5s
  const home = sandbox();
  const project = path.join(home, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(terraform:*)'] } }));
  // a path rule with one leading slash is relative to the settings file it was
  // written in, which is the other half of the scoping
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Edit(/src/**)'] } }));

  const shell = await runGate(home, { ...base, cwd: project, permission_mode: 'default' });
  assert.equal(shell.stdout.trim(), '', "the project's allow rule covers terraform apply");
  assert.deepEqual(pendingFiles(home), []);
  assert.ok(shell.ms < 2000, `the gate held for ${shell.ms}ms despite a project allow rule`);

  const editing = await runGate(home, {
    ...base,
    cwd: project,
    permission_mode: 'default',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(project, 'src', 'app.js') },
  });
  assert.equal(editing.stdout.trim(), '', 'the local rule is anchored at the project, not at the gate');
  assert.ok(editing.ms < 2000, `the gate held for ${editing.ms}ms despite a project-local allow rule`);
});

test('orphan replies are swept rather than accumulating', async () => {
  const home = sandbox();
  fs.writeFileSync(path.join(home, 'replies', 'long-gone.json'), JSON.stringify({ id: 'long-gone', decision: 'allow' }));

  await runGate(home, { ...base, permission_mode: 'auto' });

  assert.deepEqual(fs.readdirSync(path.join(home, 'replies')), [],
    'a reply whose request no longer exists answers nothing');
});

test('the log rotates at its cap instead of being thrown away', async () => {
  // The log is the only evidence of an intermittent misfire. Deleting it at the
  // size cap deletes exactly the history somebody is about to ask for.
  const home = sandbox();
  const log = path.join(home, 'gate.log');
  const previous = path.join(home, 'gate.log.1');
  fs.writeFileSync(log, 'x'.repeat(101 * 1024) + '\nEVIDENCE OF THE BUG\n');

  await runGate(home, { ...base, permission_mode: 'auto' });

  assert.ok(fs.existsSync(previous), 'the previous generation is kept, not deleted');
  assert.match(fs.readFileSync(previous, 'utf8'), /EVIDENCE OF THE BUG/);

  const current = fs.readFileSync(log, 'utf8');
  assert.ok(current.length < 100 * 1024, 'the live log starts again from empty');
  assert.match(current, /auto/, 'and records the decision that triggered the rotation');
});

test('every tool Claude Code can prompt for can raise a card', () => {
  // The installer registers Write, Edit, MultiEdit, NotebookEdit and Bash. If
  // the gate quietly stops describing one of them, that tool's calls sail past
  // with no card and the loss is invisible — the installer's matcher still
  // names it, and the pure predictor still says it would prompt.
  const inputs = {
    Bash: { command: 'terraform apply' },
    Write: { file_path: '/Users/testuser/Projects/demo/new.txt' },
    Edit: { file_path: '/Users/testuser/Projects/demo/app.js' },
    MultiEdit: { file_path: '/Users/testuser/Projects/demo/app.js' },
    NotebookEdit: { notebook_path: '/Users/testuser/Projects/demo/nb.ipynb' },
  };

  return Promise.all(Object.entries(inputs).map(async ([tool, tool_input]) => {
    const home = sandbox();
    const run = runGate(home, { ...base, permission_mode: 'default', tool_name: tool, tool_input });

    /*
     * A directory entry is not a finished file. On Windows this read landed on a
     * request that existed with zero bytes in it, and `JSON.parse('')` threw
     * `Unexpected end of JSON input` out of the poll — intermittently, on one leg
     * of nine, which is the shape of a flake rather than of a bug. A half-written
     * file is simply not ready yet, so it counts as another turn of the loop.
     */
    let request = null;
    for (let i = 0; i < 100 && !request; i++) {
      const [f] = pendingFiles(home);
      if (f) {
        try { request = JSON.parse(fs.readFileSync(path.join(home, 'pending', f), 'utf8')); }
        catch { /* still being written */ }
      }
      if (!request) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(request, `${tool} should raise a card in manual mode`);
    assert.equal(request.tool, tool);
    assert.ok(request.command, `${tool}'s card must say what it is approving`);

    fs.writeFileSync(path.join(home, 'replies', request.id + '.json'),
      JSON.stringify({ id: request.id, decision: 'deny' }));
    await run;
  }));
});

/*
 * The hook installer, run the way a user runs it.
 *
 * Every case here points CLAUDE_CONFIG_DIR at a throwaway directory. The real
 * ~/.claude/settings.json holds the user's own hooks for other tools and must
 * never be touched by a test run.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INSTALLER = path.join(__dirname, '..', 'setup-hooks.js');

/* another tool's hooks, living in the same settings file */
const FOREIGN = {
  hooks: {
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'node /Users/testuser/othertool/pre.js' }],
    }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'othertool-session-start' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'othertool-stop' }] }],
  },
  permissions: { allow: ['Bash(ls *)'], deny: [], ask: [] },
};

function configDir(settings = FOREIGN) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strays-config-'));
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  return dir;
}

function install(dir, ...args) {
  const stdout = execFileSync(process.execPath, [INSTALLER, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    encoding: 'utf8',
  });
  return { stdout, settings: JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) };
}

/*
 * The installer marks its own commands with this. Recognising them by the
 * string "claude-pet" instead — which is what these helpers used to do — only
 * ever worked because the checkout happens to be named that.
 */
const SENTINEL = '--strays-hook';

const commands = (entries) =>
  (entries || []).flatMap((e) => (e.hooks || []).map((h) => h.command));
const ours = (entries) => commands(entries).filter((c) => c.includes(SENTINEL));
const foreign = (entries) => commands(entries).filter((c) => !c.includes(SENTINEL));
const ourEntries = (entries) => (entries || [])
  .filter((e) => (e.hooks || []).some((h) => String(h.command).includes(SENTINEL)));

test('the installer registers both hooks', () => {
  const { settings } = install(configDir());
  assert.equal(ours(settings.hooks.PreToolUse).length, 1, 'the approval gate');
  assert.equal(ours(settings.hooks.SessionStart).length, 1, 'the session-host recorder');
  // either separator: the command is a shell line, not a rule to be matched, so
  // the installer writes a native path and `desktop\hooks\gate.js` is correct on
  // Windows. Only path *rules* are normalised to POSIX — see permissions.js.
  assert.match(ours(settings.hooks.PreToolUse)[0], /hooks[\\/]gate\.js/);
  assert.match(ours(settings.hooks.SessionStart)[0], /hooks[\\/]session-start\.js/);
});

test('hooks belonging to other tools are left untouched', () => {
  const dir = configDir();
  const { settings } = install(dir);
  assert.deepEqual(foreign(settings.hooks.PreToolUse), ['node /Users/testuser/othertool/pre.js']);
  assert.deepEqual(foreign(settings.hooks.SessionStart), ['othertool-session-start']);
  assert.deepEqual(commands(settings.hooks.Stop), ['othertool-stop']);
  assert.deepEqual(settings.permissions, FOREIGN.permissions, 'the rest of the file is untouched');

  install(dir, '--remove');
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(foreign(after.hooks.PreToolUse), ['node /Users/testuser/othertool/pre.js']);
  assert.deepEqual(foreign(after.hooks.SessionStart), ['othertool-session-start']);
  assert.deepEqual(commands(after.hooks.Stop), ['othertool-stop']);
});

test('removal takes both hooks away, and reinstalling does not duplicate them', () => {
  const dir = configDir();
  install(dir);
  install(dir);
  const { settings } = install(dir);
  assert.equal(ours(settings.hooks.PreToolUse).length, 1, 'a reinstall replaces its own entry');
  assert.equal(ours(settings.hooks.SessionStart).length, 1);

  const { settings: removed } = install(dir, '--remove');
  assert.deepEqual(ours(removed.hooks.PreToolUse), []);
  assert.deepEqual(ours(removed.hooks.SessionStart), []);
});

test('an install into a settings file with no hooks at all leaves nothing behind on removal', () => {
  const dir = configDir(null);
  install(dir);
  const { settings } = install(dir, '--remove');
  assert.ok(!settings.hooks, 'an empty hooks block is removed rather than left as clutter');
});

test('the installer says that open sessions need restarting', () => {
  for (const args of [[], ['--remove']]) {
    const { stdout } = install(configDir(), ...args);
    assert.match(stdout, /restart/i, `"npm run hooks ${args.join(' ')}" must say so`);
  }
});

test('the installer still recognises its own entries after the checkout moves', () => {
  // Self-identification used to rely on the literal string "claude-pet"
  // appearing in the command, which is true only because the checkout
  // directory happens to be named that. Rename or relocate the clone and a
  // reinstall would stack a second copy of every hook beside the first.
  const dir = configDir();
  const first = install(dir).settings;
  const countEntries = (s) => Object.values(s.hooks).reduce((n, list) => n + list.length, 0);
  const before = countEntries(first);

  // relocate the clone to somewhere with no telltale name in the path
  for (const list of Object.values(first.hooks)) {
    for (const entry of list) {
      for (const hook of entry.hooks) {
        hook.command = hook.command.replace(/"[^"]*claude-pet[^"]*"/, '"/opt/tools/desktop/hooks/x.js"');
      }
    }
  }
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(first, null, 2));

  const after = install(dir).settings;
  assert.equal(countEntries(after), before, 'reinstalling must replace our entries, not duplicate them');
});

test('an install that predates the sentinel is recognised and replaced', () => {
  // Before --strays-hook existed, our entries were identifiable only by the
  // "claude-pet" in their path. Drop that legacy branch and a user who
  // installed back then gets their old entries KEPT and a second copy
  // appended, so every tool call is gated twice — two cards, two holds.
  const dir = configDir({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /Users/testuser/othertool/pre.js' }] },
        {
          matcher: '^(Write|Edit|MultiEdit|NotebookEdit|Bash)$',
          hooks: [{
            type: 'command',
            command: 'node "/Users/testuser/claude-pet/desktop/hooks/gate.js"',
            timeout: 30,
          }],
        },
      ],
      SessionStart: [{
        hooks: [{
          type: 'command',
          command: 'node "/Users/testuser/claude-pet/desktop/hooks/session-start.js"',
          timeout: 5,
        }],
      }],
    },
  });

  const { settings, stdout } = install(dir);

  assert.equal(ours(settings.hooks.PreToolUse).length, 1, 'exactly one gate, never two');
  assert.equal(ours(settings.hooks.SessionStart).length, 1);
  assert.equal(commands(settings.hooks.PreToolUse).length, 2,
    'the pre-sentinel gate is gone and the foreign hook is not');
  assert.deepEqual(foreign(settings.hooks.PreToolUse), ['node /Users/testuser/othertool/pre.js']);
  assert.deepEqual(foreign(settings.hooks.SessionStart), []);
  assert.match(stdout, /replaced the approval gate/,
    'and the installer must say it replaced rather than installed');
});

test('the installed gate matches every tool that can prompt, on the timeout it budgets against', () => {
  const { settings } = install(configDir());

  const [gate] = ourEntries(settings.hooks.PreToolUse);
  assert.ok(gate, 'the gate must be installed');
  const matcher = new RegExp(gate.matcher);
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
    // narrowing this to Bash would make file-edit cards vanish for everyone
    // who reinstalls, with nothing in the output to say so
    assert.ok(matcher.test(tool), `${tool} can prompt, so the gate must be offered it`);
  }
  for (const tool of ['Read', 'Glob', 'Grep', 'Task', 'WebFetch']) {
    assert.ok(!matcher.test(tool), `${tool} never prompts; gating it spawns a hook for nothing`);
  }

  // the gate derives its hold from this number rather than hardcoding one, so
  // changing it here silently changes how long a card stays answerable
  assert.equal(gate.hooks[0].timeout, 30, 'gate.test.js pins maxHoldMs(30000) === 22500');

  const [recorder] = ourEntries(settings.hooks.SessionStart);
  assert.ok(recorder, 'the session-host recorder must be installed');
  assert.ok(!('matcher' in recorder), 'SessionStart carries no tool to match on');
  assert.equal(recorder.hooks[0].timeout, 5, 'the recorder writes one small file');
});

/*
 * The downloadable app installs the same hooks, but it cannot ask for `node`.
 *
 * Claude Code runs a hook by handing its command to a shell, and the people the
 * app exists for have no node on their PATH for that shell to find. A hook
 * command naming one does not error — Claude Code carries on, and the only
 * symptom is approval cards that never appear, which reads as the feature being
 * broken rather than the install being wrong.
 */
const APP_EXEC = '/Applications/strays.app/Contents/MacOS/strays';

test('the app installs a hook that does not need node on the machine', () => {
  const dir = configDir();
  const { settings } = install(dir, '--app', APP_EXEC);

  for (const [event, entries] of Object.entries(settings.hooks)) {
    for (const command of ours(entries)) {
      assert.ok(!/(^|[^-\w])node\s/.test(command), `${event} must not call node: ${command}`);
      assert.ok(command.startsWith(`ELECTRON_RUN_AS_NODE=1 "${APP_EXEC}"`),
        `${event} runs the app as its own node: ${command}`);
    }
  }
});

test('without --app it still writes the command an npm install needs', () => {
  // the two live side by side: npx and a global install both have node, and
  // telling them to run an app they have not got would break the older path
  const dir = configDir();
  const { settings } = install(dir);
  const [command] = ours(settings.hooks.PreToolUse);

  assert.match(command, /^node "/, `an npm install gets node: ${command}`);
  assert.ok(!command.includes('ELECTRON_RUN_AS_NODE'), command);
});

test('an app install replaces an npm one rather than stacking on it', () => {
  // someone who tried `npx claude-strays` first and then downloaded the app has
  // two installers aimed at the same two events
  const dir = configDir();
  install(dir);
  const { settings } = install(dir, '--app', APP_EXEC);

  const mine = ours(settings.hooks.PreToolUse);
  assert.equal(mine.length, 1, `one gate, not two: ${JSON.stringify(mine)}`);
  assert.ok(mine[0].includes('ELECTRON_RUN_AS_NODE'), 'and it is the app');
});

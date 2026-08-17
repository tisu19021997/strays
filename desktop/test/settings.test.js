/*
 * Settings discovery: the impure half of permission prediction.
 *
 * Every test drives the loader with explicit directories inside a throwaway
 * tree — nothing here may read the real ~/.claude.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRules } = require('../settings');
const { predictPrompt } = require('../permissions');
const { payload } = require('./helpers');

/* a throwaway user dir and project dir, populated from plain objects */
function tree({ user, project, local, managed } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strays-settings-'));
  const userDir = path.join(root, 'home', '.claude');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });

  const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  if (user) write(path.join(userDir, 'settings.json'), user);
  if (project) write(path.join(projectDir, '.claude', 'settings.json'), project);
  if (local) write(path.join(projectDir, '.claude', 'settings.local.json'), local);
  const managedPath = path.join(root, 'managed-settings.json');
  if (managed) write(managedPath, managed);

  return { root, userDir, projectDir, managedPath, scopes: { userDir, projectDir, managedPath } };
}

const perms = (permissions) => ({ permissions });

test('rules are merged across every settings scope', () => {
  const t = tree({
    managed: perms({ deny: ['Bash(shutdown:*)'] }),
    user: perms({ allow: ['Bash(npm:*)'] }),
    project: perms({ allow: ['Bash(make:*)'], ask: ['Bash(git push:*)'] }),
    local: perms({ allow: ['Bash(pytest:*)'] }),
  });

  const rules = loadRules(t.scopes);

  assert.deepEqual(rules.allow.sort(), ['Bash(make:*)', 'Bash(npm:*)', 'Bash(pytest:*)']);
  assert.deepEqual(rules.deny, ['Bash(shutdown:*)']);
  assert.deepEqual(rules.ask, ['Bash(git push:*)']);
});

test('a deny in one scope defeats an allow in another', () => {
  // Claude Code treats deny as unoverridable across scopes: a project cannot
  // allow-list its way past something the user denied.
  const t = tree({
    user: perms({ deny: ['Bash(rm:*)'] }),
    project: perms({ allow: ['Bash(rm:*)'] }),
  });

  const verdict = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'rm -rf build' } }),
    loadRules(t.scopes),
  );

  assert.equal(verdict.prompts, false);
  assert.match(verdict.reason, /deny/i);
});

test('missing and malformed settings degrade to silence instead of throwing', () => {
  const t = tree({ user: '{ this is not json', project: perms({ allow: ['Bash(npm:*)'] }) });
  fs.rmSync(path.join(t.projectDir, '.claude', 'settings.local.json'), { force: true });

  const rules = loadRules({ ...t.scopes, managedPath: path.join(t.root, 'nope.json') });

  // the broken scope contributes nothing; the readable one still counts
  assert.deepEqual(rules, { allow: ['Bash(npm:*)'], deny: [], ask: [] });
  assert.deepEqual(loadRules({}), { allow: [], deny: [], ask: [] });
  assert.deepEqual(loadRules(), { allow: [], deny: [], ask: [] });
});

test('parsing is cached against modification time and re-read when it changes', () => {
  // The gate loads settings on every tool call, so re-parsing an unchanged file
  // is pure waste. Caching is asserted from the outside: content that changes
  // without the mtime changing must not be picked up, and a newer mtime must.
  const t = tree({ user: perms({ allow: ['Bash(npm:*)'] }) });
  const file = path.join(t.userDir, 'settings.json');
  // pinned rather than read back: utimes cannot restore sub-millisecond mtimes
  const mtime = new Date(Date.now() - 60000);
  const atime = mtime;
  fs.utimesSync(file, atime, mtime);

  assert.deepEqual(loadRules(t.scopes).allow, ['Bash(npm:*)']);

  // same length as the original, so only the modification time can tell them
  // apart — the cache is keyed on the file's stamp, not on its content
  fs.writeFileSync(file, JSON.stringify(perms({ allow: ['Bash(pnp:*)'] })));
  fs.utimesSync(file, atime, mtime);
  assert.deepEqual(loadRules(t.scopes).allow, ['Bash(npm:*)'], 'an unchanged mtime should be served from cache');

  fs.utimesSync(file, atime, new Date(mtime.getTime() + 5000));
  assert.deepEqual(loadRules(t.scopes).allow, ['Bash(pnp:*)'], 'a newer mtime should be re-read');
});

test('a settings file appearing or disappearing is noticed', () => {
  const t = tree({ user: perms({ allow: ['Bash(npm:*)'] }) });
  assert.deepEqual(loadRules(t.scopes).allow, ['Bash(npm:*)']);

  fs.writeFileSync(path.join(t.projectDir, '.claude', 'settings.json'), JSON.stringify(perms({ deny: ['Bash(rm:*)'] })));
  assert.deepEqual(loadRules(t.scopes).deny, ['Bash(rm:*)'], 'a new project settings file should be picked up');

  fs.rmSync(path.join(t.userDir, 'settings.json'));
  assert.deepEqual(loadRules(t.scopes).allow, [], 'a removed settings file should stop contributing');
});

test('a single leading slash in a path rule means relative to the settings source', () => {
  // Claude Code's third path form. Only the loader knows which file a rule came
  // from, so it is the loader that anchors the pattern.
  const t = tree({ project: perms({ allow: ['Edit(/src/**)'] }) });
  const rules = loadRules(t.scopes);

  const editing = (file_path) => predictPrompt(
    payload({ permission_mode: 'default', tool_name: 'Edit', cwd: '/Users/testuser/elsewhere', tool_input: { file_path } }),
    rules,
  );

  assert.equal(editing(path.join(t.projectDir, 'src', 'app.js')).prompts, false,
    'the rule is anchored at the project the settings came from');
  assert.equal(editing('/Users/testuser/elsewhere/src/app.js').prompts, true,
    'it is not anchored at the working directory');
});

test('two sessions with different local sources are not served each other rules', () => {
  // The .local scope is anchored at the cwd the session started in, so the same
  // files can legitimately mean different things to two concurrent sessions.
  const t = tree({ local: perms({ allow: ['Edit(/src/**)'] }) });

  const editing = (rules, file_path) => predictPrompt(
    payload({ permission_mode: 'default', tool_name: 'Edit', cwd: '/Users/testuser/one', tool_input: { file_path } }),
    rules,
  );

  const one = loadRules({ ...t.scopes, localCwd: '/Users/testuser/one' });
  const two = loadRules({ ...t.scopes, localCwd: '/Users/testuser/two' });

  assert.equal(editing(one, '/Users/testuser/one/src/app.js').prompts, false);
  assert.equal(editing(two, '/Users/testuser/one/src/app.js').prompts, true,
    "the second session's rules must not be the first session's cached ones");
});

test('anchoring does not depend on the source starting with a slash', () => {
  /*
   * The loader rewrites a source-relative rule into the filesystem-absolute
   * `//abs` form. It used to build that from one slash plus a source that
   * happened to start with another, which is true of every POSIX path and of no
   * Windows one — a drive letter starts with `C`, so the result was `/C:/…`, the
   * single-slash form again, and the matcher read it as relative to the working
   * directory and matched nothing.
   *
   * A drive letter only exists on Windows, but "a source that does not start
   * with a slash" is the shape that matters, and a relative source is the same
   * shape everywhere. This is the guard; the Windows leg of CI is the proof.
   */
  const t = tree({ project: perms({ allow: ['Edit(/src/**)'] }) });
  const relative = path.relative(process.cwd(), t.projectDir);
  assert.ok(!relative.startsWith('/'), 'the source under test must not start with a slash');

  const [rule] = loadRules({ ...t.scopes, projectDir: relative }).allow;
  assert.match(rule, /^Edit\(\/\//,
    'an anchored rule has to reach the matcher as //abs, whatever the source looked like');
});

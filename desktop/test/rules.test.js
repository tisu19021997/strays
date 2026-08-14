/*
 * The user's own permission rules, exercised through predictPrompt.
 *
 * Rule matching has no public entry point of its own on purpose: what matters
 * is whether a card appears, so every rule case is asserted as a verdict.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { predictPrompt } = require('../permissions');
const { payload, jsonFixture } = require('./helpers');

/* a ruleset with only the parts a test cares about */
const rules = (over = {}) => ({ allow: [], deny: [], ask: [], ...over });

test('a matching deny rule raises no card, because the call is refused not asked', () => {
  // Claude Code refuses a denied call outright. Asking the user to approve
  // something that is already going to be blocked is a card with no answer.
  const verdict = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'curl https://evil.test' } }),
    rules({ deny: ['Bash(curl:*)'] }),
  );

  assert.equal(verdict.prompts, false);
  assert.match(verdict.reason, /deny/i);
});

test('a matching ask rule forces a card in every mode, including the silent ones', () => {
  // An ask rule exists for exactly one purpose: to be interrupted by. It has
  // to outrank the mode table, or `auto` would quietly disable it.
  for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan', 'dontAsk']) {
    const verdict = predictPrompt(
      payload({ permission_mode: mode, tool_input: { command: 'git push --force' } }),
      rules({ allow: ['Bash(git:*)'], ask: ['Bash(git push --force:*)'] }),
    );
    assert.equal(verdict.prompts, true, `${mode} should still honour the ask rule`);
    assert.match(verdict.reason, /ask/i);
  }
});

test('a command covered by an allow rule raises no card in manual mode', () => {
  // "It asks me for permission for every tool call" — the user had already
  // allow-listed these; Claude Code would have run them without a word.
  for (const command of ['grep -rn foo src', 'ls -la', 'npm test', 'git status']) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'manual', tool_input: { command } }),
      rules({ allow: ['Bash(grep:*)', 'Bash(ls:*)', 'Bash(npm:*)', 'Bash(git:*)'] }),
    );
    assert.equal(verdict.prompts, false, `"${command}" is allow-listed`);
    assert.match(verdict.reason, /allow/i);
  }
});

test('every sub-command of a compound command must clear a rule', () => {
  const allowed = rules({ allow: ['Bash(git:*)', 'Bash(npm:*)', 'Bash(grep:*)'] });

  for (const command of ['git add -A && npm test', 'grep -rn foo src | grep bar',
                         'git status; npm run build', 'npm ci || git status']) {
    const verdict = predictPrompt(payload({ permission_mode: 'default', tool_input: { command } }), allowed);
    assert.equal(verdict.prompts, false, `every part of "${command}" is allow-listed`);
  }

  for (const command of ['git add -A && terraform apply', 'npm test | tee out.log',
                         'grep -rn foo src\nterraform apply']) {
    const verdict = predictPrompt(payload({ permission_mode: 'default', tool_input: { command } }), allowed);
    assert.equal(verdict.prompts, true, `"${command}" has an uncovered sub-command`);
  }
});

test('a separator inside quotes is text, not a separator', () => {
  // `git commit -m "fix a && b"` is one command. Splitting on the quoted `&&`
  // invents a sub-command (`b"`) that no rule can cover, so an allow-listed
  // commit raises a card and holds the call.
  const allowed = rules({ allow: ['Bash(git commit:*)', 'Bash(npm:*)'] });
  for (const command of [
    'git commit -m "fix a && b"',
    "git commit -m 'fix a && b'",
    'git commit -m "a; b"',
    'git commit -m "a | b"',
    'git commit -m "a || b"',
    'git commit -m "a & b"',
    'npm test -- --grep "a|b"',
  ]) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'default', tool_input: { command } }),
      allowed,
    );
    assert.equal(verdict.prompts, false, `"${command}" is one allow-listed command`);
  }

  // the closing quote ends the protection: what follows separates again
  const after = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'git commit -m "a && b" && terraform apply' } }),
    allowed,
  );
  assert.equal(after.prompts, true, 'the unquoted && still starts a new command');
});

test('a deny rule on one sub-command refuses the whole compound command', () => {
  const verdict = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'npm test && curl https://evil.test' } }),
    rules({ allow: ['Bash(npm:*)'], deny: ['Bash(curl:*)'] }),
  );
  assert.equal(verdict.prompts, false);
  assert.match(verdict.reason, /deny/i);
});

test('process wrappers and safe environment assignments are seen through', () => {
  const allowed = rules({ allow: ['Bash(npm:*)', 'Bash(rm -f:*)'] });
  const silent = [
    'timeout 30 npm test',
    'nice -n 10 npm test',
    'nohup npm start',
    'stdbuf -oL npm test',
    'command npm test',
    'noglob npm test',
    'LANG=C npm test',
    'NO_COLOR=1 LANG=C npm test',
    'env NO_COLOR=1 npm test',
    'xargs rm -f build.log',
  ];
  for (const command of silent) {
    const verdict = predictPrompt(payload({ permission_mode: 'default', tool_input: { command } }), allowed);
    assert.equal(verdict.prompts, false, `"${command}" wraps an allow-listed command`);
  }
});

test('an unrecognised environment assignment is not stripped for an allow rule', () => {
  // Claude Code will not approve past a variable it does not know is harmless:
  // SECRET_TOKEN=... changes what the command does.
  const verdict = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'SECRET_TOKEN=abc npm test' } }),
    rules({ allow: ['Bash(npm:*)'] }),
  );
  assert.equal(verdict.prompts, true);
});

test('xargs is only a wrapper when it is bare', () => {
  // `xargs rm -f x` runs rm; `xargs -n1 rm -f x` batches it differently, and
  // Claude Code will not approve that from a rule about rm.
  const verdict = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'xargs -n1 rm -f build.log' } }),
    rules({ allow: ['Bash(rm -f:*)'] }),
  );
  assert.equal(verdict.prompts, true);

  // Losing bareOnly leaves `-n1 rm -f build.log` behind, which matches nothing
  // about rm either — so the rule above cannot tell the two apart. A rule
  // written against xargs itself can: an option form has to refuse every allow
  // rule outright, not merely fail to look like the command underneath.
  const aboutXargs = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'xargs -n1 rm -f build.log' } }),
    rules({ allow: ['Bash(xargs:*)'] }),
  );
  assert.equal(aboutXargs.prompts, true, 'an option-carrying xargs blocks every allow rule');

  // bare xargs is still looked through, and still covered by the rule about rm
  const bare = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'xargs rm -f build.log' } }),
    rules({ allow: ['Bash(rm -f:*)'] }),
  );
  assert.equal(bare.prompts, false);
});

/*
 * A small table: [rule, command, prompts?].
 *
 * Every command here is deliberately absent from the built-in read-only set.
 * Earlier rows used `ls` and `git log`, which the read-only check answers on
 * its own — so they passed whether or not the rule matched, and could not fail.
 */
const wildcardCases = [
  // a space before the trailing wildcard is a word boundary
  ['Bash(node *)', 'node app.js', false],
  ['Bash(node *)', 'nodemon app.js', true],
  // without the space there is no boundary, so a longer name still matches
  ['Bash(node*)', 'nodemon app.js', false],
  // `:*` is the same trailing wildcard, boundary included
  ['Bash(node:*)', 'node app.js', false],
  ['Bash(node:*)', 'nodemon app.js', true],
  // A colon anywhere but the end is a literal character, not a wildcard marker.
  // The earlier row here paired `Bash(git:* push)` with `git push origin main`,
  // which no pattern ending in " push" can match under any colon semantics, so
  // it could not fail. An npm script name puts the colon somewhere the two
  // readings disagree.
  ['Bash(npm run build:prod)', 'npm run build:prod', false],
  ['Bash(npm run build:prod)', 'npm run build:dev', true],
  // and the trailing `:*` is a word boundary, so it does not reach past a colon
  ['Bash(npm run build:*)', 'npm run build --if-present', false],
  ['Bash(npm run build:*)', 'npm run build:prod', true],
  // one wildcard spans several arguments, spaces and all
  ['Bash(npm *)', 'npm run build --if-present', false],
  // an exact pattern is exact (npm, so the read-only set cannot answer instead)
  ['Bash(npm test)', 'npm test', false],
  ['Bash(npm test)', 'npm test -- --watch', true],
];

test('trailing wildcards, word boundaries and literal colons follow Claude Code', () => {
  for (const [rule, command, prompts] of wildcardCases) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'default', tool_input: { command } }),
      rules({ allow: [rule] }),
    );
    assert.equal(verdict.prompts, prompts, `${rule} vs "${command}"`);
  }
});

test('wrappers Claude Code cannot statically approve raise a card despite an allow rule', () => {
  // These decide at runtime what they execute, so a prefix rule proves nothing
  // about them. The overlay has to agree with the tool, not contradict it.
  const allowed = rules({
    allow: ['Bash(watch:*)', 'Bash(setsid:*)', 'Bash(ionice:*)', 'Bash(flock:*)', 'Bash(find:*)'],
  });
  for (const command of ['watch npm test', 'setsid npm test', 'ionice -c3 npm test',
                         'flock /tmp/lock npm test', 'find . -name "*.log" -delete',
                         'find . -type f -exec rm {} +']) {
    const verdict = predictPrompt(payload({ permission_mode: 'default', tool_input: { command } }), allowed);
    assert.equal(verdict.prompts, true, `"${command}" cannot be statically approved`);
  }

  // plain find is still ordinary, and still covered by its allow rule
  const plain = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'find . -name "*.log"' } }),
    allowed,
  );
  assert.equal(plain.prompts, false);
});

test('the built-in read-only commands raise no card even with no rules at all', () => {
  // Claude Code ships with a set of inspection commands it never prompts for.
  // A user with an empty settings file still gets silence for these.
  for (const command of ['ls -la', 'cat README.md', 'pwd', 'grep -rn foo src', 'head -20 f',
                         'wc -l f', 'which node', 'stat f', 'date', 'git status',
                         'git log --oneline', 'git diff HEAD~1']) {
    const verdict = predictPrompt(payload({ permission_mode: 'default', tool_input: { command } }), rules());
    assert.equal(verdict.prompts, false, `"${command}" is read-only`);
    assert.match(verdict.reason, /read-only/i);
  }

  for (const command of ['terraform apply', 'git push', 'rm -rf build']) {
    const verdict = predictPrompt(payload({ permission_mode: 'default', tool_input: { command } }), rules());
    assert.equal(verdict.prompts, true, `"${command}" is not read-only`);
  }
});

test('a redirect stops a read-only command from being read-only', () => {
  // `cat f` reads; `cat f > /etc/hosts` writes. The program name alone is not
  // enough to decide, so a redirect drops the command out of the safe set.
  const verdict = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'echo boom > /etc/hosts' } }),
    rules(),
  );
  assert.equal(verdict.prompts, true);
});

test('a quoted angle bracket is text, not a redirect', () => {
  // Searching a JS tree for `=>` is an everyday command. Reading the `>` as a
  // redirect drops grep out of the read-only set, matches no rule, and costs
  // the user a card plus a 22-second hold on `grep -rn "=>" src`.
  for (const command of ['grep -rn "=>" src', "grep -rn '2>&1' src",
                         'grep -rn "a > b" src', 'echo "1 > 2"',
                         'grep -rn \\> src']) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'default', tool_input: { command } }),
      rules(),
    );
    assert.equal(verdict.prompts, false, `"${command}" redirects nothing and is read-only`);
    assert.match(verdict.reason, /read-only/i);
  }

  // and a redirect that really is outside the quotes still counts
  for (const command of ['grep -rn "=>" src > hits.txt', 'echo "a" > /etc/hosts']) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'default', tool_input: { command } }),
      rules(),
    );
    assert.equal(verdict.prompts, true, `"${command}" writes a file`);
  }
});

/* an Edit call on one file, in the fixture project */
const edit = (file_path, mode = 'default') =>
  payload({ permission_mode: mode, tool_name: 'Edit', tool_input: { file_path } });

test('an allow rule on a relative path is anchored at the working directory', () => {
  const allowed = rules({ allow: ['Edit(src/**)'] });

  assert.equal(
    predictPrompt(edit('/Users/testuser/Projects/demo/src/app.js'), allowed).prompts, false,
    'the project src is allow-listed',
  );
  assert.equal(
    predictPrompt(edit('/Users/testuser/Projects/demo/vendor/lib/src/app.js'), allowed).prompts, true,
    'an allow rule must not spread to a src directory further down',
  );
});

// ------------------------------------------------------------- Windows paths
/*
 * On Windows every path arrives with backslashes and a drive letter, and neither
 * survives matching that assumes POSIX. This is not cosmetic: a `deny` rule that
 * cannot match is a rule that is not enforced, and because the gate answers
 * PreToolUse with an explicit `allow`, clicking Allow on the card it wrongly
 * raises walks straight past the rule the user wrote to stop exactly that.
 */
const winPayload = (file_path) => payload({
  permission_mode: 'default',
  tool_name: 'Edit',
  cwd: 'C:\\Users\\testuser\\Projects\\demo',
  tool_input: { file_path },
});

test('a deny rule on a path still bites when the path is a Windows one', () => {
  // A deny is a refusal, not a question, so the honest answer is "no card" —
  // but it has to be the deny rule that decided, not the Edit(**) allow beside
  // it. If the deny cannot match, this call is allow-listed instead, and the
  // card that is then raised lets a click on Allow walk past the rule.
  const denied = rules({ allow: ['Edit(**)'], deny: ['Edit(secrets/**)'] });
  const verdict = predictPrompt(
    winPayload('C:\\Users\\testuser\\Projects\\demo\\secrets\\prod.pem'), denied,
  );
  assert.equal(verdict.prompts, false);
  assert.match(verdict.reason, /deny/i, 'the deny rule must be what decided it');
});

test('an allow rule on a path is honoured for a Windows path', () => {
  // the other half of the same bug: an allow rule that cannot match means a card
  // for every single edit, each holding the tool call until it is answered
  const allowed = rules({ allow: ['Edit(src/**)'] });
  assert.equal(
    predictPrompt(winPayload('C:\\Users\\testuser\\Projects\\demo\\src\\app.js'), allowed).prompts,
    false,
    'the project src is allow-listed however the path is spelled',
  );
  assert.equal(
    predictPrompt(winPayload('C:\\Users\\testuser\\Projects\\demo\\vendor\\src\\app.js'), allowed).prompts,
    true,
    'and the anchoring still holds',
  );
});

test('a Windows path is matched without regard to case', () => {
  /*
   * Windows filenames are case-insensitive, so `Secrets` and `secrets` are one
   * directory and a rule written against either has to cover both. Matching
   * case-sensitively there means a deny rule the user believes they wrote is
   * quietly not in force. POSIX paths stay case-sensitive, because there
   * `Secrets` and `secrets` really are two different directories.
   */
  const denied = rules({ allow: ['Edit(**)'], deny: ['Edit(Secrets/**)'] });

  const win = predictPrompt(
    winPayload('C:\\Users\\testuser\\Projects\\demo\\secrets\\prod.pem'), denied,
  );
  assert.match(win.reason, /deny/i, 'the same file in a different case is the same file');

  const posix = predictPrompt(edit('/Users/testuser/Projects/demo/secrets/prod.pem'), denied);
  assert.match(posix.reason, /allow/i,
    'but on a case-sensitive filesystem they are genuinely different directories');
});

test('a single star stops at one path segment, a double star spans them', () => {
  // gitignore semantics: `src/*.js` is the files in src, `src/**/*.js` is the
  // tree under it. Collapsing the two turns a narrow allow rule into a broad one.
  const single = rules({ allow: ['Edit(src/*.js)'] });
  assert.equal(predictPrompt(edit('/Users/testuser/Projects/demo/src/app.js'), single).prompts, false,
    'a file directly in src is covered');
  assert.equal(predictPrompt(edit('/Users/testuser/Projects/demo/src/lib/app.js'), single).prompts, true,
    'a single star must not cross a directory boundary');

  const double = rules({ allow: ['Edit(src/**/*.js)'] });
  for (const file of ['/Users/testuser/Projects/demo/src/lib/app.js',
                      '/Users/testuser/Projects/demo/src/lib/deep/app.js']) {
    assert.equal(predictPrompt(edit(file), double).prompts, false, `${file} is under src`);
  }
  // the `**/` segment may also match nothing at all, so `src/**/*.js` still
  // covers the files sitting directly in src
  assert.equal(predictPrompt(edit('/Users/testuser/Projects/demo/src/app.js'), double).prompts, false,
    'an empty **/ segment still matches');
  assert.equal(predictPrompt(edit('/Users/testuser/Projects/demo/lib/app.js'), double).prompts, true,
    'and what surrounds the ** still has to line up');
});

test('a rule with no argument at all covers every call to that tool', () => {
  // Claude Code writes whole-tool rules without parentheses: "Bash",
  // "WebSearch". There is no pattern to match, and the tool name is the rule.
  const bash = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'terraform apply' } }),
    rules({ allow: ['Bash'] }),
  );
  assert.equal(bash.prompts, false, 'a bare Bash rule covers even terraform apply');

  const search = (allow) => predictPrompt(
    payload({ permission_mode: 'default', tool_name: 'WebSearch', tool_input: { query: 'anything' } }),
    rules({ allow }),
  );
  assert.equal(search(['WebSearch']).prompts, false, 'a bare tool rule needs no argument');
  assert.equal(search(['WebSearch()']).prompts, false, 'and the empty-argument form means the same');
  assert.equal(search(['Bash']).prompts, true, 'but a bare rule still only covers its own tool');
});

test('a star argument covers a tool that takes neither a command nor a path', () => {
  const fetch = (over) => predictPrompt(
    payload({ permission_mode: 'default', tool_name: 'WebFetch', tool_input: { url: 'https://example.test/x' } }),
    rules(over),
  );
  assert.equal(fetch({ allow: ['WebFetch(*)'] }).prompts, false, 'a star covers the whole tool');
  // Only the star form is modelled for these tools. Anything narrower cannot be
  // proved to cover the call, and an unproven rule must leave the card standing
  // rather than assert coverage it has not established.
  assert.equal(fetch({ allow: ['WebFetch(domain:example.test)'] }).prompts, true,
    'a narrower argument is not read as covering everything');
  assert.equal(fetch({ deny: ['WebFetch(domain:other.test)'] }).prompts, true,
    'and it is not read as matching everything on the deny side either');
});

test('a deny rule on a relative path matches at any depth', () => {
  // The asymmetry is deliberate in Claude Code: allow is narrow, deny is broad.
  const denied = rules({ allow: ['Edit(**)'], deny: ['Edit(secrets/**)'] });

  for (const file of ['/Users/testuser/Projects/demo/secrets/key.pem',
                      '/Users/testuser/Projects/demo/packages/api/secrets/key.pem']) {
    const verdict = predictPrompt(edit(file), denied);
    assert.equal(verdict.prompts, false, `${file} is denied`);
    assert.match(verdict.reason, /deny/i);
  }
});

test('a bare filename in a deny rule means that filename anywhere', () => {
  const verdict = predictPrompt(
    edit('/Users/testuser/Projects/demo/packages/api/.env'),
    rules({ allow: ['Edit(**)'], deny: ['Edit(.env)'] }),
  );
  assert.equal(verdict.prompts, false);
  assert.match(verdict.reason, /deny/i);
});

test('the absolute and home-relative path forms are understood', () => {
  assert.equal(
    predictPrompt(edit('/tmp/scratch/notes.md'), rules({ allow: ['Edit(//tmp/**)'] })).prompts, false,
    '// means filesystem-absolute',
  );
  assert.equal(
    predictPrompt(edit(os.homedir() + '/notes/today.md'), rules({ allow: ['Edit(~/notes/**)'] })).prompts, false,
    '~/ means home-relative',
  );
  assert.equal(
    predictPrompt(edit('/etc/hosts'), rules({ allow: ['Edit(//tmp/**)'] })).prompts, true,
    'a path outside the pattern is not covered',
  );
});

test('the real captured settings silence the commands their owner allow-listed', () => {
  // The literal complaint, against the literal settings file it came from.
  const captured = jsonFixture('user-settings.json').permissions;
  const set = rules({ allow: captured.allow });

  for (const command of ['grep -rn foo src', 'ls -la', 'npm test', 'git status',
                         'gh pr list', 'python3 script.py', 'docker compose up -d',
                         'rm -f build.log', 'npm run build && git status']) {
    const verdict = predictPrompt(payload({ permission_mode: 'default', tool_input: { command } }), set);
    assert.equal(verdict.prompts, false, `"${command}" is in the user's allow list`);
  }

  const unlisted = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'terraform apply' } }), set,
  );
  assert.equal(unlisted.prompts, true, 'terraform is not allow-listed and should still ask');
});

test('a command outside the allow rules still raises a card', () => {
  const verdict = predictPrompt(
    payload({ permission_mode: 'manual', tool_input: { command: 'terraform apply' } }),
    rules({ allow: ['Bash(grep:*)', 'Bash(npm:*)'] }),
  );
  assert.equal(verdict.prompts, true);
});

test('a redirection is not a command separator', () => {
  // `2>&1` contains an `&`, but it redirects — it does not begin a new command.
  // Splitting on it produced a bogus sub-command that no allow rule could
  // cover, so an allow-listed command raised a card and held the call: exactly
  // the false-card-plus-stall this module exists to prevent.
  for (const command of [
    'npm test 2>&1',
    'npm run build &> /dev/null',
    'npm test > out.txt 2>&1',
    'npm start >&2',
    'npm test 2>&1 | grep failing',
    // `<&` duplicates an input descriptor; the ampersand redirects here too
    'npm test 0<&3',
  ]) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'default', tool_input: { command } }),
      rules({ allow: ['Bash(npm:*)'] }),
    );
    assert.equal(verdict.prompts, false, `"${command}" is covered by Bash(npm:*)`);
  }
});

test('a backgrounding ampersand still separates commands', () => {
  // the `&` that genuinely separates must keep separating
  const verdict = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: 'npm test & terraform apply' } }),
    rules({ allow: ['Bash(npm:*)'] }),
  );
  assert.equal(verdict.prompts, true);
});

test('an escaped or quoted angle bracket does not turn the next & into a redirect', () => {
  // The guard that spares `2>&1` must read the parsed command, not the raw
  // characters either side. `echo hi\>` ends in a literal `>`, so the `&` after
  // it backgrounds — and swallowing it hides the terraform apply that follows.
  for (const command of ['echo hi\\>& terraform apply', 'echo "hi>"& terraform apply',
                         "echo 'hi>'& terraform apply"]) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'default', tool_input: { command } }),
      rules({ allow: ['Bash(echo:*)'] }),
    );
    assert.equal(verdict.prompts, true, `"${command}" hides a terraform apply`);
  }
});

test('acceptEdits auto-approval is judged per sub-command', () => {
  // `mkdir` heads the line, but `terraform apply` is what the user is blocked
  // on. Reading only the leading program hid a prompt the user had to answer.
  const hidden = predictPrompt(
    payload({ permission_mode: 'acceptEdits', tool_input: { command: 'mkdir -p build && terraform apply' } }),
    rules(),
  );
  assert.equal(hidden.prompts, true, 'terraform apply still needs an answer');

  for (const command of ['mkdir -p build && cp a b', 'mkdir -p build && ls', 'timeout 5 mkdir x']) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'acceptEdits', tool_input: { command } }),
      rules(),
    );
    assert.equal(verdict.prompts, false, `"${command}" is auto-approved throughout`);
  }
});

test('a command Claude Code cannot statically approve is not excused by its path', () => {
  // `find -delete` is destructive and can never be approved from a prefix rule.
  // Spelled with an absolute path it must still be recognised, or it falls
  // through to the read-only set and is reported as a harmless inspection.
  for (const command of ['find . -name "*.log" -delete', '/usr/bin/find . -name "*.log" -delete',
                         '/usr/bin/watch -n1 ls', '/usr/bin/flock /tmp/l ls']) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'default', tool_input: { command } }),
      rules({ allow: ['Bash(find:*)', 'Bash(watch:*)', 'Bash(flock:*)'] }),
    );
    assert.equal(verdict.prompts, true, `"${command}" can never be statically approved`);
  }
});

test('an auto-approved command is recognised when it is spelled with a path', () => {
  // acceptEdits auto-approves mkdir. Spelled /bin/mkdir it must still be
  // recognised, or the mode raises a card Claude Code would never have raised.
  for (const command of ['/bin/mkdir -p build', '/usr/bin/touch a.txt']) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'acceptEdits', tool_input: { command } }),
      rules(),
    );
    assert.equal(verdict.prompts, false, `"${command}" is auto-approved`);
  }
});

test('a trailing wildcard leaves the arguments optional', () => {
  // `Bash(node *)` covers `node` on its own. The boundary is there to stop the
  // rule spilling onto `nodemon`, not to demand that arguments be present.
  for (const rule of ['Bash(node *)', 'Bash(node:*)']) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'default', tool_input: { command: 'node' } }),
      rules({ allow: [rule] }),
    );
    assert.equal(verdict.prompts, false, `${rule} should cover a bare node`);
  }
});

test('a command with nothing in it is not treated as covered', () => {
  // "every sub-command clears a rule" is vacuously true of no sub-commands, so
  // an empty command would sail through as approved by rules it never met.
  for (const command of ['', '   ', '\n']) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'default', tool_input: { command } }),
      rules({ allow: ['Bash(npm:*)'] }),
    );
    assert.equal(verdict.prompts, true, `an empty command must not be read as covered`);
  }
});

test('a backslash inside single quotes is a literal, so the quote still closes', () => {
  // In `cat 'x\'> /etc/hosts` the quoted text is `x\` and the redirect is real.
  // Reading the backslash as an escape leaves the quote open, hides the
  // redirect, and reports a write to /etc/hosts as a read-only inspection.
  const verdict = predictPrompt(
    payload({ permission_mode: 'default', tool_input: { command: "cat 'x\\'> /etc/hosts" } }),
    rules(),
  );
  assert.equal(verdict.prompts, true, 'a redirect outside the quotes is still a redirect');
});

test('each silent mode says which mode silenced the call', () => {
  // The reason is what the gate logs and what a user reads when a card they
  // expected did not appear. A mode falling through to the unrecognised branch
  // still returns "no card", so only the reason can tell the two apart.
  for (const mode of ['auto', 'bypassPermissions', 'dontAsk', 'plan']) {
    const verdict = predictPrompt(payload({ permission_mode: mode }), rules());
    assert.equal(verdict.prompts, false);
    assert.match(verdict.reason, new RegExp(mode), `${mode} should be named in its reason`);
    // the unrecognised branch also says "no card", and quotes the mode name
    // back, so only its absence distinguishes a mode we actually know
    assert.doesNotMatch(verdict.reason, /unrecognised/,
      `${mode} is a mode we know, not one we are merely being careful about`);
  }
});

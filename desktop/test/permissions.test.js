/*
 * Would Claude Code actually stop and ask the user about this call?
 *
 * The overlay only earns the right to show an Allow/Deny card — and to hold the
 * tool call while it waits for a click — when the honest answer is yes.
 */
const test = require('node:test');
const assert = require('node:assert');
const { predictPrompt } = require('../permissions');
const { payload, noRules } = require('./helpers');

test('auto mode never prompts, so it never raises a card', () => {
  // The reported bug: every tool call in auto mode raised a card and was then
  // held for 20 seconds. Auto mode routes actions through a classifier and
  // reports a block as a notification — the user is never asked anything.
  const verdict = predictPrompt(payload({ permission_mode: 'auto' }), noRules());

  assert.equal(verdict.prompts, false);
  assert.match(verdict.reason, /auto/);
});

test('the other non-interactive modes never raise a card either', () => {
  // bypassPermissions skips prompts outright; dontAsk denies anything not
  // pre-approved rather than asking; plan blocks edits and defers shell work.
  for (const mode of ['bypassPermissions', 'dontAsk', 'plan']) {
    const verdict = predictPrompt(payload({ permission_mode: mode }), noRules());
    assert.equal(verdict.prompts, false, `${mode} should not prompt`);
  }
});

test('an unrecognised mode stays silent rather than gating', () => {
  // This is the regression that caused the whole spec. `auto` shipped in a
  // Claude Code release this project had never heard of, and the old fallback
  // for an unknown mode was "gate anyway" — which taxed every tool call by 20s.
  // The costs are not symmetric: a missed card is one context switch, a false
  // card is 20 seconds on every call. Unknown means silent.
  for (const mode of ['someFutureMode', '', undefined, null]) {
    const verdict = predictPrompt(payload({ permission_mode: mode }), noRules());
    assert.equal(verdict.prompts, false, `unknown mode ${mode} must not gate`);
    assert.match(verdict.reason, /unrecognised|unknown/i);
  }
});

test('acceptEdits mode is silent for the edits it auto-approves', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'acceptEdits', tool_name: tool, tool_input: { file_path: '/tmp/x' } }),
      noRules(),
    );
    assert.equal(verdict.prompts, false, `${tool} should be auto-approved`);
  }
});

test('acceptEdits mode is silent for the filesystem commands it auto-approves', () => {
  // Documented set: mkdir, touch, rm, rmdir, mv, cp, sed.
  for (const command of ['mkdir -p build', 'touch a.txt', 'rm old.log', 'rmdir tmp',
                         'mv a b', 'cp a b', 'sed -i s/a/b/ f']) {
    const verdict = predictPrompt(
      payload({ permission_mode: 'acceptEdits', tool_input: { command } }),
      noRules(),
    );
    assert.equal(verdict.prompts, false, `"${command}" should be auto-approved`);
  }
});

test('acceptEdits mode still prompts for other shell commands', () => {
  // The mode auto-approves edits, not arbitrary shell. This is the one case
  // where an acceptEdits user genuinely benefits from a card.
  const verdict = predictPrompt(
    payload({ permission_mode: 'acceptEdits', tool_input: { command: 'terraform apply' } }),
    noRules(),
  );
  assert.equal(verdict.prompts, true);
});

test('manual mode prompts for an unrecognised command', () => {
  for (const mode of ['default', 'manual']) {
    const verdict = predictPrompt(
      payload({ permission_mode: mode, tool_input: { command: 'terraform apply' } }),
      noRules(),
    );
    assert.equal(verdict.prompts, true, `${mode} should prompt`);
  }
});

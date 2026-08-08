/* shared test helpers: fixture loading and payload building */
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');

const fixture = (name) => path.join(FIXTURES, name);
const readFixture = (name) => fs.readFileSync(fixture(name), 'utf8');
const jsonFixture = (name) => JSON.parse(readFixture(name));

/* a PreToolUse payload shaped exactly like Claude Code's hook stdin */
function payload(over = {}) {
  const { tool_input, ...rest } = over;
  return {
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/Users/testuser/Projects/demo',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi', ...tool_input },
    tool_use_id: 'toolu_01',
    ...rest,
  };
}

/* an empty ruleset, so mode behaviour can be tested without rule interference */
const noRules = () => ({ allow: [], deny: [], ask: [] });

module.exports = { fixture, readFixture, jsonFixture, payload, noRules, FIXTURES };

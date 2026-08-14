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

/*
 * Shift a transcript's timestamps so its newest entry is `msAgo` old, keeping
 * the gaps between entries intact.
 *
 * How old the watcher thinks a session is comes from the timestamps inside the
 * transcript, not from the file's mtime — Claude Code rewrites a transcript to
 * record a title or the last prompt long after the conversation ended, so mtime
 * says a dead session is live. Ageing content is therefore what a test means by
 * ageing a session; touching mtime tests only the no-timestamps fallback.
 */
function ageTranscript(body, msAgo) {
  const lines = body.trim().split('\n');
  const stamps = [];
  for (const line of lines) {
    try {
      const t = Date.parse(JSON.parse(line).timestamp);
      if (!Number.isNaN(t)) stamps.push(t);
    } catch { /* bookkeeping lines carry no timestamp, by design */ }
  }
  if (!stamps.length) return body;
  const shift = (Date.now() - msAgo) - Math.max(...stamps);
  return lines.map((line) => {
    let j;
    try { j = JSON.parse(line); } catch { return line; }
    const t = Date.parse(j.timestamp);
    if (Number.isNaN(t)) return line;
    j.timestamp = new Date(t + shift).toISOString();
    return JSON.stringify(j);
  }).join('\n') + '\n';
}

module.exports = {
  fixture, readFixture, jsonFixture, payload, noRules, ageTranscript, FIXTURES,
};

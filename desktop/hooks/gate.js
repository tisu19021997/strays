#!/usr/bin/env node
/*
 * strays approval gate — a Claude Code PreToolUse hook.
 *
 * The gate's job is NOT to show a card for every tool call. It is to predict
 * whether Claude Code is about to stop and ask the user something, and to offer
 * that question on the overlay instead. When Claude Code would not have asked,
 * the gate must cost nothing: no card, no file, no wait.
 *
 * That distinction is the whole point. An earlier version gated any permission
 * mode it did not recognise, met the `auto` mode of a newer Claude Code, and
 * held every single tool call for twenty seconds waiting for a click the user
 * had no reason to make. See permissions.js for why unknown now means silent.
 *
 * Flow, when a card IS warranted: write the request to <home>/pending/, the
 * overlay shows the card and writes <home>/replies/<id>.json, and this script
 * prints the permission decision. If nothing answers in time it exits silently
 * and Claude Code's own prompt takes over — always well inside the hook's
 * timeout, which would otherwise block the tool call entirely.
 *
 * Installed into ~/.claude/settings.json by `npm run hooks` (remove with
 * `npm run unhook`). Enable/disable at runtime from the tray: 🐾 → Approvals.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { predictPrompt } = require('../permissions');
const { loadRules } = require('../settings');

// STRAYS_HOME lets the tests drive a throwaway state directory
const BASE = process.env.STRAYS_HOME || path.join(os.homedir(), '.strays');
const FLAG = path.join(BASE, 'approvals-on');
const ALIVE = path.join(BASE, 'overlay.alive');
const PENDING = path.join(BASE, 'pending');
const REPLIES = path.join(BASE, 'replies');
const LOG = path.join(BASE, 'gate.log');
const LOG_CAP_BYTES = 100 * 1024;
const POLL_MS = 150;

// what Claude Code allows this hook if its settings cannot be read
const DEFAULT_HOOK_TIMEOUT_MS = 30 * 1000;
// how much of that budget is left to Claude Code to finish the call
const RESERVE_MS = 3 * 1000;
const MIN_HOLD_MS = 500;

/*
 * How long the gate may hold a tool call. Derived, never written down beside
 * the timeout: the shipped bug was a 20s wait sitting next to a 30s timeout,
 * with nothing tying the two together if either changed.
 */
function maxHoldMs(hookTimeout) {
  const timeout = Number(hookTimeout) || DEFAULT_HOOK_TIMEOUT_MS;
  const reserve = Math.max(RESERVE_MS, timeout * 0.25);
  return Math.max(MIN_HOLD_MS, Math.min(timeout - reserve, timeout - MIN_HOLD_MS));
}

/*
 * How the installer marks its own hook entries. Path-independent on purpose:
 * the old marker was the "claude-pet" in the checkout path, so a renamed or
 * relocated clone stopped being recognisable. Entries from before the sentinel
 * are still honoured, but only once no sentinel entry has been found.
 */
const HOOK_SENTINEL = '--strays-hook';
// installs that predate the rename: the old sentinel, and older still,
// the project's own name inside the checkout path
const LEGACY_HOOK_MARKERS = ['--pets-hook', 'claude-pet'];

/*
 * The timeout Claude Code was configured to give this hook, read from the
 * settings the installer wrote it into. Falls back to the environment, then to
 * the installer's own default. Guessing 30s inside an 8s timeout is not a safe
 * default: the hold outlives the hook, so Claude Code kills the gate while the
 * card is still promising the user time to click.
 */
function hookTimeoutMs(configDir) {
  const fromEnv = Number(process.env.STRAYS_HOOK_TIMEOUT);
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')); }
  catch { settings = {}; }

  const entries = (settings.hooks && settings.hooks.PreToolUse) || [];
  let legacy = 0;
  for (const entry of entries) {
    for (const hook of (entry && entry.hooks) || []) {
      const command = typeof hook.command === 'string' ? hook.command : '';
      const timeout = Number(hook.timeout);
      if (!(timeout > 0)) continue;
      if (command.includes(HOOK_SENTINEL)) return timeout * 1000;
      if (!legacy && LEGACY_HOOK_MARKERS.some((m) => command.includes(m))) legacy = timeout * 1000;
    }
  }
  if (legacy) return legacy;
  return fromEnv > 0 ? fromEnv * 1000 : DEFAULT_HOOK_TIMEOUT_MS;
}

// where Claude Code keeps the settings whose rules the prediction needs
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
/*
 * Managed (enterprise) settings, per platform. Getting this wrong is quiet and
 * one-directional: the file simply fails to read, every managed deny and ask
 * rule drops out of the merge, and calls an administrator forbade look ordinary.
 */
function managedSettingsPath() {
  if (process.platform === 'darwin') {
    return '/Library/Application Support/ClaudeCode/managed-settings.json';
  }
  if (process.platform === 'win32') {
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    return path.join(programData, 'ClaudeCode', 'managed-settings.json');
  }
  return '/etc/claude-code/managed-settings.json';
}

const MANAGED_SETTINGS = managedSettingsPath();

/* the scopes to merge for one tool call: the project is wherever it runs */
const scopesFor = (req) => ({
  managedPath: MANAGED_SETTINGS,
  userDir: CONFIG_DIR,
  projectDir: req.cwd || process.cwd(),
  localCwd: req.cwd || process.cwd(),
});

// tools Claude Code can prompt for, and how to describe each on the card
const GATED_TOOLS = {
  Bash: (i) => String(i.command || ''),
  Write: (i) => 'write ' + String(i.file_path || ''),
  Edit: (i) => 'edit ' + String(i.file_path || ''),
  MultiEdit: (i) => 'edit ' + String(i.file_path || ''),
  NotebookEdit: (i) => 'edit ' + String(i.notebook_path || ''),
};

function log(line) {
  try {
    // rotate rather than delete: the old generation is the bug report
    try { if (fs.statSync(LOG).size > LOG_CAP_BYTES) fs.renameSync(LOG, LOG + '.1'); }
    catch { /* no log yet, or it vanished under us */ }
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n');
  } catch { /* logging never blocks the gate */ }
}

function out(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
}

function overlayAlive() {
  try { return Date.now() - fs.statSync(ALIVE).mtimeMs < 15 * 1000; }
  catch { return false; }
}

/*
 * A request outlives its tool call only when the gate died badly, and a request
 * that outlives its call is a card for a command that already ran. Anything
 * past its expiry goes; anything from a version that recorded no expiry is
 * judged on the file's own age, since it cannot be judged on its contents.
 */
function pruneExpiredRequests(now, ttl) {
  let names = [];
  try { names = fs.readdirSync(PENDING); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(PENDING, name);
    try {
      let expiry = null;
      try { expiry = JSON.parse(fs.readFileSync(file, 'utf8')).expires_at; } catch { /* unreadable */ }
      if (!Number.isFinite(expiry)) expiry = fs.statSync(file).mtimeMs + ttl;
      if (expiry <= now) fs.unlinkSync(file);
    } catch { /* someone else cleaned up first */ }
  }
}

/*
 * A reply nobody is waiting for. The gate that asked has gone, so the click it
 * carries can never be honoured — and leaving it on disk risks it being read as
 * an answer to some later request that happens to reuse the id.
 */
function sweepOrphanReplies(now, ttl) {
  let names = [];
  try { names = fs.readdirSync(REPLIES); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const waiting = fs.existsSync(path.join(PENDING, name));
      const stale = now - fs.statSync(path.join(REPLIES, name)).mtimeMs > ttl;
      if (!waiting || stale) fs.unlinkSync(path.join(REPLIES, name));
    } catch { /* someone else cleaned up first */ }
  }
}

/*
 * The gate's own request, removed on every way out of the process. try/finally
 * covers a normal return and a throw; it does not cover the tool call being
 * cancelled, which kills the hook outright — hence the signal handlers.
 */
let ownRequest = null;

function releaseOwnRequest() {
  if (!ownRequest) return;
  try { fs.unlinkSync(ownRequest); } catch { /* already gone */ }
  ownRequest = null;
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => { releaseOwnRequest(); process.exit(0); });
}
process.on('exit', releaseOwnRequest);

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let req;
  try { req = JSON.parse(input); } catch { log('skip: unparseable stdin'); return; }
  const mode = req.permission_mode || '?';
  const tool = req.tool_name;

  // pass through instantly unless the user opted in AND the overlay is up
  if (!fs.existsSync(FLAG)) { log(`skip: approvals toggle off (tool=${tool} mode=${mode})`); return; }
  if (!overlayAlive()) { log(`skip: overlay not running (tool=${tool} mode=${mode})`); return; }
  const describe = GATED_TOOLS[tool];
  if (!describe || !req.tool_input) { log(`skip: tool=${tool} is never prompted for`); return; }

  // clear other sessions' wreckage before deciding anything about this call
  const holdMs = maxHoldMs(hookTimeoutMs(CONFIG_DIR));
  pruneExpiredRequests(Date.now(), holdMs);
  sweepOrphanReplies(Date.now(), holdMs);

  // the load-bearing question: would Claude Code actually ask the user?
  let rules = { allow: [], deny: [], ask: [] };
  try { rules = loadRules(scopesFor(req)); }
  catch (e) { log('settings unreadable, assuming no rules: ' + e.message); }
  const verdict = predictPrompt(req, rules);
  if (!verdict.prompts) { log(`skip: ${verdict.reason} (tool=${tool})`); return; }

  const detail = describe(req.tool_input).slice(0, 400);
  log(`gate: ${verdict.reason} tool=${tool} ${detail.slice(0, 80)}`);

  fs.mkdirSync(PENDING, { recursive: true });
  fs.mkdirSync(REPLIES, { recursive: true });

  const id = Date.now() + '-' + process.pid;
  const pendingFile = path.join(PENDING, id + '.json');
  const replyFile = path.join(REPLIES, id + '.json');
  const ts = Date.now();
  ownRequest = pendingFile;
  fs.writeFileSync(pendingFile, JSON.stringify({
    id,
    tool,
    command: detail,
    description: req.tool_input.description || '',
    session_id: req.session_id || '',
    cwd: req.cwd || '',
    ts,
    // the overlay uses this to refuse a card for a call that has already gone
    expires_at: ts + holdMs,
  }));

  const deadline = ts + holdMs;
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(replyFile)) {
        const reply = JSON.parse(fs.readFileSync(replyFile, 'utf8'));
        fs.unlinkSync(replyFile);
        // a click answers the card it was made on, never merely the one whose
        // turn it is: an id that is not ours belongs to another session
        if (reply.id && reply.id !== id) {
          log(`ignored: reply for ${reply.id} arrived on ${id}`);
          continue;
        }
        log('decision: ' + reply.decision);
        if (reply.decision === 'allow') out('allow', 'approved from the strays overlay');
        else if (reply.decision === 'deny') out('deny', 'denied from the strays overlay');
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    log('timeout: no click, falling through to the terminal prompt');
  } finally {
    releaseOwnRequest();
  }
}

// only run when Claude Code invokes the file; requiring it must not read stdin
if (require.main === module) main().then(() => process.exit(0), () => process.exit(0));

module.exports = { maxHoldMs, hookTimeoutMs, DEFAULT_HOOK_TIMEOUT_MS };

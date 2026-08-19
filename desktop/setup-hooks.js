#!/usr/bin/env node
/*
 * Installs (or removes) the strays hooks in ~/.claude/settings.json.
 *
 *   npm run hooks      add both hooks (backs up settings first)
 *   npm run unhook     remove every strays hook entry
 *
 * Two hooks, installed and removed together:
 *   PreToolUse    hooks/gate.js          the Allow/Deny approval gate
 *   SessionStart  hooks/session-start.js records which terminal hosts a session
 *
 * Both are inert unless the overlay is running — the gate additionally needs
 * approvals enabled in the tray menu. Otherwise they exit instantly with no
 * opinion and no files.
 *
 * Only entries whose command contains the claude-pet marker are ever touched,
 * so hooks belonging to other tools in the same settings file survive both
 * install and removal.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// CLAUDE_CONFIG_DIR is Claude Code's own override; honouring it also keeps the
// tests off the real settings file
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CONFIG_DIR, 'settings.json');
/*
 * A sentinel we put on our own hook commands so we can find them again. It
 * deliberately avoids the string "claude-pet": the path alone only carries
 * that because the checkout happens to be named that, so moving or renaming
 * the clone would strand the old entries and a reinstall would stack a copy.
 */
const SENTINEL = '--strays-hook';
// installs that predate the rename: the old sentinel, and older still,
// the project's own name inside the checkout path
const LEGACY_MARKERS = ['--pets-hook', 'claude-pet'];
const remove = process.argv.includes('--remove');

const HOOKS = [
  {
    event: 'PreToolUse',
    script: 'gate.js',
    // every tool Claude Code prompts for in manual mode; the gate itself
    // decides per permission-mode whether a card is warranted
    matcher: '^(Write|Edit|MultiEdit|NotebookEdit|Bash)$',
    timeout: 30,
    what: 'approval gate',
  },
  {
    event: 'SessionStart',
    script: 'session-start.js',
    timeout: 5,
    what: 'session-host recorder',
  },
];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
catch (e) {
  if (fs.existsSync(SETTINGS)) {
    console.error(SETTINGS + ' exists but is not valid JSON — fix it first.');
    process.exit(1);
  }
}

// backup before touching anything
if (fs.existsSync(SETTINGS)) {
  const backup = SETTINGS + '.strays-backup-' + Date.now();
  fs.copyFileSync(SETTINGS, backup);
  console.log('backed up settings to', backup);
}

const isOurs = (entry) =>
  entry && Array.isArray(entry.hooks) &&
  entry.hooks.some((h) => typeof h.command === 'string' &&
    (h.command.includes(SENTINEL) || LEGACY_MARKERS.some((m) => h.command.includes(m))));

/*
 * What Claude Code should actually run for a hook.
 *
 * `node "<script>"` is right for every install that arrived through npm, because
 * having npm means having node. It is wrong for the downloadable app, whose
 * whole reason to exist is people who have neither: Claude Code runs a hook by
 * handing the command to a shell, and on those machines there is no `node` on
 * the PATH for the shell to find. The app does ship a Node — Electron is one,
 * and ELECTRON_RUN_AS_NODE makes its own binary behave as one.
 *
 * Which it is comes in as `--app <path-to-the-executable>` rather than being
 * sniffed out of process.execPath, because the caller always knows and a guess
 * here fails silently: a wrong hook command does not error, it just means
 * approval cards that never appear, for a reason nothing on screen explains.
 */
const appArg = process.argv.indexOf('--app');
const APP_EXEC = appArg >= 0 ? process.argv[appArg + 1] : null;

const hookCommand = (script) => (APP_EXEC
  ? `ELECTRON_RUN_AS_NODE=1 "${APP_EXEC}" "${script}" ${SENTINEL}`
  : `node "${script}" ${SENTINEL}`);

settings.hooks = settings.hooks || {};

for (const hook of HOOKS) {
  const script = path.join(__dirname, 'hooks', hook.script);
  const existing = settings.hooks[hook.event] || [];
  // always drop stale entries of ours (old paths, re-installs)
  const kept = existing.filter((e) => !isOurs(e));
  const dropped = existing.length - kept.length;

  if (remove) {
    console.log(dropped
      ? `removed the ${hook.what} from ${hook.event}.`
      : `no ${hook.what} was registered on ${hook.event}.`);
  } else {
    kept.push({
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      hooks: [{ type: 'command', command: hookCommand(script), timeout: hook.timeout }],
    });
    console.log(`${dropped ? 'replaced' : 'installed'} the ${hook.what}: ${script}`);
  }

  if (kept.length) settings.hooks[hook.event] = kept;
  else delete settings.hooks[hook.event];
}

if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log('wrote', SETTINGS);

if (!remove) console.log('enable approvals from the tray: 🐾 → "Command approvals (Allow/Deny)"');
// hook configuration is read once, when a session starts
console.log('restart any open Claude Code sessions — running sessions keep the hooks they started with.');

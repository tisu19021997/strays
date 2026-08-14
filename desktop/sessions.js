/*
 * Where a pet click should land.
 *
 * Two halves. loadDesktopIndex does the reading: the Claude desktop app keeps
 * one JSON record per conversation, and that record is the only place the
 * desktop-side id of a session is written down. resolveJumpTarget does the
 * deciding, and is pure — it describes an action rather than performing one, so
 * the whole decision, which is where the bugs live, is testable without
 * Electron, without AppleScript and without opening anything.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/* the desktop app's store: <root>/<accountId>/<orgId>/<desktopSessionId>.json */
const SESSIONS_ROOT = path.join(
  os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions',
);

/*
 * Hundreds of records, re-read on every click. A directory's mtime changes when
 * a record is added or removed, which is the only change that can add or drop
 * an index entry, so the directory mtimes are a sufficient cache key.
 */
let cache = { root: null, stamp: null, index: {} };

function dirStamp(root) {
  const parts = [];
  const walk = (dir, depth) => {
    let st;
    try { st = fs.statSync(dir); } catch { return; }
    parts.push(dir + ':' + st.mtimeMs);
    if (!depth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), depth - 1);
  };
  walk(root, 2);
  return parts.join('|');
}

/**
 * The desktop app's session records keyed by Claude Code session id.
 * A missing, unreadable or half-written store yields an empty index rather than
 * a throw: a click that cannot be resolved must still fall back, not crash.
 *
 * @param {string} [root]  the store directory; tests point this elsewhere
 * @returns {Object<string, object>}
 */
function loadDesktopIndex(root = SESSIONS_ROOT) {
  const stamp = dirStamp(root);
  if (cache.root === root && cache.stamp === stamp) return cache.index;

  const index = {};
  const collect = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth) collect(full, depth - 1); continue; }
      if (!e.name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (rec && typeof rec.cliSessionId === 'string' && typeof rec.sessionId === 'string') {
          index[rec.cliSessionId] = rec;
        }
      } catch { /* half-written, or not a session record — skip it */ }
    }
  };
  collect(root, 2);

  cache = { root, stamp, index };
  return index;
}

/* where hooks/session-start.js leaves what it saw */
const PETS_HOME = process.env.STRAYS_HOME || path.join(os.homedir(), '.strays');

/**
 * What the SessionStart hook recorded about a session's host terminal, or null
 * if the hook was never installed, was inert, or the record has been pruned.
 *
 * @param {string} sessionId
 * @param {string} [base]  the strays state directory
 * @returns {?{termProgram: ?string, bundleId: ?string, ppid: ?number, tty: ?string}}
 */
function readSessionHost(sessionId, base = PETS_HOME) {
  if (!sessionId || !/^[\w-]+$/.test(String(sessionId))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(base, 'sessions', sessionId + '.json'), 'utf8')); }
  catch { return null; }
}

/* focus an existing desktop-app conversation by the desktop app's own id */
const EPITAXY_URL = 'claude://claude.ai/epitaxy/';

/*
 * Import a CLI session into the desktop app. The importer derives the desktop
 * id as "local_" + cliSessionId and only skips the import when a session with
 * exactly that id already exists — which, on the development machine, is true
 * of 5 records out of 670. Reaching for this route with a session the index
 * already knows about therefore creates a duplicate conversation. It is a last
 * resort, only for a desktop session the index has never heard of.
 */
const RESUME_URL = 'claude://resume?session=';

/*
 * How recently the desktop app must have focused a conversation for us to treat
 * it as still on screen.
 *
 * The deep link below navigates: it replaces whatever the window is showing with
 * the one conversation, which collapses a multi-pane layout down to a single
 * session. That is the right thing when the session you clicked is somewhere
 * else, and destructive when it was already in front of you.
 *
 * Which panes are currently open is not something we can read. The desktop app
 * keeps it in `extraPanesByMode` inside its Chromium leveldb store, snappy
 * compressed, in a private format with no compatibility promise — reading that
 * to decide a click would break on a release we cannot see coming. What every
 * session record does carry is `lastFocusedAt`, and in a multi-pane layout you
 * are moving between the visible panes constantly, so all of them are freshly
 * focused. A session focused within this window is therefore assumed to be on
 * screen already, and gets the app brought forward instead of a navigation.
 */
const LAYOUT_WINDOW_MS = 10 * 60 * 1000;

/* transcripts written by the desktop app record this entrypoint */
const DESKTOP_ENTRYPOINT = 'claude-desktop';

/* and a session started from a shell records this one */
const CLI_ENTRYPOINT = 'cli';

/* terminals a CLI session might be living in, in the order we would guess */
const TERMINAL_APPS = ['Ghostty', 'iTerm2', 'WezTerm', 'kitty', 'Alacritty', 'Warp', 'Terminal'];

/* the whole guess list: the desktop app outranks any terminal when we have no
 * idea which host a session belongs to, because it usually is the host */
const JUMP_APPS = ['Claude', ...TERMINAL_APPS];

/*
 * What the SessionStart recorder saw, translated into an application name
 * AppleScript can activate. The bundle identifier is checked first because
 * TERM_PROGRAM is set by the shell and survives being inherited, whereas
 * __CFBundleIdentifier comes from the launching application itself.
 * Anything absent from both tables (tmux, ssh, a bare login shell) leaves the
 * host unknown, which is honest: guessing is what the fallback is for.
 */
const HOST_BY_BUNDLE_ID = {
  'com.apple.Terminal': 'Terminal',
  'com.googlecode.iterm2': 'iTerm2',
  'com.mitchellh.ghostty': 'Ghostty',
  'com.github.wez.wezterm': 'WezTerm',
  'net.kovidgoyal.kitty': 'kitty',
  'org.alacritty': 'Alacritty',
  'dev.warp.Warp-Stable': 'Warp',
  'com.microsoft.VSCode': 'Code',
  'com.todesktop.230313mzl4w4u92': 'Cursor',
};

const HOST_BY_TERM_PROGRAM = {
  Apple_Terminal: 'Terminal',
  'iTerm.app': 'iTerm2',
  ghostty: 'Ghostty',
  WezTerm: 'WezTerm',
  kitty: 'kitty',
  alacritty: 'Alacritty',
  WarpTerminal: 'Warp',
  vscode: 'Code',
  Hyper: 'Hyper',
};

function hostApp(host) {
  if (!host) return null;
  return HOST_BY_BUNDLE_ID[host.bundleId] || HOST_BY_TERM_PROGRAM[host.termProgram] || null;
}

/* `ps -axco command` reports the executable name, which is often lowercase */
function firstRunning(candidates, running) {
  const names = new Set(running || []);
  return candidates.find((app) => names.has(app) || names.has(app.toLowerCase())) || null;
}

/*
 * Is this conversation probably already visible in the window as it stands?
 * An archived one certainly is not, whatever its focus timestamp says.
 */
function looksOnScreen(record, now) {
  if (!record || record.isArchived) return false;
  const at = record.lastFocusedAt;
  return typeof at === 'number' && at > 0 && now - at < LAYOUT_WINDOW_MS;
}

/**
 * @param {object} args
 * @param {object} args.session       a watcher session { id, entrypoint, ... }
 * @param {object} args.desktopIndex  desktop records keyed by cliSessionId
 * @param {object} [args.config]      ~/.strays/config.json; jumpApp, jumpMode
 * @param {number} [args.now]         injected so the layout window is testable
 * @returns {{kind: string, url?: string, app?: string, reason?: string}}
 */
function resolveJumpTarget({
  session, desktopIndex, running, config, platform, host, now = Date.now(),
} = {}) {
  // both mechanisms — the claude:// deep link and application activation —
  // are macOS-only, so elsewhere the honest answer is that there is nowhere
  // to go rather than a destination that silently fails
  if (platform !== 'darwin') {
    return { kind: 'none', reason: 'jumping to a session is only implemented on macOS' };
  }

  const pinned = config && typeof config.jumpApp === 'string' && config.jumpApp.trim();
  if (pinned) return { kind: 'activate', app: pinned };

  const record = session && desktopIndex && desktopIndex[session.id];
  if (record && typeof record.sessionId === 'string' && record.sessionId) {
    /*
     * "never" is for people who work in a multi-pane layout all day and would
     * rather always land on the app as it is than ever have it rearranged;
     * "always" is the behaviour from before the layout was worth protecting.
     */
    const mode = (config && config.jumpMode) || 'auto';
    if (mode === 'never') {
      return { kind: 'activate', app: 'Claude', reason: 'jumpMode never navigates' };
    }
    if (mode !== 'always' && looksOnScreen(record, now)) {
      return {
        kind: 'activate',
        app: 'Claude',
        reason: 'focused recently, so it is probably already on screen',
      };
    }
    return { kind: 'open-url', url: EPITAXY_URL + encodeURIComponent(record.sessionId) };
  }
  if (session && session.entrypoint === DESKTOP_ENTRYPOINT && session.id) {
    return { kind: 'open-url', url: RESUME_URL + encodeURIComponent(session.id) };
  }

  if (session && session.entrypoint === CLI_ENTRYPOINT) {
    const recorded = hostApp(host);
    if (recorded) return { kind: 'activate', app: recorded };
    // it is not in the desktop app, so guessing at the desktop app is wrong
    return { kind: 'activate', app: firstRunning(TERMINAL_APPS, running) || 'Terminal' };
  }

  // nothing identifies the host: the pre-deep-link guess, kept verbatim
  return { kind: 'activate', app: firstRunning(JUMP_APPS, running) || 'Terminal' };
}

module.exports = {
  resolveJumpTarget, loadDesktopIndex, readSessionHost, LAYOUT_WINDOW_MS,
};

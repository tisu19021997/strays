/*
 * strays desktop overlay.
 *
 * A transparent, click-through lane along the bottom of your screen where the
 * team lives, floating above every window. Hovering a pet (or an approval
 * card) makes the lane briefly interactive; everywhere else stays click-through.
 *
 * Crew-style features:
 *   - per-session live states from ~/.claude/projects (thinking/tool/waiting/done)
 *   - needs-you: a blocked session makes its pet hop with ❗
 *   - tap a pet -> its own conversation comes to the front (macOS)
 *   - Allow/Deny approval cards, via the PreToolUse gate (npm run hooks)
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ClaudeWatcher } = require('./watcher');
const { UsageTracker } = require('./usage');
const { resolveJumpTarget, loadDesktopIndex, readSessionHost } = require('./sessions');
const { Approvals } = require('./approvals');

const LANE_HEIGHT = 190;

const BASE_DIR = path.join(os.homedir(), '.strays');
const CUSTOM_PETS_FILE = path.join(BASE_DIR, 'custom-pets.json');
const APPROVALS_FLAG = path.join(BASE_DIR, 'approvals-on');
const ALIVE_FILE = path.join(BASE_DIR, 'overlay.alive');
const PENDING_DIR = path.join(BASE_DIR, 'pending');
const REPLIES_DIR = path.join(BASE_DIR, 'replies');

let win = null;
let tray = null;
let watcher = null;
let usage = null;
let usageLine = null;
let paused = false;
let party = false;
let followClaude = true;
let aliveTimer = null;

const debug = (...a) => process.env.STRAYS_DEBUG && console.log(...a);

/*
 * Everything about which requests deserve a card, and where a click goes, lives
 * in approvals.js — this file only carries them between there and the renderer.
 */
const approvals = new Approvals({
  pendingDir: PENDING_DIR,
  repliesDir: REPLIES_DIR,
  enabled: () => fs.existsSync(APPROVALS_FLAG),
  onRequest: (req) => send('approval-request', req),
  onRemove: (id) => send('approval-remove', id),
  debug,
});

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y + workArea.height - LANE_HEIGHT,
    width: workArea.width,
    height: LANE_HEIGHT,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // clicks fall through to whatever is underneath; forwarded moves keep hover working
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'overlay.html'));

  if (process.env.STRAYS_DEBUG) {
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[overlay]', msg));
  }

  win.webContents.on('did-finish-load', () => {
    try {
      const defs = JSON.parse(fs.readFileSync(CUSTOM_PETS_FILE, 'utf8'));
      if (Array.isArray(defs) && defs.length) send('custom-pets', defs);
    } catch { /* no custom pets — fine */ }
    // surface approvals that arrived before the window was ready
    approvals.scanPending();
  });

  screen.on('display-metrics-changed', positionWindow);
  screen.on('display-added', positionWindow);
  screen.on('display-removed', positionWindow);
}

function positionWindow() {
  if (!win) return;
  const { workArea } = screen.getPrimaryDisplay();
  win.setBounds({
    x: workArea.x,
    y: workArea.y + workArea.height - LANE_HEIGHT,
    width: workArea.width,
    height: LANE_HEIGHT,
  });
}

// ------------------------------------------------------------------- tray
// A real template image — an empty image + emoji title can render zero-width
// (invisible) in the macOS menu bar, especially next to a notch.
const PAW_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALklEQVR4nGNgoDL4j4SJ4Q9CA6gG/uPAFGkmyhBCmgkaMvAGEGMIUYAizSMNAACPjVSs6AupdQAAAABJRU5ErkJggg==';

function createTray() {
  const icon = nativeImage.createFromDataURL(PAW_PNG);
  icon.setTemplateImage(true); // adapts to light/dark menu bar
  tray = new Tray(icon);
  tray.setToolTip('strays');
  debug('[tray] created');
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'strays', enabled: false },
    ...(usageLine ? [{ label: usageLine, enabled: false }] : []),
    { type: 'separator' },
    {
      label: 'Follow Claude Code sessions',
      type: 'checkbox',
      checked: followClaude,
      click: (item) => {
        followClaude = item.checked;
        // switching off empties the renderer's session list, so switching back
        // on has to re-announce: the watcher deduplicates, and a session parked
        // in `waiting` would otherwise leave every pet unbound indefinitely
        if (!followClaude) send('claude-status', { state: null, sessions: [] });
        else if (watcher) { watcher.forceNextEmit(); watcher.poll(); }
      },
    },
    {
      label: 'Command approvals (Allow/Deny)',
      type: 'checkbox',
      checked: fs.existsSync(APPROVALS_FLAG),
      click: (item) => {
        if (item.checked) fs.writeFileSync(APPROVALS_FLAG, '');
        else { try { fs.unlinkSync(APPROVALS_FLAG); } catch { /* gone */ } }
      },
    },
    {
      label: 'Party mode',
      type: 'checkbox',
      checked: party,
      click: (item) => { party = item.checked; send('party', party); },
    },
    { label: 'Celebrate', click: () => send('celebrate') },
    { type: 'separator' },
    {
      label: paused ? 'Resume pets' : 'Pause pets',
      click: () => {
        paused = !paused;
        if (paused) win.hide(); else win.show();
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --------------------------------------------------------- jump to session
// sessions.js decides where a click should land; everything here just performs
// the description and says so when it fails. Override the destination with
// { "jumpApp": "iTerm2" } in ~/.strays/config.json.
function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'config.json'), 'utf8')) || {}; }
  catch { return {}; /* no config — resolve automatically */ }
}

function performJump(action) {
  if (action.kind === 'open-url') {
    debug('[jump] opening', action.url);
    return execFile('open', [action.url], (err) => {
      if (err) debug('[jump] open failed:', err.message);
    });
  }
  if (action.kind === 'activate') {
    debug('[jump] activating', action.app);
    return execFile(
      'osascript', ['-e', `tell application "${action.app.replace(/"/g, '')}" to activate`],
      (err) => { if (err) debug('[jump] activate failed:', err.message); },
    );
  }
  debug('[jump] nothing to do:', action.reason);
}

function jumpToSession(session) {
  const config = readConfig();
  const platform = process.platform;
  if (platform !== 'darwin') return performJump(resolveJumpTarget({ session, config, platform }));

  execFile('ps', ['-axco', 'command'], (err, stdout) => {
    // an unreadable process list only costs us the terminal guess
    const running = err ? [] : stdout.split('\n').map((s) => s.trim());
    performJump(resolveJumpTarget({
      session,
      desktopIndex: loadDesktopIndex(),
      running,
      config,
      platform,
      host: readSessionHost(session && session.id, BASE_DIR),
    }));
  });
}

// ------------------------------------------------------------------ boot
app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();
  approvals.ensureDirs();
  createWindow();
  createTray();
  approvals.watch();
  // ~670 records take about half a second to read cold; pay that at boot
  // rather than on the first pet click
  if (process.platform === 'darwin') loadDesktopIndex();

  // Heartbeat so the gate knows the overlay is alive — the gate reads its
  // mtime, never its contents, so the file carries the pid instead and
  // `npm run stop` can find us without knowing the checkout's name.
  const beat = () => { try { fs.writeFileSync(ALIVE_FILE, String(process.pid)); } catch { /* ro fs */ } };
  beat();
  aliveTimer = setInterval(beat, 5000);

  // hovering a pet or a card -> catch clicks; leaving -> click-through again
  ipcMain.on('set-interactive', (_e, interactive) => {
    if (win) win.setIgnoreMouseEvents(!interactive, { forward: true });
  });

  ipcMain.on('approval-reply', (_e, { id, decision }) => {
    debug('[approval] reply', id, decision);
    approvals.reply(id, decision);
  });

  ipcMain.on('jump-to-session', (_e, session) => jumpToSession(session));

  watcher = new ClaudeWatcher(
    (status) => {
      debug('[status]', status.state, JSON.stringify(status.sessions.map((s) => s.state)));
      if (followClaude) send('claude-status', status);
      if (tray) {
        // the paw icon carries the identity; the title is just a status suffix
        const active = status.sessions.filter((s) => s.state === 'thinking' || s.state === 'tool').length;
        tray.setTitle(
          status.state === 'working' ? ' ' + active
          : status.state === 'needs-you' ? ' ❗'
          : ''
        );
      }
    },
    () => followClaude && send('celebrate')
  );
  watcher.start();

  usage = new UsageTracker((stats) => {
    debug('[usage]', JSON.stringify(stats));
    send('usage', stats);
    const tok = stats.input + stats.output + stats.cacheRead + stats.cacheWrite;
    const fmt = tok >= 1e6 ? (tok / 1e6).toFixed(1) + 'M' : Math.round(tok / 1e3) + 'k';
    usageLine = `Today: ${fmt} tok · ~$${stats.cost.toFixed(2)}${stats.unpriced ? '+' : ''}`;
    rebuildTrayMenu();
  });
  usage.start();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  approvals.stop();
  if (watcher) watcher.stop();
  if (usage) usage.stop();
  clearInterval(aliveTimer);
  try { fs.unlinkSync(ALIVE_FILE); } catch { /* gone */ }
});

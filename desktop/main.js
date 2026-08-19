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
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, powerMonitor, clipboard, dialog, shell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ClaudeWatcher } = require('./watcher');
const { UsageTracker } = require('./usage');
const { resolveJumpTarget, loadDesktopIndex, readSessionHost } = require('./sessions');
const { Approvals } = require('./approvals');
const { checkForUpdate } = require('./update');
const { PointerGuard } = require('./pointer-guard');

/*
 * How much of the screen the lane covers.
 *
 * The pets walk along the bottom either way — floorY is the bottom of the
 * canvas — so this is really "how far up can a pet be carried". Full height by
 * default, because a lane you cannot lift a pet out of is a strange thing to
 * hand someone a drag gesture for. `laneHeight` in ~/.strays/config.json takes a
 * number of pixels for anyone who would rather the overlay did not cover the
 * screen; STRIP_HEIGHT is what it was before, and what the tray writes.
 */
const STRIP_HEIGHT = 190;

/* the renderer renews its claim on this beat, well inside the guard's lease */
const POINTER_SWEEP_MS = 500;

/* where a downloaded copy goes to become a newer downloaded copy */
const RELEASES_URL = 'https://github.com/tisu19021997/strays/releases/latest';

/*
 * Untouched for this long and you have actually left, so Heisenbug may wander.
 *
 * Generous on purpose. System idle time measures input, not attention: reading a
 * long reply without touching anything puts you a minute or two idle while you
 * are staring straight at the screen. A minute and a half of that was enough to
 * set the fish off in front of someone who was plainly right there.
 */
const AWAY_SECONDS = 5 * 60;

const BASE_DIR = path.join(os.homedir(), '.strays');
const CUSTOM_PETS_FILE = path.join(BASE_DIR, 'custom-pets.json');
const APPROVALS_FLAG = path.join(BASE_DIR, 'approvals-on');
const ALIVE_FILE = path.join(BASE_DIR, 'overlay.alive');
const PENDING_DIR = path.join(BASE_DIR, 'pending');
const REPLIES_DIR = path.join(BASE_DIR, 'replies');
const UPDATE_STAMP = path.join(BASE_DIR, 'update-check.json');

let win = null;
let tray = null;
let watcher = null;
let usage = null;
let usageLine = null;
let updateNotice = null;   // set once, if a newer strays exists; see lookForUpdate()
let paused = false;
let party = false;
let followClaude = true;
let showTitles = true;
let mischief = true;
let observedTimer = null;
let aliveTimer = null;

const debug = (...a) => process.env.STRAYS_DEBUG && console.log(...a);

/*
 * The lane covers the screen, so the click-through flag is now the difference
 * between a desk toy and a machine that will not take a click anywhere.
 */
const pointer = new PointerGuard({
  apply: (interactive) => {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!interactive, { forward: true });
  },
});

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

/*
 * The Claude Code hooks, installed and removed from the menu bar.
 *
 * Everything here has a command-line equivalent (`strays hooks`), and for anyone
 * who arrived through npm that is still the way. This exists because the
 * downloadable app is aimed at people with no terminal, and a feature that can
 * only be switched on by typing is, for them, not a feature.
 */
const CLAUDE_SETTINGS = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

function hooksInstalled() {
  try {
    return JSON.stringify(JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')).hooks || {})
      .includes('--strays-hook');
  } catch { return false; }
}

function connectToClaudeCode(install) {
  const args = [path.join(__dirname, 'setup-hooks.js')];
  if (!install) args.push('--remove');
  // the app runs its own hooks: see hookCommand() in setup-hooks.js
  if (app.isPackaged) args.push('--app', process.execPath);

  const out = require('child_process').spawnSync(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  const ok = out.status === 0;
  debug('[hooks]', install ? 'install' : 'remove', ok ? 'ok' : out.stderr);
  rebuildTrayMenu();

  dialog.showMessageBox({
    type: ok ? 'info' : 'error',
    message: ok
      ? (install ? 'Connected to Claude Code' : 'Disconnected from Claude Code')
      : 'Could not change the hooks',
    // hooks are read once, when a session starts — without this sentence the
    // feature looks broken to anyone with Claude Code already open
    detail: ok
      ? (install
        ? 'Approval cards are ready. Claude Code reads its hooks when a conversation starts, so restart any you already have open.\n\nYour previous settings were backed up first.'
        : 'The hooks have been removed. Conversations already open keep them until they are restarted.')
      : (out.stderr || 'Unknown error').trim(),
    buttons: ['OK'],
  });
}

/*
 * The lane, in screen coordinates: the full width of the primary display, and
 * as much of its height as the lane is allowed. Always anchored to the bottom,
 * because that is where the floor is.
 */
function laneBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const want = readConfig().laneHeight;
  const height = typeof want === 'number' && want > 0
    ? Math.min(want, workArea.height)
    : workArea.height;
  return {
    x: workArea.x,
    y: workArea.y + workArea.height - height,
    width: workArea.width,
    height,
  };
}

function createWindow() {
  win = new BrowserWindow({
    ...laneBounds(),
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

  /*
   * Every way the renderer can stop renewing its claim without saying so. The
   * lease covers all of them within a couple of seconds, but a crash is knowable
   * immediately and a screen that takes clicks again immediately is worth the
   * three lines.
   */
  win.webContents.on('render-process-gone', () => pointer.release());
  win.on('unresponsive', () => pointer.release());
  win.on('hide', () => pointer.release());
  // and none of them need an undo: the renderer's next heartbeat re-claims

  win.loadFile(path.join(__dirname, 'overlay.html'));

  if (process.env.STRAYS_DEBUG) {
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[overlay]', msg));
  }

  win.webContents.on('did-finish-load', () => {
    try {
      const defs = JSON.parse(fs.readFileSync(CUSTOM_PETS_FILE, 'utf8'));
      if (Array.isArray(defs) && defs.length) send('custom-pets', defs);
    } catch { /* no custom pets — fine */ }
    send('show-mischief', mischief);
    // surface approvals that arrived before the window was ready
    approvals.scanPending();
  });

  screen.on('display-metrics-changed', positionWindow);
  screen.on('display-added', positionWindow);
  screen.on('display-removed', positionWindow);
}

function positionWindow() {
  if (!win) return;
  // the renderer measures the lane rather than being told it, so resizing the
  // window is the whole of changing its height — see `height: 'fill'`
  win.setBounds(laneBounds());
}

// ------------------------------------------------------------------- tray
// A real template image — an empty image + emoji title can render zero-width
// (invisible) in the macOS menu bar, especially next to a notch.
const PAW_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALklEQVR4nGNgoDL4j4SJ4Q9CA6gG/uPAFGkmyhBCmgkaMvAGEGMIUYAizSMNAACPjVSs6AupdQAAAABJRU5ErkJggg==';

function createTray() {
  const icon = nativeImage.createFromDataURL(PAW_PNG);
  /*
   * A template image is a macOS idea: the system recolours it for a light or
   * dark menu bar. Everywhere else the flag is ignored and the paw renders as
   * the black pixels it actually is — invisible in the Windows 11 notification
   * area, which is dark by default. The window has no frame, no taskbar entry
   * and no dock icon, so an invisible tray icon leaves no way to quit.
   */
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('strays');
  debug('[tray] created');
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  // usage updates rebuild this every few seconds, so the config is read once
  const mode = jumpMode();
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
      label: 'Name the session on each pet',
      type: 'checkbox',
      checked: showTitles,
      click: (item) => { showTitles = item.checked; send('show-titles', showTitles); },
    },
    {
      label: 'Heisenbug wanders off when you leave',
      type: 'checkbox',
      checked: mischief,
      click: (item) => { mischief = item.checked; send('show-mischief', mischief); },
    },
    {
      label: 'Carry pets anywhere on screen',
      type: 'checkbox',
      checked: typeof readConfig().laneHeight !== 'number',
      click: (item) => {
        writeConfig({ laneHeight: item.checked ? 'full' : STRIP_HEIGHT });
        positionWindow();
      },
    },
    {
      label: 'Clicking a pet',
      submenu: [
        {
          label: 'Keep my layout when it can',
          type: 'radio',
          checked: mode === 'auto',
          click: () => writeConfig({ jumpMode: 'auto' }),
        },
        {
          label: 'Never rearrange panes',
          type: 'radio',
          checked: mode === 'never',
          click: () => writeConfig({ jumpMode: 'never' }),
        },
        {
          label: 'Always open the conversation',
          type: 'radio',
          checked: mode === 'always',
          click: () => writeConfig({ jumpMode: 'always' }),
        },
      ],
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
    /*
     * ...and the half of that which used to need a terminal. `strays hooks` is
     * not an instruction that can be given to someone who downloaded an app, so
     * the app installs its own — writing a hook command that runs this binary as
     * a Node, because their machine has none.
     */
    {
      label: hooksInstalled() ? 'Disconnect from Claude Code' : 'Connect to Claude Code…',
      click: () => connectToClaudeCode(!hooksInstalled()),
    },
    {
      label: 'Start strays at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }),
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
    /*
     * An update, when there is one. It is a menu item and not a dialog on
     * purpose: a desk toy that interrupts you to talk about itself has missed
     * the point, and nothing here installs anything — the pets would vanish
     * mid-session, which is a worse outcome than being one version behind.
     */
    ...(updateNotice ? [
      { type: 'separator' },
      { label: updateNotice.label, enabled: false },
      { label: updateNotice.detail, enabled: false },
      ...(updateNotice.command ? [{
        label: 'Copy the update command',
        click: () => clipboard.writeText(updateNotice.command),
      }] : []),
      // ...and for the downloadable app there is no command to copy, so the
      // menu opens the page the new one is on instead
      ...(app.isPackaged && !updateNotice.command ? [{
        label: 'Open the download page',
        click: () => shell.openExternal(RELEASES_URL),
      }] : []),
      {
        label: "Don't check for updates",
        click: () => { writeConfig({ updateCheck: false }); updateNotice = null; rebuildTrayMenu(); },
      },
    ] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

/*
 * Whether there is a newer strays, once a day at most.
 *
 * The only network request the project makes, and the only one it will make: it
 * sends nothing but the request, and it is off the moment anyone says so —
 * `updateCheck: false` in ~/.strays/config.json, or the tray item. It never
 * blocks boot and it can never fail loudly; the worst case is a menu that says
 * nothing, which is also what it says when you are up to date.
 */
function lookForUpdate() {
  if (readConfig().updateCheck === false) return debug('[update] check is switched off');
  checkForUpdate({ current: app.getVersion(), stampFile: UPDATE_STAMP })
    .then((notice) => {
      debug('[update]', notice ? notice.label : 'up to date, or no answer');
      if (!notice) return;
      updateNotice = notice;
      rebuildTrayMenu();
    })
    .catch((e) => debug('[update] check failed:', e.message));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --------------------------------------------------------- jump to session
// sessions.js decides where a click should land; everything here just performs
// the description and says so when it fails. Override the destination with
// { "jumpApp": "iTerm2" } in ~/.strays/config.json.
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; }
  catch { return {}; /* no config — resolve automatically */ }
}

/* what the tray radio group is currently showing as chosen */
const jumpMode = () => readConfig().jumpMode || 'auto';

/*
 * Merge into the config rather than replacing it: jumpApp and anything a future
 * release adds live in the same file, and a tray click must not drop them.
 */
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  } catch (e) { debug('[config] write failed:', e.message); }
  rebuildTrayMenu();
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
/*
 * One overlay, or you get one team of pets per copy.
 *
 * Two instances each draw the full team in the same lane, which reads as every
 * pet having been duplicated — and it is not obvious that a second copy is even
 * running, because the window has no frame, no dock icon and no taskbar entry.
 * The tray icon doubles too, but two identical paws look like one.
 *
 * It also breaks stopping. Every instance heartbeats its own pid into the same
 * overlay.alive, so the file names whichever wrote last: `npm run stop` kills an
 * arbitrary one and leaves the rest, and the approval gate reads that same file
 * to decide whether anyone is listening.
 */
/*
 * `strays.app --setup` — install the Claude Code hooks and exit.
 *
 * The downloadable app exists for people who have no terminal and no Node, so
 * "run `strays hooks`" is not an instruction that can be given to them. This is
 * the same installer the command runs, told to write a hook command that invokes
 * this very binary as a Node rather than a `node` that is not on their machine.
 *
 * Before the single-instance lock, and before whenReady: it is a one-shot that
 * must work whether or not an overlay is already out.
 */
if (process.argv.includes('--setup') || process.argv.includes('--unhook')) {
  const args = [path.join(__dirname, 'setup-hooks.js')];
  if (process.argv.includes('--unhook')) args.push('--remove');
  if (app.isPackaged) args.push('--app', process.execPath);
  const out = require('child_process').spawnSync(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  process.stdout.write(out.stdout || '');
  process.stderr.write(out.stderr || '');
  app.exit(out.status === 0 ? 0 : 1);
}

if (!app.requestSingleInstanceLock()) {
  debug('[boot] another overlay is already running — leaving it to it');
  app.quit();
} else {

app.on('second-instance', () => debug('[boot] refused a second overlay'));

/*
 * Get out of the disk image before doing anything else.
 *
 * Running strays straight from the mounted .dmg mostly works, which is the
 * problem: the hooks it installs name the path it is running from, so they point
 * into /Volumes/strays — and the first time the image is ejected, every approval
 * silently stops working with nothing on screen to explain it. macOS offers the
 * move itself, so this is the whole of the "install" step for someone who has
 * never dragged an app to Applications.
 */
function moveOutOfTheDiskImage() {
  if (process.platform !== 'darwin' || !app.isPackaged) return false;
  if (app.isInApplicationsFolder()) return false;
  if (!/^\/Volumes\//.test(app.getPath('exe'))) return false; // in Downloads is their business

  const { response } = dialog.showMessageBoxSync
    ? { response: dialog.showMessageBoxSync({
      type: 'question',
      message: 'Move strays to your Applications folder?',
      detail: 'strays is running from its disk image. It needs to live in Applications, '
            + 'or it will stop working when the image is ejected.',
      buttons: ['Move to Applications', 'Not now'],
      defaultId: 0,
      cancelId: 1,
    }) }
    : { response: 1 };
  if (response !== 0) return false;

  try { return app.moveToApplicationsFolder(); } catch (e) {
    dialog.showMessageBox({
      type: 'error',
      message: 'Could not move strays',
      detail: (e && e.message) || 'Drag strays.app into Applications yourself, then open it again.',
    });
    return false;
  }
}

app.whenReady().then(() => {
  // moveToApplicationsFolder relaunches from the new location and quits this
  // copy, so nothing below should run in the instance that moved
  if (moveOutOfTheDiskImage()) return;
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

  lookForUpdate();

  /*
   * Is the developer actually at the machine?
   *
   * Heisenbug only misbehaves when nobody is watching, and the engine works that
   * out from mousemove over its own canvas. That reasoning belongs to a web
   * page: this canvas is a 190px strip at the bottom of the screen that nobody
   * points at, so someone working all day never counted as watching and the
   * fish teleported across the screen every couple of seconds for the whole
   * session. System-wide idle time is the question actually being asked, and
   * only the main process can answer it.
   */
  const pollPresence = () => {
    let idle = 0;
    try { idle = powerMonitor.getSystemIdleTime(); } catch { idle = 0; }
    const present = idle < AWAY_SECONDS;
    debug('[presence]', idle + 's idle ->', present ? 'watching' : 'away');
    send('observed', present);
  };
  pollPresence();
  observedTimer = setInterval(pollPresence, 4000);

  /*
   * STRAYS_SNAPSHOT=<file> writes a PNG of the lane every couple of seconds.
   *
   * The lane is a canvas: what it actually drew cannot be read back from the
   * DOM, and a headless harness only proves that fillText was called, not that
   * the result is on screen and legible. capturePage is the window photographing
   * itself, so unlike screencapture(1) it needs no Screen Recording permission.
   */
  if (process.env.STRAYS_SNAPSHOT) {
    const out = process.env.STRAYS_SNAPSHOT;
    setInterval(() => {
      if (!win || win.isDestroyed()) return;
      win.webContents.capturePage()
        .then((img) => fs.writeFileSync(out, img.toPNG()))
        .catch((e) => debug('[snapshot] failed:', e.message));
    }, 2000);
  }

  // hovering a pet or a card -> catch clicks; leaving -> click-through again.
  // The renderer repeats this while it wants the pointer; see pointer-guard.js
  // for why it is a lease rather than a switch.
  ipcMain.on('set-interactive', (_e, interactive) => pointer.claim(interactive));
  setInterval(() => pointer.sweep(), POINTER_SWEEP_MS).unref();

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
        // the paw icon carries the identity; this is just a status suffix
        const active = status.sessions.filter((s) => s.state === 'thinking' || s.state === 'tool').length;
        const suffix = status.state === 'working' ? String(active)
          : status.state === 'needs-you' ? '❗'
            : '';
        /*
         * Tray.setTitle is macOS-only — text beside a menu bar icon is not a
         * thing Windows or Linux have. Elsewhere the same information goes in
         * the tooltip, where it can actually be read.
         */
        if (process.platform === 'darwin') tray.setTitle(suffix ? ' ' + suffix : '');
        else tray.setToolTip(suffix ? 'strays — ' + suffix : 'strays');
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
  clearInterval(observedTimer);
  try { fs.unlinkSync(ALIVE_FILE); } catch { /* gone */ }
});

} // end of the single-instance branch — a refused copy registers none of the
  // above, so its exit cannot tear down the overlay that is actually running

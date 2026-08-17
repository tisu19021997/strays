#!/usr/bin/env node
/*
 * `npx claude-strays`, and the `strays` command after a global install.
 *
 * The package is `claude-strays` and the command is `strays`, deliberately:
 * npm's typosquatting guard refuses the name `strays` as too close to the
 * existing `stres`. Only the registry name moved; nothing anyone types did.
 *
 * Electron cannot be started by Node directly: requiring the electron package
 * from a plain Node process hands back the path to its binary, and the app is
 * launched by running that binary against a directory containing a package.json
 * with a `main`. That directory is desktop/.
 *
 * Subcommands are handled here rather than as npm scripts, because someone who
 * installed from npm has no package.json of ours to run scripts from.
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'desktop');
const [command, ...rest] = process.argv.slice(2);

const HELP = `
strays — a tiny team of pixel pets that react to Claude Code

  strays              start the overlay (Ctrl+C, or the tray, to quit)
  strays stop         quit a running overlay
  strays restart      stop it, wait for it to go, start it again
  strays hooks        install the Allow/Deny hooks into ~/.claude/settings.json
  strays unhook       remove them again
  strays editor       open the pixel editor for drawing your own pet
  strays --help       this

Set STRAYS_DEBUG=1 before any of these to see what it is doing.
`;

/* run a script of ours under plain Node, and exit with whatever it exits with */
function node(script, args = []) {
  const child = spawn(process.execPath, [path.join(APP, script), ...args], { stdio: 'inherit' });
  child.on('close', (code) => process.exit(code == null ? 1 : code));
}

function electron(args) {
  let binary;
  try {
    binary = require('electron');
  } catch {
    console.error('Electron is missing — reinstall strays, or run `npm install` in a clone.');
    process.exit(1);
  }
  if (typeof binary !== 'string') {
    console.error('strays must be run from a terminal, not from inside Electron.');
    process.exit(1);
  }
  const child = spawn(binary, args, { stdio: 'inherit' });
  child.on('close', (code) => process.exit(code == null ? 1 : code));
}

switch (command) {
  case undefined:
  case 'start':
    electron([APP, ...rest]);
    break;
  case 'stop':
    node('stop.js', rest);
    break;
  case 'restart':
    // stop.js --wait holds until the old overlay is really gone; starting
    // inside that window loses the single-instance lock to the copy quitting
    spawn(process.execPath, [path.join(APP, 'stop.js'), '--wait'], { stdio: 'inherit' })
      .on('close', () => electron([APP, ...rest]));
    break;
  case 'hooks':
    node('setup-hooks.js', rest);
    break;
  case 'unhook':
    node('setup-hooks.js', ['--remove', ...rest]);
    break;
  case 'editor': {
    // the editor is a plain page; hand it to whatever opens HTML here
    const page = path.join(ROOT, 'editor.html');
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'explorer'
        : 'xdg-open';
    spawn(opener, [page], { stdio: 'ignore', detached: true }).unref();
    console.log('opened ' + page);
    break;
  }
  case '-h':
  case '--help':
  case 'help':
    console.log(HELP.trim());
    break;
  case '-v':
  case '--version':
    console.log(require(path.join(ROOT, 'package.json')).version);
    break;
  default:
    console.error('strays: unknown command "' + command + '"');
    console.log(HELP.trim());
    process.exit(1);
}

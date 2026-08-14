/*
 * The `strays` command.
 *
 * Once the package is installed from npm there is no checkout and no
 * package.json of ours to run scripts from, so this file is the only way in.
 * Everything here runs the real bin, because the failures worth catching are
 * the ones where it cannot even find its own files.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'strays.js');

const strays = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], {
  encoding: 'utf8',
  env: { ...process.env, ...env },
});

test('the package declares the command, and the command is there', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.strays, 'bin/strays.js');
  assert.ok(fs.existsSync(BIN), 'bin/strays.js must exist where package.json says');
  assert.match(fs.readFileSync(BIN, 'utf8'), /^#!\/usr\/bin\/env node/,
    'npm needs the shebang to make the shim on macOS and Linux');
});

test('everything the command touches at runtime is published', () => {
  /*
   * `files` is a whitelist, so anything missing from it is simply absent for
   * everyone who installed from npm — and works perfectly in the checkout it
   * was tested in. Tests are excluded on purpose; the app is not.
   */
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const needed of ['bin/', 'desktop/', 'strays.js']) {
    assert.ok(pkg.files.includes(needed), `${needed} must be in files`);
  }
  assert.ok(pkg.files.includes('!desktop/test/'), 'the tests should not ship');
  assert.ok(pkg.dependencies && pkg.dependencies.electron,
    'electron has to be a real dependency, or npx cannot start anything');
});

test('--help and --version answer without starting anything', () => {
  const help = strays(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /strays stop/);
  assert.match(help.stdout, /strays hooks/);

  const version = strays(['--version']);
  assert.equal(version.status, 0);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(version.stdout.trim(), pkg.version);
});

test('an unknown command says so and fails, rather than starting the overlay', () => {
  const out = strays(['definitely-not-a-command']);
  assert.equal(out.status, 1, 'a typo must not be treated as `start`');
  assert.match(out.stderr, /unknown command/);
});

test('stop is reachable through the command, and finds its own script', () => {
  // the path from bin/ into desktop/ is the thing being checked: it is easy to
  // get right in a checkout and wrong once npm has laid the package out
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strays-cli-'));
  const out = strays(['stop'], { STRAYS_HOME: dir });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /no overlay running/);
});

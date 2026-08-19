/*
 * Which version the app thinks it is.
 *
 * This is the input to the update check, so getting it wrong does not fail — it
 * lies, once a day, for ever. `bin/strays.js` starts Electron with `desktop/` as
 * the app directory, so `app.getVersion()` reads `desktop/package.json`; that file
 * carried a placeholder `1.0.0` through four releases, and every `npx` and global
 * install was therefore told there was an update to fetch. The packaged app was
 * right purely by accident, because its manifest is the real one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { appVersion } = require('../version');

const ROOT = path.join(__dirname, '..', '..');
const rootManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const desktopManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));

test('the version comes from the package that is published', () => {
  assert.strictEqual(appVersion('fallback'), rootManifest.version);
  assert.match(rootManifest.version, /^\d+\.\d+\.\d+/, 'and it looks like a version');
});

/*
 * The regression, stated as the thing that must stay impossible: a version in
 * desktop/package.json is a second copy of a number only the root manifest is
 * ever bumped, so the two drift silently and app.getVersion() reads the stale one.
 */
test('desktop/package.json declares no version to drift', () => {
  assert.strictEqual(desktopManifest.version, undefined,
    'a version here is what made every npx install report a phantom update');
});

test('Electron still has what it needs to start the app', () => {
  // dropping the version must not take the entry point with it
  assert.strictEqual(desktopManifest.main, 'main.js');
  assert.ok(desktopManifest.name, 'Electron wants a name');
});

test('the fallback is used only when the real manifest cannot be read', () => {
  // proves the happy path is not silently returning the fallback
  assert.notStrictEqual(appVersion('fallback'), 'fallback');
});

/*
 * The update check must never be handed app.getVersion() directly again. Asserted
 * against the source because the alternative is requiring main.js, which starts
 * an Electron app.
 */
test('main.js does not pass Electron the version question', () => {
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
  const call = main.match(/checkForUpdate\(\{[^}]*\}/);
  assert.ok(call, 'the update call should have been found');
  assert.ok(call[0].includes('appVersion('),
    'the version handed to the update check must come from version.js');
  assert.ok(!/current:\s*app\.getVersion\(\)/.test(call[0]),
    'app.getVersion() reads desktop/package.json, which is not the published version');
});

/*
 * Build the downloadable macOS app.
 *
 *   node tools/build-app.js          # -> dist/strays-<version>.dmg
 *
 * Why this exists rather than a plain `electron-builder --mac`:
 *
 * electron-builder refuses to run while `electron` is in `dependencies`, and in
 * this package it is there deliberately — `npx claude-strays` has to be able to
 * start the app, and npx installs dependencies but not devDependencies. Both
 * positions are right for their own purpose and they cannot both be true in one
 * file, so the build gets its own copy of the manifest with electron moved
 * across, in a staging directory.
 *
 * Staged rather than edited in place on purpose. Rewriting package.json and
 * restoring it afterwards works right up until the build is interrupted, and
 * then the published manifest is silently wrong — which is the kind of damage
 * that gets committed by accident. Nothing here writes to the repo.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, '.build-stage');

/* everything the app is made of; the npm package's `files` is a different list
 * for a different job, so this is not derived from it */
const SOURCES = ['desktop', 'strays.js', 'editor.html', 'LICENSE', 'build', 'electron-builder.yml'];

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

for (const item of SOURCES) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(STAGE, item), { recursive: true });
}
// the test suite is not part of the app, and electron-builder's `files` filter
// runs late enough that copying it first is just wasted work
fs.rmSync(path.join(STAGE, 'desktop', 'test'), { recursive: true, force: true });

/*
 * The manifest the build sees: electron moved to devDependencies, and the
 * metadata a packaged app needs but a command-line one never did.
 */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const electron = (pkg.dependencies || {}).electron;
if (!electron) throw new Error('electron is not a dependency — has package.json changed?');
delete pkg.dependencies.electron;
if (!Object.keys(pkg.dependencies).length) delete pkg.dependencies;
pkg.devDependencies = { ...(pkg.devDependencies || {}), electron };
pkg.main = 'desktop/main.js';
pkg.author = pkg.author || 'strays';
pkg.description = pkg.description || 'Pixel-art pets that react to your Claude Code sessions.';
delete pkg.bin;     // the app is not a command
delete pkg.scripts; // ...and none of them mean anything inside the bundle
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

// electron itself is large and already downloaded; share the one in the repo
// rather than making the staging copy fetch its own
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(STAGE, 'node_modules'), 'dir');

console.log(`staged ${SOURCES.length} paths, electron ${electron} -> devDependencies`);

/*
 * Built straight into the repo's dist rather than into the staging directory
 * and copied back. An .app is full of symlinks — every framework has a
 * Versions/Current pointing at Versions/A — and fs.cpSync flattens enough of
 * that to produce a bundle which looks complete, passes a file listing, and
 * dies at launch with "Library not loaded: Electron Framework". The .dmg
 * survived the copy because it is one file, so the corruption only showed up in
 * the unpacked tree: a broken app next to a working installer.
 */
fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
try {
  execFileSync('npx', [
    '--yes', 'electron-builder@26', '--mac', '--publish', 'never',
    '-c.directories.output', path.join(ROOT, 'dist'),
  ], { cwd: STAGE, stdio: 'inherit' });
} finally {
  fs.rmSync(path.join(STAGE, 'node_modules'), { force: true });
  fs.rmSync(STAGE, { recursive: true, force: true });
}

for (const f of fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => /\.(dmg|zip)$/.test(f))) {
  const { size } = fs.statSync(path.join(ROOT, 'dist', f));
  console.log(`  dist/${f}  ${(size / 1024 / 1024).toFixed(1)} MB`);
}

/*
 * The one place the app's version comes from.
 *
 * Not `app.getVersion()`, which reads the manifest of whatever directory Electron
 * was pointed at — and `bin/strays.js` points it at `desktop/`, whose
 * package.json exists only to name an entry point. That file carried a
 * placeholder `1.0.0` that no release has ever bumped, so every `npx` and global
 * install compared **1.0.0** against npm's latest and was told, for ever, that
 * there was an update to install. The packaged app was right by accident, because
 * its manifest happens to be the real one; the path the README actually
 * recommends was not.
 *
 * So the version is read from the package that is published, and `desktop/`
 * declares none at all — a second copy of a version number is a second thing to
 * bump, and the release workflow only ever bumps one.
 */
const path = require('path');

function appVersion(fallback) {
  try {
    const v = require(path.join(__dirname, '..', 'package.json')).version;
    if (typeof v === 'string' && v) return v;
  } catch { /* not laid out as expected — fall through */ }
  return fallback;
}

module.exports = { appVersion };

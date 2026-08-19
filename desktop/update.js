/*
 * Is there a newer strays than this one, and how would you get it?
 *
 * Nothing here installs anything. A desk toy that replaces its own code while
 * you are working is a worse idea than a line in a menu, and an overlay that
 * restarts itself takes your pets away mid-session. So this finds out, says so
 * once, and tells you the one command that applies to the way you actually
 * installed it.
 *
 * The network call is the only one in the whole project, so it is kept behind a
 * seam: everything below except `fetchLatest` is pure and offline, and the
 * caller injects the fetch. That is what lets the whole matrix — no answer, a
 * lying answer, a half-written cache — be tested without a registry.
 */
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const REGISTRY = 'https://registry.npmjs.org/claude-strays';
const PACKAGE = 'claude-strays';
const COMMAND = 'strays';

/* how long an answer is good for. A desk pet does not need to know sooner. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;

/*
 * Compare two versions the way npm orders them.
 *
 * Numeric per part, so 1.10.0 is above 1.9.0 — a string compare puts them the
 * other way round and would offer a downgrade as an update. A prerelease sorts
 * below the release it leads to, which is all this needs: strays does not
 * publish prereleases, and if it ever does, `1.2.0-rc.1` must not be offered to
 * someone already on `1.2.0`.
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).trim().replace(/^v/, '').split('-');
    const parts = core.split('.').map((n) => parseInt(n, 10));
    return { parts, pre: pre || '' };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    const l = x.parts[i], r = y.parts[i];
    if (!Number.isFinite(l) || !Number.isFinite(r)) return 0; // unparseable: no opinion
    if (l !== r) return l < r ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;  // a release outranks any prerelease of itself
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/* the newer of the two, or null when there is nothing to say */
function newerVersion(current, available) {
  if (!current || !available) return null;
  return compareVersions(current, available) < 0 ? String(available).trim() : null;
}

/*
 * What the registry's own answer says the latest release is.
 *
 * `dist-tags.latest` rather than the newest key in `versions`: a version can be
 * published and then deprecated or untagged, and `latest` is the one npm would
 * actually install. Offering anything else means the command in the menu does
 * not get you the version the menu named.
 */
function latestFromRegistry(body) {
  try {
    const tags = JSON.parse(body)['dist-tags'];
    const latest = tags && tags.latest;
    return typeof latest === 'string' ? latest : null;
  } catch { return null; }
}

/*
 * How this copy got here, which decides what the user should run.
 *
 * npx resolves the `latest` tag on each run, so there is genuinely nothing for
 * an npx user to do and telling them to run something is wrong. A global
 * install is frozen at the version it was installed at until someone says
 * otherwise, and a git checkout answers to git.
 */
function installKind(dir = __dirname) {
  const p = dir.replace(/\\/g, '/');
  // the downloadable app, which has no npm anywhere in the picture: there is no
  // command to give someone who never typed one, so it gets a page instead
  if (p.includes('.app/Contents/Resources/')) return 'app';
  if (p.includes('/_npx/')) return 'npx';
  if (p.includes('/node_modules/' + PACKAGE + '/')) return 'global';
  return 'checkout';
}

/* the one command that applies, or null when there is nothing to run */
function updateCommand(kind) {
  if (kind === 'npx') return null;             // already gets the latest each run
  if (kind === 'app') return null;             // a download, not a command
  if (kind === 'checkout') return 'git pull';
  return `npm install -g ${PACKAGE}@latest`;
}

/* what the tray should say about an available update */
function updateNotice(current, latest, kind) {
  const next = newerVersion(current, latest);
  if (!next) return null;
  const command = updateCommand(kind);
  return {
    version: next,
    label: `UPDATE ${next} AVAILABLE`,
    /*
     * Three kinds of person, three sentences. Someone with a command gets it to
     * copy; an npx user is already current next time they run it; and someone
     * who downloaded the app has no terminal in the story at all, so telling
     * them to run anything would be the one instruction they cannot follow.
     *
     * Terse, and the version you are on comes first — that is the fact being
     * reported. No exclamation, no urgency: nothing here is broken.
     */
    detail: command ? `ON ${current} — RUN: ${command}`
      : kind === 'app' ? `ON ${current} — DOWNLOAD ${next} FROM RELEASES`
        : `ON ${current} — YOUR NEXT npx ${PACKAGE} PICKS IT UP`,
    command,
  };
}

/* ------------------------------------------------------------- the seam */

/*
 * Ask the registry, and never let it be the reason anything fails.
 *
 * Resolves to null on anything at all — offline, a proxy, a 500, a timeout, a
 * body that is not JSON. An update check that can throw is an update check that
 * can take the overlay down, and the overlay is the product.
 */
function fetchLatest(url = REGISTRY, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const req = https.get(url, {
        // the abbreviated document: the full one for a package with many
        // versions is megabytes, and all of it but dist-tags is waste here
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return done(null); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 2_000_000) { req.destroy(); done(null); } // not our document
        });
        res.on('end', () => done(latestFromRegistry(body)));
        res.on('error', () => done(null));
      });
      req.on('timeout', () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
    } catch { done(null); }
  });
}

/* ------------------------------------------------------- the whole check */

function readStamp(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; /* absent, or half-written */ }
}

/**
 * The latest known version, asking the registry at most once a day.
 *
 * @param {object} opts
 * @param {string} opts.current        the running version
 * @param {string} opts.stampFile      where the last answer is remembered
 * @param {boolean} [opts.enabled]     false answers null without a request
 * @param {number} [opts.now]          the clock, injected for tests
 * @param {function} [opts.fetch]      () => Promise<string|null>
 * @param {number} [opts.intervalMs]
 * @returns {Promise<object|null>}     an updateNotice, or null
 */
async function checkForUpdate(opts) {
  const {
    current, stampFile, enabled = true, now = Date.now(),
    fetch = fetchLatest, intervalMs = CHECK_INTERVAL_MS, kind = installKind(),
  } = opts;
  if (!enabled) return null;

  const stamp = readStamp(stampFile);
  const fresh = typeof stamp.checkedAt === 'number' && now - stamp.checkedAt < intervalMs;
  // A cached answer is used even when it says there is nothing new: the point of
  // the interval is one request a day, not one request a day that finds an
  // update. `checkedAt` in the future is a clock that moved, so re-ask.
  if (fresh && now >= stamp.checkedAt) return updateNotice(current, stamp.latest, kind);

  const latest = await fetch();
  if (!latest) return null; // offline, or the registry said nothing useful

  try {
    fs.mkdirSync(path.dirname(stampFile), { recursive: true });
    fs.writeFileSync(stampFile, JSON.stringify({ checkedAt: now, latest }));
  } catch { /* a check that cannot be remembered still answers */ }

  return updateNotice(current, latest, kind);
}

module.exports = {
  CHECK_INTERVAL_MS,
  checkForUpdate,
  compareVersions,
  fetchLatest,
  installKind,
  latestFromRegistry,
  newerVersion,
  updateCommand,
  updateNotice,
};

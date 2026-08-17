/*
 * Is there a newer strays, and what should the user run?
 *
 * The registry is never contacted here: `checkForUpdate` takes the fetch as an
 * argument precisely so the interesting cases — offline, a lying answer, a
 * clock that moved, a cache written by a future version — are all reachable
 * without a network. What is worth getting right is the ordering (offering a
 * downgrade is worse than saying nothing) and the throttle (a desk toy must not
 * talk to a registry on a loop).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CHECK_INTERVAL_MS, checkForUpdate, compareVersions, installKind,
  latestFromRegistry, newerVersion, updateCommand, updateNotice,
} = require('../update');

const stampFile = () => path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'strays-update-')), 'update-check.json');

/* a fetch that answers with `latest` and counts how often it was asked */
function registry(latest) {
  const calls = [];
  return { fetch: () => { calls.push(1); return Promise.resolve(latest); }, calls };
}

test('versions are ordered numerically, not as strings', () => {
  // 1.10.0 sorts below 1.9.0 as text, and offering a downgrade as an update is
  // worse than never checking at all
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0, 'a leading v is the same version');

  // a prerelease sorts below the release it leads to
  assert.equal(compareVersions('1.2.0-rc.1', '1.2.0'), -1);
  assert.equal(compareVersions('1.2.0', '1.2.0-rc.1'), 1);
});

test('an unparseable version on either side is not an update', () => {
  /*
   * Either direction has to stay quiet. A registry answering with something
   * unexpected must not produce a notice, and a running version that cannot be
   * read is not grounds for telling someone to upgrade — "you have latest, run
   * this to get 2.0.0" is advice given without knowing what they are on.
   */
  for (const junk of ['', 'latest', 'not.a.version', null, undefined]) {
    const shown = JSON.stringify(junk);
    assert.equal(newerVersion('1.0.0', junk), null, `${shown} is not a version to offer`);
    assert.equal(newerVersion(junk, '2.0.0'), null, `and ${shown} is not one to compare against`);
  }
});

test('only a strictly newer version is an update', () => {
  assert.equal(newerVersion('1.0.0', '1.0.1'), '1.0.1');
  assert.equal(newerVersion('1.0.0', '1.0.0'), null, 'the same version is not an update');
  assert.equal(newerVersion('1.1.0', '1.0.0'), null, 'and an older one certainly is not');
});

test('the latest release comes from dist-tags, not from the version list', () => {
  /*
   * A version can be published and later untagged or deprecated, and `latest`
   * is the one npm would actually install. Naming any other version means the
   * command in the menu does not get you the version the menu named.
   */
  const body = JSON.stringify({
    'dist-tags': { latest: '1.2.0', next: '2.0.0-rc.1' },
    versions: { '1.2.0': {}, '2.0.0-rc.1': {}, '1.3.0': {} },
  });
  assert.equal(latestFromRegistry(body), '1.2.0');

  for (const junk of ['', 'not json', '{}', '{"dist-tags":{}}', '{"dist-tags":null}', '[]']) {
    assert.equal(latestFromRegistry(junk), null, `${junk} yields nothing`);
  }
});

test('the command matches how this copy was installed', () => {
  // npx resolves `latest` on every run, so telling an npx user to run something
  // is telling them to do work that is already done
  assert.equal(installKind('/Users/dev/.npm/_npx/a1b2c3/node_modules/claude-strays/desktop'), 'npx');
  assert.equal(updateCommand('npx'), null);

  assert.equal(installKind('/usr/local/lib/node_modules/claude-strays/desktop'), 'global');
  assert.equal(updateCommand('global'), 'npm install -g claude-strays@latest');

  assert.equal(installKind('/Users/dev/Desktop/strays/desktop'), 'checkout');
  assert.equal(updateCommand('checkout'), 'git pull');

  // Windows spells all three with backslashes
  assert.equal(installKind('C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\claude-strays\\desktop'), 'global');
  assert.equal(installKind('C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\ab\\node_modules\\claude-strays\\desktop'), 'npx');
});

test('the notice names both versions, and tells npx users to do nothing', () => {
  const global = updateNotice('1.0.0', '1.2.0', 'global');
  assert.match(global.label, /1\.2\.0/);
  assert.match(global.detail, /1\.0\.0/, 'it says what you are on');
  assert.equal(global.command, 'npm install -g claude-strays@latest');

  const npx = updateNotice('1.0.0', '1.2.0', 'npx');
  assert.equal(npx.command, null, 'there is nothing for an npx user to run');
  assert.match(npx.detail, /npx/);

  assert.equal(updateNotice('1.2.0', '1.2.0', 'global'), null, 'being current says nothing');
});

test('a check with nothing to report is still a check', async () => {
  const file = stampFile();
  const r = registry('1.0.0');
  assert.equal(await checkForUpdate({ current: '1.0.0', stampFile: file, fetch: r.fetch }), null);
  assert.ok(fs.existsSync(file), 'the answer is remembered even when it is "no"');

  /*
   * And the memory is used. The interval exists to make one request a day, not
   * one request a day that happens to find an update — caching only the good
   * answers would ask the registry on every launch for anyone up to date, which
   * is everyone, almost always.
   */
  assert.equal(await checkForUpdate({ current: '1.0.0', stampFile: file, fetch: r.fetch }), null);
  assert.equal(r.calls.length, 1, 'the second check did not ask again');
});

test('the registry is asked once a day, and the cached answer is reused', async () => {
  const file = stampFile();
  const r = registry('2.0.0');
  const at = (now) => checkForUpdate({ current: '1.0.0', stampFile: file, fetch: r.fetch, now, kind: 'global' });

  const first = await at(1_000_000);
  assert.equal(first.version, '2.0.0');
  assert.equal(r.calls.length, 1);

  const soon = await at(1_000_000 + CHECK_INTERVAL_MS - 1);
  assert.equal(soon.version, '2.0.0', 'the cached answer still stands');
  assert.equal(r.calls.length, 1, 'and cost nothing');

  await at(1_000_000 + CHECK_INTERVAL_MS + 1);
  assert.equal(r.calls.length, 2, 'a day later it asks again');
});

test('being switched off means no request at all', async () => {
  const r = registry('2.0.0');
  const notice = await checkForUpdate({
    current: '1.0.0', stampFile: stampFile(), fetch: r.fetch, enabled: false,
  });
  assert.equal(notice, null);
  assert.equal(r.calls.length, 0, 'switched off has to mean the network is untouched');
});

test('a check that cannot reach the registry says nothing and keeps quiet', async () => {
  // offline, a proxy, a 500, a timeout: all of it arrives here as null, and none
  // of it may throw — an update check that can fail is one that can take the
  // overlay down, and the overlay is the product
  const file = stampFile();
  let asked = 0;
  const offline = () => { asked++; return Promise.resolve(null); };

  assert.equal(await checkForUpdate({ current: '1.0.0', stampFile: file, fetch: offline }), null);
  assert.ok(!fs.existsSync(file), 'a failed check is not remembered as an answer');

  // so the next launch tries again rather than waiting out the interval
  assert.equal(await checkForUpdate({ current: '1.0.0', stampFile: file, fetch: offline }), null);
  assert.equal(asked, 2);
});

test('a stamp that is missing, corrupt or from the future is survivable', async () => {
  const file = stampFile();
  const r = registry('2.0.0');
  const check = (now) => checkForUpdate({
    current: '1.0.0', stampFile: file, fetch: r.fetch, now, kind: 'global',
  });

  fs.writeFileSync(file, '{ half a wri');
  assert.equal((await check(5_000_000)).version, '2.0.0', 'a corrupt stamp is just a missing one');

  /*
   * A stamp dated after now means the clock moved — a laptop waking in another
   * timezone, or an ntp correction. Treating it as fresh would hold the answer
   * until real time caught up, which for a clock set years ahead is never.
   */
  fs.writeFileSync(file, JSON.stringify({ checkedAt: 9_000_000_000_000, latest: '0.0.1' }));
  const after = await check(5_000_001);
  assert.equal(after.version, '2.0.0', 'a future stamp is re-checked, not trusted');
});

test('the version in the stamp is what gets compared, not the one in the file name', async () => {
  // a stamp written by an older strays carries whatever it saw; the running
  // version is the only thing that decides whether that is news
  const file = stampFile();
  fs.writeFileSync(file, JSON.stringify({ checkedAt: 1_000_000, latest: '1.5.0' }));
  const opts = { stampFile: file, now: 1_000_001, kind: 'global', fetch: () => Promise.resolve(null) };

  assert.equal((await checkForUpdate({ ...opts, current: '1.0.0' })).version, '1.5.0');
  assert.equal(await checkForUpdate({ ...opts, current: '1.5.0' }), null);
  assert.equal(await checkForUpdate({ ...opts, current: '2.0.0' }), null, 'ahead of the registry');
});

/*
 * Who is on the team, and in what order sessions reach them.
 *
 * The order decides which pet you see when one Claude window is open, so the
 * cases that matter are all about a config file outliving the release that wrote
 * it: a pet since deleted, one just adopted, a list that names the same pet
 * twice. All pure, so none of it needs Electron or a live Claude Code.
 */
const test = require('node:test');
const assert = require('node:assert');

const { resolveRoster, mergeRoster, defaultOrder, LAST_BY_DEFAULT } = require('../pet-roster');

// what the lane actually ships with, so the default cases are about the real team
const BUILT_INS = ['segfault', 'grep', 'mutex', 'heisenbug'];
const available = (customs = []) => ({ builtIns: BUILT_INS, customs });

test('with no config at all, the order is the one the lane already had', () => {
  const { order, enabled } = resolveRoster({}, available());
  assert.deepStrictEqual(order, ['segfault', 'grep', 'mutex', 'heisenbug']);
  assert.deepStrictEqual(enabled, order, 'nothing is off until someone says so');
});

/*
 * The one property that must not move: before this existed, bindSessions put the
 * fish last by filtering. That filter is now switched off whenever a roster is
 * set, so the default roster has to reproduce it or every existing user's team
 * quietly reorders on upgrade.
 */
test('customs sit between the land pets and the fish, as the old filter had it', () => {
  const { order } = resolveRoster({}, available(['Yoda', 'Nullptr']));
  assert.deepStrictEqual(order, ['segfault', 'grep', 'mutex', 'Yoda', 'Nullptr', 'heisenbug']);
  assert.strictEqual(order[order.length - 1], LAST_BY_DEFAULT);
});

test('defaultOrder puts the fish last however the built-ins arrive', () => {
  assert.deepStrictEqual(
    defaultOrder(['heisenbug', 'grep'], ['Yoda']),
    ['grep', 'Yoda', 'heisenbug'],
  );
});

test('a stated order is honoured verbatim, fish included', () => {
  const cfg = { order: ['heisenbug', 'mutex', 'segfault', 'grep'] };
  const { order, enabled } = resolveRoster(cfg, available());
  assert.deepStrictEqual(order, ['heisenbug', 'mutex', 'segfault', 'grep']);
  assert.strictEqual(order[0], 'heisenbug', 'dragging the fish to the top has to stick');
  assert.deepStrictEqual(enabled, order);
});

test('off removes a pet from the team but leaves it in place in the list', () => {
  const cfg = { order: ['segfault', 'grep', 'mutex', 'heisenbug'], off: ['grep'] };
  const { order, enabled } = resolveRoster(cfg, available());
  assert.deepStrictEqual(order, ['segfault', 'grep', 'mutex', 'heisenbug'],
    'unchecking a pet must not make its row jump under the cursor');
  assert.deepStrictEqual(enabled, ['segfault', 'mutex', 'heisenbug']);
});

test('everything off is an empty team rather than a crash', () => {
  const cfg = { order: BUILT_INS.slice(), off: BUILT_INS.slice() };
  const { order, enabled } = resolveRoster(cfg, available());
  assert.deepStrictEqual(enabled, []);
  assert.strictEqual(order.length, 4, 'all four rows are still there to switch back on');
});

/*
 * A pet drawn thirty seconds ago has to come out. Appending unknowns to the end
 * of the saved order would land every new custom behind Heisenbug — last to ever
 * be handed a session, which for a pet you just made reads as it not working.
 */
test('a newly adopted custom slots in behind the pet ahead of it by default', () => {
  const cfg = { order: ['segfault', 'grep', 'mutex', 'heisenbug'] };
  const { order, enabled } = resolveRoster(cfg, available(['Yoda']));
  assert.deepStrictEqual(order, ['segfault', 'grep', 'mutex', 'Yoda', 'heisenbug']);
  assert.ok(order.indexOf('Yoda') < order.indexOf('heisenbug'),
    'a brand-new pet must not queue behind the fallback pet');
  assert.deepStrictEqual(enabled, order);
});

test('a new custom lands behind its default predecessor even in a reordered list', () => {
  // the user has dragged the fish to the front; Mutex still precedes a custom by
  // default, so Yoda belongs immediately after Mutex wherever Mutex now is
  const cfg = { order: ['heisenbug', 'segfault', 'mutex', 'grep'] };
  const { order } = resolveRoster(cfg, available(['Yoda']));
  assert.deepStrictEqual(order, ['heisenbug', 'segfault', 'mutex', 'Yoda', 'grep']);
});

/*
 * A partial config — hand-written, or saved by a release with fewer pets — where
 * several pets have to be slotted in around the two that are named. Each
 * insertion moves everything after it along, so the positions recorded for the
 * named pets have to move with it; a stale one sends the next insertion to the
 * wrong index. Yoda anchors on Mutex, so Mutex's *current* position is what
 * decides where he lands.
 */
test('pets slot in correctly around a config that names only some of them', () => {
  const cfg = { order: ['mutex', 'heisenbug'] };
  const { order } = resolveRoster(cfg, available(['Yoda']));
  assert.deepStrictEqual(order, ['segfault', 'grep', 'mutex', 'Yoda', 'heisenbug']);
  assert.ok(order.indexOf('Yoda') > order.indexOf('mutex'),
    'Yoda follows Mutex by default, so he must not land ahead of him');
});

test('two new customs keep their own relative order', () => {
  const cfg = { order: ['segfault', 'grep', 'mutex', 'heisenbug'] };
  const { order } = resolveRoster(cfg, available(['Yoda', 'Nullptr']));
  assert.deepStrictEqual(order, ['segfault', 'grep', 'mutex', 'Yoda', 'Nullptr', 'heisenbug']);
});

test('a pet that no longer exists is dropped from a saved order', () => {
  const cfg = { order: ['segfault', 'Ghost', 'grep', 'mutex', 'heisenbug'] };
  const { order, enabled } = resolveRoster(cfg, available());
  assert.ok(!order.includes('Ghost'), 'a deleted custom pet cannot stay on the team');
  assert.deepStrictEqual(order, ['segfault', 'grep', 'mutex', 'heisenbug']);
  assert.deepStrictEqual(enabled, order);
});

test('a pet named twice in a saved order is placed once', () => {
  const cfg = { order: ['grep', 'segfault', 'grep', 'mutex', 'heisenbug'] };
  const { order } = resolveRoster(cfg, available());
  assert.deepStrictEqual(order, ['grep', 'segfault', 'mutex', 'heisenbug']);
});

test('an off entry for a pet that is not here is inert, not an error', () => {
  const cfg = { order: ['segfault', 'grep', 'mutex', 'heisenbug'], off: ['Yoda'] };
  const { order, enabled } = resolveRoster(cfg, available());
  assert.ok(!order.includes('Yoda'));
  assert.deepStrictEqual(enabled, ['segfault', 'grep', 'mutex', 'heisenbug']);
});

test('a pet switched off before it was deleted comes back still off', () => {
  const cfg = { order: ['segfault', 'grep', 'mutex', 'Yoda', 'heisenbug'], off: ['Yoda'] };
  const { order, enabled } = resolveRoster(cfg, available(['Yoda']));
  assert.ok(order.includes('Yoda'), 'it is on the list again');
  assert.ok(!enabled.includes('Yoda'), 'and still switched off');
});

test('a ragged config is read as no opinion rather than throwing', () => {
  for (const cfg of [null, undefined, {}, { order: null }, { order: 'grep' }, { off: 7 }]) {
    const { order, enabled } = resolveRoster(cfg, available());
    assert.deepStrictEqual(order, ['segfault', 'grep', 'mutex', 'heisenbug'], String(JSON.stringify(cfg)));
    assert.deepStrictEqual(enabled, order);
  }
});

/*
 * Saving. The window can only report on the pets it drew, so the merge is where
 * a preference about an absent pet either survives or is silently thrown away.
 */
test('the window\'s order is taken wholesale', () => {
  const saved = { order: ['segfault', 'grep', 'mutex', 'heisenbug'], off: [] };
  const next = mergeRoster(saved, { order: ['heisenbug', 'mutex', 'grep', 'segfault'], off: [] });
  assert.deepStrictEqual(next.order, ['heisenbug', 'mutex', 'grep', 'segfault']);
});

test('unchecking and rechecking a pet in the window round-trips', () => {
  const shown = ['segfault', 'grep', 'mutex', 'heisenbug'];
  const off = mergeRoster({ order: shown, off: [] }, { order: shown, off: ['grep'] });
  assert.deepStrictEqual(off.off, ['grep']);
  const on = mergeRoster(off, { order: shown, off: [] });
  assert.deepStrictEqual(on.off, [], 'switching it back on has to actually clear it');
});

/*
 * The case a straight overwrite loses: Yoda was switched off, then deleted from
 * custom-pets.json, so the window never drew him and cannot mention him. Drop his
 * entry now and re-drawing that pet brings him back switched on — which the user
 * never asked for.
 */
test('an off entry for a pet the window never showed survives a save', () => {
  const saved = { order: ['segfault', 'grep', 'mutex', 'heisenbug'], off: ['Yoda'] };
  const next = mergeRoster(saved, {
    order: ['segfault', 'grep', 'mutex', 'heisenbug'],
    off: ['mutex'],
  });
  assert.ok(next.off.includes('Yoda'), 'the absent pet keeps its preference');
  assert.ok(next.off.includes('mutex'), 'and the window still gets its say');
});

test('a pet the window showed as on clears a stale off entry', () => {
  const saved = { order: ['segfault', 'grep'], off: ['grep'] };
  const next = mergeRoster(saved, { order: ['segfault', 'grep'], off: [] });
  assert.deepStrictEqual(next.off, [],
    'the window showed grep, so its answer wins over the old config');
});

test('mergeRoster never writes the same id twice', () => {
  const next = mergeRoster({ off: ['Yoda', 'Yoda'] }, { order: ['grep'], off: ['grep', 'grep'] });
  assert.deepStrictEqual(next.off.slice().sort(), ['Yoda', 'grep']);
});

test('a ragged update saves an empty roster rather than throwing', () => {
  assert.deepStrictEqual(mergeRoster(null, null), { order: [], off: [] });
  assert.deepStrictEqual(mergeRoster({ off: 'grep' }, { order: 'x' }), { order: [], off: [] });
});

test('no pets available at all is an empty roster, not an exception', () => {
  const { order, enabled } = resolveRoster({ order: ['grep'] }, { builtIns: [], customs: [] });
  assert.deepStrictEqual(order, []);
  assert.deepStrictEqual(enabled, []);
  assert.deepStrictEqual(resolveRoster({}, undefined), { order: [], enabled: [] });
});

// ------------------------------------------------------------------ guests
/*
 * The pets that ship with strays but are not the team.
 *
 * The four animals are the story — each one a bug you have personally met — so a
 * bundled guest arrives switched off and the Pets window is where you let one in.
 * The whole difficulty is that "switched off by default" has to stop applying the
 * moment the user says otherwise, and the window saves the *entire* list on every
 * change, so after one save every pet is named in `order`.
 */
const guests = (names, customs = names) => ({
  builtIns: BUILT_INS, customs, guests: names,
});

test('a bundled guest ships switched off, but is still on the list', () => {
  const { order, enabled } = resolveRoster({}, guests(['Yoda', 'BMO']));
  assert.ok(order.includes('Yoda') && order.includes('BMO'), 'both are shown');
  assert.ok(!enabled.includes('Yoda'), 'and neither is out');
  assert.ok(!enabled.includes('BMO'));
  assert.deepStrictEqual(enabled, ['segfault', 'grep', 'mutex', 'heisenbug'],
    'the team is exactly the four animals');
});

test('letting a guest in survives a restart', () => {
  // what the window saves after checking Yoda: the whole order, Yoda not in off
  const saved = {
    order: ['segfault', 'grep', 'mutex', 'Yoda', 'BMO', 'heisenbug'],
    off: ['BMO'],
  };
  const { enabled } = resolveRoster(saved, guests(['Yoda', 'BMO']));
  assert.ok(enabled.includes('Yoda'),
    'a guest the user switched on must not be forced back off on the next launch');
  assert.ok(!enabled.includes('BMO'), 'and the one still unchecked stays out');
});

test('a guest switched off by hand is off for the stated reason, not the default', () => {
  const saved = { order: ['segfault', 'Yoda'], off: ['Yoda'] };
  const { enabled } = resolveRoster(saved, guests(['Yoda']));
  assert.deepStrictEqual(enabled, ['segfault', 'grep', 'mutex', 'heisenbug']);
});

/*
 * The team has to stay together at the top. Five guests between Mutex and
 * Heisenbug pushed the fish off the bottom of the window, so the four stopped
 * reading as a set — which is how this was reported.
 */
test('guests go after the whole team, not into the middle of it', () => {
  const { order } = resolveRoster({}, guests(['Yoda', 'Rick']));
  assert.deepStrictEqual(order, ['segfault', 'grep', 'mutex', 'heisenbug', 'Yoda', 'Rick']);
  assert.ok(order.indexOf('Yoda') > order.indexOf('heisenbug'),
    'the fish is the last of the team, so a guest comes after her');
});

test('guests land at the bottom even when the team has been reordered', () => {
  // anchoring a guest on the fish would drop it into the middle of this list
  const cfg = { order: ['heisenbug', 'segfault', 'mutex', 'grep'] };
  const { order } = resolveRoster(cfg, guests(['Yoda']));
  assert.deepStrictEqual(order, ['heisenbug', 'segfault', 'mutex', 'grep', 'Yoda']);
});

test('a user-drawn custom still lands among the team, not with the guests', () => {
  const { order } = resolveRoster({}, {
    builtIns: BUILT_INS, customs: ['Nullptr', 'Yoda'], guests: ['Yoda'],
  });
  assert.deepStrictEqual(order, ['segfault', 'grep', 'mutex', 'Nullptr', 'heisenbug', 'Yoda'],
    'a pet you drew is one of yours; a bundled one is a visitor');
});

test('a guest the user dragged upward keeps the place they gave it', () => {
  const cfg = { order: ['Yoda', 'mutex', 'heisenbug', 'segfault', 'grep'] };
  const { order, enabled } = resolveRoster(cfg, guests(['Yoda', 'Rick']));
  assert.strictEqual(order[0], 'Yoda', 'placed by hand, so it stays put');
  assert.strictEqual(order[order.length - 1], 'Rick', 'the unplaced guest still goes last');
  assert.ok(enabled.includes('Yoda'), 'and stays switched on');
  assert.ok(!enabled.includes('Rick'));
});

test('a guest that is not here changes nothing', () => {
  const { order, enabled } = resolveRoster({}, {
    builtIns: BUILT_INS, customs: [], guests: ['Ghost'],
  });
  assert.deepStrictEqual(order, ['segfault', 'grep', 'mutex', 'heisenbug']);
  assert.deepStrictEqual(enabled, order, 'and does not switch off a built-in');
});

test('a missing or ragged guest list is read as no guests', () => {
  for (const bad of [undefined, null, 'Yoda', 7]) {
    const { order, enabled } = resolveRoster({}, { builtIns: BUILT_INS, customs: ['Yoda'], guests: bad });
    assert.deepStrictEqual(order, ['segfault', 'grep', 'mutex', 'Yoda', 'heisenbug'],
      `guests=${JSON.stringify(bad)} — Yoda falls back to being an ordinary custom pet`);
    assert.deepStrictEqual(enabled, order);
  }
});

/*
 * A pet can reach the order by two routes — the saved order, and being appended
 * as an unplaced guest — so the one invariant that has to hold across every
 * config is that it arrives once. A duplicate id is worse than a wrong position:
 * the roster keys pets by id, so the second one shadows the first.
 */
test('the resolved order never contains the same pet twice', () => {
  const cases = [
    [{}, guests(['Yoda', 'Rick'])],
    [{ order: ['Yoda', 'mutex', 'heisenbug', 'segfault', 'grep'] }, guests(['Yoda', 'Rick'])],
    [{ order: ['Yoda', 'Rick'], off: ['Rick'] }, guests(['Yoda', 'Rick'])],
    [{ order: ['grep', 'grep', 'Yoda'] }, guests(['Yoda'])],
    [{ order: ['Rick', 'Yoda'] }, guests(['Yoda', 'Rick'])],
  ];
  for (const [cfg, avail] of cases) {
    const { order, enabled } = resolveRoster(cfg, avail);
    assert.strictEqual(new Set(order).size, order.length,
      `duplicate in order for ${JSON.stringify(cfg)}: ${order.join(',')}`);
    assert.strictEqual(new Set(enabled).size, enabled.length, 'and none in enabled');
  }
});

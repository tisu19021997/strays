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

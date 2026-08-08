/*
 * A pet keeps its session.
 *
 * The watcher emits sessions sorted by most-recent-activity, so a positional
 * assignment reshuffles every pet whenever a different session gets busy. The
 * pet a developer aims at has to be the pet they click, and the pet an approval
 * card is drawn above.
 *
 * strays.js is a browser file, so the engine is driven here through its public
 * API over the smallest DOM that lets it mount.
 */
const test = require('node:test');
const assert = require('node:assert');

// ------------------------------------------------------------- minimal DOM
const LANE_W = 800;

const drawnText = []; // every string the engine paints, so labels are readable

function fakeContext() {
  const ctx = {
    measureText: (t) => ({ width: String(t).length * 6 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillText: (t) => drawnText.push(String(t)),
  };
  for (const m of ['arcTo', 'beginPath', 'clearRect', 'closePath', 'drawImage',
                   'ellipse', 'fill', 'fillRect', 'lineTo', 'moveTo',
                   'restore', 'rotate', 'save', 'scale', 'setTransform', 'translate']) {
    ctx[m] = () => {};
  }
  return ctx;
}

function fakeElement() {
  return {
    style: {}, width: 0, height: 0, clientWidth: LANE_W, clientHeight: 190,
    setAttribute() {}, appendChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: LANE_W, height: 190 }),
    getContext: () => fakeContext(),
  };
}

globalThis.document = {
  hidden: false,
  body: fakeElement(),
  createElement: fakeElement,
  addEventListener() {}, removeEventListener() {},
};
// window listeners are kept so the test can drive the real pointer path
const listeners = new Map();
globalThis.window = {
  innerWidth: LANE_W, innerHeight: 900, devicePixelRatio: 1,
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  removeEventListener(type, fn) {
    const a = listeners.get(type) || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  },
};
const fire = (type, ev) => (listeners.get(type) || []).slice().forEach((fn) => fn(ev || {}));
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const Strays = require('../../strays.js');

// ------------------------------------------------------------- test helpers
// the cwd deliberately says nothing about the id: two sessions in one repo are
// exactly the case a hover label has to tell apart
const session = (id, state) => ({ id, state: state || 'thinking', cwd: '/Users/dev/Projects/demo' });

/* what each pet currently holds, in pet order */
const bound = (world) => world.pets.map((p) => (p.session ? p.session.id : null));
const onScreen = (world) => world.pets.filter((p) => !p.hidden);
const petFor = (world, id) => world.pets.find((p) => p.session && p.session.id === id);
const centreOf = (pet) => pet.x + (pet.sprites.walk1[0].length * pet.scale) / 2;

function mountFollowing(t, opts) {
  const world = Strays.mount(Object.assign(
    { height: 190, loadStored: false, parent: document.body }, opts));
  Strays.setFollowMode(true);
  t.after(() => Strays.destroy());
  return world;
}

const frame = () => Strays.step(1 / 60, 1);

/* rest the pointer on a pet and return the strings drawn that frame */
function hoverPet(world, pet) {
  fire('mousemove', { clientX: centreOf(pet), clientY: world.h - 5 });
  drawnText.length = 0;
  frame();
  return drawnText.slice();
}

/* a real pointer press on a pet, then the pointer leaves again */
function clickPet(world, pet) {
  fire('mousemove', { clientX: centreOf(pet), clientY: world.h - 5 });
  fire('mousedown', {});
  frame();
  fire('mouseup', {});
  fire('mousemove', { clientX: -500, clientY: -500 });
  frame();
}

// ------------------------------------------------------------------- tests
test('a pet keeps its session when the activity order changes', (t) => {
  const world = mountFollowing(t);

  Strays.setSessions([session('alpha'), session('beta'), session('gamma')]);
  frame();
  const first = bound(world);
  assert.deepEqual(first.filter(Boolean), ['alpha', 'beta', 'gamma']);

  // beta gets busy, so the watcher now emits it first. Nothing about which pet
  // represents which session has changed.
  Strays.setSessions([session('beta'), session('gamma'), session('alpha')]);
  frame();
  assert.deepEqual(bound(world), first);

  Strays.setSessions([session('gamma'), session('alpha'), session('beta')]);
  frame();
  assert.deepEqual(bound(world), first);
});

test('a session that ends releases its pet, and the team shrinks with it', (t) => {
  const clicked = [];
  const world = mountFollowing(t, { onPetClick: (s) => clicked.push(s.id) });

  Strays.setSessions([session('alpha'), session('beta'), session('gamma')]);
  frame();
  const beta = petFor(world, 'beta');
  clickPet(world, beta);
  assert.ok(clicked.includes('beta'), 'a bound pet reports its session on click');

  // beta finishes. alpha and gamma keep the pets they already had, and the
  // pets on screen are exactly the ones still holding a session.
  Strays.setSessions([session('alpha'), session('gamma')]);
  frame();
  assert.equal(beta.session, null);
  assert.deepEqual(bound(world).filter(Boolean), ['alpha', 'gamma']);
  assert.deepEqual(onScreen(world).map((p) => p.session && p.session.id), ['alpha', 'gamma']);

  clicked.length = 0;
  clickPet(world, beta);
  assert.deepEqual(clicked.filter((id) => id === 'beta'), [],
    'a released pet no longer reports the session it used to hold');
});

test('a new session takes a free pet and leaves the bound ones alone', (t) => {
  const world = mountFollowing(t);

  Strays.setSessions([session('alpha'), session('beta')]);
  frame();
  const alpha = petFor(world, 'alpha');
  const beta = petFor(world, 'beta');

  // delta starts and is instantly the busiest, so the watcher emits it first
  Strays.setSessions([session('delta'), session('alpha'), session('beta')]);
  frame();
  assert.equal(alpha.session.id, 'alpha');
  assert.equal(beta.session.id, 'beta');
  const delta = petFor(world, 'delta');
  assert.ok(delta && delta !== alpha && delta !== beta, 'delta got a pet of its own');
  assert.equal(onScreen(world).length, 3);

  // alpha ends and epsilon starts: the freed pet is available again
  Strays.setSessions([session('delta'), session('beta'), session('epsilon')]);
  frame();
  assert.equal(petFor(world, 'epsilon'), alpha);
  assert.equal(delta.session.id, 'delta');
  assert.equal(beta.session.id, 'beta');
});

test('a first-time binding still fills the land pets before the fish', (t) => {
  // the fish is assignable last however the team itself is ordered
  const world = mountFollowing(t, { pets: ['heisenbug', 'segfault', 'grep'] });
  const fish = world.pets.find((p) => p.kind === 'heisenbug');

  Strays.setSessions([session('alpha')]);
  frame();
  assert.equal(petFor(world, 'alpha').kind, 'segfault');
  assert.equal(fish.session, null);
  assert.equal(onScreen(world).length, 1);

  Strays.setSessions([session('alpha'), session('beta'), session('gamma')]);
  frame();
  assert.equal(petFor(world, 'beta').kind, 'grep');
  assert.equal(petFor(world, 'gamma'), fish);
  assert.equal(onScreen(world).length, 3);
});

test('the fish answers a click like the rest of the team', (t) => {
  const clicked = [];
  const world = mountFollowing(t, { onPetClick: (s) => clicked.push(s.id) });
  const fish = world.pets.find((p) => p.kind === 'heisenbug');

  // the watcher emits up to eight sessions and only three pets walk, so the
  // fourth concurrent session is held by the fish
  Strays.setSessions([session('a'), session('b'), session('c'), session('d')]);
  frame();
  assert.equal(petFor(world, 'd'), fish);

  clickPet(world, fish);
  assert.deepEqual(clicked, ['d'], 'the fish reports its session exactly once');

  // and a land pet still reports exactly once, so the fish is not special-cased
  clicked.length = 0;
  clickPet(world, petFor(world, 'a'));
  assert.deepEqual(clicked, ['a']);
});

test('hovering a bound pet reveals which session it holds', (t) => {
  const world = mountFollowing(t);
  const sid = '7f3a9c21-0b44-4d6e-9a10-2c5e8b7d1f00';

  Strays.setSessions([session(sid)]);
  frame();
  const pet = petFor(world, sid);

  const label = hoverPet(world, pet).find((s) => s.includes(pet.name));
  assert.ok(label, 'the hovered pet gets a label');
  assert.ok(label.includes(sid.slice(0, 8)),
    `label "${label}" should name the session it holds`);

  // the fish is bindable too, and still reports the usage it is there to report
  const other = '0c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff';
  Strays.setSessions([session(sid), session('b'), session('c'), session(other)]);
  frame();
  const fish = petFor(world, other);
  assert.equal(fish.kind, 'heisenbug');
  const fishLabel = hoverPet(world, fish).find((s) => s.includes(fish.name));
  assert.ok(fishLabel.includes(other.slice(0, 8)),
    `label "${fishLabel}" should name the session it holds`);
  assert.match(fishLabel, /anomalies/);
});

test('an approval card anchors to the pet bound to the requesting session', (t) => {
  const world = mountFollowing(t);

  Strays.setSessions([session('alpha'), session('beta')]);
  frame();
  const beta = petFor(world, 'beta');
  assert.equal(Strays.sessionAnchor('beta'), centreOf(beta));

  // beta gets busy and leads the emission: the card still points at its pet
  Strays.setSessions([session('beta'), session('alpha')]);
  frame();
  assert.equal(Strays.sessionAnchor('beta'), centreOf(beta));
  assert.notEqual(Strays.sessionAnchor('alpha'), Strays.sessionAnchor('beta'));

  // once the session is gone there is no pet to point at
  Strays.setSessions([session('alpha')]);
  frame();
  assert.equal(Strays.sessionAnchor('beta'), null);
  assert.equal(Strays.sessionAnchor('nobody-here'), null);
});

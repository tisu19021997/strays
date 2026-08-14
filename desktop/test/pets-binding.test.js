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
const drawnFills = []; // and every colour it fills with, so chrome is checkable

function fakeContext() {
  const ctx = {
    measureText: (t) => ({ width: String(t).length * 6 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillText: (t) => drawnText.push(String(t)),
    // the lane's surfaces are plain rectangles, so the fill style at the moment
    // of the call is the only record of what colour anything came out
    fillRect: () => drawnFills.push(String(ctx.fillStyle)),
  };
  for (const m of ['arcTo', 'beginPath', 'clearRect', 'closePath', 'drawImage',
                   'ellipse', 'fill', 'lineTo', 'moveTo',
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

/*
 * Whether anyone is watching is judged against performance.now(), so a test that
 * wants to be unwatched has to be able to let real time pass without waiting for
 * it. Starts at zero, which is "the pointer moved just now".
 */
let clock = 0;
globalThis.performance = { now: () => clock };
const waitLongEnoughToBeAlone = () => { clock += 60 * 1000; };

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

test('hovering a bound pet says where it is running and what it is doing', (t) => {
  // The hover line must not restate the plate above it. The name is already
  // there; what the name cannot tell you is which checkout it is in and whether
  // it is waiting on you.
  const world = mountFollowing(t);
  const sid = '7f3a9c21-0b44-4d6e-9a10-2c5e8b7d1f00';

  Strays.setSessions([{ ...session(sid, 'waiting'), title: 'Fix the watcher' }]);
  frame();
  const pet = petFor(world, sid);

  const drawn = hoverPet(world, pet);
  const detail = drawn.find((s) => s.includes('demo'));
  assert.ok(detail, `no detail line among ${JSON.stringify(drawn)}`);
  assert.match(detail, /needs you/, 'the state is said in words, not the watcher\'s term');
  assert.ok(drawn.some((s) => s.includes('Fix the watcher')),
    'and the name stays on the plate above it');
});

test('an untitled session falls back to its id, and a titled one does not need to', (t) => {
  /*
   * Two sessions open in the same repo are the case this protects: the plate
   * can only show the project for an untitled one, so without the id a click
   * cannot be aimed. A titled session is already distinguishable, and spending
   * the line on a uuid nobody recognises would be a waste of it.
   */
  const world = mountFollowing(t);
  const bare = '7f3a9c21-0b44-4d6e-9a10-2c5e8b7d1f00';
  Strays.setSessions([session(bare)]);
  frame();
  assert.ok(
    hoverPet(world, petFor(world, bare)).some((s) => s.includes(bare.slice(0, 8))),
    'an untitled session has nothing else to tell two of them apart',
  );

  const titled = '0c1d2e3f-aaaa-bbbb-cccc-ddddeeeeffff';
  Strays.setSessions([{ ...session(titled), title: 'Named session' }]);
  frame();
  assert.ok(
    !hoverPet(world, petFor(world, titled)).some((s) => s.includes(titled.slice(0, 8))),
    'a titled session must not spend the line on a uuid',
  );
});

test('hovering a pet with no session says so, and unhovered ones stay bare', (t) => {
  // A wandering pet carries no label — that is the quiet default. But pointing
  // at one has to explain itself: no name is *because* there is no session.
  const world = mountFollowing(t);
  Strays.setSessions([]);
  frame();
  const pet = world.pets.find((p) => p.kind === 'segfault');

  drawnText.length = 0;
  frame();
  assert.ok(!drawnText.some((s) => s.includes(pet.name)),
    'an unhovered pet with no session must not be labelled at all');

  const drawn = hoverPet(world, pet);
  assert.ok(drawn.some((s) => s.includes(pet.name)), 'hovering names the pet');
  assert.ok(drawn.some((s) => s.includes('no session')),
    `hovering should explain the absence, got ${JSON.stringify(drawn)}`);
});

test('a pet speaks in its own colour, never in white', (t) => {
  /*
   * The bubble used to be white. That failed twice: it was the loudest surface
   * in the lane for the least important thing in it, and over a light window
   * there was no bubble visible at all. Taking the fill from the speaker's own
   * palette makes it legible on any backdrop and says who is talking.
   */
  const world = mountFollowing(t);
  Strays.setSessions([session('alpha'), session('beta')]);
  frame();

  const grep = world.pets.find((p) => p.kind === 'grep');
  world.bubbles.push({ pet: grep, text: 'found it', age: 0.5, life: 99 });

  drawnFills.length = 0;
  frame();
  const own = grep.pal[1];
  assert.ok(drawnFills.includes(own),
    `the bubble should be filled with the pet's own ${own}`);
  for (const fill of drawnFills) {
    assert.ok(!/^#(fff|ffffff|fafafc)$/i.test(fill),
      `nothing in the lane should be painted white, found ${fill}`);
  }
});

test('the fish still reports the usage it exists to report', (t) => {
  const world = mountFollowing(t);
  const ids = ['a', 'b', 'c', 'd'];
  Strays.setSessions(ids.map((i) => session(i)));
  frame();
  const fish = petFor(world, 'd');
  assert.equal(fish.kind, 'heisenbug');

  Strays.setUsage({ input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, cost: 12.5 });
  const drawn = hoverPet(world, fish);
  const line = drawn.find((s) => s.includes('$'));
  assert.ok(line, `no usage line among ${JSON.stringify(drawn)}`);
  assert.match(line, /12\.50/);
  assert.match(line, /tok/);
});

// --------------------------------------------------------------- Heisenbug
/* how far the fish moves over a stretch of frames, with nobody touching it */
function fishDrift(world, seconds = 60) {
  const fish = world.pets.find((p) => p.kind === 'heisenbug');
  let last = fish.x;
  let jumps = 0;
  for (let i = 0; i < seconds * 60; i++) {
    clock += 1000 / 60;
    Strays.step(1 / 60);
    if (Math.abs(fish.x - last) > 60) jumps++;
    last = fish.x;
  }
  return jumps;
}

/* the fish is the last pet bound, so it takes four sessions to put her on one */
const fourSessions = () => ['a', 'b', 'c', 'd'].map((id) => session(id, 'resting'));

test('the fish teleports when she is genuinely alone', (t) => {
  // the character, stated: she only misbehaves when nobody is looking. If this
  // ever goes quiet, the joke has been deleted rather than fixed.
  const world = mountFollowing(t);
  Strays.setSessions(fourSessions());
  frame();
  waitLongEnoughToBeAlone();
  assert.ok(fishDrift(world) > 0, 'unwatched, she should get up to something');
});

test('a host that knows someone is there stops her wandering off', (t) => {
  /*
   * The bug this exists for. The engine infers "someone is watching" from a
   * mousemove over its own canvas, which on a web page is fair. The desktop
   * overlay is a 190px strip along the bottom of the screen that nobody ever
   * points at, so a developer sitting there working all day never counted, and
   * the fish teleported across the screen for the entire session — about
   * thirty times a minute. The overlay now answers the question itself, from
   * system-wide idle time.
   */
  const world = mountFollowing(t);
  Strays.setSessions(fourSessions());
  frame();
  Strays.setObserved(true);
  waitLongEnoughToBeAlone();

  assert.equal(fishDrift(world), 0,
    'told that someone is present, she must stay put however old the last mousemove is');
});

test('and the mischief can be switched off outright', (t) => {
  const world = mountFollowing(t);
  Strays.setSessions(fourSessions());
  frame();
  Strays.setMischief(false);
  waitLongEnoughToBeAlone();

  assert.equal(fishDrift(world), 0, 'off means off, watched or not');
});

test('handing observation back to the pointer restores the guess, both ways', (t) => {
  /*
   * The plain-web-page case: no host to ask, so the mousemove heuristic is all
   * there is. `null` has to mean "work it out again" — not "nobody is there",
   * which would leave a page that had once called setObserved permanently
   * convinced it was alone.
   */
  const world = mountFollowing(t);
  Strays.setSessions(fourSessions());
  frame();
  Strays.setObserved(true);
  Strays.setObserved(null);

  // the pointer just moved, so the heuristic should say someone is watching.
  // Asserted on the decision itself rather than on whether she happens to
  // teleport: the teleport is on a timer of several seconds, and the heuristic
  // only holds for six, so drift cannot tell these apart in the time available.
  fire('mousemove', { clientX: 10, clientY: world.h - 5 });
  Strays.step(1 / 60);
  assert.equal(world.observed, true,
    'with the pointer live, handing back control must not read as being alone');

  // and once it has been still for long enough, the same heuristic says alone
  waitLongEnoughToBeAlone();
  Strays.step(1 / 60);
  assert.equal(world.observed, false, 'the guess still notices when nobody is there');
  assert.ok(fishDrift(world) > 0, 'and she gets up to something again');
});

// ------------------------------------------------------------- sprite sets
/*
 * Every state the pets can be drawn in, taken from drawPet's own switch. A pet
 * whose sprite set has a hole in it selects `undefined`, and reading .length off
 * it throws out of the render loop — which on a canvas means every pet silently
 * disappears, with nothing on screen to say why.
 *
 * This shipped: DOG defines neither `sit` nor `sleep`, and `sleep` fell back only
 * as far as `sit`, so Grep falling asleep blanked the entire overlay. It stayed
 * hidden because the world only reaches `idle` — the state that lets a pet fall
 * asleep — when no session is active or waiting, and a stale-session bug used to
 * keep something in `waiting` almost permanently.
 */
const DRAWN_STATES = ['walk', 'fetch', 'sit', 'deadlock', 'sleep', 'loaf',
  'sniff', 'dig', 'glitch', 'crashed', 'swim'];

/* the grids drawPet selects out of a pet's own sprite set */
const REQUIRED_GRIDS = ['walk1', 'walk2', 'sit', 'sleep'];

const MINIMAL_PET = {
  name: 'Nullptr',
  palette: { 1: '#8fd977', k: '#17181c' },
  grids: { walk1: ['.11.', '1111', '.1.1'] }, // walk1 only, as the docs allow
};

test('every pet resolves every grid the drawing code can select', (t) => {
  const world = mountFollowing(t);
  Strays.addCustomPet(MINIMAL_PET, false);
  frame();

  for (const pet of world.pets) {
    for (const grid of REQUIRED_GRIDS) {
      const g = pet.sprites[grid];
      assert.ok(Array.isArray(g) && g.length,
        `${pet.name} has no ${grid} grid — drawing it would throw and blank the lane`);
      assert.ok(g.every((row) => row.length === g[0].length),
        `${pet.name}'s ${grid} has rows of differing length`);
    }
  }
});

test('every pet can be drawn in every state without throwing', (t) => {
  const world = mountFollowing(t);
  Strays.addCustomPet(MINIMAL_PET, false);
  Strays.setSessions([]);       // nobody hidden, so the whole team is drawn
  frame();

  for (const state of DRAWN_STATES) {
    for (const pet of world.pets) {
      pet.state = state;
      pet.stateT = 999;         // don't let the step transition out before drawing
      pet.frame = 1;            // the second walk frame is a separate grid
    }
    assert.doesNotThrow(() => frame(), `drawing every pet in "${state}" threw`);
    for (const pet of world.pets) { pet.frame = 0; }
    assert.doesNotThrow(() => frame(), `drawing every pet in "${state}" threw on frame 0`);
  }
});

// ------------------------------------------------------ naming the session
/* the strings drawn in one frame with nothing hovered */
function paint() {
  drawnText.length = 0;
  frame();
  return drawnText.slice();
}

test('a pet carries the name of the session it holds, without being hovered', (t) => {
  // eight pets in one lane, and the point is to know which is which at a glance
  const world = mountFollowing(t);
  Strays.setSessions([{ ...session('alpha'), title: 'Fix the watcher' }]);
  frame();

  assert.ok(paint().some((s) => s.includes('Fix the watcher')),
    'the session name belongs on the pet, not behind a hover');
  assert.ok(petFor(world, 'alpha'), 'and the pet is still bound');
});

test('a session with no name falls back to the project it is running in', (t) => {
  // a transcript always records a cwd and only sometimes records a title
  mountFollowing(t);
  Strays.setSessions([session('alpha')]); // cwd /Users/dev/Projects/demo
  frame();
  assert.ok(paint().some((s) => s.includes('demo')),
    'the last segment of the working directory is the fallback');
});

test('a Windows working directory names the project, not the whole path', (t) => {
  // A Windows cwd contains no forward slashes, so "the last segment" used to be
  // the entire string — the caption read `C:\Users\me\Proje…` instead of `demo`
  mountFollowing(t);
  Strays.setSessions([{ id: 'w', state: 'tool', cwd: 'C:\\Users\\quang\\Projects\\demo' }]);
  frame();

  const drawn = paint();
  assert.ok(drawn.some((s) => s === 'demo'),
    `expected the project name, got ${JSON.stringify(drawn)}`);
  assert.ok(!drawn.some((s) => s.includes('C:')), 'and not the drive it is on');
});

test('a long name is cut down rather than covering the pets either side', (t) => {
  mountFollowing(t);
  const long = 'Investigate the flaky approval gate timeout on Windows';
  Strays.setSessions([{ ...session('alpha'), title: long }]);
  frame();

  const drawn = paint().find((s) => s.startsWith('Investigate'));
  assert.ok(drawn, 'the name is still drawn');
  assert.ok(drawn.length < long.length, `"${drawn}" was not shortened`);
  assert.ok(drawn.endsWith('…'), 'and it says that it was cut');
});

test('names can be turned off, leaving the state badge alone', (t) => {
  mountFollowing(t);
  Strays.setSessions([{ ...session('alpha', 'waiting'), title: 'Fix the watcher' }]);
  frame();

  Strays.setShowTitles(false);
  const off = paint();
  assert.ok(!off.some((s) => s.includes('Fix the watcher')), 'the name is gone');
  assert.ok(off.includes('❗'), 'the state glyph is not');

  Strays.setShowTitles(true);
  assert.ok(paint().some((s) => s.includes('Fix the watcher')), 'and it comes back');
});

test('a session carrying neither name nor cwd draws a badge and no name', (t) => {
  // the engine is a <script> tag on any page too, where setSessions may pass
  // nothing but an id and a state
  mountFollowing(t);
  Strays.setSessions([{ id: 'bare', state: 'tool' }]);
  frame();
  const drawn = paint();
  assert.ok(drawn.includes('🔧'), 'the state badge still draws');
  assert.ok(!drawn.some((s) => s.includes('undefined') || s.includes('null')),
    'and nothing leaks a missing field into the lane');
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

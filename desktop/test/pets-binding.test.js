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
const drawnAngles = []; // and every angle it turns by, so a wiggle is provable

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
                   'scale', 'setTransform', 'translate']) {
    ctx[m] = () => {};
  }
  // a turned sprite is turned by the context, so this is the only evidence that
  // a struggling pet was actually drawn struggling rather than just computing an
  // angle nothing reads
  ctx.rotate = (a) => drawnAngles.push(a);
  // the save stack, which has to come back to where it started every frame: a
  // save that is never restored does not spoil one frame, it leaves every later
  // frame drawn under a transform nothing will take off again
  ctx.save = () => { stack.depth++; stack.deepest = Math.max(stack.deepest, stack.depth); };
  ctx.restore = () => { stack.depth--; };
  return ctx;
}
const stack = { depth: 0, deepest: 0 };

function fakeElement() {
  return {
    style: {}, width: 0, height: 0, clientWidth: LANE_W, clientHeight: 190,
    setAttribute() {}, appendChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: LANE_W, height: 190 }),
    getContext: () => fakeContext(),
  };
}

/*
 * Listeners are kept so the test can drive the real pointer path, and window
 * and document share one table: the engine puts mouseleave on the document and
 * everything else on the window, and a test firing at the wrong one would pass
 * by reaching nothing at all.
 */
const listeners = new Map();
const listenTo = {
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

globalThis.document = Object.assign({
  hidden: false,
  body: fakeElement(),
  createElement: fakeElement,
}, listenTo);
globalThis.window = Object.assign({
  innerWidth: LANE_W, innerHeight: 900, devicePixelRatio: 1,
}, listenTo);
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

/*
 * The dice, seeded — see the same note in render-loop.test.js.
 *
 * Pets choose their next state at random and start at random positions, so a
 * handful of these tests passed or failed on the seed the process happened to
 * get: a fish that starts pinned against the far wall facing outward is clamped
 * back to the same x, and "she moved" is then false through no fault of the
 * engine. Deterministic dice make a failure here mean something and make it
 * reproducible.
 */
let seed = 0x5f3a91c;
Math.random = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};

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
  'sniff', 'dig', 'glitch', 'crashed', 'swim', 'held', 'falling'];

/* the states that only exist off the floor, and have to be drawn there */
const AIRBORNE = ['held', 'falling'];

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
      // a carried pet drawn at floor level lands on the step before anything is
      // painted, so the branch under test never runs
      pet.lift = AIRBORNE.includes(state) ? 40 : 0;
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

// ------------------------------------------------------ carrying a pet around
/*
 * A press that travels is a drag; one that does not is a click.
 *
 * The two used to be the same event: the jump fired the instant the button went
 * down, which cannot tell them apart even in principle. Every one of these
 * asserts one half of that split, or one of the ways a carry can be left
 * hanging with a pet stuck to the pointer.
 */

/* press on a pet and drag the pointer to (x, y), a frame per step */
function dragTo(world, pet, x, y, steps = 4) {
  fire('mousemove', { clientX: centreOf(pet), clientY: world.h - 5 });
  fire('mousedown', {});
  const x0 = centreOf(pet), y0 = world.h - 5;
  for (let i = 1; i <= steps; i++) {
    fire('mousemove', {
      clientX: x0 + ((x - x0) * i) / steps,
      clientY: y0 + ((y - y0) * i) / steps,
    });
    frame();
  }
}

/* run the world until the pet is back on the floor, or give up */
function settle(world, pet, frames = 240) {
  for (let i = 0; i < frames && (pet.state === 'falling' || pet.lift > 0); i++) frame();
}

test('dragging a pet carries it, and does not open its session', (t) => {
  const clicked = [];
  const world = mountFollowing(t, { onPetClick: (s) => clicked.push(s.id) });
  Strays.setSessions([session('alpha')]);
  frame();
  const pet = petFor(world, 'alpha');
  const from = pet.x;

  dragTo(world, pet, from + 200, world.h - 70);
  assert.equal(pet.state, 'held', 'the pet is in hand');
  assert.ok(pet.x > from + 100, `it followed the pointer (${from} -> ${pet.x})`);
  assert.ok(pet.lift > 20, `and came off the floor (lift ${pet.lift})`);

  fire('mouseup', {});
  assert.deepEqual(clicked, [], 'a drag is not a click, and must not navigate');

  settle(world, pet);
  assert.equal(pet.lift, 0, 'it lands again');
  assert.ok(pet.state !== 'held' && pet.state !== 'falling', 'and goes back to being a pet');
});

test('a press that barely moves is still a click', (t) => {
  const clicked = [];
  const world = mountFollowing(t, { onPetClick: (s) => clicked.push(s.id) });
  Strays.setSessions([session('alpha')]);
  frame();
  const pet = petFor(world, 'alpha');
  const from = pet.x;

  // a hand resting on a mouse moves it a pixel or two; that is not a drag
  fire('mousemove', { clientX: centreOf(pet), clientY: world.h - 5 });
  fire('mousedown', {});
  fire('mousemove', { clientX: centreOf(pet) + 1, clientY: world.h - 6 });
  frame();
  assert.notEqual(pet.state, 'held', 'a pixel of jitter did not pick it up');
  fire('mouseup', {});

  assert.deepEqual(clicked, ['alpha'], 'and the click still lands');
  assert.ok(Math.abs(pet.x - from) < 20, 'the pet was not thrown anywhere');
});

test('the lane keeps the pointer for the whole carry', (t) => {
  /*
   * The overlay makes its window click-through the moment nothing is hovered,
   * and it is the same window the release has to arrive at. If hover drops
   * mid-carry the mouseup goes to whatever application is underneath, and the
   * pet is stuck to the cursor with no way to put it down.
   */
  const hover = [];
  const world = mountFollowing(t, { onHoverChange: (on) => hover.push(on) });
  Strays.setSessions([session('alpha')]);
  frame();
  const pet = petFor(world, 'alpha');

  // carried right up to the ceiling, well clear of the band a pet is caught in
  dragTo(world, pet, centreOf(pet) + 40, 2);
  hover.length = 0;
  fire('mousemove', { clientX: centreOf(pet) + 60, clientY: 2 });
  frame();
  assert.ok(!hover.includes(false), 'lifting a pet clear of the floor kept the lane');

  /*
   * And holding still does not let go either. The idle timeout that clears a
   * stale hover is real, so it is driven here rather than waited for: a timer
   * armed during a carry is one that will drop the pet.
   */
  const realSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (fn) => { fn(); return 0; };
    fire('mousemove', { clientX: centreOf(pet) + 60, clientY: 2 });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(pet.state, 'held', 'the pet is still in hand');
  assert.ok(!hover.includes(false), 'and the lane still has the pointer');

  fire('mouseup', {});
  settle(world, pet);
});

test('the pointer leaving the page puts the pet down', (t) => {
  // there is no release coming, so nothing else ever will
  const world = mountFollowing(t);
  Strays.setSessions([session('alpha')]);
  frame();
  const pet = petFor(world, 'alpha');

  dragTo(world, pet, centreOf(pet) + 60, world.h - 80);
  assert.equal(pet.state, 'held');

  fire('mouseleave', {});
  assert.equal(world.grab, null, 'the carry ended with the pointer');
  settle(world, pet);
  assert.ok(pet.state !== 'held' && pet.state !== 'falling', 'the pet is not left hanging');
  assert.equal(pet.lift, 0, 'it is back on the floor');
});

test('a session ending mid-carry ends the carry', (t) => {
  const clicked = [];
  const world = mountFollowing(t, { onPetClick: (s) => clicked.push(s.id) });
  Strays.setSessions([session('alpha'), session('beta')]);
  frame();
  const pet = petFor(world, 'beta');

  dragTo(world, pet, centreOf(pet) + 50, world.h - 60);
  assert.equal(pet.state, 'held');

  // beta finishes: in follow mode its pet leaves the lane, and a hidden pet is
  // never updated again
  Strays.setSessions([session('alpha')]);
  frame();
  assert.equal(world.grab, null, 'the grab went with it');

  fire('mouseup', {});
  assert.deepEqual(clicked, [], 'and the release answers for nothing');
});

test('picking a pet up interrupts whatever it was in the middle of', (t) => {
  const world = mountFollowing(t, { pets: ['segfault', 'grep', 'mutex'] });
  frame();
  const grep = world.pets.find((p) => p.kind === 'grep');
  const cats = world.pets.filter((p) => p.kind !== 'grep');

  // Grep has the ball, and the two cats are nose to nose
  world.ball.held = grep;
  grep.carrying = 'ball';
  world.deadlock = { a: cats[0], b: cats[1], t: 3 };
  cats[0].state = 'deadlock'; cats[1].state = 'deadlock';

  dragTo(world, grep, centreOf(grep) + 30, world.h - 60);
  assert.equal(world.ball.held, null, 'you picked the dog up, so the dog dropped the ball');

  fire('mouseup', {});
  settle(world, grep);

  dragTo(world, cats[0], centreOf(cats[0]) + 30, world.h - 60);
  assert.equal(world.deadlock, null, 'and carrying one cat off settles the argument');
  assert.notEqual(cats[1].state, 'deadlock', 'the other one is free to move again');
  fire('mouseup', {});
  settle(world, cats[0]);
});

test('a pet cannot be carried out of the lane', (t) => {
  // the nameplate hangs above the sprite and grows a line on hover; a pet held
  // at the ceiling would wear a label clipped off the top of the screen
  const world = mountFollowing(t);
  Strays.setSessions([session('alpha')]);
  frame();
  const pet = petFor(world, 'alpha');

  dragTo(world, pet, -400, -400, 6);
  const top = pet.spriteTop;
  assert.ok(top > 0, `the sprite stayed in the lane (top ${top})`);
  assert.ok(pet.x >= 0, `and so did its left edge (x ${pet.x})`);

  hoverPet(world, pet); // its plate is drawn from spriteTop, and must fit above it
  assert.ok(top - 37 >= 0, 'with room above it for the plate the hover expands');

  fire('mouseup', {});
  settle(world, pet);
});

test('a pet carried off the floor keeps its own label', (t) => {
  /*
   * An unbound pet is only labelled while the pointer is on it, and the pointer
   * is on it for the whole carry. A pet is caught anywhere in the bottom of the
   * lane, so lifting one above that band has to take the band with it — or the
   * pet in your hand goes anonymous the moment you raise it.
   */
  const world = mountFollowing(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];

  dragTo(world, pet, centreOf(pet) + 20, 6);
  drawnText.length = 0;
  frame();
  assert.ok(drawnText.includes('Segfault'), 'the pet being carried is still named');

  fire('mouseup', {});
  settle(world, pet);
});

// --------------------------------------------------------- being carried off
/*
 * A pet fights the grip. The wiggle is an envelope (how hard it is struggling)
 * over a pair of waves (which way it is twisting), so what is worth pinning is
 * the shape: it goes both ways, it is bounded, it answers to being swung about,
 * and it is gone the moment there are four feet on the floor again.
 */

/* run the world for n frames, collecting whatever fn reads off each one */
function over(n, fn) {
  const seen = [];
  for (let i = 0; i < n; i++) { frame(); seen.push(fn()); }
  return seen;
}

/*
 * The panic is deliberately random, so a test that needs a settled pet has to
 * take the dice away. 0.99 rather than 1: `pick()` indexes an array with it.
 */
function withoutLuck(fn) {
  const real = Math.random;
  Math.random = () => 0.99;
  try { return fn(); } finally { Math.random = real; }
}

test('a carried pet struggles both ways, and never spins', (t) => {
  const world = mountFollowing(t);
  Strays.setSessions([session('alpha')]);
  frame();
  const pet = petFor(world, 'alpha');

  dragTo(world, pet, centreOf(pet) + 40, world.h - 60);
  const tilts = over(50, () => pet.tilt);

  assert.ok(tilts.some((a) => a > 0.02), 'it twists one way');
  assert.ok(tilts.some((a) => a < -0.02), 'and the other');
  assert.ok(tilts.every((a) => Math.abs(a) <= 0.25),
    `a held pet leans, it does not cartwheel (max ${Math.max(...tilts.map(Math.abs))})`);

  fire('mouseup', {});
  settle(world, pet);
  assert.equal(pet.tilt, 0, 'and it stands up straight once it lands');
  assert.equal(pet.squirm, 0, 'with nothing left to fight');
});

test('a pet swung about fights harder than one held still', (t) => {
  const world = mountFollowing(t);
  Strays.setSessions([session('alpha')]);
  frame();
  const pet = petFor(world, 'alpha');

  withoutLuck(() => {
    dragTo(world, pet, centreOf(pet) + 20, world.h - 60);
    // held still: no fresh panic can strike, so it sulks down to the floor value
    const still = over(90, () => pet.squirm).pop();
    assert.ok(still < 0.3, `holding it still lets it settle (${still})`);

    /*
     * And then swept the length of the lane. It takes a sweep rather than one
     * jump because the speed a carry is judged on is smoothed across frames —
     * a single stuttered sample must not read as a shake.
     */
    const to = pet.x < world.w / 2 ? world.w - 60 : 60;
    const from = world.mouse.x;
    let peak = 0;
    for (let i = 1; i <= 6; i++) {
      fire('mousemove', { clientX: from + ((to - from) * i) / 6, clientY: world.h - 60 });
      frame();
      peak = Math.max(peak, pet.squirm);
    }
    assert.ok(peak > still + 0.2, `being swung about set it off again (${still} -> ${peak})`);
  });

  fire('mouseup', {});
  settle(world, pet);
});

test('legs scrabble in the air faster than they walk on the floor', (t) => {
  const world = mountFollowing(t, { pets: ['grep'] });
  frame();
  const pet = world.pets[0];
  const flips = (n) => {
    let last = pet.frame, count = 0;
    over(n, () => { if (pet.frame !== last) { count++; last = pet.frame; } });
    return count;
  };

  pet.state = 'walk';
  const walking = flips(60);

  dragTo(world, pet, centreOf(pet) + 20, world.h - 60);
  const carried = flips(60);
  // twice over, not merely more: the two rates are far apart on purpose, and a
  // margin of one is just where the cycle happened to be when the count started
  assert.ok(carried > walking * 2,
    `a carried pet kicks much faster than it walks (${carried} vs ${walking})`);

  fire('mouseup', {});
  settle(world, pet);
});

test('every pet has a way of being carried, including one just adopted', (t) => {
  // a custom pet is drawn by the same code as the built-ins, so it has to have
  // a struggle of its own rather than an undefined one
  const world = mountFollowing(t, { pets: ['segfault', 'grep', 'heisenbug'] });
  Strays.addCustomPet(MINIMAL_PET, false);
  frame();
  // spread out by hand: an adopted pet is dropped in at a random x, and two
  // pets sharing one means the drag under test lands on whichever is on top
  world.pets.forEach((p, i) => { p.x = 30 + i * 180; });

  for (const pet of world.pets) {
    dragTo(world, pet, centreOf(pet) + 30, world.h - 60);
    drawnAngles.length = 0;
    const tilts = over(30, () => pet.tilt);
    assert.ok(tilts.every((a) => Number.isFinite(a)),
      `${pet.name} tilts to a number`);
    assert.ok(tilts.some((a) => Math.abs(a) > 0.02),
      `${pet.name} puts up a fight`);
    // and the fight reaches the canvas: the fish is drawn by her own function,
    // and computing an angle nothing turns by is the easy way to miss her
    assert.ok(drawnAngles.some((a) => Math.abs(a) > 0.02),
      `${pet.name} is actually drawn struggling`);
    fire('mouseup', {});
    settle(world, pet);
    assert.equal(pet.tilt, 0, `${pet.name} lands upright`);
  }
});

test('two pets in the same spot: you pick up the one you can see', (t) => {
  /*
   * Pets are drawn in array order, so the last one drawn is the one on top.
   * Searching forwards finds the pet behind it — survivable for a click, and
   * not for a carry, where the wrong animal comes away in your hand.
   */
  const world = mountFollowing(t, { pets: ['segfault', 'mutex'] });
  frame();
  const [behind, inFront] = world.pets;
  behind.x = inFront.x = 300;
  behind.state = inFront.state = 'sit';

  dragTo(world, inFront, 380, world.h - 60);
  assert.equal(world.grab && world.grab.pet, inFront, 'the pet on top is the one carried');
  assert.notEqual(behind.state, 'held', 'and the one underneath stays put');

  fire('mouseup', {});
  settle(world, inFront);
});

test('a pet fights hardest the moment it leaves the floor', (t) => {
  const world = mountFollowing(t);
  Strays.setSessions([session('alpha')]);
  frame();
  const pet = petFor(world, 'alpha');

  // the panic is random by design, so it is taken away to watch the envelope
  withoutLuck(() => {
    /*
     * Lifted gently — just past the slop and no further. Sweeping it across the
     * lane would set it off by being swung about, which is a different cause
     * with the same symptom, and would hide a pickup that did nothing at all.
     */
    fire('mousemove', { clientX: centreOf(pet), clientY: world.h - 5 });
    fire('mousedown', {});
    fire('mousemove', { clientX: centreOf(pet) + 5, clientY: world.h - 5 });
    frame();
    assert.equal(pet.state, 'held', 'it is off the floor');

    const first = Math.max(...over(10, () => Math.abs(pet.tilt)));
    assert.ok(first > 0.12, `it comes up fighting (${first})`);

    const later = Math.max(...over(120, () => Math.abs(pet.tilt)).slice(-30));
    assert.ok(later < first / 2,
      `and sulks if you just hold on to it (${first} -> ${later})`);
  });

  fire('mouseup', {});
  settle(world, pet);
});

test('the lane hands the canvas back the way it found it', (t) => {
  /*
   * A carried pet is drawn turned, which is the first transform in the pet
   * path. Leave that save unbalanced and the tilt never comes off: the whole
   * lane draws at an angle from then on, and clearRect no longer covers it.
   */
  const world = mountFollowing(t, { pets: ['segfault'] });
  frame();
  assert.equal(stack.depth, 0, 'a plain frame balances');

  const pet = world.pets[0];
  stack.deepest = 0;
  dragTo(world, pet, centreOf(pet) + 40, world.h - 60);
  for (let i = 0; i < 20; i++) {
    frame();
    assert.equal(stack.depth, 0, 'and so does every frame of a carry');
  }
  assert.ok(stack.deepest > 0, 'the carry really did save the context');

  fire('mouseup', {});
  settle(world, pet);
  assert.equal(stack.depth, 0, 'and it is still balanced after the landing');
});

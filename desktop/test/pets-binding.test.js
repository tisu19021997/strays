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
/*
 * The lane's width, mutable for the same reason its height is: on the desktop
 * both come from the display. A test measuring how far a thrown pet travels has
 * to be able to ask for a lane it will not cross, or WALL_BOUNCE takes 40% of
 * the speed and the measurement is really about the walls.
 */
let laneW = 800;

/*
 * The lane's height is a variable because it is one in the overlay too: there
 * the window *is* the lane, and `height: 'fill'` measures it rather than being
 * told a number, so a pet can be carried up the whole screen. Tests that care
 * go through mountFullScreen().
 */
let laneH = 190;

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
    style: {}, width: 0, height: 0,
    get clientWidth() { return laneW; },
    get clientHeight() { return laneH; }, // a getter: the lane can be resized
    setAttribute() {}, appendChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: laneW, height: laneH }),
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
  get innerWidth() { return laneW; }, innerHeight: 900, devicePixelRatio: 1,
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
const widthOf = (pet) => pet.sprites.walk1[0].length * pet.scale;
const centreOf = (pet) => pet.x + widthOf(pet) / 2;

/*
 * How high the lane lets a pet go, mirroring liftCeiling() — floor, then the
 * sprite, then the 37px the nameplate needs above it. Duplicated rather than
 * exported: it is the same arithmetic the carry tests already spell out, and a
 * test wanting to know where the ceiling is does not justify widening the API.
 */
const liftCeilingOf = (world, pet) =>
  Math.max(0, (world.h - 14) - pet.sprites.walk1.length * pet.scale - 37);

function mountFollowing(t, opts) {
  const world = Strays.mount(Object.assign(
    { height: 190, loadStored: false, parent: document.body }, opts));
  Strays.setFollowMode(true);
  t.after(() => Strays.destroy());
  return world;
}

/*
 * A lane the size of a display, mounted the way the desktop overlay mounts one.
 *
 * The height is the whole point: the ceiling a pet can be carried to, the
 * distance it then falls, and the room its nameplate needs all have to come out
 * of the lane's own height rather than a constant written next to them. 1440 is
 * a real display rather than a round number — free fall over that distance is
 * what reaches terminal velocity, and a lane that cannot reach it cannot show
 * that the cap is there.
 */
const FULL_LANE_H = 1440;
function mountFullScreen(t, opts, height = FULL_LANE_H, width = laneW) {
  laneH = height;
  laneW = width;
  t.after(() => { laneH = 190; laneW = 800; });
  return mountFollowing(t, Object.assign({ height: 'fill' }, opts));
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

test('and hands it back the moment the button is up', (t) => {
  /*
   * The other half of holding the pointer, and by far the more expensive one to
   * get wrong. A claim the renderer never withdraws does not cost the lane, it
   * costs every click on the machine — including the one that would reach the
   * tray to quit strays. `world.pressed` extends the claim past the grab so that
   * a flick released before the button does not hand a live drag to whatever is
   * underneath; if it is never cleared, that extension is forever.
   */
  const hover = [];
  const world = mountFollowing(t, { onHoverChange: (on) => hover.push(on) });
  Strays.setSessions([session('alpha')]);
  frame();
  const pet = petFor(world, 'alpha');

  dragTo(world, pet, centreOf(pet) + 60, world.h - 60);
  fire('mouseup', {});
  settle(world, pet);

  hover.length = 0;
  fire('mousemove', { clientX: -500, clientY: -500 });
  frame();
  assert.deepEqual(hover, [false], 'the pointer went back to the desktop');
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

// ------------------------------------------------------- a lane worth the name
/*
 * The overlay's window used to be a 190px strip, so "drag a pet" meant dragging
 * it about an inch off the floor. The window is now the size of the display and
 * the lane is measured from it, which only works because every bound in the
 * carry — the ceiling, the chrome above it, the fall back down — is derived
 * from floorY rather than written as a number that would need keeping in step.
 */

test('a full-screen lane measures its window instead of taking a fixed height', (t) => {
  const world = mountFullScreen(t);
  assert.equal(world.h, FULL_LANE_H, 'the lane is as tall as the window it was mounted in');
  // and in a real browser it is the stylesheet that makes that measurement true
  assert.equal(world.canvas.style.height, '100vh', 'the canvas fills its window');
});

test('a pet can be carried most of the way up a full-screen lane', (t) => {
  const world = mountFullScreen(t);
  Strays.setSessions([session('alpha')]);
  frame();
  const pet = petFor(world, 'alpha');

  dragTo(world, pet, centreOf(pet), 0, 8);

  /*
   * A strip allows about 87px of lift, which is under half of 190. Anything
   * that reaches past 70% of the lane can only have come from a ceiling that
   * grew with it.
   */
  assert.ok(pet.lift > world.h * 0.7,
    `carried ${Math.round(pet.lift)}px up a ${world.h}px lane`);
  // and no higher than its own nameplate, which is drawn from spriteTop
  assert.ok(pet.spriteTop >= 37,
    `with room above it for the plate the hover expands (top ${pet.spriteTop})`);

  fire('mouseup', {});
  settle(world, pet, 600);
});

test('a celebration falls on the pets, not down the whole display', (t) => {
  /*
   * Confetti was spawned just off the top edge of the canvas, which was a few
   * pixels above the pets' ears while the canvas was a strip. At the size of a
   * display the same line is a fifteen-second drizzle over everything on screen,
   * every time a session finishes — and permanently, in party mode.
   */
  const world = mountFullScreen(t);
  frame();
  Strays.celebrate();

  assert.ok(world.confetti.length > 0, 'there is confetti');
  const highest = Math.min(...world.confetti.map((c) => c.y));
  assert.ok(highest > world.h - 300,
    `it starts over the lane (highest piece at ${Math.round(highest)} of ${world.h})`);
});

test('a pet dropped from the top of the screen gets all the way down', (t) => {
  const world = mountFullScreen(t);
  Strays.setSessions([session('alpha')]);
  frame();
  const pet = petFor(world, 'alpha');

  dragTo(world, pet, centreOf(pet), 0, 8);
  for (let i = 0; i < 6; i++) frame(); // hold still, so the release is not a fling
  fire('mouseup', {});
  const seen = untilStill(world, pet);

  assert.equal(pet.state === 'falling', false, 'it stopped falling');
  assert.equal(pet.lift, 0, 'and got all the way back to the floor');
  assert.ok(seen.frames < 1200, `in ${seen.frames} frames, not for ever`);
});

// ------------------------------------------------------------- letting go
/*
 * A throw, not a drop.
 *
 * Releasing a pet used to hand it back to gravity with whatever velocity the
 * carry's own smoothing happened to be holding, clamped so low that every flick
 * came out the same gentle lob, and then it stopped dead wherever it first
 * touched something. What follows pins the four things that makes it an object
 * with a mass instead: the throw is the gesture, the floor gives some back, the
 * walls and ceiling are surfaces rather than clamps, and none of it runs for ever.
 */

/* throw a pet to (x, y) over `steps` frames — the fewer, the harder the flick */
function throwTo(world, pet, x, y, steps) {
  dragTo(world, pet, x, y, steps);
  fire('mouseup', {});
  return Math.hypot(pet.vx, pet.vy);
}

/*
 * Carry on dragging a pet that is already held, from wherever the pointer is.
 *
 * The only way to build up speed in a direction the pet has to travel to get to:
 * a hard downward flick has to start from high up, and a single sweep from the
 * floor cannot be both.
 */
function dragOn(world, x, y, steps) {
  const x0 = world.mouse.x, y0 = world.mouse.y;
  for (let i = 1; i <= steps; i++) {
    fire('mousemove', {
      clientX: x0 + ((x - x0) * i) / steps,
      clientY: y0 + ((y - y0) * i) / steps,
    });
    frame();
  }
}

/* run until it stops moving, and say what it did on the way */
function untilStill(world, pet, cap = 1200) {
  const seen = {
    frames: 0, peakLift: pet.lift, liftAfterFloor: 0, touched: false,
    maxTilt: 0, tiltBeforeRest: 0,
  };
  for (let i = 0; i < cap && (pet.state === 'falling' || pet.lift > 0); i++) {
    frame();
    seen.frames++;
    seen.peakLift = Math.max(seen.peakLift, pet.lift);
    seen.maxTilt = Math.max(seen.maxTilt, Math.abs(pet.tilt));
    // the last frame it was still in flight, so the angle it is about to land at
    // is readable rather than already reset
    if (pet.state === 'falling') seen.tiltBeforeRest = Math.abs(pet.tilt);
    if (pet.lift <= 0) seen.touched = true;
    else if (seen.touched) seen.liftAfterFloor = Math.max(seen.liftAfterFloor, pet.lift);
  }
  return seen;
}

test('the same gesture throws the same, however long you have been dragging', (t) => {
  /*
   * This is what measuring the window buys over smoothing the whole carry, and
   * it is the difference the test above cannot see.
   *
   * An exponential average of the carry is still larger for a fast drag than a
   * slow one, so it looks right. What it is not is a function of the *gesture*:
   * it converges on the true speed over about five frames, so the same flick let
   * go of after three frames and after twelve gives two different throws. Which
   * means a throw you cannot repeat, for a reason invisible on screen.
   *
   * 8px a frame either way — well under the cap, because a saturated throw would
   * hide the whole effect.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];

  pet.x = 100;
  const brief = throwTo(world, pet, centreOf(pet) + 24, world.h - 5, 3);
  settle(world, pet, 1200);

  pet.x = 100;
  const sustained = throwTo(world, pet, centreOf(pet) + 96, world.h - 5, 12);
  settle(world, pet, 1200);

  assert.ok(Math.abs(brief - sustained) / sustained < 0.1,
    `the same 8px a frame either way (${Math.round(brief)} vs ${Math.round(sustained)}px/s)`);
});

test('a harder flick throws harder', (t) => {
  const world = mountFullScreen(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];
  const target = pet.x + 500;

  const flick = throwTo(world, pet, target, world.h - 200, 3);
  settle(world, pet, 1200);

  pet.x = 100;
  const nudge = throwTo(world, pet, 600, world.h - 200, 200);

  assert.ok(flick > nudge * 3,
    `a flick throws harder than a slow drag over the same distance (${Math.round(flick)} vs ${Math.round(nudge)}px/s)`);
  settle(world, pet, 1200);
});

test('a diagonal throw is not the strongest throw in the lane', (t) => {
  // clamping each axis separately lets a corner fling out at √2 times the limit,
  // so the hardest throw available would be a diagonal one
  const world = mountFullScreen(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];

  pet.x = 200;
  const flat = throwTo(world, pet, 1400, world.h - 5, 3);
  settle(world, pet, 1200);

  pet.x = 200;
  const corner = throwTo(world, pet, 1400, world.h - 1000, 3);
  settle(world, pet, 1200);

  assert.ok(corner <= flat + 1,
    `the cap is a speed, not a pair of them (${Math.round(corner)} vs ${Math.round(flat)}px/s)`);
});

test("a throw arcs the way a thrown ball arcs", (t) => {
  /*
   * A parabola is two statements, and only two: the horizontal speed does not
   * change, and the vertical speed changes by the same amount every frame.
   *
   * Both had something in the way. Horizontal drag in flight breaks the first —
   * the pet stalls forward, the arc leans, and it comes down steeper than it went
   * up, which is a falling leaf rather than a thrown ball. Terminal velocity
   * breaks the second, flattening the descent into a straight line exactly where
   * the curve should be at its steepest.
   *
   * Sampled over one free flight, and only while it really is free: the floor, a
   * wall, the ceiling and terminal velocity all end the sample, because all four
   * are meant to bend the curve. Doing that by tuning the throw to miss them
   * instead makes the test fail for the wrong reason the moment anyone touches
   * gravity — or, as it turns out, the throw cap, which decides how high the
   * arc gets and so whether FALL_MAX is inside it at all. FALL_MAX is a sprite
   * height a frame, so the sample can work out where it is from the pet.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] }, 2160);
  frame();
  const pet = world.pets[0];
  pet.x = 60;

  /*
   * Carried up first — slowly, so the climb is not itself the throw — and then
   * flicked upward with just enough sideways in it to have a horizontal speed
   * worth holding constant.
   *
   * The height is what makes the sample worth taking. A throw from the floor at
   * THROW_MAX rises 250px and comes back at 1400px/s, which is too small a
   * flight to tell a parabola from a straight line; from up here the descent
   * passes 2000px/s while staying clear of FALL_MAX, so the frames where a cap
   * would flatten the curve are inside the sample rather than beyond it.
   */
  dragTo(world, pet, centreOf(pet), world.h - 900, 120);
  const releasedAt = pet.lift;
  dragOn(world, world.mouse.x + 12, world.mouse.y - 120, 3);
  fire('mouseup', {});

  const wall = world.w - widthOf(pet) - 6;
  const terminal = pet.sprites.walk1.length * pet.scale * 60; // FALL_MAX's own derivation
  const xs = [], lifts = [];
  for (let i = 0; i < 400; i++) {
    frame();
    if (pet.lift <= 0) break;                                   // the floor
    if (pet.x <= 6.001 || pet.x >= wall - 0.001) break;          // a wall
    if (pet.lift >= liftCeilingOf(world, pet) - 0.001) break;    // the ceiling
    if (pet.vy >= terminal - 0.5) break;                         // terminal velocity
    xs.push(pet.x);
    lifts.push(pet.lift);
  }

  assert.ok(lifts.length > 40, `a flight worth measuring (${lifts.length} frames)`);
  assert.ok(Math.max(...lifts) - releasedAt > 150,
    `that actually went up (${Math.round(Math.max(...lifts) - releasedAt)}px above the release)`);

  const diff = (a) => a.slice(1).map((v, i) => v - a[i]);
  const dx = diff(xs);
  const d2lift = diff(diff(lifts));

  // constant horizontal speed
  const spread = Math.max(...dx) - Math.min(...dx);
  assert.ok(spread < 1e-9,
    `the horizontal speed never changes (${spread.toExponential(2)}px of drift per frame)`);
  assert.ok(dx[0] > 1, 'and there was some to keep');

  // constant downward acceleration, all the way to the floor
  const accel = Math.max(...d2lift) - Math.min(...d2lift);
  assert.ok(accel < 1e-9,
    `gravity is the same every frame (${accel.toExponential(2)}px/frame² of variation)`);
  assert.ok(d2lift[0] < 0, 'and it pulls down');

  // and the steepest part of it is fast enough that a cap would have shown up:
  // FALL_MAX is 2400, and this gets close enough to it that flattening there
  // would be inside the frames the constant-acceleration assertion just read
  const fastest = Math.max(...diff(lifts).map((d) => -d)) * 60;
  assert.ok(fastest > 1800, `it was really moving by the end (${Math.round(fastest)}px/s)`);
});

test('a throw comes back down while you are still watching it', (t) => {
  /*
   * The shape of a parabola is set by the launch angle, so the test above holds
   * at any gravity at all — which leaves the one thing gravity actually decides
   * unpinned: how big the arc is. At 900 a hard 45° throw hung for three seconds
   * and ranged further than the screen it was thrown across, so nearly every
   * throw ended against a wall and none of them looked thrown. This is a floor
   * under that, not a tuning fork: it fails for a value that is wrong, not for
   * one that is merely different.
   *
   * The bound tracks `THROW_MAX`, because hang time is linear in release speed:
   * at a cap of 1800 a wrong gravity hung for 2.8s, at 1000 the same wrongness
   * hung for 1.8s and slipped under a two-second bound, and at 2400 the *right*
   * gravity holds a hard lob up for 1.8s of its own. Two and a half seconds is
   * the line at this cap — g=1200 takes 3.0s. Re-derive it if the cap moves;
   * a bound the cap has made unfailable looks exactly like a passing test.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];
  pet.x = 60;

  // up and along in equal measure — the throw that stays in the air longest
  throwTo(world, pet, centreOf(pet) + 300, world.h - 300, 3);

  let frames = 0;
  while (frames < 400 && pet.lift > 0) { frame(); frames++; }

  assert.ok(pet.lift <= 0, 'it came down');
  assert.ok(frames < 150,
    `and inside two and a half seconds (${frames} frames, ${(frames / 60).toFixed(2)}s)`);
});

test('nothing falls so fast that its own frames stop touching', (t) => {
  /*
   * The one place the curve gives way, and it is a backstop rather than physics.
   * A built-in sprite is 40px tall, so past 2400px/s successive frames do not
   * overlap at all and a fall reads as a jump cut. A normal throw never gets
   * there; a hard downward flick from the top of a tall display does.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] }, 2160);
  frame();
  const pet = world.pets[0];

  // up slowly, so the climb is not itself a throw, then flicked hard downward
  dragTo(world, pet, centreOf(pet), 100, 60);
  dragOn(world, centreOf(pet), 400, 3);
  fire('mouseup', {});

  let fastest = 0;
  for (let i = 0; i < 900 && (pet.state === 'falling' || pet.lift > 0); i++) {
    frame();
    fastest = Math.max(fastest, pet.vy);
  }

  assert.ok(fastest <= 2400, `held to a sprite height a frame (${Math.round(fastest)}px/s)`);
  assert.ok(fastest > 2399, `and it really did reach the cap (${Math.round(fastest)}px/s)`);
  assert.equal(pet.lift, 0, 'and it landed');
});

test('a thrown pet bounces, and stops bouncing', (t) => {
  const world = mountFullScreen(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];

  throwTo(world, pet, pet.x + 40, 200, 4);
  const seen = untilStill(world, pet);

  assert.ok(seen.touched, 'it reached the floor');
  assert.ok(seen.liftAfterFloor > 20,
    `and came back off it (${Math.round(seen.liftAfterFloor)}px)`);
  assert.equal(pet.state === 'falling', false, 'and it did settle');
  assert.equal(pet.lift, 0, 'on the floor');
  assert.ok(seen.frames < 1200, `in ${seen.frames} frames, not for ever`);
});

test('each bounce is smaller than the one before it', (t) => {
  const world = mountFullScreen(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];

  throwTo(world, pet, pet.x + 40, 200, 4);

  // the peak of each hop, in order
  const peaks = [];
  let rising = 0;
  for (let i = 0; i < 1200 && (pet.state === 'falling' || pet.lift > 0); i++) {
    const before = pet.lift;
    frame();
    if (pet.lift > before) rising = Math.max(rising, pet.lift);
    else if (rising) { peaks.push(rising); rising = 0; }
  }

  assert.ok(peaks.length >= 2, `it hopped more than once (${peaks.length} hops)`);
  for (let i = 1; i < peaks.length; i++) {
    assert.ok(peaks[i] < peaks[i - 1],
      `hop ${i + 1} (${Math.round(peaks[i])}px) is lower than hop ${i} (${Math.round(peaks[i - 1])}px)`);
  }
});

test('a pet swept along the floor at a hand\'s pace keeps its momentum', (t) => {
  /*
   * The gesture people actually make, and the one the test below could not see.
   *
   * That one flicks hard enough to saturate THROW_MAX at 1800px/s, which carried
   * 582px and passed. An ordinary sweep is more like 600px/s — and that carried
   * 181px, under three of the pet's own body lengths, which does not read as
   * momentum at all. It read as the pet stopping dead the moment it was let go,
   * because the friction was both far too strong and the wrong curve: a
   * proportional decay takes most of the speed off at once and then crawls.
   *
   * So this pins the ordinary case in the pet's own units, and does it at a speed
   * chosen to be well clear of the cap.
   */
  // in a lane wide enough that it never reaches a side, for the same reason the
  // bounce test below needs one: `WALL_BOUNCE` takes 40% of the forward speed, and
  // in the default 800px lane that wall was most of what this measured — which is
  // what made it read as a friction regression when the friction was right
  const world = mountFullScreen(t, { pets: ['segfault'] }, FULL_LANE_H, 2560);
  frame();
  const pet = world.pets[0];
  pet.x = 60;

  // 400px in 40 frames is 600px/s: brisk, unremarkable, nowhere near the cap
  const speed = throwTo(world, pet, centreOf(pet) + 400, world.h - 5, 40);
  assert.ok(speed > 500 && speed < 700, `an ordinary sweep (${Math.round(speed)}px/s)`);

  // distance covered rather than where it ended up: it bounces on the way
  let carried = 0, last = pet.x;
  for (let i = 0; i < 1200 && (pet.state === 'falling' || pet.lift > 0); i++) {
    frame();
    carried += Math.abs(pet.x - last);
    last = pet.x;
  }

  assert.ok(carried > widthOf(pet) * 5,
    `it carried on (${Math.round(carried)}px, ${(carried / widthOf(pet)).toFixed(1)} body lengths)`);
});

test('a bounce carries a pet on rather than stopping it', (t) => {
  /*
   * A bounce is the floor pushing *up*, so it should barely touch how fast the
   * pet is already travelling sideways — that is what lets a thrown ball skip on
   * and on across a room instead of arriving and dying. At FLOOR_GRIP 0.75 a
   * quarter of the forward speed went into each hop and a thrown pet spent most
   * of its travel before its first contact.
   *
   * Measured as ground covered before the first touch against ground covered
   * after it, which needs no absolute distance and so does not have to be
   * retuned alongside gravity or the friction. In a lane wide enough that it
   * never reaches a side — a wall takes 40% of the forward speed, and this is
   * not a test about walls.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] }, FULL_LANE_H, 2560);
  frame();
  const pet = world.pets[0];
  pet.x = 60;

  dragTo(world, pet, centreOf(pet), world.h - 400, 30);   // up, slowly
  dragOn(world, world.mouse.x + 400, world.mouse.y, 40);  // then across, ~600px/s
  fire('mouseup', {});

  let before = 0, after = 0, touched = false, last = pet.x;
  for (let i = 0; i < 1200 && (pet.state === 'falling' || pet.lift > 0); i++) {
    frame();
    const step = Math.abs(pet.x - last);
    last = pet.x;
    if (touched) after += step; else before += step;
    if (pet.lift <= 0) touched = true;
  }

  assert.ok(before > 100, `it flew before it landed (${Math.round(before)}px)`);
  assert.ok(after > before * 1.5,
    `and the bouncing carried it further still (${Math.round(before)}px flying, ${Math.round(after)}px after)`);
});

test('a hand that stops before letting go is still throwing', (t) => {
  /*
   * The fault that made every other measurement in this file look fine while
   * the thing felt dead in the hand — and the reason it was invisible.
   *
   * The throw was the last 90ms of *wall clock*, and almost nobody releases the
   * button during the sweep: you sweep, you stop, you let go. A stop of 90ms was
   * enough for that window to hold nothing but stationary samples, so an ordinary
   * 600px/s sweep threw the pet 16px — a drop. A tenth of a second is inside
   * ordinary button-release latency, so most throws silently were not throws.
   *
   * No test could see it, because every one of them releases on the same frame
   * as its last mousemove. That is what dragTo does, and it is the gesture no
   * hand performs. The pause here is the whole test.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] }, FULL_LANE_H, 2560);
  frame();
  const pet = world.pets[0];

  const sweepThenWait = (stillFrames) => {
    pet.x = 300; pet.lift = 0; pet.state = 'sit';
    pet.vx = 0; pet.vy = 0; pet.spin = 0; pet.tumble = 0; pet.tilt = 0;
    dragTo(world, pet, centreOf(pet) + 400, world.h - 5, 40); // 400px in 40 frames: ~600px/s
    for (let i = 0; i < stillFrames; i++) frame();            // ...then the hand rests
    fire('mouseup', {});
    const speed = Math.abs(pet.vx);
    settle(world, pet, 1200);
    return speed;
  };

  const immediate = sweepThenWait(0);
  const sixtyMs = sweepThenWait(4);
  assert.ok(immediate > 400, `released mid-sweep, it throws (${Math.round(immediate)}px/s)`);
  /*
   * Both bounds are the point. A 66ms pause has to leave a *throw* — under the
   * wall-clock window it left 20% of one, which is a drop — and it also has to
   * leave less than the whole thing, because what is left of the throw is the
   * size of the hitch when the pet was visibly frozen for those 66ms. One
   * half-life is 55ms, so this is about two thirds.
   */
  assert.ok(sixtyMs > immediate * 0.5,
    `a 66ms pause is still a throw (${Math.round(sixtyMs)} of ${Math.round(immediate)}px/s)`);
  assert.ok(sixtyMs < immediate * 0.85,
    `and it does cost something (${Math.round(sixtyMs)} of ${Math.round(immediate)}px/s)`);
});

test('but a pet held still for a moment is being put down, not thrown', (t) => {
  // the other side of the grace, and it has to reach exactly zero: a pet placed
  // deliberately that slides away from where you put it is the same bug as one
  // that will not throw, in the other direction
  const world = mountFullScreen(t, { pets: ['segfault'] }, FULL_LANE_H, 2560);
  frame();
  const pet = world.pets[0];
  pet.x = 300;

  dragTo(world, pet, centreOf(pet) + 400, world.h - 5, 40);
  for (let i = 0; i < 30; i++) frame(); // half a second of stillness
  fire('mouseup', {});

  assert.equal(pet.vx, 0, 'nothing left of the sweep');
  const from = pet.x;
  settle(world, pet, 1200);
  assert.ok(Math.abs(pet.x - from) < 2, `and it stays where it was put (${Math.round(pet.x - from)}px)`);
});

test('a pet pinned against the edge of the lane does not launch off it', (t) => {
  /*
   * The bug behind "it freezes for 0.1s then it flies".
   *
   * A carried pet stops at the edge of the lane while the pointer carries on
   * past it — and a flick on a trackpad runs the cursor into the edge of the
   * screen constantly. The pet is then visibly motionless, and it used to leave
   * at 1676px/s all the same, because the window was fed by asking *the pet*
   * whether it had moved: a pinned frame looked like a resting hand, recorded
   * nothing, and left the pre-pin samples standing as the gesture.
   *
   * Asked of the pointer, those frames are samples that happen to record a
   * position that has not changed, so the measured speed bleeds away over
   * THROW_WINDOW — which is what the eye saw happen.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] }, FULL_LANE_H, 1512);
  frame();
  const pet = world.pets[0];

  const wall = world.w - widthOf(pet) - 6;
  const flickIntoWall = (pastFrames) => {
    pet.x = 900; pet.lift = 0; pet.state = 'sit';
    pet.vx = 0; pet.vy = 0; pet.spin = 0; pet.tumble = 0; pet.tilt = 0;
    fire('mousemove', { clientX: centreOf(pet), clientY: world.h - 5 });
    fire('mousedown', {});
    let x = centreOf(pet), pinned = 0;
    for (let i = 0; i < 40 && pinned < pastFrames; i++) {
      x += 2000 / 60; // ~2000px/s, straight at the wall and then past it
      fire('mousemove', { clientX: x, clientY: world.h - 5 });
      frame();
      if (pet.x >= wall - 0.01) pinned++;
    }
    assert.equal(pinned, pastFrames, 'the pet really did end up pinned');
    fire('mouseup', {});
    const speed = Math.abs(pet.vx);
    settle(world, pet, 1200);
    return speed;
  };

  // a hundred milliseconds of a pet sitting still against the wall
  assert.ok(flickIntoWall(6) < 300,
    'six frames pinned and it is not a throw any more');
  // and by the time the window has turned over there is nothing left at all
  assert.ok(flickIntoWall(8) < 60,
    'eight frames pinned and it stays where it was pressed');
});

test('a flick leaves when the flick ends, not when the button comes up', (t) => {
  /*
   * Measured on a Force Touch trackpad, with STRAYS_DEBUG=1:
   *
   *   [throw] still 158ms gesture 6900px per s x0.21 -> 494px per s
   *
   * The pointer stops reporting movement 158 to 200ms before the mouseup lands,
   * and for all of it the pet is glued to a finger that has already stopped —
   * reported as "it freezes for 0.1s then it flies". Nothing about how *much* is
   * thrown can fix that: throw hard at the end of the pause and it is a jump cut,
   * throw softly and there was no point flicking.
   *
   * So a flick is released when the flick ends. What this pins is that the pet is
   * gone before the button is heard from, and that the lane still holds the
   * pointer when it happens — the finger is down and still moving, and handing
   * that half of a drag to whatever is underneath is the stuck-pet failure again,
   * this time in someone else's window.
   */
  const hover = [];
  const clicked = [];
  const world = mountFullScreen(t, {
    pets: ['segfault'],
    onHoverChange: (on) => hover.push(on),
    onPetClick: (sess) => clicked.push(sess.id),
  }, FULL_LANE_H, 2560);
  frame();
  const pet = world.pets[0];
  pet.x = 300;
  pet.session = session('alpha'); // so a stray click would be visible

  // ~2500px/s, and then the hand stops dead: a finger leaving a trackpad
  dragTo(world, pet, centreOf(pet) + 500, world.h - 5, 12);
  assert.equal(pet.state, 'held', 'it is being carried');
  hover.length = 0;

  for (let i = 0; i < 3; i++) frame(); // 50ms of a stopped hand, button still down

  assert.equal(world.grab, null, 'the pet has left the hand');
  assert.equal(pet.state, 'falling', 'and it is in the air');
  assert.ok(Math.abs(pet.vx) > 1500,
    `at the speed of the gesture (${Math.round(Math.abs(pet.vx))}px/s)`);

  /*
   * And the finger keeps going, because it is still down — which is the moment
   * the lane could drop the pointer. Hover is only recomputed on a move, so this
   * has to be a real one: a test that only steps frames here cannot see it, and
   * did not.
   */
  fire('mousemove', { clientX: world.mouse.x + 30, clientY: world.h - 5 });
  frame();
  assert.ok(!hover.includes(false),
    'and the lane still has the pointer, because the finger is still down');

  // ...and the mouseup, whenever it turns up, has nothing left to do
  const flying = pet.vx;
  fire('mouseup', {});
  assert.equal(pet.vx, flying, 'the button does not re-throw it');
  assert.deepEqual(clicked, [], 'nor read a thrown pet as a click');
});

test('but a carry that is merely paused is still a carry', (t) => {
  /*
   * The other side of FLICK_MIN, and the whole reason there is a threshold.
   * Placing a pet means aiming, and aiming means slowing down, so the window
   * averages the slowing tail: the flicks off the trackpad above measured 1560
   * and 6900px/s, and a pet being carefully put down measures a couple of
   * hundred. A pet must not launch itself out of a hand that paused to think.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] }, FULL_LANE_H, 2560);
  frame();
  const pet = world.pets[0];
  pet.x = 300;

  dragTo(world, pet, centreOf(pet) + 400, world.h - 5, 40); // ~600px/s
  for (let i = 0; i < 30; i++) frame();                     // half a second of thought

  assert.ok(world.grab, 'still in hand after half a second of stillness');
  assert.equal(pet.state, 'held', 'and still being carried');

  fire('mouseup', {});
  assert.equal(pet.vx, 0, 'and then put down, not thrown');
});

test('a hard flick leaves the hand at the speed of the hand', (t) => {
  /*
   * The anti-lag test, and the one that was missing when the cap came down to
   * 1000.
   *
   * A carried pet sits exactly under the pointer, so if it leaves at less than
   * the speed the hand was going, the cursor visibly pulls away from it — and
   * that reads as the pet hanging back rather than as a soft throw. At a cap of
   * 1000 a 2000px/s flick left at half the hand's speed, and the report was "when
   * I release there is a delay, not like throwing a ball".
   *
   * The bound is deliberately a fraction of a *stated* hand speed rather than an
   * absolute: 2000px/s is a brisk flick that a trackpad produces without trying,
   * and the point is that nothing between the hand and the pet is holding it
   * back.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] }, FULL_LANE_H, 2560);
  frame();
  const pet = world.pets[0];
  pet.x = 300;

  const hand = 2000; // 200px in 6 frames
  const release = throwTo(world, pet, centreOf(pet) + 200, world.h - 5, 6);
  assert.ok(release > hand * 0.85,
    `it leaves at the hand's speed (${Math.round(release)}px/s of ${hand})`);
});

test('and no throw outruns the lane it is drawn in', (t) => {
  /*
   * Where the cap's *value* comes from, as opposed to its existence.
   *
   * `FALL_MAX` is a sprite height a frame, because past that successive positions
   * stop touching and motion reads as a jump cut rather than as movement. A throw
   * is no more legible than a fall, so the lane has one speed limit in every
   * direction and the throw is held to it — which is checkable from the pet's own
   * geometry rather than by repeating the number.
   *
   * Both halves matter. Without the ceiling a savage flick is a jump cut; without
   * "it really reached it" the cap could be anything lower, which is the lag.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] }, FULL_LANE_H, 2560);
  frame();
  const pet = world.pets[0];
  pet.x = 300;

  const limit = pet.sprites.walk1.length * pet.scale * 60; // FALL_MAX's own derivation
  const release = throwTo(world, pet, centreOf(pet) + 600, world.h - 5, 6); // ~6000px/s

  assert.ok(release <= limit + 1,
    `held to a sprite height a frame (${Math.round(release)} of ${limit}px/s)`);
  assert.ok(release > limit - 1,
    `and a hand that fast really does reach it (${Math.round(release)}px/s)`);
});

test('an ordinary sweep does not somersault', (t) => {
  /*
   * The middle of the tumble's range, which is the only place the coefficient
   * shows. `SPIN_PER_SPEED` is per px/s of release speed, so it has to be
   * revisited whenever `THROW_MAX` moves — and the two tests either side of this
   * one cannot see that: a hard throw saturates `SPIN_MAX` at any sane value, and
   * a pet set down gently barely turns at any value at all. At 0.0065, which is
   * what a cap of 1000 wanted, being swept across a desk at 600px/s put a pet
   * into `TUMBLE_MAX` — spinning like a top for having been moved.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] }, FULL_LANE_H, 2560);
  frame();
  const pet = world.pets[0];
  pet.x = 300;

  withoutLuck(() => {
    throwTo(world, pet, centreOf(pet) + 400, world.h - 5, 40); // ~600px/s
    const seen = untilStill(world, pet);
    // measured: 0.45rad at 0.0035, and 0.75 at the 0.0065 a cap of 1000 wanted.
    // A hard flick is 1.15 at both — saturated, which is why it cannot see this.
    assert.ok(seen.maxTilt > 0.15, `it does turn (${seen.maxTilt.toFixed(2)} rad)`);
    assert.ok(seen.maxTilt < 0.6,
      `but an ordinary sweep is not a somersault (${seen.maxTilt.toFixed(2)} rad)`);
  });
});

test('and the hardest flick there is still comes to rest', (t) => {
  /*
   * The other end of the same lever, and what `GROUND_GOVERNOR` is for.
   *
   * Letting the pet leave at the speed of the hand is what makes a throw feel
   * like a throw, and on its own it is also the cannon: sliding friction is a
   * constant, so carry distance goes as the *square* of release speed, and the
   * hardest flick a trackpad produces slid 4528px over 3.9 seconds — across the
   * display and back off both walls, at a barely-changing speed the whole way,
   * which is the least ball-like thing in the lane.
   *
   * So the ground sheds a cubic term as well. It is a governor rather than
   * physics: 5e-7·v³ is 108px/s² against an ordinary 600px/s sweep — a ninth of
   * the carry, which is nothing — and 6912px/s² at the cap, which is most of it.
   * A bracket rather than a tuning fork: the floor is there because a governor
   * strong enough to make a hard flick feel like a nudge is the older bug back.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] }, FULL_LANE_H, 2560);
  frame();
  const pet = world.pets[0];
  pet.x = 300;

  // ~2500px/s, flat: the hardest throw anyone makes, and all of it on the floor
  // where the governor lives. A lob spends its travel in flight instead, which is
  // bounded by gravity and the ceiling and has its own tests.
  dragTo(world, pet, centreOf(pet) + 500, world.h - 5, 12);
  fire('mouseup', {});

  let travelled = 0, last = pet.x, frames = 0;
  for (let i = 0; i < 1500 && (pet.state === 'falling' || pet.lift > 0); i++) {
    frame();
    frames++;
    travelled += Math.abs(pet.x - last);
    last = pet.x;
  }
  const bodies = travelled / widthOf(pet);

  assert.ok(bodies > 10, `a hard throw really travels (${bodies.toFixed(1)} body lengths)`);
  assert.ok(bodies < 35,
    `and stops inside a screen rather than pinballing (${bodies.toFixed(1)} body lengths)`);
  assert.ok(frames < 180,
    `in three seconds, not four (${frames} frames, ${(frames / 60).toFixed(1)}s)`);
});

test('and a pet set down without moving does not slide at all', (t) => {
  // the other half of it: momentum has to come from the gesture, or a pet put
  // down carefully wanders off across the floor on its own
  const world = mountFullScreen(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];
  pet.x = 300;

  dragTo(world, pet, centreOf(pet), world.h - 200, 30); // straight up, then hold
  for (let i = 0; i < 12; i++) frame();
  fire('mouseup', {});
  const from = pet.x;
  settle(world, pet, 1200);

  assert.ok(Math.abs(pet.x - from) < 12,
    `it went straight down (${Math.round(pet.x - from)}px sideways)`);
});

test('a pet thrown level along the floor skids instead of stopping dead', (t) => {
  /*
   * A level throw never earns an impact worth bouncing, so it lands on the frame
   * it was released. Without friction on the floor that is a pet standing exactly
   * where it was let go, which is the one throw that looked like a bug.
   *
   * Measured as distance covered rather than where it ended up: a hard throw
   * crosses the whole test lane and comes back off the far wall, so the finishing
   * position can be behind the release point having travelled twice its length.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];
  pet.x = 100;

  throwTo(world, pet, 700, world.h - 5, 3);
  let travelled = 0, last = pet.x;
  for (let i = 0; i < 1200 && (pet.state === 'falling' || pet.lift > 0); i++) {
    frame();
    travelled += Math.abs(pet.x - last);
    last = pet.x;
  }

  assert.ok(travelled > 300, `it carried on (${Math.round(travelled)}px past the release)`);
  assert.equal(pet.state === 'falling', false, 'and friction stopped it');
});

test('a pet thrown at a wall comes off it', (t) => {
  const world = mountFullScreen(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];
  // from the left, so the throw itself is never up against the clamp that stops
  // a carried pet leaving the lane — you cannot wind up through a wall
  pet.x = 100;

  throwTo(world, pet, 600, world.h - 600, 3);
  const wall = world.w - widthOf(pet) - 6;
  let hitWall = false, cameBack = 0;
  for (let i = 0; i < 900 && (pet.state === 'falling' || pet.lift > 0); i++) {
    frame();
    if (pet.x >= wall) hitWall = true;
    else if (hitWall) cameBack = Math.max(cameBack, wall - pet.x);
  }

  assert.ok(hitWall, 'it reached the wall');
  assert.ok(cameBack > 20, `and came back off it (${Math.round(cameBack)}px)`);
});

test('a pet thrown at the ceiling stays in the lane', (t) => {
  /*
   * liftCeiling bounds a *carry*. A throw is not a carry, and 1800px/s upward is
   * two metres of rise — off the top of the screen, wearing a nameplate that is
   * not on it either.
   */
  const world = mountFullScreen(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];

  throwTo(world, pet, pet.x, -2000, 3);
  const seen = untilStill(world, pet);

  assert.ok(seen.peakLift <= world.h, `it never left the lane (peaked at ${Math.round(seen.peakLift)} of ${world.h})`);
  assert.ok(seen.peakLift > world.h * 0.5, 'and it really was thrown upward');
  assert.equal(pet.lift, 0, 'and it came back down');
});

test('a hard throw turns the pet over, and it lands upright', (t) => {
  const world = mountFullScreen(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];
  pet.x = 100;

  throwTo(world, pet, 700, 300, 3);
  const spun = untilStill(world, pet);

  // the flail of being carried is about a fifth of a radian; a tumble is not
  assert.ok(spun.maxTilt > 0.5, `it turned over (${spun.maxTilt.toFixed(2)} rad)`);
  assert.ok(spun.maxTilt < Math.PI / 2 + 0.3,
    `without going past its own side (${spun.maxTilt.toFixed(2)} rad)`);
  /*
   * And it rights itself on the way, rather than being snapped upright on the
   * frame it lands. An angle that only ever accumulates has to be zeroed at the
   * end, and that is a visible pop out of nowhere on every single throw.
   */
  assert.ok(spun.tiltBeforeRest < 0.35,
    `nearly upright before it lands (${spun.tiltBeforeRest.toFixed(2)} rad)`);
  assert.equal(pet.tilt, 0, 'and upright once it stops');
  assert.equal(pet.tumble, 0, 'with nothing left over to tilt the next frame');
});

test('a pet set down gently barely turns at all', (t) => {
  // the mirror of the above: the tumble has to answer to the throw, or every
  // release is the same somersault
  const world = mountFullScreen(t, { pets: ['segfault'] });
  frame();
  const pet = world.pets[0];

  withoutLuck(() => {
    throwTo(world, pet, pet.x + 2, world.h - 300, 200);
    const dropped = untilStill(world, pet);
    assert.ok(dropped.maxTilt < 0.5,
      `set down, not thrown (${dropped.maxTilt.toFixed(2)} rad)`);
  });
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

// ------------------------------------------------------------------- roster
/*
 * Who is on the team, and in what order sessions reach them.
 *
 * The order is not cosmetic: bindSessions walks the pet list and hands the first
 * free pet to each new session, so row one of the Pets window is "the pet you see
 * when one Claude window is open". Two properties carry the whole feature — the
 * stated order is obeyed, and obeying it disturbs nothing that is already out.
 */
const YODA = {
  name: 'Yoda',
  palette: { 1: '#a9c98d', 2: '#84a86a', k: '#17181c' },
  grids: { walk1: ['.11.', '1221', '.11.'] },
};

const ids = (world) => world.pets.map((p) => (p.custom ? p.name : p.kind));

test('a stated order is the order sessions are handed out in', (t) => {
  const world = mountFollowing(t);
  Strays.setRoster(['mutex', 'grep', 'segfault']);
  Strays.setSessions([session('s1'), session('s2'), session('s3')]);
  frame();
  assert.deepStrictEqual(ids(world), ['mutex', 'grep', 'segfault']);
  assert.deepStrictEqual(bound(world), ['s1', 's2', 's3'],
    'the pet at the top takes the first session');
});

/*
 * The fish is last by default because she is the fallback — bindSessions used to
 * enforce that by filtering, which would quietly override anything a user drags.
 * An explicit order has to win, or the Pets window is lying about what it does.
 */
test('the fish can be dragged to the front, and stays there', (t) => {
  const world = mountFollowing(t);
  Strays.setRoster(['heisenbug', 'segfault', 'grep', 'mutex']);
  Strays.setSessions([session('only')]);
  frame();
  assert.strictEqual(ids(world)[0], 'heisenbug');
  assert.strictEqual(petFor(world, 'only').kind, 'heisenbug',
    'the one session goes to the pet at the top, fish or not');
});

test('with no roster set, the fish is still last', (t) => {
  const world = mountFollowing(t, { pets: ['heisenbug', 'segfault'] });
  Strays.setSessions([session('one')]);
  frame();
  assert.strictEqual(petFor(world, 'one').kind, 'segfault',
    'the default reshuffle has to survive for anyone who never opens the window');
});

/*
 * The reason this is a roster and not a remount, and the *default* — which is the
 * path the host takes when it re-applies the roster on launch and every time the
 * Pets window is focused. Nobody moves and nobody loses the conversation they are
 * carrying, because re-dealing because a window got focus is worse than useless.
 *
 * A reorder the user actually performed passes `{ rebind: true }` and is asserted
 * separately, below. Getting that distinction wrong in either direction is a bug:
 * this file once had only this half, and the Pets window looked broken.
 */
test('re-applying a roster keeps every pet where it is, with the session it holds', (t) => {
  const world = mountFollowing(t);
  Strays.setSessions([session('s1'), session('s2'), session('s3')]);
  frame();

  const before = new Map(world.pets.map((p) => [p.kind, { x: p.x, id: p.session && p.session.id }]));
  const order = ['mutex', 'heisenbug', 'segfault', 'grep'];
  Strays.setRoster(order);

  // asserted before stepping, deliberately: a frame walks the pets along, so
  // stepping first would measure the lane's own movement and hide a teleport
  // under it. The claim is that the reorder itself disturbs nothing.
  assert.deepStrictEqual(ids(world), order, 'the list really was reordered');
  for (const pet of world.pets) {
    const was = before.get(pet.kind);
    assert.strictEqual(pet.x, was.x, `${pet.kind} must not move`);
    assert.strictEqual(pet.session && pet.session.id, was.id,
      `${pet.kind} must keep the session it was carrying`);
  }

  // and the sessions stay put across the frames that follow, rather than being
  // re-dealt down the new order
  frame();
  assert.deepStrictEqual(
    world.pets.map((p) => p.session && p.session.id),
    order.map((k) => before.get(k).id),
  );
});

/*
 * ...and the other half, which shipped broken.
 *
 * Keeping the bindings is right for a roster the *host* re-applies — at launch, or
 * whenever the Pets window is focused. It is wrong for a reorder the user just
 * performed: the array order sets draw order and who takes the **next** session,
 * not where a pet stands, so with conversations already live a drag changed
 * nothing anybody could see. It looked like the window did not work, and the way
 * round it was to toggle Follow Claude Code sessions, which clears the session
 * list and re-announces it — dealing everyone out again by accident.
 */
test('a reorder the user asked for deals the sessions down the new list', (t) => {
  const world = mountFollowing(t);
  Strays.setSessions([session('s1'), session('s2'), session('s3')]);
  frame();
  assert.strictEqual(petFor(world, 's1').kind, 'segfault', 'the default deal');

  Strays.setRoster(['mutex', 'heisenbug', 'segfault', 'grep'], { rebind: true });
  frame();

  assert.strictEqual(petFor(world, 's1').kind, 'mutex',
    'the pet dragged to the top takes the first session');
  assert.strictEqual(petFor(world, 's2').kind, 'heisenbug');
  assert.strictEqual(petFor(world, 's3').kind, 'segfault');
  assert.deepStrictEqual(bound(world), ['s1', 's2', 's3', null]);
});

test('a re-deal does not move any pet on screen', (t) => {
  // the point of rebinding rather than remounting: the nameplates change hands,
  // the animals stay where they are
  const world = mountFollowing(t);
  Strays.setSessions([session('s1'), session('s2')]);
  frame();
  const where = new Map(world.pets.map((p) => [p.kind, p.x]));

  Strays.setRoster(['heisenbug', 'mutex', 'grep', 'segfault'], { rebind: true });
  for (const pet of world.pets) {
    assert.strictEqual(pet.x, where.get(pet.kind), `${pet.kind} must not be teleported`);
  }
});

test('a re-deal keeps a carry in progress', (t) => {
  const world = mountFollowing(t, { pets: ['segfault', 'grep'] });
  frame();
  const grep = world.pets.find((p) => p.kind === 'grep');
  dragTo(world, grep, centreOf(grep) + 10, world.h - 40);

  Strays.setRoster(['grep', 'segfault'], { rebind: true });
  frame();
  assert.ok(world.grab && world.grab.pet === grep,
    'a pet still in the hand when the list is saved stays in the hand');
  fire('mouseup', {});
  frame();
  assert.strictEqual(world.badFrames, 0);
});

test('switching a pet off takes it out of the lane entirely', (t) => {
  const world = mountFollowing(t);
  Strays.setRoster(['segfault', 'grep']);
  frame();
  assert.deepStrictEqual(ids(world), ['segfault', 'grep']);
  assert.ok(!world.pets.some((p) => p.kind === 'mutex'), 'Mutex is gone, not merely hidden');
});

test('switching a pet back on brings it out again', (t) => {
  const world = mountFollowing(t);
  Strays.setRoster(['segfault']);
  frame();
  Strays.setRoster(['segfault', 'mutex']);
  frame();
  assert.deepStrictEqual(ids(world), ['segfault', 'mutex']);
  assert.ok(world.pets[1].sprites.walk1, 'and is built well enough to draw');
});

test('an empty roster empties the lane rather than throwing', (t) => {
  const world = mountFollowing(t);
  Strays.setRoster([]);
  frame();
  assert.deepStrictEqual(world.pets, []);
  frame(); // and keeps drawing
  assert.strictEqual(world.badFrames, 0, 'an empty lane is not a broken one');
});

/*
 * A roster names pets, and the config it comes from outlives any one release: a
 * custom pet deleted from custom-pets.json, or a built-in a future version drops,
 * leaves a name behind that resolves to nothing. Throwing on it would take the
 * whole lane down for a stale line in a settings file.
 */
test('a name the world has never heard of is skipped, not thrown on', (t) => {
  const world = mountFollowing(t);
  Strays.setRoster(['segfault', 'Ghost', 'grep']);
  frame();
  assert.deepStrictEqual(ids(world), ['segfault', 'grep']);
  assert.strictEqual(world.badFrames, 0);
});

/*
 * Registering and placing are separate on purpose: the overlay registers every
 * def it is handed and lets the roster decide who is actually out. If registering
 * also added the pet, one switched off would appear and then vanish, and re-sending
 * the defs — which happens whenever one is drawn — would double it up.
 */
test('registering a custom pet does not put it out', (t) => {
  const world = mountFollowing(t, { pets: ['segfault'] });
  assert.strictEqual(Strays.registerCustomPet(YODA), true);
  frame();
  assert.deepStrictEqual(ids(world), ['segfault'], 'registered, not adopted');
});

test('a registered custom pet can then be placed by name', (t) => {
  const world = mountFollowing(t, { pets: ['segfault'] });
  Strays.registerCustomPet(YODA);
  Strays.setRoster(['Yoda', 'segfault']);
  Strays.setSessions([session('s1')]);
  frame();
  assert.deepStrictEqual(ids(world), ['Yoda', 'segfault']);
  assert.strictEqual(petFor(world, 's1').name, 'Yoda',
    'a custom pet at the top takes the first session like any other');
});

test('re-registering the same name replaces the art rather than adding a pet', (t) => {
  const world = mountFollowing(t, { pets: [] });
  Strays.registerCustomPet(YODA);
  Strays.setRoster(['Yoda']);
  frame();
  const wide = { ...YODA, grids: { walk1: ['.1111.', '122221', '.1111.'] } };
  Strays.registerCustomPet(wide);
  Strays.setRoster([]);        // out...
  Strays.setRoster(['Yoda']);  // ...and back, which is when the new art is built
  frame();
  assert.strictEqual(world.pets.length, 1, 'still exactly one Yoda');
  assert.strictEqual(world.pets[0].sprites.walk1[0].length, 6, 'and he is the redrawn one');
});

test('a malformed def is refused rather than registered', (t) => {
  mountFollowing(t, { pets: [] });
  assert.strictEqual(Strays.registerCustomPet({ name: 'Broken' }), false);
  Strays.setRoster(['Broken']);
  frame();
  assert.deepStrictEqual(Strays._world.pets, []);
});

/*
 * A pet can be carrying the ball, deadlocked with another, or literally in the
 * user's hand when its row is unchecked. Each is a reference kept outside
 * world.pets, and each is asserted on its own — the first version of this set all
 * three up in one test and then picked the pet up, which passes for the wrong
 * reason: grabPet already drops the ball and breaks the deadlock, so two thirds
 * of it was checking work the drag had done.
 *
 * The guards beside bindSessions do not cover any of this either. Those fire on
 * `hidden`, and a pet taken off the roster is not hidden — it is gone, so nothing
 * will ever set that flag on it again.
 */
test('a pet taken out drops the ball it was carrying', (t) => {
  const world = mountFollowing(t, { pets: ['segfault', 'grep'] });
  frame();
  const grep = world.pets.find((p) => p.kind === 'grep');
  world.ball.held = grep;
  grep.carrying = 'ball';

  Strays.setRoster(['segfault']);
  assert.strictEqual(world.ball.held, null, 'the ball is not held by a pet that has gone');
  frame();
  assert.strictEqual(world.badFrames, 0);
});

test('a pet taken out of a deadlock frees the one still on the lane', (t) => {
  const world = mountFollowing(t, { pets: ['segfault', 'mutex'] });
  frame();
  const [segfault, mutex] = world.pets;
  segfault.state = 'deadlock';
  mutex.state = 'deadlock';
  world.deadlock = { a: segfault, b: mutex };

  Strays.setRoster(['segfault']);
  assert.strictEqual(world.deadlock, null, 'the pair is forgotten');
  assert.strictEqual(segfault.state, 'walk',
    'and the cat that stayed goes back to walking rather than standing off ' +
    'against an animal that no longer exists');
  frame();
  assert.strictEqual(world.badFrames, 0);
});

test('a pet taken out mid-carry is not left stuck to the cursor', (t) => {
  const world = mountFollowing(t, { pets: ['segfault', 'grep'] });
  frame();
  const grep = world.pets.find((p) => p.kind === 'grep');
  dragTo(world, grep, centreOf(grep) + 10, world.h - 40);
  assert.ok(world.grab && world.grab.pet === grep, 'the pet really is being carried');

  Strays.setRoster(['segfault']);
  assert.strictEqual(world.grab, null, 'nothing is left in the hand');
  frame();
  fire('mouseup', {});  // the release still has to land somewhere harmless
  frame();
  assert.strictEqual(world.badFrames, 0);
});

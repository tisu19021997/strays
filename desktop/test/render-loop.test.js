/*
 * The lane has to survive being left running.
 *
 * Two failures live here, and they present identically: the pets vanish and
 * their shadows stay. The shadow is painted first, so anything that throws
 * between it and the sprite freezes the canvas exactly there.
 *
 *   1. The sprite cache is keyed by object identity. A palette written inline
 *      at a call site is a new object every frame, so every frame minted a new
 *      offscreen canvas and kept it forever — the renderer grew until Chromium
 *      would not hand out another 2D context.
 *   2. Whatever throws, tick() has to re-arm. It did not, so the first bad
 *      frame was the last frame.
 *
 * Both are only visible over time, so these drive the real engine for a long
 * simulated run rather than asserting on a single frame.
 */
const test = require('node:test');
const assert = require('node:assert');

const LANE_W = 800;
let canvases = 0; // every offscreen sprite canvas the engine has asked for

function fakeContext() {
  const ctx = {
    measureText: (t) => ({ width: String(t).length * 6 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillText() {}, fillRect() {},
  };
  for (const m of ['arcTo', 'beginPath', 'clearRect', 'closePath', 'drawImage', 'ellipse',
                   'fill', 'lineTo', 'moveTo', 'restore', 'rotate', 'save', 'scale',
                   'setTransform', 'translate']) ctx[m] = () => {};
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
  createElement: (tag) => { if (tag === 'canvas') canvases++; return fakeElement(); },
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = {
  innerWidth: LANE_W, innerHeight: 900, devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {},
};
globalThis.localStorage = { getItem: () => null, setItem() {} };

// the scheduled frame callback, so a test can drive the loop the way a browser
// does and see for itself whether the next one was ever booked
let pending = null;
globalThis.requestAnimationFrame = (fn) => { pending = fn; return 1; };
globalThis.cancelAnimationFrame = () => { pending = null; };

let clock = 0;
globalThis.performance = { now: () => clock };

/*
 * The dice, seeded.
 *
 * Every pet decides what to do next at random, so which states a run reaches —
 * and therefore which sprites get cached — differs on every process. A state
 * whose first occurrence lands after the warm-up mints a canvas late and reads
 * exactly like the leak this file exists to catch, so the suite failed about one
 * run in four for a reason that had nothing to do with the code. Nine CI legs
 * make that a near-certain red on every push.
 *
 * A fixed sequence trades exploration for a result that means something. The
 * exhaustive coverage lives in pets-binding's DRAWN_STATES, which draws every
 * pet in every state on purpose rather than hoping to wander into them.
 */
let seed = 0x2f6e2b1;
Math.random = () => {
  // xorshift32: a deterministic stream, and short enough to be obviously right
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};

const Strays = require('../../strays.js');

const FPS = 60;
function mountLane(t) {
  const world = Strays.mount({ height: 190, loadStored: false, parent: document.body });
  t.after(() => Strays.destroy());
  return world;
}

/* run the simulation for a stretch of wall-clock, drawing every frame */
function run(minutes) {
  for (let i = 0; i < minutes * 60 * FPS; i++) {
    clock += 1000 / FPS;
    Strays.step(1 / FPS, 1);
  }
}

test('drawing for an hour costs no more canvases than drawing for five minutes', (t) => {
  mountLane(t);

  /*
   * The engine draws a fixed, small set of (grid, palette, scale) combinations —
   * four pets over a dozen states, the ball, and the helmet in its two moods.
   * Five minutes reaches all of them; it saturates at 22 by the second minute,
   * and the last of them is Heisenbug's spooked helmet, which needs the lane to
   * decide nobody is watching. So this is a warm-up, not a sample.
   */
  run(5);
  const warm = canvases;
  assert.ok(warm > 0, 'the sprites have to be rendered at least once');
  assert.ok(warm < 64, `${warm} canvases to warm up is far more than the engine draws`);

  /*
   * ...and the next fifty-five minutes should ask for nothing. Segfault crashes
   * every 18-40 seconds, so that is a hundred-odd glitches — the state that used
   * to mint two fresh canvases on every frame it was in, and keep them.
   */
  run(55);
  assert.equal(canvases, warm,
    `the sprite cache leaked: ${canvases - warm} new canvases in 55 minutes of drawing`);
});

test('a frame that throws costs one frame, not the rest of the session', (t) => {
  const world = mountLane(t);
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a);
  t.after(() => { console.error = realError; });

  assert.ok(pending, 'mounting schedules the first frame');

  // exactly the shape of the bug that shipped: a pet whose sprite set cannot be
  // resolved, which throws inside drawPet after its shadow is already down
  const victim = world.pets[0];
  const sprites = victim.sprites;
  victim.sprites = null;

  const armed = pending;
  pending = null;
  armed(clock += 16);
  assert.ok(pending, 'a throwing frame must still book the next one');
  assert.equal(errors.length, 1, 'and must say so once, rather than silently');

  // a hundred more bad frames: still running, and not shouting every frame
  for (let i = 0; i < 100; i++) { const f = pending; pending = null; f(clock += 16); }
  assert.ok(pending, 'still animating after a hundred bad frames');
  assert.equal(errors.length, 1, 'a permanent fault must not write 60 lines a second');

  // and when the fault clears, the lane comes back on its own
  victim.sprites = sprites;
  const f = pending; pending = null; f(clock += 16);
  assert.ok(pending, 'and it recovers without a remount');
  assert.equal(world.badFrames, 101, 'every bad frame is counted');
});

test('a caller that defeats the cache is bounded, and says so', (t) => {
  const world = mountLane(t);
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a);
  t.after(() => { console.warn = realWarn; });

  /*
   * Each custom pet brings its own palette object, so this is the cache's worst
   * case reached honestly: past the cap it must drop what it has rather than
   * grow, and the lane must keep drawing.
   */
  for (let i = 0; i < 300; i++) {
    Strays.addCustomPet({
      name: 'Leak' + i,
      grids: { walk1: ['11', '11'] },
      palette: { 1: '#' + (0x100000 + i).toString(16) },
    });
  }
  Strays.step(1 / FPS, 1);
  const after = canvases;
  Strays.step(1 / FPS, 1);

  assert.ok(warned.length >= 1, 'overflowing the cache is a bug worth naming');
  assert.ok(canvases - after <= 300 + world.pets.length,
    'past the cap the cache must churn, not grow without limit');
});

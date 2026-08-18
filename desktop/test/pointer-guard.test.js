/*
 * The click-through flag, which is now the whole screen's problem.
 *
 * While the lane was a 190px strip, a claim that was never withdrawn cost the
 * bottom inch of the display. The lane is the size of a display now, so the same
 * claim costs every click on the machine — including the ones that would reach
 * the menu bar to quit strays. The guard exists so that no way for the renderer
 * to go quiet can leave the pointer captured indefinitely.
 *
 * The clock is injected, so the whole matrix runs without waiting for any of it.
 */
const test = require('node:test');
const assert = require('node:assert');

const { PointerGuard } = require('../pointer-guard');

/*
 * A guard over a fake clock, recording every change it actually applies.
 *
 * `holdMs` is optional on purpose: left out, the guard uses the term it really
 * ships with, which is the only way a test can hold an opinion about that
 * number rather than about one the test itself supplied.
 */
function harness(holdMs) {
  const applied = [];
  let clock = 0;
  const guard = new PointerGuard({
    apply: (v) => applied.push(v),
    now: () => clock,
    holdMs,
  });
  return {
    guard,
    applied,
    tick(ms) { clock += ms; guard.sweep(); },
    /* the renderer's heartbeat: renewed every beat for the given stretch */
    renewFor(ms, beat = 500) {
      for (let t = 0; t < ms; t += beat) { clock += beat; guard.claim(true); guard.sweep(); }
    },
  };
}

test('a claim nobody renews expires, and the screen takes clicks again', () => {
  const h = harness(2000);
  h.guard.claim(true);
  assert.deepEqual(h.applied, [true], 'hovering a pet catches the pointer');

  h.tick(1500);
  assert.deepEqual(h.applied, [true], 'a lease still inside its term is honoured');

  h.tick(600);
  assert.deepEqual(h.applied, [true, false], 'and past it the pointer is handed back');
});

test('a renewed claim outlives its lease for as long as it is renewed', () => {
  const h = harness(2000);
  h.guard.claim(true);

  // a carry is seconds long, and dropping hover in the middle of one sends the
  // mouseup to the application underneath — the pet then sticks to the cursor
  h.renewFor(30_000);

  assert.deepEqual(h.applied, [true], 'thirty seconds of holding a pet, uninterrupted');
});

test('letting go is immediate, not merely eventual', () => {
  const h = harness(2000);
  h.guard.claim(true);
  h.guard.claim(false);
  assert.deepEqual(h.applied, [true, false]);

  h.tick(10_000);
  assert.deepEqual(h.applied, [true, false], 'and it does not come back on its own');
});

test('a heartbeat is not a native call', () => {
  const h = harness(2000);
  h.guard.claim(true);
  h.renewFor(5000);
  assert.equal(h.applied.length, 1,
    'the window is told once, however often the renderer says it still wants the pointer');
});

test('release works even when the guard believes it has nothing to release', () => {
  /*
   * The valve. Every caller of it — a dead renderer, a hidden lane, a quit — is
   * a case where the guard's idea of the window may be wrong, and "I already
   * handed the pointer back" is exactly what a stuck window would say.
   */
  const h = harness(2000);
  assert.equal(h.guard.interactive, false, 'nothing claimed');

  h.guard.release();
  assert.deepEqual(h.applied, [false], 'the window is told anyway');
});

test('a claim made before a release cannot outlive it', () => {
  const h = harness(2000);
  h.guard.claim(true);
  h.guard.release();
  assert.deepEqual(h.applied, [true, false]);

  h.tick(100);
  h.tick(100);
  assert.deepEqual(h.applied, [true, false], 'the lease went with it');
});

test('the lease is long enough that a slow renderer is not a dropped pet', () => {
  /*
   * The two failures are not symmetrical, but neither is small: never expiring
   * costs the whole screen, and expiring too eagerly drops a pet mid-carry. The
   * beat is 500ms, so the term has to swallow several missed ones.
   */
  const h = harness();
  h.guard.claim(true);
  h.tick(1400); // nearly three missed beats
  assert.deepEqual(h.applied, [true], 'a renderer having a bad second keeps its pet');
});

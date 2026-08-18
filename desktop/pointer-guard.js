/*
 * Who gets the pointer, and for how long.
 *
 * The overlay window is click-through, and becomes interactive for exactly as
 * long as the renderer says something on the lane is under the cursor. That was
 * a small promise while the lane was a 190px strip: the worst a stuck claim
 * could do was make the bottom inch of the screen refuse clicks, which is
 * strange but survivable. The lane is now the size of a display, so the same
 * stuck claim swallows every click on the machine until strays is killed — from
 * a menu bar the pointer can no longer reach.
 *
 * So a claim is a lease, not a switch. The renderer renews it while it wants
 * the pointer and the host drops it the moment renewals stop, which turns every
 * way the renderer can go quiet — crashed, wedged in a loop, or simply buggy
 * enough to never say `false` — into at most `holdMs` of a stiff desktop that
 * then fixes itself.
 *
 * The lease is deliberately many beats long. Expiring one that is still being
 * renewed is not a smaller failure than never expiring it: hover dropping
 * mid-carry sends the mouseup to the application underneath, and the pet stays
 * stuck to the cursor with nothing on screen able to put it down.
 */

const HOLD_MS = 2000; // an unrenewed claim is honoured this long and no longer

class PointerGuard {
  constructor({ apply, now = Date.now, holdMs = HOLD_MS } = {}) {
    this.apply = apply;
    this.now = now;
    this.holdMs = holdMs;
    this.interactive = false;
    this.until = 0;
  }

  /* the renderer, saying whether the lane is under the cursor — repeatedly */
  claim(wants) {
    this.until = wants ? this.now() + this.holdMs : 0;
    this.set(!!wants);
  }

  /* the host's timer: a lease nobody renewed has run out */
  sweep() {
    if (this.interactive && this.now() >= this.until) this.set(false);
  }

  /*
   * The valve: the renderer died, the lane was hidden, the app is quitting.
   *
   * Unconditional, because this is the one path that has to work when the
   * guard's idea of the window is wrong — a belief that says "already
   * click-through" is exactly what a stuck window would produce.
   */
  release() {
    this.until = 0;
    this.interactive = false;
    this.apply(false);
  }

  set(next) {
    if (next === this.interactive) return; // no native call per heartbeat
    this.interactive = next;
    this.apply(next);
  }
}

module.exports = { PointerGuard, HOLD_MS };

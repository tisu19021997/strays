/*
 * The overlay renderer.
 *
 * overlay.js is a browser file loaded by overlay.html, so it is driven here
 * over the smallest DOM and the smallest petsBridge that let it run — the same
 * shape pets-binding.test.js uses for the engine. Everything the cards do
 * (which decision is sent, where the card lands, how long it lingers) is
 * observable through that stub, and nothing here needs Electron.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------- minimal DOM
const LANE_W = 1440;
const LANE_H = 190;
const CARD_W = 360; // a card is only as wide as its command: never assume one width

function fakeContext() {
  const ctx = {
    measureText: (t) => ({ width: String(t).length * 6 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillText() {},
  };
  for (const m of ['arcTo', 'beginPath', 'clearRect', 'closePath', 'drawImage',
                   'ellipse', 'fill', 'fillRect', 'lineTo', 'moveTo',
                   'restore', 'rotate', 'save', 'scale', 'setTransform', 'translate']) {
    ctx[m] = () => {};
  }
  return ctx;
}

function fakeElement(tag) {
  const handlers = new Map();
  const el = {
    tag: tag || 'div',
    className: '', textContent: '',
    style: {}, children: [], parent: null,
    width: 0, height: 0,
    clientWidth: LANE_W, clientHeight: LANE_H, offsetWidth: CARD_W,
    setAttribute() {},
    getContext: () => fakeContext(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: LANE_W, height: LANE_H }),
    appendChild(child) { child.parent = el; el.children.push(child); return child; },
    remove() {
      if (!el.parent) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    removeEventListener() {},
    click() { (handlers.get('click') || []).slice().forEach((fn) => fn({})); },
    fire(type) { (handlers.get(type) || []).slice().forEach((fn) => fn({})); },
  };
  return el;
}

const cardWrap = fakeElement('div');

globalThis.document = {
  hidden: false,
  body: fakeElement('body'),
  createElement: fakeElement,
  getElementById: (id) => (id === 'cards' ? cardWrap : null),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = {
  innerWidth: LANE_W, innerHeight: 900, devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {},
};
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

/*
 * The clock is the harness's, like the DOM is.
 *
 * The renderer keeps a heartbeat running that renews its claim on the pointer
 * (see pointer-guard.js), and a real interval here would both outlive the file —
 * a pending timer is a process node:test will wait on for ever — and tick
 * unbidden in the middle of assertions about what was sent. Held instead, so a
 * test can beat it deliberately.
 */
const beats = [];
globalThis.setInterval = (fn) => beats.push(fn);
globalThis.clearInterval = () => {};
const beat = () => beats.forEach((fn) => fn());

// ---------------------------------------------------------- bridge to main
const bridge = {
  replies: [], jumps: [], interactive: [], handlers: {},
  onClaudeStatus(cb) { bridge.handlers.status = cb; },
  onParty(cb) { bridge.handlers.party = cb; },
  onUsage(cb) { bridge.handlers.usage = cb; },
  onShowTitles(cb) { bridge.handlers.showTitles = cb; },
  onCelebrate(cb) { bridge.handlers.celebrate = cb; },
  onCustomPets(cb) { bridge.handlers.customPets = cb; },
  onApprovalRequest(cb) { bridge.handlers.request = cb; },
  onApprovalRemove(cb) { bridge.handlers.remove = cb; },
  approvalReply(id, decision) { bridge.replies.push({ id, decision }); },
  jumpToSession(s) { bridge.jumps.push(s); },
  setInteractive(on) { bridge.interactive.push(on); },
};
/*
 * Listeners this file does not drive still have to exist, or the renderer throws
 * on the line that registers one and abandons the rest of the file. Naming them
 * all by hand made this stub a second list to maintain, and it fell behind the
 * renderer three times. Unknown `onX` handlers are accepted and dropped; that
 * the preload really exposes what the renderer subscribes to is asserted
 * directly in renderer-scripts.test.js.
 */
globalThis.window.petsBridge = new Proxy(bridge, {
  get: (target, key) => (
    key in target ? target[key]
      : typeof key === 'string' && /^on[A-Z]/.test(key) ? () => {}
        : undefined
  ),
});

globalThis.Strays = require('../../strays.js');
// the renderer has no module system: overlay.html loads requests.js as a plain
// script and overlay.js reads the same helper main.js uses off the global
const { isLive, DEFAULT_TTL_MS } = require('../requests.js');
require('../overlay.js');

// ------------------------------------------------------------- test helpers
const world = Strays._world;
const frame = () => Strays.step(1 / 60, 1);

/* every timer overlay.js schedules while `fn` runs, newest last */
function captureTimers(fn) {
  const real = globalThis.setTimeout;
  const seen = [];
  globalThis.setTimeout = (f, ms) => { seen.push({ fn: f, ms }); return 0; };
  try { fn(); } finally { globalThis.setTimeout = real; }
  return seen;
}

let nextId = 0;
function request(over) {
  return Object.assign({
    id: 'req-' + (++nextId),
    tool: 'Bash',
    command: 'rm -rf ./build',
    description: '',
    session_id: '',
    cwd: '/Users/dev/Projects/demo',
    ts: Date.now(),
    expires_at: Date.now() + 12000,
  }, over);
}

/* deliver a request the way main.js does, and hand back the card it made */
const liveCards = new Set();
function send(req) {
  const timers = captureTimers(() => bridge.handlers.request(req));
  liveCards.add(req.id);
  return { req, card: cardWrap.children[cardWrap.children.length - 1], timers };
}

const descendants = (el) => el.children.flatMap((c) => [c, ...descendants(c)]);
const button = (card, label) =>
  descendants(card).find((e) => e.tag === 'button' && e.textContent === label);
const cardText = (card) => descendants(card).map((e) => e.textContent).filter(Boolean);

/* pin a session's pet so the anchor under test is a known number */
function placeSessions(ids, xs) {
  Strays.setSessions(ids.map((id) => ({ id, state: 'waiting', cwd: '/Users/dev/Projects/demo' })));
  frame();
  ids.forEach((id, i) => {
    const pet = world.pets.find((p) => p.session && p.session.id === id);
    pet.x = xs[i] - (pet.sprites.walk1[0].length * pet.scale) / 2;
  });
}

test.beforeEach(() => {
  bridge.replies.length = 0;
  /*
   * Through the renderer's own removal path, not by pulling the elements out
   * from under it. Ripping them out leaves overlay.js still believing the
   * pointer is on a card it no longer has — several of these tests hover a card
   * and never answer it — so the lane started every later test already
   * interactive, and an assertion about handing the pointer back could not fail.
   */
  liveCards.forEach((id) => bridge.handlers.remove(id));
  liveCards.clear();
  cardWrap.children.slice().forEach((c) => c.remove());
});

// ------------------------------------------------------------------- tests
test('Allow sends allow and Deny sends deny, each for its own card', () => {
  const first = send(request({ id: 'aaa', command: 'git push --force' }));
  const second = send(request({ id: 'bbb', command: 'rm -rf /' }));

  button(second.card, 'Deny').click();
  button(first.card, 'Allow').click();

  assert.deepEqual(bridge.replies, [
    { id: 'bbb', decision: 'deny' },
    { id: 'aaa', decision: 'allow' },
  ]);
});

test('a card sits above the pet bound to the session that asked', () => {
  placeSessions(['alpha', 'beta'], [400, 1000]);

  const a = send(request({ id: 'a1', session_id: 'alpha' }));
  const b = send(request({ id: 'b1', session_id: 'beta' }));

  // the stylesheet pulls a card back by half its own width, so left is where
  // the card's centre goes — the pet's centre, whatever the card's width is
  assert.equal(a.card.style.left, '400px');
  assert.equal(b.card.style.left, '1000px');
  assert.equal(a.card.style.transform, undefined,
    'the centring transform is the stylesheet\'s job and must survive');
});

test('a card anchored at the edge of the screen stays on screen', () => {
  placeSessions(['left', 'right'], [8, LANE_W - 8]);

  const l = send(request({ id: 'l1', session_id: 'left' }));
  const r = send(request({ id: 'r1', session_id: 'right' }));

  // a card 12px from either edge, i.e. its centre a half-card further in
  assert.equal(l.card.style.left, 12 + CARD_W / 2 + 'px');
  assert.equal(r.card.style.left, LANE_W - 12 - CARD_W / 2 + 'px');
});

test('a card with no pet to point at is left where the stylesheet centres it', () => {
  const { card } = send(request({ id: 'n1', session_id: 'a-session-that-ended' }));
  assert.equal(card.style.left, undefined,
    'positioning an unanchored card would drag it off centre');
});

test('the stylesheet positions cards against the lane, not a centring flow', () => {
  // overlay.js writes a viewport x into card.style.left. That is only what it
  // means while the card is placed on #cards directly; as a relative offset
  // from a centred flow position it lands half a screen away.
  const css = fs.readFileSync(path.join(__dirname, '..', 'overlay.html'), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(selector + ' {');
    assert.ok(at >= 0, `overlay.html has no ${selector} rule`);
    return css.slice(at, css.indexOf('}', at));
  };

  assert.match(rule('#cards'), /position:\s*fixed/);
  assert.match(rule('.card'), /position:\s*absolute/);
  assert.doesNotMatch(rule('.card'), /position:\s*relative/);
});

test('two cards asking the same thing are told apart by their project', () => {
  const a = send(request({ id: 'p1', cwd: '/Users/dev/Projects/api-gateway', command: 'npm test' }));
  const b = send(request({ id: 'p2', cwd: '/Users/dev/Projects/web-client', command: 'npm test' }));

  const textA = cardText(a.card), textB = cardText(b.card);
  assert.ok(textA.some((t) => t.includes('api-gateway')), `card reads ${JSON.stringify(textA)}`);
  assert.ok(textB.some((t) => t.includes('web-client')), `card reads ${JSON.stringify(textB)}`);
  assert.ok(!textA.some((t) => t.includes('web-client')), 'a card names its own project only');
  assert.ok(!textA.some((t) => t.includes('/Users/dev')),
    'the project is the label, not the whole path across somebody\'s home directory');
});

test('a card shows what the tool call said it was for', () => {
  const { card } = send(request({
    id: 'p3', tool: 'Bash', command: 'gh pr merge 42',
    description: 'merge the release PR',
  }));
  const text = cardText(card);
  assert.ok(text.some((t) => t.includes('merge the release PR')), `card reads ${JSON.stringify(text)}`);
  assert.ok(text.some((t) => t.includes('gh pr merge 42')), 'the command itself is still shown');
});

test('a request the gate could say nothing about carries no empty labels', () => {
  const { card } = send(request({ id: 'p4', cwd: '', description: '', command: 'ls' }));
  const text = cardText(card);
  assert.deepEqual(text.filter((t) => /^[\s·]*$/.test(t)), [],
    `nothing on the card is punctuation with no label: ${JSON.stringify(text)}`);
  assert.ok(text.some((t) => t.includes('ls')));
});

test('a card lingers for as long as the gate is still holding the call', () => {
  const { card, timers } = send(request({ id: 'g1', expires_at: Date.now() + 12000 }));
  const linger = timers[timers.length - 1];

  assert.ok(Math.abs(linger.ms - 12500) < 250,
    `card scheduled its retraction at ${linger.ms}ms, expected the gate's 12000 + a little`);

  linger.fn();
  assert.deepEqual(cardWrap.children, [], 'the card retracts when the hold runs out');
  assert.equal(card.parent, null);
});

test('a request carrying only a timestamp lingers as long as main.js shows it', () => {
  // main.js judges the same request through requests.js, which falls back to
  // ts + the default TTL. Reading expires_at raw here tears the card down while
  // the gate is still waiting on an answer.
  const req = request({ id: 'g2', ts: Date.now(), expires_at: undefined });
  assert.ok(isLive(req), 'main.js would be showing this request');

  const { timers } = send(req);
  const ms = timers[timers.length - 1].ms;
  assert.ok(Math.abs(ms - (DEFAULT_TTL_MS + 500)) < 250,
    `card scheduled its retraction at ${ms}ms, expected about ${DEFAULT_TTL_MS + 500}ms`);
});

test('answering a card takes it off screen', () => {
  const { card } = send(request({ id: 'ccc' }));
  assert.equal(cardWrap.children.length, 1);

  button(card, 'Allow').click();
  assert.deepEqual(cardWrap.children, [], 'the answered card is gone');

  // the gate retracting a request it timed out on removes the card too
  const other = send(request({ id: 'ddd' }));
  assert.equal(cardWrap.children.length, 1);
  bridge.handlers.remove('ddd');
  assert.deepEqual(cardWrap.children, []);
  assert.equal(other.card.parent, null);
});

test('two cards asking at once never hide one another', () => {
  // Both pets are near the left edge, so the horizontal clamp pushes both cards
  // to the same place. Stacked at the same spot the lower card is invisible AND
  // unclickable, so that session's tool call can only time out.
  placeSessions(['s-left', 's-alsoleft'], [6, 60]);
  const a = send(request({ session_id: 's-left', command: 'terraform apply' }));
  const b = send(request({ session_id: 's-alsoleft', command: 'terraform destroy' }));

  const spot = (c) => `${c.style.left}|${c.style.bottom}`;
  assert.notEqual(spot(a.card), spot(b.card),
    'two cards clamped to the same x must not occupy the same place');
});

test('answering a card stops the lane swallowing clicks, even with another card up', () => {
  // The overlay is click-through until something is hovered. If a card is
  // answered while the pointer is on it, nothing can ever fire its mouseleave
  // again — so the full-width lane along the bottom of the screen goes on
  // eating every click aimed at whatever application is underneath.
  placeSessions(['s-one', 's-two'], [300, 900]);
  const first = send(request({ session_id: 's-one' }));
  send(request({ session_id: 's-two' }));

  first.card.fire('mouseenter');
  assert.equal(bridge.interactive[bridge.interactive.length - 1], true,
    'hovering a card must catch clicks');

  button(first.card, 'Allow').click();
  assert.equal(bridge.interactive[bridge.interactive.length - 1], false,
    'answering the hovered card must hand clicks back');
});

test('a card still under the pointer keeps the lane interactive', () => {
  // the mirror of the case above: releasing too eagerly would make the
  // remaining card's buttons unclickable
  placeSessions(['s-one', 's-two'], [300, 900]);
  const first = send(request({ session_id: 's-one' }));
  const second = send(request({ session_id: 's-two' }));

  first.card.fire('mouseenter');
  second.card.fire('mouseenter');
  button(first.card, 'Allow').click();

  assert.equal(bridge.interactive[bridge.interactive.length - 1], true,
    'the pointer is still on the second card');
});

test('the heartbeat carries the current answer, not the one that armed it', () => {
  /*
   * The host expires a claim nobody renews, which is the only thing standing
   * between a renderer that has stopped tracking hover and a screen that takes
   * no clicks at all. A beat that repeats `true` because it was started while
   * something was hovered renews a claim that is no longer true — and the case
   * that produces one is the case above, a card answered under the pointer,
   * which can never fire its own mouseleave.
   */
  placeSessions(['s-one'], [300]);
  const first = send(request({ session_id: 's-one' }));

  first.card.fire('mouseenter');
  beat();
  assert.equal(bridge.interactive[bridge.interactive.length - 1], true,
    'a live hover is renewed');

  button(first.card, 'Allow').click();
  bridge.interactive.length = 0;
  beat();
  assert.deepEqual(bridge.interactive, [false],
    'and once the card is gone the beat stops asking for the pointer');
});

test('a request delivered twice raises only one card', () => {
  // main.js has two paths to the renderer — the scan at launch and the
  // directory watch — and both can fire for the same file. A second card for
  // the same request would sit over the first and take a click meant for it.
  const req = request({ id: 'twice', session_id: 'a-session' });
  bridge.handlers.request(req);
  bridge.handlers.request(req);

  assert.equal(cardWrap.children.length, 1);
});

test('a card is given the class the stylesheet positions', () => {
  // The lane's absolute positioning and the anchoring maths are two halves of
  // one fix; without the class the card falls back to static flow and the
  // computed left is ignored.
  const { card } = send(request({ session_id: 'a-session' }));
  assert.equal(card.className, 'card');
});

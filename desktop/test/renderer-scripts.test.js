/*
 * The renderer's scripts, loaded the way the browser loads them.
 *
 * overlay.html pulls in several classic scripts, and classic scripts share one
 * global lexical scope: a top-level `const` in the second file collides with a
 * top-level `function` of the same name in the first, and the collision is a
 * SyntaxError raised at parse time, before a single statement runs. The whole
 * overlay dies — no pets, no cards, no click-to-jump — and nothing else in the
 * suite can see it, because every other test `require()`s these files and
 * CommonJS gives each its own module scope.
 *
 * This shipped once. The script list is read out of overlay.html rather than
 * written down here, so adding a script to the page brings it under test too.
 */
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.join(__dirname, '..');
const OVERLAY_HTML = path.join(DESKTOP, 'overlay.html');

/* the scripts overlay.html loads, in the order it loads them */
function pageScripts() {
  const html = fs.readFileSync(OVERLAY_HTML, 'utf8');
  return [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => ({
    src: m[1],
    code: fs.readFileSync(path.resolve(DESKTOP, m[1]), 'utf8'),
  }));
}

/* just enough browser for the scripts to reach the end of their top level */
function browserGlobals() {
  const noop = () => {};
  const element = () => ({
    className: '', textContent: '', style: {}, children: [],
    width: 0, height: 0, clientWidth: 1440, clientHeight: 190, offsetWidth: 360,
    dataset: {},
    setAttribute: noop, removeAttribute: noop, remove: noop,
    addEventListener: noop, removeEventListener: noop,
    appendChild: (c) => c,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1440, height: 190 }),
    getContext: () => new Proxy({}, {
      get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 })
        : k === 'createRadialGradient' ? () => ({ addColorStop: noop })
          : noop),
    }),
  });

  const globals = {
    console: { log: noop, warn: noop, error: noop },
    document: {
      hidden: false, currentScript: null, body: element(),
      createElement: element, getElementById: () => element(),
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, removeEventListener: noop,
    },
    localStorage: { getItem: () => null, setItem: noop },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
    Image: function Image() { return element(); },
  };
  globals.window = globals;
  globals.globalThis = globals;
  globals.window.innerWidth = 1440;
  globals.window.innerHeight = 900;
  globals.window.devicePixelRatio = 1;
  globals.window.addEventListener = noop;
  globals.window.removeEventListener = noop;

  // the preload's contextBridge surface: every renderer listener registers here
  const on = () => noop;
  globals.window.petsBridge = {
    onClaudeStatus: on, onParty: on, onUsage: on, onCelebrate: on,
    onCustomPets: on, onApprovalRequest: on, onApprovalRemove: on,
    approvalReply: noop, jumpToSession: noop, setInteractive: noop,
  };
  return globals;
}

test('every script overlay.html loads can be loaded together', () => {
  const scripts = pageScripts();
  assert.ok(scripts.length >= 2, 'overlay.html should load more than one script');

  const context = vm.createContext(browserGlobals());
  const loaded = [];
  for (const { src, code } of scripts) {
    try {
      vm.runInContext(code, context, { filename: src });
    } catch (err) {
      assert.fail(
        `${src} failed to load after [${loaded.join(', ')}]: ${err.name}: ${err.message}`,
      );
    }
    loaded.push(src);
  }
});

test('no two scripts declare the same global name', () => {
  // The specific collision that killed the renderer, stated directly: a script
  // that only wants a helper from an earlier one must not re-declare its name.
  const seen = new Map();
  for (const { src, code } of pageScripts()) {
    const declarations = [...code.matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((m) => m[1])
      .concat([...code.matchAll(/^const\s*\{([^}]+)\}/gm)]
        .flatMap((m) => m[1].split(',').map((s) => s.split(':').pop().trim()))
        .filter(Boolean));

    for (const name of declarations) {
      const owner = seen.get(name);
      assert.ok(
        owner === undefined || owner === src,
        `${src} re-declares "${name}", already declared by ${owner} — ` +
        'classic scripts share one global scope, so this is a parse-time SyntaxError',
      );
      seen.set(name, src);
    }
  }
});

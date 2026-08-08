/*
 * How long an approval request still means anything.
 *
 * The gate knows, because it wrote the expiry. The overlay did not ask, and so
 * resurrected cards for commands that had finished — including on a fresh
 * launch, where no gate has run yet to prune anything.
 */
const test = require('node:test');
const assert = require('node:assert');
const { isLive, remainingMs, DEFAULT_TTL_MS } = require('../requests');

const NOW = 1_800_000_000_000;

test('a request past its expiry is dead', () => {
  assert.equal(isLive({ id: 'x', ts: NOW - 60_000, expires_at: NOW - 1 }, NOW), false);
});

test('a request inside its expiry is live', () => {
  assert.equal(isLive({ id: 'x', ts: NOW, expires_at: NOW + 5_000 }, NOW), true);
});

test('a request from before expiries were recorded is judged on its age', () => {
  // A real one of these was sitting on the reporter's machine, written by a
  // gate that predated expires_at and then killed.
  assert.equal(isLive({ id: 'x', ts: NOW - DEFAULT_TTL_MS - 1 }, NOW), false);
  assert.equal(isLive({ id: 'x', ts: NOW - 1_000 }, NOW), true);
});

test('a request that records no time at all is not trusted', () => {
  for (const req of [{ id: 'x' }, {}, null, undefined]) {
    assert.equal(isLive(req, NOW), false, JSON.stringify(req));
  }
});

test('the time left on a request never goes negative', () => {
  assert.equal(remainingMs({ ts: NOW, expires_at: NOW + 4_000 }, NOW), 4_000);
  assert.equal(remainingMs({ ts: NOW - 90_000, expires_at: NOW - 60_000 }, NOW), 0);
});

test('a request with no recorded expiry is judged the same on both sides of the seam', () => {
  // requests.js answers for the overlay; the gate decides how long it will
  // really wait. If these two defaults drift apart, a request written without
  // an expiry is shown by one side after the other has stopped waiting.
  const { DEFAULT_HOOK_TIMEOUT_MS } = require('../hooks/gate');
  assert.equal(DEFAULT_TTL_MS, DEFAULT_HOOK_TIMEOUT_MS,
    'the fallback lifetime must mirror the hook timeout the gate assumes');
});

/*
 * How long an approval request still means anything.
 *
 * The gate writes an expiry into every request because it is the only party
 * that knows how long it intends to wait. Everyone else — the overlay at
 * launch, the overlay watching the directory — has to ask before showing a
 * card, or a command that finished ten minutes ago gets one.
 */

/* what to assume for a request written before expiries were recorded */
const DEFAULT_TTL_MS = 30 * 1000;

/* the moment a request stops meaning anything, or null if it cannot be judged */
function expiryOf(request) {
  if (!request) return null;
  if (Number.isFinite(request.expires_at)) return request.expires_at;
  if (Number.isFinite(request.ts)) return request.ts + DEFAULT_TTL_MS;
  return null;
}

/* whether a card for this request could still be answered */
function isLive(request, now = Date.now()) {
  const expiry = expiryOf(request);
  return expiry !== null && expiry > now;
}

/* how long a card should stay on screen, never negative */
function remainingMs(request, now = Date.now()) {
  const expiry = expiryOf(request);
  return expiry === null ? 0 : Math.max(0, expiry - now);
}

const api = { isLive, remainingMs, expiryOf, DEFAULT_TTL_MS };

/* main.js requires this; the overlay renderer has no module system and loads
   it as a plain script, so both sides can answer with the same expiry */
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.straysRequests = api;

/* the overlay renderer: pets + Crew-style approval cards */

let cardHover = false;
let petHover = false;

/*
 * Asking for the pointer is a lease the host expires, not a switch it flips —
 * see pointer-guard.js. The lane covers the screen, so a claim the host keeps
 * honouring after this renderer has stopped tracking hover is every click on
 * the machine; renewing it says "still here, and still true".
 *
 * One beat that always runs, rather than one armed and disarmed alongside the
 * hover state. An interval that has to be cancelled is a thing that can be left
 * armed — a card answered under the pointer never fires its own mouseleave, and
 * that alone would have renewed a stale claim for ever, which is the failure
 * the lease exists to prevent. This one carries the current answer instead of a
 * hardcoded `true`, so being wrong costs at most one beat.
 */
const RENEW_MS = 500;
const syncInteractive = () => window.petsBridge.setInteractive(cardHover || petHover);
setInterval(syncInteractive, RENEW_MS);

const world = Strays.mount({
  // the window is the lane, whatever size the host has made it
  height: 'fill',
  // STRAYS_DEBUG=1 makes every release explain itself — see the note in preload.js
  debug: window.petsBridge.debug,
  onHoverChange: (hovering) => { petHover = hovering; syncInteractive(); },
  onPetClick: (session) => window.petsBridge.jumpToSession(session),
});
console.log('strays overlay mounted:', world.pets.length, 'pets, lane', world.w + 'px');
Strays.setFollowMode(true); // one visible pet per session, Crew-style

window.petsBridge.onClaudeStatus((s) => {
  Strays.setStatus(s.state);
  Strays.setSessions(s.sessions || []);
});
window.petsBridge.onParty((on) => Strays.setParty(on));
window.petsBridge.onShowTitles((on) => Strays.setShowTitles(on));
// the lane is a strip nobody points at, so the engine cannot tell from the
// pointer whether anyone is there — the main process asks the system instead
window.petsBridge.onObserved((on) => Strays.setObserved(on));
window.petsBridge.onMischief((on) => Strays.setMischief(on));
window.petsBridge.onUsage((stats) => Strays.setUsage(stats));
window.petsBridge.onCelebrate(() => Strays.celebrate());
/*
 * Custom pets are *registered* here, not added: the roster that arrives next is
 * the only thing that decides who is actually on the lane. Adding them here too
 * would put a pet out that the Pets window has switched off, and would double it
 * up whenever the defs are re-sent — which happens every time one is drawn.
 */
window.petsBridge.onCustomPets((defs) => {
  defs.forEach((def) => {
    if (!Strays.registerCustomPet(def)) console.warn('skipping custom pet:', def && def.name);
  });
});
/*
 * Who is on the team, and in what order sessions reach them — from the Pets
 * window, via main.js, which always sends the custom defs first because an order
 * cannot name a pet the world has never been handed.
 *
 * Reordering is not a remount: pets already out keep their position, their state
 * and any carry in progress, so dragging a row moves nobody on screen.
 *
 * `rebind` is set only by a save from the Pets window, and it is what makes that
 * save visible. The order decides who takes the *next* session and bindSessions
 * is sticky, so without it a reorder with conversations already live changes
 * nothing at all — the bug that reported this was the order appearing to do
 * nothing until Follow Claude Code sessions was toggled off and on.
 */
window.petsBridge.onRoster(({ ids, rebind }) => {
  Strays.setRoster(ids, { rebind });
  // what the lane ended up with, which is not always what it was asked for: a
  // name for a pet this world has never been handed is skipped
  console.log('roster:', world.pets.map((p) => p.name).join(' -> ') || '(nobody)',
    rebind ? '(re-dealt)' : '');
});

// ---------------------------------------------------------- approval cards
// requests.js, loaded ahead of this file — the renderer has no module system,
// so the helper main.js requires arrives on the global instead. It is held
// whole rather than destructured: classic scripts share one global scope, and
// re-declaring a name requests.js already defines is a parse-time SyntaxError
// that stops this entire file from running.
const requestLifetime = window.straysRequests;

/* one card plus the gap above it, when cards have to be stacked */
const CARD_ROW_HEIGHT = 74;

const cardWrap = document.getElementById('cards');
const cards = new Map(); // id -> element
const hoveredCards = new Set(); // ids the pointer is currently over

/* the lane catches clicks while anything on it is hovered, and only then */
const syncCardHover = () => { cardHover = hoveredCards.size > 0; syncInteractive(); };

window.petsBridge.onApprovalRequest((req) => {
  if (cards.has(req.id)) return;
  const card = document.createElement('div');
  card.className = 'card';

  const cmd = document.createElement('div');
  cmd.className = 'cmd';
  const head = document.createElement('div');
  head.className = 'head';
  const tool = document.createElement('b');
  tool.textContent = req.tool || 'Bash';
  head.appendChild(tool);
  // Two sessions can be waiting at the same moment, and the tool and the
  // command are often word for word the same in both. What the gate knows that
  // differs is where the call came from and what it said it was for.
  const label = [projectName(req.cwd), req.description].filter(Boolean).join(' · ');
  if (label) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = label;
    head.appendChild(meta);
  }
  const text = document.createElement('code');
  text.textContent = req.command;
  cmd.appendChild(head);
  cmd.appendChild(text);

  const btns = document.createElement('div');
  btns.className = 'btns';
  const allow = document.createElement('button');
  allow.className = 'allow';
  allow.textContent = 'Allow';
  const deny = document.createElement('button');
  deny.className = 'deny';
  deny.textContent = 'Deny';
  btns.appendChild(allow);
  btns.appendChild(deny);

  card.appendChild(cmd);
  card.appendChild(btns);

  const reply = (decision) => () => {
    window.petsBridge.approvalReply(req.id, decision);
    removeCard(req.id);
    if (decision === 'allow') Strays.celebrate();
  };
  allow.addEventListener('click', reply('allow'));
  deny.addEventListener('click', reply('deny'));

  card.addEventListener('mouseenter', () => { hoveredCards.add(req.id); syncCardHover(); });
  card.addEventListener('mouseleave', () => { hoveredCards.delete(req.id); syncCardHover(); });

  cardWrap.appendChild(card);
  cards.set(req.id, card);
  anchorCard(card, req.session_id);
  stackCards();

  // Retract with the gate, not on a guess: the gate derives its hold from the
  // configured hook timeout, and main.js judges the very same request live
  // through requests.js. Reading the expiry any other way here takes the card
  // away while the tool call is still held and still answerable.
  const linger = Math.max(1000, requestLifetime.remainingMs(req)) + 500;
  setTimeout(() => removeCard(req.id), linger);
});

/* the project a request came from: the last segment of its working directory */
function projectName(cwd) {
  // split on both separators: a Windows cwd contains no forward slashes
  const parts = String(cwd || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// Raise the card above the pet bound to the session that asked, when we know
// it — the binding is sticky, so this is the same pet the user can click. The
// card keeps the stylesheet's translateX(-50%), so it only has to be told where
// its centre goes; the width is measured after it is in the document, because
// a card is exactly as wide as the command it is showing.
function anchorCard(card, sessionId) {
  const cx = Strays.sessionAnchor(sessionId);
  if (cx === null) return; // no pet to point at: leave it centred
  const half = card.offsetWidth / 2;
  card.style.left = Math.max(12 + half, Math.min(window.innerWidth - 12 - half, cx)) + 'px';
}

/* where a card's centre sits: its anchor, or the middle if it has none */
function cardCentre(card) {
  const left = parseFloat(card.style.left);
  return Number.isFinite(left) ? left : window.innerWidth / 2;
}

/*
 * Two sessions can ask at the same moment, and two pets near the same edge
 * clamp to the same place. A card completely behind another is invisible and
 * unclickable, so the session underneath could only ever time out. Cards that
 * would collide are stacked upward instead of sharing a spot.
 */
function stackCards() {
  const placed = [];
  for (const card of cards.values()) {
    const centre = cardCentre(card);
    const width = card.offsetWidth || 0;
    let row = 0;
    while (placed.some((p) => p.row === row && Math.abs(p.centre - centre) < (p.width + width) / 2)) {
      row++;
    }
    card.style.bottom = row * CARD_ROW_HEIGHT + 'px';
    placed.push({ row, centre, width });
  }
}

window.petsBridge.onApprovalRemove((id) => removeCard(id));

function removeCard(id) {
  const card = cards.get(id);
  if (!card) return;
  cards.delete(id);
  card.remove();
  // A card answered under the pointer can never fire its own mouseleave, and
  // the lane it leaves behind would go on swallowing clicks meant for whatever
  // application is underneath.
  hoveredCards.delete(id);
  stackCards();
  syncCardHover();
}

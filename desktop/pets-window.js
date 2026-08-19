/*
 * The Pets window: who is on the team, and in what order sessions reach them.
 *
 * The order is the point. bindSessions hands the first free pet to each new
 * session, so row one is "the pet you see when one Claude window is open" — a
 * thing that until now was decided by the order of an array literal.
 *
 * Every row draws its pet's real sprite, through the engine's own
 * Strays.renderSprite. A roster of names is a list you have to decode, and
 * "which one is Mutex" is exactly the question a picker should answer by itself.
 */

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');

/* the resolved roster, in display order: [{ id, name, custom, grids, palette, on }] */
let rows = [];

/*
 * A sprite at the size the row has room for, not the size the lane draws at. The
 * grids are 7 to 13 cells tall depending on the animal, so a fixed scale makes
 * the fish tiny beside a standing custom pet; scaling to the seat's height keeps
 * every row's art the same physical size.
 */
const SEAT_H = 34;
function spriteFor(pet) {
  const grid = pet.grids && (pet.grids.walk1 || pet.grids.swim1);
  if (!grid || !grid.length) return null;
  // +2 because renderSprite pads a cell all round for the generated outline
  const scale = Math.max(1, Math.floor(SEAT_H / (grid.length + 2)));
  try { return Strays.renderSprite(grid, pet.palette, scale); }
  catch { return null; /* a malformed def must not take the window down */ }
}

function render() {
  listEl.textContent = '';
  rows.forEach((pet, i) => listEl.appendChild(rowEl(pet, i)));
  emptyEl.hidden = rows.some((p) => p.on);
}

function rowEl(pet, index) {
  const row = document.createElement('div');
  row.className = 'row' + (pet.on ? '' : ' off');
  row.draggable = false;              // the grip arms this, not the row
  row.dataset.id = pet.id;

  const grip = document.createElement('div');
  grip.className = 'grip';
  grip.textContent = '::';
  grip.title = 'Drag to reorder';
  // Only the handle starts a drag. With the whole row draggable, a press that
  // began on the checkbox becomes a reorder and the click never lands.
  grip.addEventListener('mousedown', () => { row.draggable = true; });
  grip.addEventListener('mouseup', () => { row.draggable = false; });

  const seat = document.createElement('div');
  seat.className = 'seat';
  const art = spriteFor(pet);
  if (art) { art.className = 'sprite'; seat.appendChild(art); }

  const who = document.createElement('div');
  who.className = 'who';
  const name = document.createElement('div');
  name.className = 'name';
  const nameText = document.createElement('span');
  nameText.textContent = pet.name;
  name.appendChild(nameText);
  if (pet.custom) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'CUSTOM';
    badge.title = 'Yours — from ~/.strays/custom-pets.json';
    name.appendChild(badge);
  }
  const slot = document.createElement('div');
  slot.className = 'slot label';
  slot.textContent = slotLabel(pet, index);
  who.appendChild(name);
  who.appendChild(slot);

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = pet.on;
  box.title = 'Show this pet';
  box.addEventListener('change', () => {
    pet.on = box.checked;
    render();
    save();
  });

  row.appendChild(grip);
  row.appendChild(seat);
  row.appendChild(who);
  row.appendChild(box);
  wireDrag(row);
  return row;
}

/*
 * Which session a pet would take. Counted over the pets that are *on*, because a
 * switched-off pet takes no session at all — numbering it anyway would promise a
 * slot that does not exist, and shift every number below it by one for no reason.
 *
 * Zero-padded, so the column does not jog sideways between slot 9 and slot 10.
 */
function slotLabel(pet, index) {
  if (!pet.on) return 'Off';
  const place = rows.slice(0, index).filter((p) => p.on).length + 1;
  return `Session ${String(place).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ dragging
let dragId = null;

function wireDrag(row) {
  row.addEventListener('dragstart', (e) => {
    dragId = row.dataset.id;
    row.classList.add('dragging');
    // Firefox and Chromium both want *something* set or the drag never starts
    e.dataTransfer.setData('text/plain', dragId);
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => {
    dragId = null;
    row.draggable = false;
    [...listEl.children].forEach((c) => c.classList.remove('dragging', 'over'));
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (dragId && row.dataset.id !== dragId) row.classList.add('over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('over'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('over');
    move(dragId, row.dataset.id);
  });
}

/* put `id` where `beforeId` currently is, sliding the rest along */
function move(id, beforeId) {
  if (!id || id === beforeId) return;
  const from = rows.findIndex((p) => p.id === id);
  const to = rows.findIndex((p) => p.id === beforeId);
  if (from < 0 || to < 0) return;
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);
  render();
  save();
}

// ------------------------------------------------------------------- saving
/*
 * The whole list, every time. The window is the only thing that knows the order,
 * and main.js merges rather than overwrites so preferences about pets that are
 * not on screen survive — see mergeRoster in pet-roster.js.
 */
function save() {
  window.straysPets.save({
    order: rows.map((p) => p.id),
    off: rows.filter((p) => !p.on).map((p) => p.id),
  });
}

// ------------------------------------------------------------------ the lane
const TOGGLES = ['follow', 'titles', 'mischief', 'party'];

function wireToggles(state) {
  for (const key of TOGGLES) {
    const el = document.getElementById(key);
    el.checked = !!state[key];
    el.addEventListener('change', () => window.straysPets.setToggle(key, el.checked));
  }
  document.getElementById('celebrate')
    .addEventListener('click', () => window.straysPets.celebrate());
}

// --------------------------------------------------------------------- boot
async function load() {
  const data = await window.straysPets.load();
  const on = new Set(data.enabled);
  rows = data.pets.map((p) => ({ ...p, on: on.has(p.id) }));
  render();
  return data;
}

load().then((data) => wireToggles(data.toggles));
// a pet drawn in the editor, or deleted, while this window is open
window.straysPets.onPetsChanged(() => load());

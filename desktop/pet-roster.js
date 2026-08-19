/*
 * Who is on the team, and in what order sessions reach them.
 *
 * The order is not decoration. bindSessions walks the pet list and hands the
 * first free pet to each new session, so position one is "the pet you see when
 * one Claude window is open". That is the thing people actually want to choose,
 * and until now it was decided by the order of an array literal in strays.js.
 *
 * Pure, and separate from main.js, for the usual reason in this project: the
 * interesting cases are all about a config file that outlives the release that
 * wrote it — a pet that has since been deleted, one that has just been adopted,
 * a name saved before it was renamed — and none of them need Electron to test.
 */

/*
 * The fish goes last, and that is inherited rather than invented here: the lane
 * has always handed sessions to land pets first and fallen back to Heisenbug
 * only when it ran out. Keeping that as the *default* order — rather than as a
 * reshuffle applied after the fact, which is what strays.js used to do — is what
 * lets an explicit order be honoured verbatim without changing what anyone who
 * never opens the Pets window sees.
 */
const LAST_BY_DEFAULT = 'heisenbug';

/*
 * Every pet that exists right now, in the order sessions would reach them if
 * nobody had ever stated a preference. Customs sit between the land pets and the
 * fish, which is where the old `filter(kind !== 'heisenbug')` put them.
 */
function defaultOrder(builtInIds, customNames) {
  const last = builtInIds.filter((id) => id === LAST_BY_DEFAULT);
  const first = builtInIds.filter((id) => id !== LAST_BY_DEFAULT);
  return [...first, ...customNames, ...last];
}

/*
 * config: { order?: string[], off?: string[] } — what the user dragged and
 *   unchecked, straight out of ~/.strays/config.json under `pets`.
 * available: { builtIns, customs, defaultOff } — what exists on disk now, plus the
 *   ids that arrive switched off. `defaultOff` is for the pets that ship with
 *   strays: the four animals are the team, and a bundled guest that let itself out
 *   on install would be a surprise rather than a present.
 *
 * Returns { order, enabled }: `order` is every available pet in the order to
 * show and to bind, `enabled` is the subset that is switched on. The window
 * needs both — a pet that is off still has a position, or unchecking one would
 * make it jump to the bottom of the list under the user's cursor.
 */
function resolveRoster(config, available) {
  const cfg = config || {};
  const builtIns = (available && available.builtIns) || [];
  const customs = (available && available.customs) || [];

  const def = defaultOrder(builtIns, customs);
  const exists = new Set(def);

  // A saved order can name pets that are gone: a custom pet deleted out of
  // custom-pets.json, or a built-in a future release drops. Dropping those
  // quietly is the point — the alternative is a roster that refers to nothing
  // and a lane that comes up empty.
  const saved = [];
  const seen = new Set();
  for (const id of Array.isArray(cfg.order) ? cfg.order : []) {
    if (!exists.has(id) || seen.has(id)) continue; // gone, or listed twice
    seen.add(id);
    saved.push(id);
  }

  /*
   * Then the pets the saved order has never heard of, which is how a newly
   * adopted custom pet turns up without anyone editing the config.
   *
   * Each one slots in behind whichever pet precedes it in the *default* order,
   * so a fresh custom lands among the land pets rather than after the fish.
   * Appending to the end instead would put every new pet behind Heisenbug — last
   * to ever get a session, which for a pet you drew five seconds ago reads as it
   * not working.
   */
  const rank = new Map(saved.map((id, i) => [id, i]));
  const order = saved.slice();
  for (let d = 0; d < def.length; d++) {
    const id = def[d];
    if (rank.has(id)) continue;
    /*
     * Anchor on the pet immediately ahead of this one in default order, and
     * nothing further back is ever needed: this walks def in order, so every
     * earlier pet has already been placed — either the user positioned it, or a
     * previous pass inserted it and recorded where. That invariant is what keeps
     * this a lookup instead of a search.
     */
    const insertAt = d === 0 ? 0 : rank.get(def[d - 1]) + 1;
    order.splice(insertAt, 0, id);
    // every recorded position at or after the splice has moved along by one, and
    // a stale one would send the next insertion to the wrong index
    for (const [key, value] of rank) if (value >= insertAt) rank.set(key, value + 1);
    rank.set(id, insertAt);
  }

  // An `off` entry naming a pet that is not here is simply inert, which is why
  // this needs no guard. Keeping such an entry *on the way back out* is the part
  // that takes work — see mergeRoster.
  const off = new Set(Array.isArray(cfg.off) ? cfg.off : []);

  /*
   * A pet that ships switched off, but only while the config has never placed it.
   * Being *in* `order` is the test: the Pets window saves the whole list, so once
   * anything has been saved every available pet is named there — and a guest the
   * user switched on would otherwise be forced back off on the next launch, which
   * reads as the checkbox not working rather than as a default.
   *
   * There is no need to also consult `off`: an id listed there is already off, so
   * defaulting it off again cannot change the answer.
   */
  const placed = new Set(saved);
  for (const id of Array.isArray(available && available.defaultOff) ? available.defaultOff : []) {
    if (!placed.has(id)) off.add(id);
  }

  return { order, enabled: order.filter((id) => !off.has(id)) };
}

/*
 * What to save after the Pets window changes something.
 *
 * The window can only ever report on the pets it drew, so a straight overwrite
 * quietly loses every preference about a pet that was not on screen. The case
 * that bites: switch a custom pet off, delete it from custom-pets.json, then
 * change anything at all in the window — the `off` entry is not in the update,
 * so it is dropped, and drawing that pet again brings it back switched on. The
 * user never asked for it back.
 *
 * So `order` is taken wholesale (the window showed every available pet, so its
 * order is complete and authoritative), while `off` is a union: what the window
 * says about the pets it showed, plus what the old config said about the pets it
 * could not.
 */
function mergeRoster(saved, update) {
  const prevOff = Array.isArray(saved && saved.off) ? saved.off : [];
  const order = Array.isArray(update && update.order) ? update.order.slice() : [];
  const off = Array.isArray(update && update.off) ? update.off : [];
  const shown = new Set(order);
  const unseen = prevOff.filter((id) => !shown.has(id));
  return { order, off: [...new Set([...unseen, ...off])] };
}

module.exports = { resolveRoster, mergeRoster, defaultOrder, LAST_BY_DEFAULT };

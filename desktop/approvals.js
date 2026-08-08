/*
 * The approvals plumbing, with no Electron in it.
 *
 * The gate writes a request into <home>/pending/ and blocks; the overlay shows
 * a card; the click comes back as <home>/replies/<id>.json. This class owns the
 * two directories and the rules about what may be shown — main.js keeps only
 * the wiring: build one of these, forward what it reports to the renderer.
 *
 * Directories and the "are approvals enabled" question are parameters so the
 * whole of it can be driven against a throwaway directory. That is the point:
 * while this lived in main.js it could not be loaded at all.
 */
const fs = require('fs');
const path = require('path');
const { isLive } = require('./requests');

/* a request id names a file, so it may not describe a path */
const ID = /^[\w-]+$/;

class Approvals {
  constructor({ pendingDir, repliesDir, enabled, onRequest, onRemove, debug } = {}) {
    this.pendingDir = pendingDir;
    this.repliesDir = repliesDir;
    this.enabled = enabled || (() => true);
    this.onRequest = onRequest || (() => {});
    this.onRemove = onRemove || (() => {});
    this.debug = debug || (() => {});
    this.watcher = null;
  }

  ensureDirs() {
    fs.mkdirSync(this.pendingDir, { recursive: true });
    fs.mkdirSync(this.repliesDir, { recursive: true });
  }

  /*
   * A request only earns a card while the gate that wrote it is still waiting.
   * A gate killed outright leaves its request behind, and gate-side pruning
   * cannot help here — at launch no gate has run yet. Showing one of these
   * means a card for a command that finished, answered into a file nobody reads.
   */
  show(req, why) {
    if (!this.enabled()) return false;
    if (!isLive(req)) return false;
    this.debug('[approval]', why, req && req.id, req && req.command);
    this.onRequest(req);
    return true;
  }

  scanPending() {
    let entries = [];
    try { entries = fs.readdirSync(this.pendingDir).filter((f) => f.endsWith('.json')); }
    catch { return; }
    for (const f of entries) {
      const file = path.join(this.pendingDir, f);
      try {
        const req = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (this.show(req, 'pending')) continue;
        // nobody is waiting on it — clear it out rather than re-reading it forever
        if (!isLive(req)) fs.unlinkSync(file);
      } catch { /* half-written; the next watch event gets it */ }
    }
  }

  watch() {
    this.ensureDirs();
    // fs.watch is fine here: gate.js writes each request in a single writeFileSync
    this.watcher = fs.watch(this.pendingDir, (_ev, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      const file = path.join(this.pendingDir, filename);
      if (fs.existsSync(file)) {
        try { this.show(JSON.parse(fs.readFileSync(file, 'utf8')), 'request'); }
        catch { /* half-written */ }
      } else {
        // gate timed out and cleaned up — retract the card
        this.onRemove(path.basename(filename, '.json'));
      }
    });
    return this.watcher;
  }

  stop() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }

  /*
   * A click, written where the gate that asked is looking. The id goes in the
   * body as well as in the name: the gate refuses a reply carrying an id that
   * is not its own, and with two sessions holding cards at once that check is
   * the only thing stopping one Allow from answering the other's command.
   */
  reply(id, decision) {
    if (!ID.test(String(id))) return false;
    try {
      fs.writeFileSync(
        path.join(this.repliesDir, id + '.json'),
        JSON.stringify({ id, decision: decision === 'allow' ? 'allow' : 'deny' }),
      );
      return true;
    } catch (e) {
      this.debug('[approval] reply failed', e.message);
      return false;
    }
  }
}

module.exports = { Approvals, ID };

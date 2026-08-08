/*
 * Watches ~/.claude/projects for Claude Code session activity.
 * No dependencies, no config, nothing leaves the machine.
 *
 * Session transcripts are append-only JSONL files named <session-id>.jsonl.
 * Per session we derive a Crew-style live state from the tail of the file:
 *
 *   thinking   written to in the last few seconds, last entry isn't a tool call
 *   tool       written to in the last few seconds, assistant is running a tool
 *   waiting    stalled with a trailing assistant message -> Claude waits on YOU
 *   done       just transitioned from active to finished (shown briefly)
 *
 * Emits { state, sessions: [{ id, state, cwd, entrypoint?, permissionMode? }] }
 * where `state` is the legacy global rollup ('working' | 'needs-you' | 'idle' |
 * null). entrypoint says which host runs the session ('claude-desktop' or
 * 'cli'); both it and permissionMode are absent when the transcript predates
 * them, so every consumer has to degrade rather than assume.
 * Fires onDone() when a working session finishes (pets celebrate).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const ACTIVE_MS = 12 * 1000;
const STALE_MS = 15 * 60 * 1000;
const DONE_SHOW_MS = 10 * 1000;
const POLL_MS = 2000;
const MAX_SESSIONS = 8;

class ClaudeWatcher {
  // opts.projectsDir points the scan somewhere other than ~/.claude/projects,
  // which is the only way to exercise the tail scan over known transcripts.
  constructor(onStatus, onDone, opts = {}) {
    this.onStatus = onStatus;
    this.onDone = onDone || null;
    this.projectsDir = opts.projectsDir || PROJECTS_DIR;
    this.timer = null;
    this.lastEmit = '';
    this.forced = false;          // send the next status even if it repeats
    this.wasActive = new Set();   // files seen in an active state
    this.doneUntil = new Map();   // file -> timestamp to keep showing 'done'
  }

  start() {
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.poll();
  }

  stop() {
    clearInterval(this.timer);
  }

  poll() {
    let files = [];
    try {
      files = this.recentTranscripts();
    } catch {
      this.emit({ state: null, sessions: [] });
      return;
    }

    const now = Date.now();
    const sessions = [];

    files.sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(0, MAX_SESSIONS)) {
      const age = now - f.mtime;
      const tail = this.tailInfo(f.file);
      let state;

      if (age < ACTIVE_MS) {
        state = tail.toolUse ? 'tool' : 'thinking';
        this.wasActive.add(f.file);
      } else if (tail.role === 'assistant') {
        if (this.wasActive.has(f.file)) {
          this.wasActive.delete(f.file);
          this.doneUntil.set(f.file, now + DONE_SHOW_MS);
          if (this.onDone) this.onDone();
        }
        state = (this.doneUntil.get(f.file) || 0) > now ? 'done' : 'waiting';
      } else {
        // stalled mid-turn (tool still running, or session abandoned)
        state = age < 60 * 1000 ? 'thinking' : null;
      }

      if (state) {
        const session = { id: path.basename(f.file, '.jsonl'), state, cwd: tail.cwd || null };
        // older transcripts record neither; consumers must cope with absence
        if (tail.entrypoint) session.entrypoint = tail.entrypoint;
        if (tail.permissionMode) session.permissionMode = tail.permissionMode;
        sessions.push(session);
      }
    }

    const anyActive = sessions.some((s) => s.state === 'thinking' || s.state === 'tool');
    const anyWaiting = sessions.some((s) => s.state === 'waiting');
    const state = anyActive ? 'working' : anyWaiting ? 'needs-you' : files.length ? 'idle' : null;
    this.emit({ state, sessions });
  }

  /*
   * Send the next status even if it repeats the last one. Deduplication assumes
   * the consumer still has what it was last told, which stops being true the
   * moment anything throws that away — the tray's Follow toggle empties the
   * renderer's session list when switched off. A session sitting in `waiting`
   * emits the same status forever, so the state change that would otherwise
   * undo the damage may never come.
   */
  forceNextEmit() {
    this.forced = true;
  }

  emit(status) {
    const key = JSON.stringify(status);
    if (this.forced || key !== this.lastEmit) {
      this.forced = false;
      this.lastEmit = key;
      this.onStatus(status);
    }
  }

  recentTranscripts() {
    const out = [];
    const now = Date.now();
    for (const proj of fs.readdirSync(this.projectsDir)) {
      const dir = path.join(this.projectsDir, proj);
      let entries;
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const e of entries) {
        if (!e.endsWith('.jsonl')) continue;
        const file = path.join(dir, e);
        try {
          const st = fs.statSync(file);
          if (now - st.mtimeMs < STALE_MS) out.push({ file, mtime: st.mtimeMs });
        } catch { /* transcript vanished mid-scan */ }
      }
    }
    return out;
  }

  // What the tail of the transcript says about the session, from one read.
  // entrypoint and permissionMode need not share a line with role or cwd, so
  // the walk only stops once every field is known or the tail runs out.
  tailInfo(file) {
    const info = { role: null, toolUse: false, cwd: null, entrypoint: null, permissionMode: null };
    try {
      const st = fs.statSync(file);
      const len = Math.min(64 * 1024, st.size);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        let j;
        try { j = JSON.parse(lines[i]); } catch { continue; /* partial line at the cut */ }
        if (!info.cwd && j.cwd) info.cwd = j.cwd;
        if (!info.entrypoint && typeof j.entrypoint === 'string') info.entrypoint = j.entrypoint;
        if (!info.permissionMode && typeof j.permissionMode === 'string') {
          info.permissionMode = j.permissionMode;
        }
        if (!info.role) {
          const role = j.type || (j.message && j.message.role);
          if (role === 'assistant' || role === 'user' || role === 'human') {
            info.role = role === 'human' ? 'user' : role;
            const content = j.message && j.message.content;
            info.toolUse = Array.isArray(content) && content.some((c) => c && c.type === 'tool_use');
          }
        }
        if (info.role && info.cwd && info.entrypoint && info.permissionMode) break;
      }
    } catch { /* unreadable — treat as unknown */ }
    return info;
  }
}

module.exports = { ClaudeWatcher };

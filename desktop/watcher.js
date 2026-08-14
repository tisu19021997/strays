/*
 * Watches ~/.claude/projects for Claude Code session activity.
 * No dependencies, no config, nothing leaves the machine.
 *
 * Session transcripts are append-only JSONL files named <session-id>.jsonl.
 * Per session we derive a Crew-style live state from the tail of the file:
 *
 *   thinking   active in the last few seconds, last entry isn't a tool call
 *   tool       active in the last few seconds, assistant is running a tool
 *   waiting    turn ended recently with an assistant message -> Claude waits on YOU
 *   resting    the same, but long enough ago to stop nudging about it
 *   done       just transitioned from active to finished (shown briefly)
 *
 * Emits { state, sessions: [{ id, state, cwd, title?, entrypoint?, permissionMode? }] }
 * where `state` is the legacy global rollup ('working' | 'needs-you' | 'idle' |
 * null). entrypoint says which host runs the session ('claude-desktop' or
 * 'cli'); it, permissionMode and title are absent when the transcript does not
 * record them, so every consumer has to degrade rather than assume.
 * Fires onDone() when a working session finishes (pets celebrate).
 *
 * IMPORTANT: how old a session is comes from the timestamps *inside* the
 * transcript, never from the file's mtime. See activityAt below.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const ACTIVE_MS = 12 * 1000;
const DONE_SHOW_MS = 10 * 1000;
const POLL_MS = 2000;
const MAX_SESSIONS = 8;

/*
 * How long a finished turn still counts as Claude *waiting on you*.
 *
 * `waiting` is the nudge: it makes the pet hop and wear a ❗. That has to expire,
 * because a pet hopping for a quarter of an hour is crying wolf.
 */
const WAITING_MS = 5 * 60 * 1000;

/*
 * ...and how long the session keeps its pet afterwards, quietly.
 *
 * These are two different questions and conflating them was a bug in both
 * directions. A transcript whose last entry is from the assistant has ended its
 * turn, and that is all it says — whether you are still sitting in that window
 * is not written down anywhere. Treat that as `waiting` throughout and every
 * finished conversation nags forever; drop it the moment the nudge expires and
 * the session you are sitting there reading loses its pet, and its name with it.
 *
 * So a quiet session goes `resting`: still yours, still named, no longer
 * shouting. It only stops being a session when the transcript goes stale.
 */
const RESTING_MS = 30 * 60 * 1000;

/*
 * The mtime prefilter. It only has to be generous enough not to exclude a
 * session that is still resting: mtime is always at or after the last real
 * entry, so anything whose mtime is already older than RESTING_MS has content
 * older than that too, and the timestamps decide the rest.
 */
const STALE_MS = RESTING_MS;

/* a turn nobody has advanced in this long has been abandoned, not stalled */
const MID_TURN_MS = 60 * 1000;

/* the tail window: enough for the last few turns of any transcript */
const TAIL_BYTES = 64 * 1024;

/*
 * A session's title is written once, when Claude Code names the conversation,
 * which for a long session is far outside the tail window. It is worth one
 * bounded read of the head to find — and only one, because the tail cache below
 * keeps the answer.
 */
const HEAD_BYTES = 128 * 1024;

/* line types that carry no timestamp and are not conversation activity */
const BOOKKEEPING = new Set([
  'last-prompt', 'ai-title', 'custom-title', 'mode', 'permission-mode', 'summary',
]);

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
    // file -> { mtimeMs, size, info }: a transcript that has not changed since
    // the last poll cannot have a different tail, so re-reading it is waste.
    // This is what makes it affordable to read every candidate's real activity
    // time before deciding which eight sessions get a pet.
    this.tails = new Map();
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
    const seen = new Set();
    const candidates = [];

    for (const f of files) {
      seen.add(f.file);
      const tail = this.tailInfo(f.file, f);
      /*
       * mtime is not evidence of a conversation. Claude Code rewrites a
       * transcript to record a generated title, the last prompt and the current
       * mode long after the exchange ended, and each of those writes moves the
       * mtime. On a machine with a few hundred conversations that surfaced pets
       * for sessions whose real last message was days old. The timestamps on the
       * entries themselves cannot be moved that way; mtime is only the fallback
       * for transcripts too old to carry any.
       */
      candidates.push({ file: f.file, tail, activityAt: tail.lastActivity || f.mtime });
    }

    // whatever we did not see this time has aged out of the scan entirely
    for (const file of this.tails.keys()) if (!seen.has(file)) this.tails.delete(file);

    candidates.sort((a, b) => b.activityAt - a.activityAt);

    const sessions = [];
    for (const c of candidates) {
      if (sessions.length >= MAX_SESSIONS) break;
      const state = this.stateFor(c, now);
      if (!state) continue;
      const session = {
        id: path.basename(c.file, '.jsonl'),
        state,
        cwd: c.tail.cwd || null,
      };
      // older transcripts record none of these; consumers must cope with absence
      if (c.tail.title) session.title = c.tail.title;
      if (c.tail.entrypoint) session.entrypoint = c.tail.entrypoint;
      if (c.tail.permissionMode) session.permissionMode = c.tail.permissionMode;
      sessions.push(session);
    }

    const anyActive = sessions.some((s) => s.state === 'thinking' || s.state === 'tool');
    const anyWaiting = sessions.some((s) => s.state === 'waiting');
    const state = anyActive ? 'working' : anyWaiting ? 'needs-you' : sessions.length ? 'idle' : null;
    this.emit({ state, sessions });
  }

  /*
   * The live state of one candidate, or null when it does not deserve a pet.
   * Kept apart from poll() because this is the whole judgement: everything else
   * there is reading files and sorting.
   */
  stateFor({ file, tail, activityAt }, now) {
    const age = now - activityAt;

    if (age < ACTIVE_MS) {
      this.wasActive.add(file);
      return tail.toolUse ? 'tool' : 'thinking';
    }

    if (tail.role === 'assistant') {
      if (this.wasActive.has(file)) {
        this.wasActive.delete(file);
        this.doneUntil.set(file, now + DONE_SHOW_MS);
        if (this.onDone) this.onDone();
      }
      if ((this.doneUntil.get(file) || 0) > now) return 'done';
      // the turn is over: nudge while that is still news, then settle down
      if (age < WAITING_MS) return 'waiting';
      return age < RESTING_MS ? 'resting' : null;
    }

    // stalled mid-turn: a tool call still running, or a session walked away from
    return age < MID_TURN_MS ? 'thinking' : null;
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
          // a cheap prefilter only: a transcript nobody has written to at all
          // cannot have become active. What the writes meant is decided later,
          // from the timestamps inside.
          if (now - st.mtimeMs < STALE_MS) {
            out.push({ file, mtime: st.mtimeMs, size: st.size });
          }
        } catch { /* transcript vanished mid-scan */ }
      }
    }
    return out;
  }

  /* read `bytes` from the end (or the start, with from: 'head') of a file */
  static slice(file, size, bytes, from) {
    const len = Math.min(bytes, size);
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, from === 'head' ? 0 : size - len);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf8');
  }

  // What the tail of the transcript says about the session, from one read —
  // cached until the file changes, so a poll over a few hundred transcripts
  // costs reads only for the ones that actually moved.
  tailInfo(file, stat) {
    const hit = this.tails.get(file);
    if (hit && hit.mtimeMs === stat.mtime && hit.size === stat.size) return hit.info;

    const info = {
      role: null, toolUse: false, cwd: null, title: null,
      entrypoint: null, permissionMode: null, lastActivity: null,
    };
    let aiTitle = null;
    try {
      this.scan(ClaudeWatcher.slice(file, stat.size, TAIL_BYTES), info, (t, j) => {
        if (t === 'custom-title' && !info.title) info.title = j.customTitle;
        if (t === 'ai-title' && !aiTitle) aiTitle = j.aiTitle;
      });
      /*
       * A title is written once and never again, so on any long-running session
       * it sits far above the tail window. One bounded read of the head finds
       * it; the cache above means this happens once per session, not per poll.
       */
      if (!info.title && !aiTitle && stat.size > TAIL_BYTES) {
        this.scan(ClaudeWatcher.slice(file, stat.size, HEAD_BYTES, 'head'), null, (t, j) => {
          if (t === 'custom-title' && !info.title) info.title = j.customTitle;
          if (t === 'ai-title' && !aiTitle) aiTitle = j.aiTitle;
        });
      }
    } catch { /* unreadable — treat as unknown */ }
    // a name the user typed outranks one Claude Code generated
    if (!info.title && aiTitle) info.title = aiTitle;
    if (typeof info.title === 'string') info.title = info.title.trim() || null;

    this.tails.set(file, { mtimeMs: stat.mtime, size: stat.size, info });
    return info;
  }

  /*
   * Walk a chunk of transcript newest line first, filling `info` and handing
   * every line to `onLine`. entrypoint, permissionMode and cwd need not share a
   * line with role, so the walk only stops once every field is known.
   */
  scan(chunk, info, onLine) {
    const lines = chunk.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let j;
      try { j = JSON.parse(lines[i]); } catch { continue; /* partial line at the cut */ }
      const type = j.type;
      if (onLine) onLine(type, j);
      if (!info) continue;

      if (!info.cwd && j.cwd) info.cwd = j.cwd;
      if (!info.entrypoint && typeof j.entrypoint === 'string') info.entrypoint = j.entrypoint;
      if (!info.permissionMode && typeof j.permissionMode === 'string') {
        info.permissionMode = j.permissionMode;
      }
      /*
       * The newest timestamp in the file is when the conversation last actually
       * moved. Bookkeeping lines carry none, which is exactly why they must not
       * be allowed to stand in for activity.
       */
      if (!info.lastActivity && !BOOKKEEPING.has(type) && typeof j.timestamp === 'string') {
        const t = Date.parse(j.timestamp);
        if (!Number.isNaN(t)) info.lastActivity = t;
      }
      if (!info.role) {
        const role = type || (j.message && j.message.role);
        if (role === 'assistant' || role === 'user' || role === 'human') {
          info.role = role === 'human' ? 'user' : role;
          const content = j.message && j.message.content;
          info.toolUse = Array.isArray(content) && content.some((c) => c && c.type === 'tool_use');
        }
      }
      if (info.role && info.cwd && info.entrypoint && info.permissionMode && info.lastActivity) {
        break;
      }
    }
  }
}

module.exports = { ClaudeWatcher, WAITING_MS, RESTING_MS };

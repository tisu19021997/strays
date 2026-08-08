/*
 * Token usage tracker — Heisenbug's day job.
 *
 * Tails ~/.claude/projects transcripts and aggregates today's token usage
 * (assistant entries carry message.usage). Reads incrementally via per-file
 * byte offsets, dedupes by message id (streaming can rewrite an entry), and
 * estimates cost from a small pricing map. Everything stays on your machine.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const POLL_MS = 30 * 1000;

// $ per MTok [input, output]; cache read ≈ 0.1x input, cache write ≈ 1.25x input.
// Estimates only — matched by id prefix so date-suffixed ids still hit.
const PRICES = [
  ['claude-fable-5', 10, 50], ['claude-mythos-5', 10, 50],
  ['claude-opus-5', 5, 25], ['claude-opus-4', 5, 25],
  ['claude-sonnet-5', 3, 15], ['claude-sonnet-4', 3, 15],
  ['claude-haiku-4-5', 1, 5], ['claude-haiku', 1, 5],
];

function priceFor(model) {
  const hit = PRICES.find(([prefix]) => String(model || '').startsWith(prefix));
  return hit ? { input: hit[1], output: hit[2] } : null;
}

class UsageTracker {
  constructor(onUsage) {
    this.onUsage = onUsage;
    this.timer = null;
    this.offsets = new Map();   // file -> bytes consumed
    this.byMsg = new Map();     // message id -> usage snapshot (dedupe)
    this.buckets = new Map();   // minute epoch -> output tokens (burn rate)
    this.day = this.todayKey();
    this.lastEmit = '';
  }

  todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  }

  start() {
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.poll();
  }

  stop() {
    clearInterval(this.timer);
  }

  poll() {
    // midnight: the meter resets, the fish forgets
    if (this.todayKey() !== this.day) {
      this.day = this.todayKey();
      this.offsets.clear();
      this.byMsg.clear();
      this.buckets.clear();
    }

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    let files = [];
    try {
      for (const proj of fs.readdirSync(PROJECTS_DIR)) {
        const dir = path.join(PROJECTS_DIR, proj);
        let entries;
        try { entries = fs.readdirSync(dir); } catch { continue; }
        for (const e of entries) {
          if (!e.endsWith('.jsonl')) continue;
          const file = path.join(dir, e);
          try {
            const st = fs.statSync(file);
            if (st.mtimeMs >= midnight.getTime()) files.push({ file, size: st.size });
          } catch { /* vanished */ }
        }
      }
    } catch { return; } // no ~/.claude yet

    for (const { file, size } of files) {
      const from = this.offsets.get(file) || 0;
      if (size <= from) continue;
      this.consume(file, from, size, midnight.getTime());
      this.offsets.set(file, size);
    }

    this.emit();
  }

  consume(file, from, to, midnightMs) {
    let text;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(to - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch { return; }

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; /* partial tail line; re-read next poll is fine */ }
      const msg = j.message;
      if (j.type !== 'assistant' || !msg || !msg.usage) continue;
      const ts = j.timestamp ? Date.parse(j.timestamp) : Date.now();
      if (Number.isFinite(ts) && ts < midnightMs) continue;

      const u = msg.usage;
      const snap = {
        model: msg.model || '',
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
      };
      const id = msg.id || (file + ':' + from);
      const prev = this.byMsg.get(id);
      this.byMsg.set(id, snap);

      // burn-rate buckets track fresh output only
      const minute = Math.floor((Number.isFinite(ts) ? ts : Date.now()) / 60000);
      const fresh = Math.max(0, snap.output - (prev ? prev.output : 0));
      if (fresh > 0) this.buckets.set(minute, (this.buckets.get(minute) || 0) + fresh);
    }

    // drop burn buckets older than an hour
    const cutoff = Math.floor(Date.now() / 60000) - 60;
    for (const k of this.buckets.keys()) if (k < cutoff) this.buckets.delete(k);
  }

  stats() {
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0, unpriced: false };
    for (const s of this.byMsg.values()) {
      totals.input += s.input;
      totals.output += s.output;
      totals.cacheRead += s.cacheRead;
      totals.cacheWrite += s.cacheWrite;
      totals.messages++;
      const p = priceFor(s.model);
      if (p) {
        totals.cost +=
          (s.input * p.input + s.output * p.output +
           s.cacheRead * 0.1 * p.input + s.cacheWrite * 1.25 * p.input) / 1e6;
      } else if (s.model) {
        totals.unpriced = true;
      }
    }
    // output tokens in the last 10 minutes -> tokens/min
    const now = Math.floor(Date.now() / 60000);
    let recent = 0;
    for (const [minute, tokens] of this.buckets) if (minute > now - 10) recent += tokens;
    totals.burnPerMin = Math.round(recent / 10);
    return totals;
  }

  emit() {
    const s = this.stats();
    const key = JSON.stringify(s);
    if (key !== this.lastEmit) {
      this.lastEmit = key;
      this.onUsage(s);
    }
  }
}

module.exports = { UsageTracker };

/*
 * Would Claude Code actually stop and ask the user about this tool call?
 *
 * The overlay only earns the right to raise an Allow/Deny card — and to hold
 * the tool call while it waits for a click — when the honest answer is yes.
 * Everything here is pure: a payload and a ruleset in, a verdict out.
 */
const os = require('os');

/* modes in which Claude Code never interrupts the user with a prompt */
const SILENT_MODES = {
  auto: 'auto mode: a classifier vets the call, the user is never asked',
  bypassPermissions: 'bypassPermissions mode: prompts are skipped',
  dontAsk: 'dontAsk mode: unapproved calls are denied, never asked about',
  plan: 'plan mode: edits are blocked and shell work defers to the classifier',
};

/*
 * Modes in which Claude Code can still interrupt the user, and so the only
 * modes worth gating. An unlisted mode is treated as silent on purpose: `auto`
 * shipped in a Claude Code release this project predated, the old fallback for
 * an unknown mode was to gate anyway, and the result was a card plus a 20s hold
 * on every single tool call. A missed card costs one context switch; a false
 * card costs 20 seconds every time. Fail toward silence.
 */
const PROMPTING_MODES = ['default', 'manual', 'acceptEdits'];

/* tools whose whole job is editing a file */
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/* the filesystem commands acceptEdits auto-approves alongside file edits */
const ACCEPT_EDITS_COMMANDS = ['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed'];

/* the leading program of a command line, ignoring arguments */
function leadingProgram(command) {
  const first = String(command || '').trim().split(/\s+/)[0] || '';
  return first.split('/').pop();
}

/* "Bash(git:*)" -> { tool: 'Bash', arg: 'git:*' }; "WebSearch" -> arg null */
function parseRule(rule) {
  const text = String(rule || '').trim();
  const m = /^([A-Za-z_][\w-]*)\((.*)\)$/s.exec(text);
  return m ? { tool: m[1], arg: m[2] } : { tool: text, arg: null };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/*
 * Claude Code's pattern grammar. A trailing `:*` or ` *` is a wildcard with a
 * word boundary in front of it, so `ls *` covers `ls -la` but not `lsof`. A
 * trailing `*` with no space has no boundary. A `*` anywhere else spans any
 * text including spaces, and a colon anywhere but the very end is literal.
 */
function patternToRegex(pattern) {
  let body = pattern;
  let tail = 'exact';
  if (body.endsWith(':*') || body.endsWith(' *')) { body = body.slice(0, -2); tail = 'boundary'; }
  else if (body.endsWith('*')) { body = body.slice(0, -1); tail = 'loose'; }
  const source = body.split('*').map(escapeRegex).join('[\\s\\S]*');
  if (tail === 'boundary') return new RegExp('^' + source + '(?:\\s[\\s\\S]*)?$');
  if (tail === 'loose') return new RegExp('^' + source + '[\\s\\S]*$');
  return new RegExp('^' + source + '$');
}

/*
 * Claude Code is shell-operator aware: a rule has to clear each sub-command on
 * its own, so `Bash(npm:*)` does not smuggle in `&& terraform apply`. Quoted
 * text is not a separator, or `echo "a && b"` would split into nonsense.
 */
const SEPARATORS = ['&&', '||', '|&', ';', '|', '&', '\n'];

function splitCommand(command) {
  const text = String(command || '');
  const parts = [];
  let current = '';
  let quote = null;
  // the previous character as the shell read it: only an unquoted, unescaped
  // one can be half of a redirection operator
  let previous = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && quote !== "'") { current += ch + (text[i + 1] || ''); i++; previous = ''; continue; }
    if (quote) { current += ch; if (ch === quote) quote = null; previous = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; previous = ''; continue; }
    const sep = SEPARATORS.find((s) => text.startsWith(s, i));
    // `2>&1`, `>&2`, `<&3` and `&>` all carry an ampersand that redirects rather
    // than separates. Treating one as a separator invents a sub-command no rule
    // can cover, which is a false card and a held tool call. Judged from the
    // parsed text: `echo hi\>& terraform apply` really does background.
    if (sep === '&' && (text[i + 1] === '>' || previous === '>' || previous === '<')) {
      current += ch;
      previous = ch;
      continue;
    }
    if (sep) { parts.push(current); current = ''; i += sep.length - 1; previous = ''; continue; }
    current += ch;
    previous = ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/*
 * Wrappers Claude Code looks through when matching a rule, with how many of
 * their own arguments come off with them. `bareOnly` marks a wrapper that stops
 * being transparent the moment it takes options: `xargs rm` runs rm, but
 * `xargs -n1 rm` batches the arguments differently.
 */
const WRAPPERS = {
  timeout: { options: true, value: /^\d+(?:\.\d+)?[smhd]?$/ },
  time: { options: true },
  nice: { options: true, value: /^\d+$/ },
  nohup: {},
  stdbuf: { options: true },
  command: {},
  builtin: {},
  noglob: {},
  xargs: { bareOnly: true },
  env: { assignments: true },
};

/*
 * Environment variables that cannot change what a command does, and so may be
 * stripped before an allow rule is matched. Anything outside this list stops
 * the match: FOO=bar in front of a command is part of the command's meaning.
 */
const SAFE_ENV_VARS = [
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_COLLATE', 'LC_CTYPE', 'LC_MESSAGES',
  'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME', 'TZ', 'TERM', 'COLUMNS', 'LINES',
  'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'GIT_PAGER', 'PAGER',
  'CI', 'DEBIAN_FRONTEND',
];

const isSafeAssignment = (token) => {
  const eq = token.indexOf('=');
  return eq > 0 && SAFE_ENV_VARS.includes(token.slice(0, eq));
};

const isAssignment = (token) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);

/*
 * Reduce a sub-command to the command a rule is really about. Returns null when
 * something in the prefix cannot be looked through, which means no allow rule
 * may match: an unknown assignment or a wrapper carrying its own options.
 */
function unwrapCommand(subCommand) {
  let tokens = subCommand.split(/\s+/).filter(Boolean);
  for (let guard = 0; guard < 16 && tokens.length; guard++) {
    if (isAssignment(tokens[0])) {
      if (!isSafeAssignment(tokens[0])) return null;
      tokens = tokens.slice(1);
      continue;
    }
    const spec = WRAPPERS[tokens[0].split('/').pop()];
    if (!spec || tokens.length < 2) break;
    if (spec.bareOnly && tokens[1].startsWith('-')) return null;
    let i = 1;
    if (spec.assignments) while (tokens[i] && isAssignment(tokens[i])) {
      if (!isSafeAssignment(tokens[i])) return null;
      i++;
    }
    if (spec.options) while (tokens[i] && tokens[i].startsWith('-')) i++;
    if (spec.value && tokens[i] && spec.value.test(tokens[i])) i++;
    tokens = tokens.slice(i);
  }
  return tokens.join(' ');
}

/*
 * Programs whose real command is only known at runtime. No prefix rule can
 * prove anything about them, so Claude Code prompts however the rules read.
 */
const UNAPPROVABLE_WRAPPERS = ['watch', 'setsid', 'ionice', 'flock'];

function neverStaticallyApproved(subCommand) {
  const tokens = subCommand.split(/\s+/).filter(Boolean);
  const program = (tokens[0] || '').split('/').pop();
  if (UNAPPROVABLE_WRAPPERS.includes(program)) return true;
  // find only becomes an executor with these flags
  return program === 'find' && tokens.some((t) => t === '-exec' || t === '-execdir' || t === '-delete');
}

/*
 * Claude Code's built-in read-only commands, which never prompt in any mode.
 * Kept as data so a future release can be diffed against it rather than
 * hunted for across conditionals.
 */
const READ_ONLY_COMMANDS = [
  'ls', 'cat', 'pwd', 'grep', 'find', 'head', 'tail', 'wc', 'diff', 'echo',
  'which', 'file', 'stat', 'date',
];

/* read-only only in these sub-commands; `git push` is not an inspection */
const READ_ONLY_SUBCOMMANDS = {
  git: ['log', 'status', 'diff', 'show'],
};

/*
 * A `>` that really redirects: unquoted and unescaped. A regex over the raw text
 * cannot tell one from the `>` in `grep -rn "=>" src`, and calling that a write
 * costs a card and a held tool call on an everyday search of a JS tree.
 */
function hasRedirect(subCommand) {
  const text = String(subCommand || '');
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return true;
  }
  return false;
}

function isReadOnly(subCommand) {
  if (neverStaticallyApproved(subCommand)) return false;
  // a redirect turns an inspection into a write, whatever the program is
  if (hasRedirect(subCommand)) return false;
  const unwrapped = unwrapCommand(subCommand);
  if (unwrapped === null) return false;
  const tokens = unwrapped.split(/\s+/).filter(Boolean);
  const program = (tokens[0] || '').split('/').pop();
  const subs = READ_ONLY_SUBCOMMANDS[program];
  if (subs) return subs.includes(tokens[1]);
  return READ_ONLY_COMMANDS.includes(program);
}

/* the argument of a file tool's call, whatever the tool calls it */
const FILE_PATH_KEYS = ['file_path', 'notebook_path', 'path'];

function targetPath(payload) {
  const input = payload.tool_input || {};
  for (const key of FILE_PATH_KEYS) if (input[key]) return String(input[key]);
  return '';
}

/*
 * Rules are written with forward slashes; Windows hands us backslashes and a
 * drive letter. Everything below matches in the POSIX spelling, so both sides
 * are converted to it before they ever meet.
 *
 * This is load-bearing rather than tidy. A `deny` rule that cannot match is a
 * rule that is not enforced — and because the gate answers PreToolUse with an
 * explicit decision, a card wrongly raised over a denied path lets a click on
 * Allow walk straight past the rule written to prevent it.
 */
const toPosix = (p) => String(p || '').replace(/\\/g, '/');

/* `/abs`, and `C:/abs` — which is the same claim spelled for a lettered drive */
const DRIVE = /^[A-Za-z]:\//;
const isAbsolutePath = (p) => p.startsWith('/') || DRIVE.test(p);

/*
 * `//abs` unwrapped: the first slash is the marker saying "filesystem-absolute",
 * and the rest is the path.
 *
 * On POSIX the path is itself `/…`, so the marker and the path share a slash and
 * dropping one is exactly right. A lettered drive has no leading slash of its
 * own, so dropping one leaves `/C:/…`, which cannot match a file that is always
 * spelled `C:/…`. Every source-anchored rule on Windows was inert that way, and
 * an inert deny is a deny that is not in force.
 */
const fromDoubleSlash = (pattern) => {
  const rest = pattern.slice(2);
  return DRIVE.test(rest) ? rest : '/' + rest;
};

/* gitignore-style: ** spans directories, * stops at one, ? is one character */
function globToRegex(glob, nocase) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may also match nothing at all, so `a/**/b` covers `a/b`
        if (glob[i + 2] === '/') { source += '(?:[\\s\\S]*/)?'; i += 2; }
        else { source += '[\\s\\S]*'; i++; }
      }
      else source += '[^/]*';
      continue;
    }
    if (ch === '?') { source += '[^/]'; continue; }
    source += escapeRegex(ch);
  }
  return new RegExp('^' + source + '$', nocase ? 'i' : '');
}

const joinPath = (dir, rest) => toPosix(dir).replace(/\/+$/, '') + '/' + rest;

/*
 * Claude Code's four path forms. `//abs` is filesystem-absolute, `~/x` is
 * home-relative, and a bare path is relative to the working directory — narrow
 * for an allow rule, matching at any depth for a deny or ask rule, because a
 * secret is a secret wherever it sits. The settings-source-relative form (a
 * single leading slash) is resolved to `//abs` by the loader, which is the only
 * layer that knows which file a rule came from.
 */
function pathPatternMatches(pattern, payload, broad) {
  const file = toPosix(targetPath(payload));
  if (!file) return false;
  const home = toPosix(process.env.HOME || os.homedir());
  const absolute = isAbsolutePath(file) ? file : joinPath(payload.cwd, file);
  /*
   * Windows filenames are case-insensitive, and the case of the drive letter in
   * particular is not stable between what the shell reports and what a rule was
   * written with. The shape of the path is the tell — no platform check needed,
   * which keeps this a pure function the whole matrix can be driven through.
   */
  const nocase = DRIVE.test(absolute);

  let globs;
  if (pattern.startsWith('//')) globs = [fromDoubleSlash(pattern)];
  else if (pattern.startsWith('~/')) globs = [joinPath(home, pattern.slice(2))];
  else if (pattern.startsWith('/')) globs = [pattern];
  else {
    const relative = pattern.replace(/^\.\//, '');
    globs = [joinPath(payload.cwd, relative)];
    if (broad) globs.push('**/' + relative);
  }
  return globs.some((glob) => globToRegex(toPosix(glob), nocase).test(absolute));
}

/* the forms of one sub-command a rule may be written against */
function candidates(subCommand) {
  const unwrapped = unwrapCommand(subCommand);
  return unwrapped && unwrapped !== subCommand ? [subCommand, unwrapped] : [subCommand];
}

/* tools whose rule argument is a path pattern rather than a command pattern */
const FILE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'];

/* does one rule cover this sub-command (or, for other tools, this call)? */
function ruleCovers(rule, payload, forms, broad) {
  const { tool, arg } = parseRule(rule);
  if (tool !== payload.tool_name) return false;
  if (arg === null || arg === '') return true;
  if (tool === 'Bash') {
    const re = patternToRegex(arg);
    return forms.some((form) => re.test(form));
  }
  if (FILE_TOOLS.includes(tool)) return pathPatternMatches(arg, payload, broad);
  return arg === '*';
}

const subCommands = (payload) => splitCommand(payload.tool_input && payload.tool_input.command);

/* deny and ask fire on a single matching sub-command */
function anyRuleMatches(list, payload) {
  const set = list || [];
  if (!set.length) return false;
  if (payload.tool_name !== 'Bash') return set.some((r) => ruleCovers(r, payload, [], true));
  return subCommands(payload)
    .some((sub) => set.some((r) => ruleCovers(r, payload, candidates(sub), true)));
}

/* allow only silences a call when every sub-command is covered */
function allRulesCover(list, payload) {
  const set = list || [];
  if (!set.length) return false;
  if (payload.tool_name !== 'Bash') return set.some((r) => ruleCovers(r, payload, [], false));
  const subs = subCommands(payload);
  return subs.length > 0 && subs.every((sub) => {
    // a read-only sub-command needs no rule of its own, so one inspection step
    // in a pipeline cannot force a card for the whole line
    if (isReadOnly(sub)) return true;
    if (neverStaticallyApproved(sub)) return false;
    // a prefix that cannot be looked through blocks every allow rule
    const unwrapped = unwrapCommand(sub);
    if (unwrapped === null) return false;
    return set.some((r) => ruleCovers(r, payload, [sub, unwrapped], false));
  });
}

/*
 * acceptEdits auto-approves a short list of filesystem commands. Judging that
 * by the leading program of the whole line let `mkdir -p build && terraform
 * apply` pass as "mkdir", hiding a prompt the user was actually blocked on.
 * Every sub-command has to earn it, the same way allow rules are judged.
 */
function acceptEditsCovers(payload) {
  if (payload.tool_name !== 'Bash') return false;
  const subs = subCommands(payload);
  return subs.length > 0 && subs.every((sub) => {
    if (isReadOnly(sub)) return true;
    if (neverStaticallyApproved(sub)) return false;
    const unwrapped = unwrapCommand(sub);
    return unwrapped !== null && ACCEPT_EDITS_COMMANDS.includes(leadingProgram(unwrapped));
  });
}

/**
 * @param {object} payload  PreToolUse hook stdin
 * @param {object} rules    merged { allow, deny, ask }
 * @returns {{prompts: boolean, reason: string}}
 */
function predictPrompt(payload, rules) {
  const mode = payload.permission_mode;
  const set = rules || {};

  // A denied call is refused, not asked about: there is nothing to click.
  if (anyRuleMatches(set.deny, payload)) {
    return { prompts: false, reason: 'a deny rule matches: the call is refused, not asked about' };
  }

  // An ask rule outranks the mode table: forcing a prompt is its whole job, so
  // a silent mode must not be able to switch it off.
  if (anyRuleMatches(set.ask, payload)) {
    return { prompts: true, reason: 'an ask rule matches: Claude Code always asks' };
  }

  if (SILENT_MODES[mode]) return { prompts: false, reason: SILENT_MODES[mode] };

  // Modes we understand well enough to gate. Anything else is deliberately
  // silent — see PROMPTING_MODES' comment; do not "fix" this to gate.
  if (!PROMPTING_MODES.includes(mode)) {
    return { prompts: false, reason: `unrecognised mode ${JSON.stringify(mode)}: staying silent` };
  }

  if (mode === 'acceptEdits') {
    if (EDIT_TOOLS.includes(payload.tool_name)) {
      return { prompts: false, reason: 'acceptEdits mode: file edits are auto-approved' };
    }
    if (acceptEditsCovers(payload)) {
      return { prompts: false, reason: 'acceptEdits mode: every command here is auto-approved' };
    }
  }

  if (allRulesCover(set.allow, payload)) {
    return { prompts: false, reason: 'an allow rule covers this call' };
  }

  if (payload.tool_name === 'Bash') {
    const subs = subCommands(payload);
    if (subs.length > 0 && subs.every(isReadOnly)) {
      return { prompts: false, reason: 'a built-in read-only command: Claude Code never asks' };
    }
  }

  return { prompts: true, reason: `mode ${mode}: Claude Code may prompt` };
}

module.exports = { predictPrompt, parseRule, FILE_TOOLS };

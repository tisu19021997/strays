/*
 * Where the user's permission rules come from.
 *
 * Kept apart from permissions.js on purpose: prediction is pure and this is
 * not. Everything here reads the disk, so everything here also has to survive
 * the disk — a missing file, a half-written file, a file full of nonsense. A
 * settings file the gate cannot parse must cost the user silence, never a
 * crash and never a spurious card.
 */
const fs = require('fs');
const path = require('path');
const { parseRule, FILE_TOOLS } = require('./permissions');

/*
 * Claude Code's scopes, lowest source first. Precedence only decides which
 * scope wins a conflicting *value*; rules themselves are unioned, which is what
 * makes a deny in any scope impossible to override from another scope — the
 * predictor checks deny before it checks anything else.
 */
function scopeFiles(scopes) {
  const { managedPath, userDir, projectDir, localCwd, extraPaths } = scopes || {};
  const files = [];
  if (managedPath) files.push({ file: managedPath, source: path.dirname(managedPath) });
  if (userDir) files.push({ file: path.join(userDir, 'settings.json'), source: userDir });
  if (projectDir) {
    files.push({ file: path.join(projectDir, '.claude', 'settings.json'), source: projectDir });
    files.push({
      file: path.join(projectDir, '.claude', 'settings.local.json'),
      // .local patterns are relative to the cwd the session started in
      source: localCwd || projectDir,
    });
  }
  for (const file of extraPaths || []) files.push({ file, source: path.dirname(file) });
  return files;
}

/* a permissions block, or nothing at all if the file cannot be trusted */
function readPermissions(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return null; }
  try {
    const parsed = JSON.parse(text);
    const permissions = parsed && parsed.permissions;
    return permissions && typeof permissions === 'object' ? permissions : null;
  } catch { return null; }
}

const asList = (value) => (Array.isArray(value) ? value.filter((r) => typeof r === 'string') : []);

/*
 * A path rule with one leading slash is relative to the file it was written in
 * — the project root for project settings, ~/.claude for user settings. The
 * predictor cannot know that, so the pattern is rewritten here into the
 * filesystem-absolute `//` form before it ever reaches evaluation.
 */
function anchorToSource(rule, source) {
  const { tool, arg } = parseRule(rule);
  if (!FILE_TOOLS.includes(tool) || !arg) return rule;
  if (!arg.startsWith('/') || arg.startsWith('//')) return rule;
  return `${tool}(/${path.join(source, arg)})`;
}

/*
 * The gate runs once per tool call, so settings are parsed once per change
 * instead of once per call. A file that is absent contributes a stamp of its
 * own, so a settings file appearing is as visible as one being edited.
 */
const cache = new Map();

const stamp = (file) => {
  try { const s = fs.statSync(file); return s.mtimeMs + ':' + s.size; }
  catch { return 'absent'; }
};

function loadRules(scopes) {
  const files = scopeFiles(scopes);
  // the source is part of the key: the same files anchor differently for a
  // session that started in a different directory
  const key = files.map(({ file, source }) => file + '\0' + source).join('\n');
  const stamps = files.map(({ file }) => stamp(file)).join('\n');

  const cached = cache.get(key);
  if (cached && cached.stamps === stamps) return cached.rules;

  const rules = { allow: [], deny: [], ask: [] };
  for (const { file, source } of files) {
    const permissions = readPermissions(file);
    if (!permissions) continue;
    for (const kind of ['allow', 'deny', 'ask']) {
      rules[kind].push(...asList(permissions[kind]).map((rule) => anchorToSource(rule, source)));
    }
  }
  cache.set(key, { stamps, rules });
  return rules;
}

module.exports = { loadRules };

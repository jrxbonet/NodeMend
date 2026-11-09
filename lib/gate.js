// NodeMend — the single enforcement table (pure Node, no Electron imports)
// main.js's guard() asks actionFor() which action keys an IPC call touches, then decide() for each.
// Renderer hiding is cosmetic; this is the only place a machine-changing call is refused.
//   decide() -> null | 'LICENSE_REQUIRED' | 'POLICY_DENIED:<token>'
const EDITION_ORDER = ['evaluation', 'solo', 'enterprise'];

// license: refused in Free (internally 'evaluation'). policy: may appear in policy.disable (enterprise + feature 'policy').
// feature: enterprise-only IPC family, needs that feature in the key. renderer: token only the UI checks.
const ACTIONS = {
  'clean':           { license: false, policy: true, label: 'Clean selected' },
  'recycle':         { license: false, policy: true, label: 'Empty Recycle Bin' },
  'cleanmgr':        { license: true, policy: true, label: 'Windows Disk Cleanup' },
  'advanced-clean': { license: true, policy: true, label: 'Advanced cleanup categories' },
  'dism-restore':    { license: true,  policy: true, label: 'DISM RestoreHealth' },
  'dism-cleanup':    { license: true,  policy: true, label: 'DISM component cleanup' },
  'sfc':             { license: true,  policy: true, label: 'SFC /scannow' },
  'wu-install':      { license: true,  policy: true, label: 'Install Windows updates' },
  'drivers-install': { license: true,  policy: true, label: 'Install driver updates' },
  'winget-upgrade':  { license: true,  policy: true, label: 'winget upgrade' },
  'uninstall':       { license: true,  policy: true, label: 'Uninstall program' },
  'startup-toggle':  { license: true,  policy: true, label: 'Startup enable/disable' },
  'dup-trash':       { license: true,  policy: true, label: 'Recycle duplicates' },
  'defender':        { license: true,  policy: true, label: 'Defender update/scan' },
  'maintenance':     { license: true,  policy: true, label: 'Windows maintenance' },
  'recovery':        { license: true,  policy: true, label: 'Recover deleted files' },
  'disk-analyze':    { license: true,  policy: true, label: 'Disk analyzer' },
  'privacy':         { license: true,  policy: true, label: 'Privacy cleaning' },
  'performance':     { license: true,  policy: true, label: 'Performance controls' },
  'smart-clean':     { license: true,  policy: true, label: 'Automatic cleaning' },
  'cleaner-lock':    { license: false, policy: true, label: 'Category pinned by policy', implicit: true },
  'user-license':    { license: false, policy: true, label: 'Activate a license' },
  'do-all':          { license: false, policy: true, label: 'Do all the things', renderer: true },
  'quick':           { license: false, policy: true, label: 'Quick maintenance', renderer: true },
  'feature:unattended': { feature: 'unattended', label: 'Unattended mode / scheduling' },
  'feature:report':     { feature: 'report',     label: 'Report directory' },
  'feature:policy':     { feature: 'policy',     label: 'Policy file' },
  'feature:audit':      { feature: 'audit',      label: 'Audit log' }
};
const FREE_CLEANER_CATEGORIES = ['user-temp', 'win-temp', 'thumbs', 'edge', 'chrome', 'brave', 'opera', 'firefox', 'recycle'];
const LICENSE_GATED = Object.keys(ACTIONS).filter(k => ACTIONS[k].license);
const POLICY_TOKENS = Object.keys(ACTIONS).filter(k => ACTIONS[k].policy && !ACTIONS[k].implicit);
const ENTERPRISE_CHANNELS = [['report:', 'report'], ['policy:', 'policy'], ['audit:', 'audit'], ['schedule', 'unattended']];

// Public scripts and their exact param() declarations. PowerShell accepts abbreviated names
// and positional arguments, so argv must be validated before classifying an action.
// schedule.ps1 and performance.ps1 are private, separately guarded IPC implementations.
const READ_ONLY_SCRIPTS = ['sysinfo.ps1', 'diag.ps1', 'drivers.ps1', 'programs.ps1', 'startup.ps1', 'wu-check.ps1'];
const SCRIPT_PARAMS = {
  'sysinfo.ps1': {}, 'drivers.ps1': {}, 'programs.ps1': {}, 'startup.ps1': {}, 'wu-check.ps1': {},
  'diag.ps1': { days: 'int' },
  'cleanmgr.ps1': { drive: 'string' },
  'recyclebin.ps1': { empty: 'switch' },
  'wu-install.ps1': { drivers: 'switch', ids: 'string' },
  'defender.ps1': { action: ['update', 'quickscan'] },
  'uninstall.ps1': { kind: ['registry', 'appx'], id: 'string', silent: 'switch' },
  'startup-toggle.ps1': { name: 'string', hive: ['hkcu:', 'hklm:'], key: ['run', 'run32', 'startupfolder'], enable: 'bool' }
};
function validateScriptArgs(script, args) {
  if (typeof script !== 'string' || !/^[a-z][a-z0-9-]*\.ps1$/i.test(script) ||
      !Object.prototype.hasOwnProperty.call(SCRIPT_PARAMS, script.toLowerCase())) throw new Error('invalid script');
  const name = script.toLowerCase(), schema = SCRIPT_PARAMS[name];
  if (args === undefined) args = [];
  if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 32768 || /[\x00-\x1f\x7f]/.test(arg)))
    throw new Error('invalid script arguments');
  const params = Object.create(null);
  const invalid = () => { throw new Error('invalid script arguments'); };
  for (let i = 0; i < args.length; i++) {
    // ASCII '-' only, full parameter name only; this rejects --%, common parameters,
    // aliases, Unicode switch prefixes, paths, positional data and unknown parameters.
    const match = /^-([a-z]+)(?::(.*))?$/i.exec(args[i]);
    if (!match) invalid();
    const key = match[1].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(schema, key) || Object.prototype.hasOwnProperty.call(params, key)) invalid();
    const type = schema[key];
    let value = match[2];
    if (type === 'switch' && value === undefined) { params[key] = true; continue; }
    if (value === undefined) {
      if (++i >= args.length) invalid();
      value = args[i];
    }
    // Values resembling another named parameter must never be consumed as data by this
    // parser while PowerShell binds them as an action-changing parameter instead.
    if (/^[\-\u2013\u2014\u2015]/.test(value)) invalid();
    if (type === 'switch' || type === 'bool') {
      if (!/^\$(true|false)$/i.test(value)) invalid();
      params[key] = value.toLowerCase() === '$true';
    } else if (type === 'int') {
      if (!/^\d+$/.test(value) || Number(value) > 2147483647) invalid();
      params[key] = Number(value);
    } else if (Array.isArray(type)) {
      if (!type.includes(value.toLowerCase())) invalid();
      params[key] = value.toLowerCase();
    } else params[key] = value;
  }
  if (name === 'startup-toggle.ps1' && ['name', 'hive', 'key', 'enable'].some(key => !Object.prototype.hasOwnProperty.call(params, key))) invalid();
  return { script: name, params };
}
function scriptActions(a, b) {
  const { script: s, params } = validateScriptArgs(a, b);
  if (s === 'cleanmgr.ps1') return ['cleanmgr'];
  if (s === 'uninstall.ps1') return ['uninstall'];
  if (s === 'wu-install.ps1') return [params.drivers ? 'drivers-install' : 'wu-install'];
  if (s === 'defender.ps1') return ['defender'];
  if (s === 'startup-toggle.ps1') return ['startup-toggle'];
  if (s === 'recyclebin.ps1') return params.empty ? ['recycle'] : [];
  if (READ_ONLY_SCRIPTS.includes(s)) return [];
  throw new Error('invalid script: ' + s);
}

// Section 6.3 cleaner lock: allowed = policy.cleaner.on ∪ (default-on categories not in policy.cleaner.off).
// `categories` is main.js's CATEGORIES (only `id` and `on` are read).
function allowedCategories(policy, categories) {
  const c = (policy && policy.cleaner) || {};
  const on = Array.isArray(c.on) ? c.on : [], off = Array.isArray(c.off) ? c.off : [];
  const set = new Set(on);
  for (const cat of categories || []) if (cat && cat.on && !off.includes(cat.id)) set.add(cat.id);
  return set;
}

// Section 4.5. (channel, a, b) = the IPC's meaningful arguments AFTER the task id:
//   clean:run (ids) · task:ps (script, args) · task:exe (kind, args) · ps:json (script, args) ·
//   dup:trash (paths) · license:activate () · report:*/policy:*/audit:*/schedule ().
// policyCtx = { policy, categories }; edition-agnostic (decide() applies the edition).
function actionFor(channel, a, b, policyCtx = {}) {
  const policy = (policyCtx && policyCtx.policy) || {};
  switch (channel) {
    case 'disk:analyze': return ['disk-analyze'];
    case 'privacy:clean': return ['privacy'];
    case 'performance:pause': return ['performance'];
    case 'smart:configure': return ['smart-clean'];
    case 'clean:run': {
      const ids = Array.isArray(a) ? a : [];
      const out = ['clean'];
      if (ids.some(id => !FREE_CLEANER_CATEGORIES.includes(id))) out.push('advanced-clean');
      if (ids.includes('recycle')) out.push('recycle');
      if (policy.cleaner && policy.cleaner.lock === true) {
        const allowed = allowedCategories(policy, policyCtx.categories);
        if (ids.some(id => !allowed.has(id))) out.push('cleaner-lock');
      }
      return out;
    }
    case 'task:ps':
    case 'ps:json': return scriptActions(a, b);
    case 'task:exe': {
      if (a === 'dism-restore' || a === 'dism-cleanup' || a === 'sfc' || a === 'maintenance') return [a];
      if (a === 'winget-all' || a === 'winget-id') return ['winget-upgrade'];
      if (a === 'dism-scan' || a === 'chkdsk') return []; // read-only diagnostic scans
      throw new Error('invalid exe: ' + a);
    }
    case 'dup:trash': return ['dup-trash'];
    case 'recovery:run':
    case 'recovery:launch': return ['recovery'];
    case 'license:activate': return ['user-license'];
    default: {
      const hit = ENTERPRISE_CHANNELS.find(([prefix]) => String(channel).startsWith(prefix));
      return hit ? ['feature:' + hit[1]] : [];
    }
  }
}

// licCtx = { edition: 'evaluation'|'solo'|'enterprise', features: string[], policy: object|null }
function decide(action, licCtx = {}) {
  const edition = EDITION_ORDER.includes(licCtx.edition) ? licCtx.edition : 'evaluation';
  const features = Array.isArray(licCtx.features) ? licCtx.features : [];
  const policy = licCtx.policy || {};
  if (String(action).startsWith('feature:')) return edition === 'enterprise' && features.includes(action.slice(8)) ? null : 'LICENSE_REQUIRED';
  if (LICENSE_GATED.includes(action) && edition === 'evaluation') return 'LICENSE_REQUIRED';
  const policyActive = edition === 'enterprise' && features.includes('policy');
  if (!policyActive) return null;
  if (action === 'cleaner-lock') return 'POLICY_DENIED:cleaner-lock'; // only emitted when an id is outside the pinned set
  const disable = Array.isArray(policy.disable) ? policy.disable : [];
  return disable.includes(action) ? 'POLICY_DENIED:' + action : null;
}

// Section 6.2 schema v1. Returns { ok, error, data }: unknown keys dropped, wrong types -> error and
// data = {} (allow-all) so a typo in the policy can never lock an admin out of the app.
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function validatePolicy(obj) {
  const out = {};
  const bad = k => ({ ok: false, error: `policy: "${k}" has the wrong type`, data: {} });
  if (!isObj(obj)) return { ok: false, error: 'policy: root must be a JSON object', data: {} };
  const strList = k => { const v = obj[k]; if (v == null) return true; if (!Array.isArray(v) || !v.every(s => typeof s === 'string')) return false; out[k] = [...new Set(v.map(s => s.trim()).filter(Boolean))]; return true; };
  const str = (o, k, t) => { const v = o[k]; if (v == null) return true; if (typeof v !== 'string') return false; t[k] = v; return true; };
  const bool = (o, k, t) => { const v = o[k]; if (v == null) return true; if (typeof v !== 'boolean') return false; t[k] = v; return true; };
  const num = (o, k, t) => { const v = o[k]; if (v == null) return true; if (typeof v !== 'number' || !Number.isFinite(v)) return false; t[k] = v; return true; };
  if (obj.version != null) { if (typeof obj.version !== 'number') return bad('version'); out.version = obj.version; }
  if (!str(obj, 'orgName', out)) return bad('orgName');
  if (!str(obj, 'supportText', out)) return bad('supportText');
  if (!strList('hideTabs')) return bad('hideTabs');
  if (!strList('disable')) return bad('disable');
  if (obj.cleaner != null) {
    if (!isObj(obj.cleaner)) return bad('cleaner');
    const c = {};
    for (const k of ['on', 'off']) { const v = obj.cleaner[k]; if (v == null) continue; if (!Array.isArray(v) || !v.every(s => typeof s === 'string')) return bad('cleaner.' + k); c[k] = [...new Set(v)]; }
    if (!bool(obj.cleaner, 'lock', c)) return bad('cleaner.lock');
    out.cleaner = c;
  }
  if (obj.defaults != null) {
    if (!isObj(obj.defaults)) return bad('defaults');
    const d = {};
    if (!num(obj.defaults, 'dupMinSize', d)) return bad('defaults.dupMinSize');
    out.defaults = d;
  }
  if (obj.unattended != null) {
    if (!isObj(obj.unattended)) return bad('unattended');
    const u = {};
    if (!bool(obj.unattended, 'allow', u)) return bad('unattended.allow');
    if (!str(obj.unattended, 'profile', u)) return bad('unattended.profile');
    if (obj.unattended.steps != null) { const v = obj.unattended.steps; if (!Array.isArray(v) || !v.every(s => typeof s === 'string')) return bad('unattended.steps'); u.steps = v.slice(); }
    if (!num(obj.unattended, 'timeoutMin', u)) return bad('unattended.timeoutMin');
    if (!bool(obj.unattended, 'requireElevation', u)) return bad('unattended.requireElevation');
    out.unattended = u;
  }
  if (!str(obj, 'reportDir', out)) return bad('reportDir');
  if (obj.audit != null) {
    if (!isObj(obj.audit)) return bad('audit');
    const a = {};
    if (!bool(obj.audit, 'eventLog', a)) return bad('audit.eventLog');
    out.audit = a;
  }
  if (!bool(obj, 'lockLicensePanel', out)) return bad('lockLicensePanel');
  if (!bool(obj, 'allowUserLicense', out)) return bad('allowUserLicense');
  return { ok: true, error: null, data: out };
}

module.exports = { FREE_CLEANER_CATEGORIES, READ_ONLY_SCRIPTS, validateScriptArgs, scriptActions, ACTIONS, EDITION_ORDER, LICENSE_GATED, POLICY_TOKENS, actionFor, decide, allowedCategories, validatePolicy };

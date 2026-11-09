// NodeMend Enterprise — NodeMend.policy.json: discovery, validation, load.
// Pure Node. Everything environment-specific comes in through the injected ctx so the module
// can be exercised without Electron. This file also hosts the small ctx helpers (paths,
// expandEnv, safe) shared by the other enterprise modules: it has no sibling dependencies,
// so requiring it never creates a cycle.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = 'NodeMend.policy.json';
const LEGACY_FILE = 'TidyWin.policy.json';
const PROFILES = ['quick', 'full', 'smoke'];

// ---------------------------------------------------------------- shared ctx helpers
const call = v => (typeof v === 'function' ? v() : v);
const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };
const pad = n => String(n).padStart(2, '0');
function localStamp(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; }
function today(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function expandEnv(p) { return String(p || '').replace(/%([^%]+)%/g, (_, k) => process.env[k] || process.env[k.toUpperCase()] || ''); }

// Normalizes ctx.paths: each entry may be a value or a function (lib/paths.js exports functions).
// Falls back to lib/paths.js (lazy, may not exist yet) and finally to inline defaults.
function paths(ctx) {
  const p = (ctx && ctx.paths) || {};
  const lib = safe(() => require('../lib/paths'));
  const pick = (k, fb) => call(p[k]) || (lib && typeof lib[k] === 'function' ? safe(() => lib[k]()) : null) || fb();
  const fn = (k, fb) => (typeof p[k] === 'function' ? p[k] : (lib && typeof lib[k] === 'function' ? lib[k] : fb));
  return {
    dataDir: pick('dataDir', () => path.join(process.env.ProgramData || 'C:\\ProgramData', 'NodeMend')),
    exeDir: pick('exeDir', () => process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)),
    userDataDir: pick('userDataDir', () => (ctx && ctx.app && ctx.app.getPath ? safe(() => ctx.app.getPath('userData')) : null) || path.join(os.tmpdir(), 'NodeMend')),
    resolveArgPath: fn('resolveArgPath', x => path.resolve(process.env.PORTABLE_EXECUTABLE_DIR || process.cwd(), String(x))),
    stamp: fn('stamp', localStamp)
  };
}

// ---------------------------------------------------------------- schema v1
// 'list' = array of strings (normalized: trimmed, empty dropped, de-duplicated). Unknown keys are ignored.
const SCHEMA = {
  version: 'version', orgName: 'str', supportText: 'str', hideTabs: 'list', disable: 'list',
  cleaner: { on: 'list', off: 'list', lock: 'bool' },
  defaults: { dupMinSize: 'int' },
  unattended: { allow: 'bool', profile: 'profile', steps: 'list', timeoutMin: 'int', requireElevation: 'bool' },
  reportDir: 'str', audit: { eventLog: 'bool' }, lockLicensePanel: 'bool', allowUserLicense: 'bool'
};

function check(v, type, key) {
  const fail = want => { throw new Error(`${key}: expected ${want}`); };
  if (typeof type === 'object') {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) fail('object');
    const out = {};
    for (const [k, t] of Object.entries(type)) if (v[k] !== undefined) out[k] = check(v[k], t, `${key}.${k}`);
    return out;
  }
  switch (type) {
    case 'str': if (typeof v !== 'string') fail('string'); return v;
    case 'bool': if (typeof v !== 'boolean') fail('boolean'); return v;
    case 'int': if (!Number.isInteger(v) || v < 0) fail('non-negative integer'); return v;
    case 'version': if (v !== 1) fail('1 (unsupported policy version)'); return v;
    case 'profile': if (!PROFILES.includes(v)) fail(PROFILES.join('|')); return v;
    case 'list': {
      if (!Array.isArray(v) || !v.every(s => typeof s === 'string')) fail('array of strings');
      return [...new Set(v.map(s => s.trim()).filter(Boolean))];
    }
    default: fail(type);
  }
  return v;
}

// validate(obj) -> { ok, error, data }. data is the normalized policy ({} on error, so callers can allow-all).
function validate(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'policy must be a JSON object', data: {} };
  try { return { ok: true, error: null, data: check(obj, SCHEMA, 'policy') }; }
  catch (e) { return { ok: false, error: e.message.replace(/^policy\./, ''), data: {} }; }
}

// ---------------------------------------------------------------- discovery
// Order: --policy > TIDYWIN_POLICY > <dataDir>\NodeMend.policy.json > <exeDir>\NodeMend.policy.json. First found wins.
const READ_TIMEOUT_MS = 3000;
function withTimeout(pr, ms) {
  let t; const to = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms); });
  return Promise.race([pr, to]).finally(() => clearTimeout(t));
}
// Every candidate is read in parallel and raced against a 3 s timeout, like license discovery,
// so a --policy on an unreachable UNC path can never stall startup or a reload.
async function discover(ctx) {
  const P = paths(ctx);
  const cli = (ctx && ctx.cli) || {};
  const out = [];
  if (cli.policy) out.push({ source: 'cli', path: P.resolveArgPath(expandEnv(cli.policy)) });
  const explicit = process.env.NODEMEND_POLICY || process.env.TIDYWIN_POLICY;
  if (explicit) out.push({ source: 'env', path: P.resolveArgPath(expandEnv(explicit)) });
  for (const [source, directory] of [['programdata', P.dataDir], ['exe', P.exeDir]]) {
    out.push({ source, path: path.join(directory, FILE) });
    out.push({ source, path: path.join(directory, LEGACY_FILE) });
  }
  await Promise.all(out.map(async c => {
    try { c.text = String(await withTimeout(fs.promises.readFile(c.path, 'utf8'), (ctx && ctx.timeoutMs) || READ_TIMEOUT_MS)); c.found = true; }
    catch (e) { c.found = false; c.timeout = !!(e && e.code === 'TIMEOUT'); }
  }));
  return out;
}

// Enforcement needs an enterprise edition with the 'policy' feature; otherwise the file is only displayed.
function enforced(ctx) {
  const lic = safe(() => ctx.getLicenseState && ctx.getLicenseState()) || {};
  return lic.edition === 'enterprise' && Array.isArray(lic.features) && lic.features.includes('policy');
}

// load(ctx) -> { path, source, found, ok, error, data, enforced, candidates }
// Invalid JSON/schema -> ok:false, data:{} (allow-all); the error is surfaced by the License tab.
async function load(ctx) {
  const candidates = await discover(ctx);
  const enf = enforced(ctx);
  const log = line => safe(() => ctx.log && ctx.log(line));
  const strip = cs => cs.map(({ text, ...c }) => c);
  // An explicitly named policy (--policy / TIDYWIN_POLICY) that cannot be read is an error, never a
  // silent fall-through to a different (or no) policy: unattended exits 4, the License tab shows it.
  const explicit = candidates.find(c => c.source === 'cli' || c.source === 'env');
  if (explicit && !explicit.found) {
    const error = explicit.timeout ? `policy file unreachable (timed out): ${explicit.path}` : `policy file not found or unreadable: ${explicit.path}`;
    log(`policy error (${explicit.path}): ${error}`);
    return { path: explicit.path, source: explicit.source, found: false, ok: false, error, data: {}, enforced: enf, candidates: strip(candidates) };
  }
  const hit = candidates.find(c => c.found) || candidates.find(c => c.timeout);
  if (!hit) return { path: null, source: null, found: false, ok: true, error: null, data: {}, enforced: enf, candidates: strip(candidates) };
  let res;
  if (hit.timeout) res = { ok: false, error: 'cannot read policy: unreachable (timed out)', data: {} };
  else { try { res = validate(JSON.parse(hit.text.replace(/^\uFEFF/, ''))); } catch (e) { res = { ok: false, error: `cannot read policy: ${e.message}`, data: {} }; } }
  if (!res.ok) log(`policy error (${hit.path}): ${res.error}`);
  else if (!enf) log(`policy ignored (edition): ${hit.path}`);
  return { path: hit.path, source: hit.source, found: true, ...res, enforced: enf, candidates: strip(candidates) };
}

// The policy that actually applies: loaded data when enforced, else {} (allow-all).
function effective(ctx) {
  const p = safe(() => ctx.getPolicy && ctx.getPolicy());
  if (!p || !p.ok || !p.data) return {};
  return (p.enforced !== undefined ? p.enforced : enforced(ctx)) ? p.data : {};
}

module.exports = { FILE, PROFILES, SCHEMA, validate, discover, load, effective, enforced,
  helpers: { paths, call, safe, expandEnv, localStamp, today } };

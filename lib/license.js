// TidyWin — license discovery, selection and edition model (pure Node, no Electron imports)
// Everything here takes an injected ctx so main.js and the tests share one implementation:
//   ctx = { argv, env, exeDir, dataDir, userDataDir, today, builtAt, keys, readFile, isPackaged,
//           timeoutMs, policy, elevated }
// `readFile(path)` is async (main.js passes fs.promises.readFile); every candidate read is raced
// against a timeout so an unplugged UNC drive or a dead thumb drive can never block startup.
const os = require('os');
const path = require('path');
const codec = require('./license-codec');
const { resolveArgPath } = require('./paths');

const ALL_FEATURES = codec.FEATURES.slice();
const RANK = { solo: 1, enterprise: 2 };
const LICENSE_URL = 'https://bohadashtech.com/tidywin'; // placeholder until the store page exists
const LIC_FILE = 'TidyWin.lic';
const FILE_SOURCES = ['exe', 'programdata', 'userdata'];
const READ_TIMEOUT_MS = 3000;

// `--name=value` or `--name value` (Electron's own switches are simply skipped over).
function argValue(argv, name) {
  const a = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < a.length; i++) {
    const s = String(a[i]);
    if (s === name) return i + 1 < a.length ? String(a[i + 1]) : '';
    if (s.startsWith(name + '=')) return s.slice(name.length + 1);
  }
  return undefined;
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// cli / env values are either a token (anything normalize() accepts) or a path to a .lic file.
function explicit(source, value, ctx) {
  const v = value == null ? '' : String(value);
  if (!v.trim()) return { source, path: null, found: false, status: 'none' };
  if (codec.looksLikeToken(v)) return { source, path: null, inline: true, text: v };
  return { source, path: resolveArgPath(v, { env: ctx.env || {} }) };
}

function applyVerify(c, text, ctx) {
  const r = codec.verifyToken(text, { keys: ctx.keys, today: ctx.today, builtAt: ctx.builtAt });
  c.found = true;
  c.status = r.status;
  c.detail = r.detail || null;
  c.warnings = r.warnings || [];
  c.payload = r.payload || null;
  c.edition = r.payload ? r.payload.edition : null;
  c.id = r.payload ? r.payload.id : null;
  c.expires = r.payload ? (r.payload.expires || null) : null;
  return c;
}

async function fill(c, ctx) {
  if (c.inline) return applyVerify(c, c.text, ctx);
  if (!c.path) { c.found = false; c.status = c.status || 'none'; return c; }
  const read = typeof ctx.readFile === 'function' ? ctx.readFile : (() => Promise.reject(new Error('no readFile')));
  try {
    const text = await withTimeout(Promise.resolve().then(() => read(c.path, 'utf8')), ctx.timeoutMs || READ_TIMEOUT_MS);
    return applyVerify(c, String(text), ctx);
  } catch (e) {
    c.found = false;
    c.status = e && e.code === 'TIMEOUT' ? 'timeout' : 'missing';
    return c;
  }
}

// Section 3.1: the five candidates, read in parallel, each verified. Order is precedence order.
async function discover(ctx = {}) {
  const env = ctx.env || {};
  const cands = [
    explicit('cli', argValue(ctx.argv, '--license'), ctx),
    explicit('env', env.TIDYWIN_LICENSE, ctx),
    { source: 'exe', path: ctx.exeDir ? path.join(ctx.exeDir, LIC_FILE) : null },
    { source: 'programdata', path: ctx.dataDir ? path.join(ctx.dataDir, LIC_FILE) : null },
    { source: 'userdata', path: ctx.userDataDir ? path.join(ctx.userDataDir, LIC_FILE) : null }
  ];
  await Promise.all(cands.map(c => fill(c, ctx)));
  return cands;
}

// What license:state / the License tab shows per candidate (payload and token stay in main).
function summarize(c) {
  return { source: c.source, path: c.path, found: !!c.found, status: c.status || 'none', edition: c.edition || null, id: c.id || null, expires: c.expires || null,
    maint: (c.payload && c.payload.maint) || null, ignored: !!c.ignored };
}

function licenseOf(c) {
  const p = c.payload;
  return { id: p.id, edition: p.edition, licensee: p.licensee, email: p.email || null, seats: p.seats, issued: p.issued, expires: p.expires || null,
    maint: p.maint || null, features: p.features || null, brand: p.brand || null, notes: p.notes || null, source: c.source, path: c.path };
}

// Section 3.2. Returns { edition: 'evaluation'|key edition, status, warnings, license, chosen, candidates }.
// `edition` here is the KEY's edition; effectiveEdition() caps it by the build.
function resolve(candidates, ctx = {}) {
  const allowUser = !(ctx.policy && ctx.policy.allowUserLicense === false);
  const cands = candidates.map(c => (c.source === 'userdata' && !allowUser) ? { ...c, ignored: true } : c);
  const usable = cands.filter(c => !c.ignored);
  let chosen = usable.find(c => c.source === 'cli' && c.status === 'valid') || usable.find(c => c.source === 'env' && c.status === 'valid') || null;
  if (!chosen) {
    const files = usable.filter(c => FILE_SOURCES.includes(c.source) && c.status === 'valid');
    files.sort((x, y) => (RANK[y.edition] || 0) - (RANK[x.edition] || 0)); // stable: ties keep table order
    chosen = files[0] || null;
  }
  const summary = cands.map(summarize);
  if (chosen) return { edition: chosen.edition, status: 'valid', warnings: chosen.warnings.slice(), license: licenseOf(chosen), chosen, candidates: summary };
  const first = usable.find(c => c.found || c.status === 'timeout') || null;
  return { edition: 'evaluation', status: first ? first.status : 'none', warnings: first && first.warnings ? first.warnings.slice() : [], license: null, chosen: null, candidates: summary,
    detail: first && first.detail ? first.detail : null, statusOf: first ? summarize(first) : null };
}

// Section 4.2: min(build, key). `lic` is the resolved license (or payload) or null.
function effectiveEdition(build, lic) {
  const b = build === 'enterprise' ? 'enterprise' : 'solo';
  if (!lic || !RANK[lic.edition]) return { edition: 'evaluation', features: [], warnings: [] };
  const warnings = [];
  let edition = lic.edition;
  if (RANK[lic.edition] > RANK[b]) { edition = b; warnings.push('enterprise-key-in-solo-build'); }
  if (b === 'enterprise' && lic.edition === 'solo') warnings.push('solo-key-in-enterprise-build');
  const features = edition === 'enterprise' ? (Array.isArray(lic.features) ? lic.features.slice() : ALL_FEATURES.slice()) : [];
  return { edition, features, warnings };
}

// Section 3.3: where license:activate may write, and which scope the UI offers by default.
function writeTargets(ctx = {}) {
  const env = ctx.env || {};
  const targets = {
    exe: ctx.exeDir ? path.join(ctx.exeDir, LIC_FILE) : null,
    machine: ctx.dataDir ? path.join(ctx.dataDir, LIC_FILE) : null,
    user: ctx.userDataDir ? path.join(ctx.userDataDir, LIC_FILE) : null
  };
  targets.default = env.PORTABLE_EXECUTABLE_DIR ? 'exe' : (ctx.elevated ? 'machine' : 'user');
  return targets;
}

// Section 3.4: the record main.js writes to <dataDir>\activation.json on first licensed start.
function activationRecord(license, ctx = {}) {
  let user = ctx.user;
  if (!user) { try { user = os.userInfo().username; } catch { user = process.env.USERNAME || null; } }
  return {
    licenseId: license.id, edition: license.edition, licensee: license.licensee, seats: license.seats,
    hostname: ctx.hostname || os.hostname(), user,
    activatedAt: (ctx.now instanceof Date ? ctx.now : new Date()).toISOString(),
    appVersion: ctx.appVersion || null, buildEdition: ctx.buildEdition || null
  };
}

module.exports = { ALL_FEATURES, RANK, LICENSE_URL, LIC_FILE, FILE_SOURCES, READ_TIMEOUT_MS, argValue, discover, resolve, effectiveEdition, writeTargets, activationRecord, summarize };

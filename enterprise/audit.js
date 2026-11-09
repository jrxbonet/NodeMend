// NodeMend Enterprise — audit log: one JSON object per line in <dataDir>\audit\<yyyy-MM>.jsonl
// (userData\audit fallback when ProgramData is not writable), 12-month rotation and an optional
// Application event-log mirror through eventcreate.exe. Nothing here ever throws: an audit
// failure must never block the action being audited.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { helpers } = require('./policy');
const { paths, safe } = helpers;

const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const KEEP_MONTHS = 12;
// eventcreate IDs (valid range 1-1000). 'start', 'license-*' and 'policy-load' are file-only.
const EVENT_IDS = { 'run-start': 101, 'run-end': 102, done: 110, 'denied-policy': 120, 'denied-license': 130, 'report-queued': 140 };

let dirCache = null;      // resolved audit directory (first writable of dataDir/userData)
let elevCache = null;     // isElevated() spawns net.exe; ask once per process

function enabled(ctx) {
  const lic = safe(() => ctx.getLicenseState && ctx.getLicenseState()) || {};
  return lic.edition === 'enterprise' && Array.isArray(lic.features) && lic.features.includes('audit');
}

function elevated(ctx) {
  if (typeof ctx.elevated === 'boolean') return ctx.elevated;
  if (elevCache === null) elevCache = !!safe(() => ctx.isElevated && ctx.isElevated(), false);
  return elevCache;
}

// Directory in use; created on first call. Falls back to userData when ProgramData is read-only.
function dir(ctx) {
  if (dirCache) return dirCache;
  const P = paths(ctx);
  for (const base of [P.dataDir, P.userDataDir]) {
    const d = path.join(base, 'audit');
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); dirCache = d; return d; } catch { /* try next */ }
  }
  return path.join(P.dataDir, 'audit'); // nothing writable: writes will fail silently
}

function monthName(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function file(ctx) { return path.join(dir(ctx), monthName() + '.jsonl'); }
const newOpId = () => crypto.randomBytes(4).toString('hex');

// write(ctx, event, { opId, action, target, result, secs, reason }) -> opId (always, even when disabled)
function write(ctx, event, f = {}) {
  const opId = f.opId || newOpId();
  try {
    if (!enabled(ctx)) return opId;
    const lic = safe(() => ctx.getLicenseState()) || {};
    const result = f.result !== undefined ? f.result : (f.reason ? { ok: false, error: String(f.reason) } : null);
    const line = {
      ts: new Date().toISOString(), opId,
      host: ctx.hostname || os.hostname(), user: ctx.user || safe(() => os.userInfo().username, ''), elevated: elevated(ctx),
      mode: ctx.mode || (ctx.cli && ctx.cli.unattended ? 'unattended' : 'gui'),
      edition: lic.edition || null, licenseId: (lic.license && lic.license.id) || null,
      event, action: f.action !== undefined ? f.action : null, target: f.target !== undefined ? f.target : null,
      result, secs: typeof f.secs === 'number' ? f.secs : null
    };
    fs.appendFileSync(file(ctx), JSON.stringify(line) + '\n');
    mirror(ctx, line);
  } catch { /* never block the action */ }
  return opId;
}

// Event-log mirror (policy audit.eventLog === true). Fire-and-forget; eventcreate needs an
// elevated token to register the 'NodeMend' source the first time, so failures are simply dropped.
function mirror(ctx, line) {
  try {
    const pol = safe(() => require('./policy').effective(ctx)) || {};
    if (!pol.audit || pol.audit.eventLog !== true) return;
    let key = line.event;
    if (key === 'denied') key = /^LICENSE_REQUIRED/.test((line.result && line.result.error) || '') ? 'denied-license' : 'denied-policy';
    const id = EVENT_IDS[key];
    if (!id) return;
    const failed = line.result && (line.result.ok === false || line.result.error);
    const type = (id >= 120 || failed) ? 'WARNING' : 'INFORMATION';
    const compact = [`NodeMend ${line.event}`, line.action && `action=${line.action}`, line.target != null && `target=${JSON.stringify(line.target)}`,
      line.result && `result=${JSON.stringify(line.result)}`, line.licenseId && `license=${line.licenseId}`, `user=${line.user}`, `mode=${line.mode}`, `opId=${line.opId}`]
      .filter(Boolean).join(' ').slice(0, 1000);
    const p = spawn(path.join(SYS32, 'eventcreate.exe'), ['/L', 'APPLICATION', '/SO', 'NodeMend', '/T', type, '/ID', String(id), '/D', compact], { windowsHide: true, stdio: 'ignore' });
    p.on('error', () => { /* ignore */ });
    p.unref();
  } catch { /* ignore */ }
}

// Delete <yyyy-MM>.jsonl files older than 12 months. Returns the deleted file names.
function rotate(ctx) {
  const deleted = [];
  try {
    const d = dir(ctx);
    const cut = new Date(); cut.setMonth(cut.getMonth() - KEEP_MONTHS);
    const cutoff = monthName(cut);
    for (const n of fs.readdirSync(d)) {
      const m = /^(\d{4}-\d{2})\.jsonl$/.exec(n);
      if (m && m[1] < cutoff) { try { fs.unlinkSync(path.join(d, n)); deleted.push(n); } catch { /* in use */ } }
    }
  } catch { /* no dir yet */ }
  return deleted;
}

// Last n lines of the current month (or the newest file when this month has none). Never throws.
function tail(ctx, n = 20) {
  const out = { path: file(ctx), dir: dir(ctx), lines: [] };
  try {
    let f = out.path;
    if (!fs.existsSync(f)) {
      const all = fs.readdirSync(out.dir).filter(x => /^\d{4}-\d{2}\.jsonl$/.test(x)).sort();
      if (!all.length) return out;
      f = path.join(out.dir, all[all.length - 1]);
    }
    const size = fs.statSync(f).size, want = Math.min(size, 64 * 1024);
    const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(want);
    try { fs.readSync(fd, buf, 0, want, size - want); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n').filter(l => l.startsWith('{'));
    out.lines = lines.slice(-n);
  } catch { /* unreadable */ }
  return out;
}

module.exports = { EVENT_IDS, KEEP_MONTHS, enabled, dir, file, write, rotate, tail, newOpId };

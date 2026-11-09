// NodeMend Enterprise — report sink. Every run writes a local copy under <dataDir>\reports; when a
// report directory is configured (--report-dir > policy.reportDir > settings.reportDir >
// <PORTABLE_EXECUTABLE_DIR>\reports) the JSON/MD pair also goes to <reportDir>\<HOST>\, plus
// <reportDir>\_latest\<HOST>.json and <reportDir>\_activations\<HOST>.json. Any failure on the
// remote side queues the pair in <dataDir>\outbox, which flush() retries at every app start.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { helpers } = require('./policy');
const { paths, safe, expandEnv } = helpers;

const REMOTE_TIMEOUT_MS = 20000;  // a dead UNC path can block for a long time; the GUI must not
const KEEP_DAYS = 90;             // outbox items older than this are dropped by flush()
let lastSent = null;              // ISO time of the last successful remote write in this process

function withTimeout(promise, ms, what) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

// Atomic write: tmp file + rename (rename replaces an existing file on Windows).
function writeAtomic(file, text) { fs.writeFileSync(file + '.tmp', text, 'utf8'); fs.renameSync(file + '.tmp', file); return file; }
async function writeAtomicAsync(file, text) { await fsp.writeFile(file + '.tmp', text, 'utf8'); await fsp.rename(file + '.tmp', file); return file; }

const cleanName = s => String(s || 'manual').replace(/[^\w.-]+/g, '_').slice(0, 40);
const hostOf = ctx => (ctx && ctx.hostname) || os.hostname();

// resolveDir(ctx) -> { dir, source: 'cli'|'policy'|'settings'|'portable'|null, fixed }
// fixed = the License tab must not offer to edit it (cli/policy own it).
function resolveDir(ctx) {
  const P = paths(ctx);
  const cli = (ctx && ctx.cli) || {};
  const pol = safe(() => require('./policy').effective(ctx)) || {};
  const settings = safe(() => ctx.getSettings && ctx.getSettings()) || {};
  let dir = null, source = null;
  if (cli.reportDir) { dir = P.resolveArgPath(expandEnv(cli.reportDir)); source = 'cli'; }
  else if (pol.reportDir) { dir = expandEnv(pol.reportDir); source = 'policy'; }
  else if (settings.reportDir) { dir = expandEnv(settings.reportDir); source = 'settings'; }
  else if (process.env.PORTABLE_EXECUTABLE_DIR) { dir = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'reports'); source = 'portable'; }
  return { dir: dir || null, source, fixed: source === 'cli' || source === 'policy' };
}

function activationPath(ctx) {
  const P = paths(ctx);
  return [path.join(P.dataDir, 'activation.json'), path.join(P.userDataDir, 'activation.json')].find(p => fs.existsSync(p)) || null;
}
// Local copy and outbox live under %ProgramData%\NodeMend when it is writable (elevated),
// else under userData; same rule as audit.dir(), so an unelevated Enterprise GUI (UAC declined)
// still keeps its local copy and can queue reports for an unreachable share.
const dirCache = {};
function subDir(ctx, sub, create) {
  if (dirCache[sub]) return dirCache[sub];
  const P = paths(ctx);
  for (const base of [P.dataDir, P.userDataDir]) {
    const d = path.join(base, sub);
    try {
      if (create) { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); dirCache[sub] = d; return d; }
      if (fs.existsSync(d)) return d;              // peek only (status/license:state): never create
    } catch { /* try next */ }
  }
  return path.join(P.dataDir, sub);
}
const localDir = (ctx, create = true) => subDir(ctx, 'reports', create);
const outboxDir = (ctx, create = true) => subDir(ctx, 'outbox', create);

// Step 2 of send(): the remote pair, _latest and _activations. Rejects on any error.
async function deliver(ctx, dir, name, jsonText, mdText) {
  const host = hostOf(ctx);
  const hostDir = path.join(dir, host);
  await fsp.mkdir(hostDir, { recursive: true });
  const written = [await writeAtomicAsync(path.join(hostDir, name + '.json'), jsonText), await writeAtomicAsync(path.join(hostDir, name + '.md'), mdText)];
  const latest = path.join(dir, '_latest');
  await fsp.mkdir(latest, { recursive: true });
  written.push(await writeAtomicAsync(path.join(latest, host + '.json'), jsonText));
  const act = activationPath(ctx);
  if (act) {
    const actDir = path.join(dir, '_activations');
    await fsp.mkdir(actDir, { recursive: true });
    written.push(await writeAtomicAsync(path.join(actDir, host + '.json'), await fsp.readFile(act, 'utf8')));
  }
  return written;
}

// send(ctx, { json, md, profile }) -> { configured, dir, written: [paths], queued, error? }
async function send(ctx, { json, md, profile } = {}) {
  const P = paths(ctx);
  const name = `${P.stamp()}-${require('../lib/paths').runId()}-${cleanName(profile)}`;
  const jsonText = typeof json === 'string' ? json : JSON.stringify(json === undefined ? null : json, null, 2);
  const mdText = String(md || '');
  const log = line => safe(() => ctx.log && ctx.log(line));
  const written = [];
  // 1. local copy, always (dataDir already falls back to userData when ProgramData is read-only)
  try {
    const ld = localDir(ctx); fs.mkdirSync(ld, { recursive: true });
    written.push(writeAtomic(path.join(ld, name + '.json'), jsonText), writeAtomic(path.join(ld, name + '.md'), mdText));
  } catch (e) { log(`report: local copy failed: ${e.message}`); }
  // 2. report directory
  const { dir } = resolveDir(ctx);
  if (!dir) return { configured: false, dir: null, written, queued: false };
  try {
    written.push(...await withTimeout(deliver(ctx, dir, name, jsonText, mdText), REMOTE_TIMEOUT_MS, 'report write'));
    lastSent = new Date().toISOString();
    return { configured: true, dir, written, queued: false };
  } catch (e) {
    // 3. outbox
    let queuedTo = null;
    try {
      const ob = outboxDir(ctx); fs.mkdirSync(ob, { recursive: true });
      queuedTo = writeAtomic(path.join(ob, name + '.json'), jsonText); writeAtomic(path.join(ob, name + '.md'), mdText);
      written.push(queuedTo, path.join(ob, name + '.md'));
    } catch (e2) { log(`report: outbox write failed: ${e2.message}`); }
    log(`report: ${dir} unreachable (${e.code || e.message}); queued to outbox`);
    safe(() => require('./audit').write(ctx, 'report-queued', { action: null, target: { dir, file: queuedTo }, result: { ok: false, error: e.code || e.message } }));
    return { configured: true, dir, written, queued: true, error: e.code || e.message };
  }
}

// flush(ctx) -> { flushed, remaining, deleted, dir }. Oldest first; stops at the first delivery
// failure (the share is down, the rest would fail too). Items older than 90 days are dropped.
async function flush(ctx) {
  const { dir } = resolveDir(ctx);
  const out = { flushed: 0, remaining: 0, deleted: 0, dir };
  const ob = outboxDir(ctx);
  let names = [];
  try { names = fs.readdirSync(ob).filter(n => n.endsWith('.json')).sort(); } catch { return out; }
  const cutoff = Date.now() - KEEP_DAYS * 86400e3;
  const log = line => safe(() => ctx.log && ctx.log(line));
  let down = !dir;
  for (const n of names) {
    const jp = path.join(ob, n), mp = jp.slice(0, -5) + '.md';
    const rm = () => { for (const f of [jp, mp]) { try { fs.unlinkSync(f); } catch { /* gone */ } } };
    const st = safe(() => fs.statSync(jp)); if (!st) continue;
    if (st.mtimeMs < cutoff) { rm(); out.deleted++; continue; }
    if (down) { out.remaining++; continue; }
    try {
      const jsonText = fs.readFileSync(jp, 'utf8');
      const mdText = safe(() => fs.readFileSync(mp, 'utf8'), '');
      await withTimeout(deliver(ctx, dir, n.slice(0, -5), jsonText, mdText), REMOTE_TIMEOUT_MS, 'outbox flush');
      rm(); out.flushed++; lastSent = new Date().toISOString();
    } catch (e) { down = true; out.remaining++; log(`report: outbox flush stopped: ${e.code || e.message}`); }
  }
  if (out.flushed) log(`report: flushed ${out.flushed} queued report(s) to ${dir}`);
  return out;
}

const countJson = d => safe(() => fs.readdirSync(d).filter(n => n.endsWith('.json')).length, null);

// status(ctx) -> { dir, source, fixed, configured, reachable, lastSent, outboxCount, activations, localDir, outboxDir, activationPath }
async function status(ctx) {
  const { dir, source, fixed } = resolveDir(ctx);
  let reachable = false, activations = null, last = lastSent;
  if (dir) {
    reachable = await withTimeout(fsp.access(dir), 5000, 'report dir check').then(() => true, () => false);
    if (reachable) {
      activations = countJson(path.join(dir, '_activations')) || 0;
      if (!last) last = safe(() => fs.statSync(path.join(dir, '_latest', hostOf(ctx) + '.json')).mtime.toISOString());
    }
  }
  // outboxCount counts files (a queued report is a .json + .md pair => 2), as the License tab shows it.
  return { dir, source, fixed, configured: !!dir, reachable, lastSent: last || null, outboxCount: safe(() => fs.readdirSync(outboxDir(ctx, false)).length, 0),
    activations, localDir: localDir(ctx, false), outboxDir: outboxDir(ctx, false), activationPath: activationPath(ctx) };
}

module.exports = { REMOTE_TIMEOUT_MS, KEEP_DAYS, resolveDir, send, flush, status, localDir, outboxDir, activationPath, writeAtomic };

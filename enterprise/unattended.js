// NodeMend Enterprise — headless mode. `NodeMend-Enterprise.exe --unattended ...` runs a step
// profile in a hidden BrowserWindow (the renderer's runUnattended() drives the same code path as
// "Do all the things"), writes the report through the report sink and exits with a code.
// Electron is a GUI-subsystem exe: NOTHING goes to stdout. The log file and the exit code are
// the only outputs. All Electron objects arrive through ctx so the pure parts are unit-testable.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { helpers } = require('./policy');
const { paths, safe, expandEnv, today } = helpers;

const APP_DIR = path.resolve(__dirname, '..');
const EXIT = { OK: 0, FAILED: 1, ARGS: 2, LICENSE: 3, POLICY: 4, ELEVATION: 5, TIMEOUT: 6, RUNNING: 7, REBOOT: 3010 };
const EXIT_LEGEND = { 0: 'ok', 1: 'step failed', 2: 'bad arguments', 3: 'license does not permit', 4: 'policy forbids', 5: 'not elevated (policy requires)', 6: 'timeout', 7: 'already running', 3010: 'ok, reboot required' };
// Mirrors renderer/js/app.js ALL_STEPS order; keep in sync when steps are added there.
const ALL_STEP_KEYS = ['diag', 'clean', 'cleanmgr', 'dism', 'sfc', 'chkdsk', 'defupd', 'defscan', 'wu', 'drivers', 'winget', 'dup', 'maint', 'refresh'];
// cleanmgr is deliberately absent from quick: its window watcher cannot see session-0 dialogs.
const PROFILES = { quick: ['diag', 'clean', 'defupd', 'dism', 'refresh'], full: ALL_STEP_KEYS.slice(), smoke: ['diag', 'refresh'] };
const DEFAULT_TIMEOUT_MIN = 180;
const READY_POLL_S = 90;

// ---------------------------------------------------------------- CLI
// Tolerant of Electron/Chromium switches (unknown --flags are ignored); --k=v and --k v both work.
const SWITCHES = {
  'unattended': ['unattended', 'flag'], 'profile': ['profile', 'str'], 'steps': ['steps', 'list'], 'report-dir': ['reportDir', 'str'],
  'policy': ['policy', 'str'], 'license': ['license', 'str'], 'log': ['log', 'str'], 'timeout-min': ['timeoutMin', 'num'],
  'reboot-exit-code': ['rebootExitCode', 'flag'], 'no-elevate': ['noElevate', 'flag'], 'install-license': ['installLicense', 'str'],
  'quiet': ['quiet', 'flag'], 'elevated': ['elevated', 'flag']
};
function parseArgv(argv) {
  const cli = { unattended: false, profile: null, steps: null, reportDir: null, policy: null, license: null, log: null, timeoutMin: null,
    rebootExitCode: false, noElevate: false, installLicense: null, quiet: false, elevated: false, errors: [] };
  const args = (argv || []).map(String);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const name = (eq < 0 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
    const def = SWITCHES[name];
    if (!def) continue;
    const [key, type] = def;
    if (type === 'flag') { cli[key] = true; continue; }
    let v = eq < 0 ? null : a.slice(eq + 1);
    if (v === null) {
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) v = args[++i];
      else { cli.errors.push(`--${name} needs a value`); continue; }
    }
    if (type === 'num') { const n = Number(v); if (!Number.isFinite(n) || n <= 0) { cli.errors.push(`--${name}: not a positive number: ${v}`); continue; } cli[key] = n; }
    else if (type === 'list') cli[key] = v.split(',').map(s => s.trim()).filter(Boolean);
    else cli[key] = v;
  }
  return cli;
}

// Precedence: --steps > --profile > policy.unattended.steps > policy.unattended.profile > quick.
function resolveSteps(cli, pol) {
  const u = (pol && pol.unattended) || {};
  const profile = cli.profile || u.profile || 'quick';
  if (!PROFILES[profile]) return { error: `unknown profile "${profile}" (quick|full|smoke)`, profile: null };
  const steps = cli.steps || (!cli.profile && Array.isArray(u.steps) && u.steps.length ? u.steps : PROFILES[profile]);
  const unknown = steps.filter(k => !ALL_STEP_KEYS.includes(k));
  if (unknown.length) return { error: `unknown step(s): ${unknown.join(', ')} (valid: ${ALL_STEP_KEYS.join(', ')})`, profile };
  return { profile, steps: [...new Set(steps)] };
}

// ---------------------------------------------------------------- log file
let logFd = null, logPath = null, active = false, hiddenWin = null;
const progress = new Map(); // step key -> { state, secs, reason } from the renderer's unattendedProgress()

function openLog(ctx, cli, profile) {
  const P = paths(ctx);
  const candidates = cli.log ? [P.resolveArgPath(expandEnv(cli.log))]
    : [P.dataDir, P.userDataDir].map(d => path.join(d, 'logs', `${P.stamp()}-${require('../lib/paths').runId()}-${profile}.log`));
  for (const f of candidates) {
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); logFd = fs.openSync(f, 'a'); logPath = f; return f; } catch { /* next */ }
  }
  logPath = null; return null;
}
function log(line) {
  const text = `[${new Date().toISOString()}] ${String(line).replace(/\r?\n/g, ' | ')}\n`;
  if (logFd !== null) { try { fs.writeSync(logFd, text); } catch { /* disk full */ } }
}
// main.js calls this from send('task:line') so PowerShell/exe output lands in the run log too.
function logLine(line) { if (active) log('  ' + line); }
function closeLog() { if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* ignore */ } logFd = null; } }

function exit(ctx, code, reason) {
  log(`EXIT ${code} (${EXIT_LEGEND[code] || 'unknown'})${reason ? ': ' + reason : ''}`);
  safe(() => ctx.log && ctx.log(`unattended: exit ${code}${reason ? ' - ' + reason : ''}`));
  closeLog(); active = false;
  safe(() => ctx.app && ctx.app.exit(code));
  return code;
}

// ---------------------------------------------------------------- report helpers
function minimalJson(ctx, profile, steps, started, elevated) {
  const lic = safe(() => ctx.getLicenseState()) || {};
  const l = lic.license || {};
  return { schema: 1, host: ctx.hostname || os.hostname(), domain: process.env.USERDOMAIN || null, user: ctx.user || safe(() => os.userInfo().username, ''),
    elevated, mode: 'unattended', profile, started, finished: null, durationSec: null, exitCode: null, rebootRequired: false,
    app: { version: ctx.version || null, build: ctx.build || null, edition: lic.edition || null, licenseId: l.id || null, licensee: l.licensee || null, brand: l.brand || null },
    steps: steps.map(key => ({ key, label: key, state: 'skipped', secs: null, reason: 'timeout' })),
    sys: null, clean: null, diag: null, wu: null, drivers: null, winget: null, dup: null, log: [] };
}
function applyProgress(json, steps) {
  const known = new Map((json.steps || []).map(s => [s.key, s]));
  json.steps = steps.map(key => {
    const p = progress.get(key), s = known.get(key) || { key, label: key, state: 'skipped', secs: null, reason: 'timeout' };
    if (p && p.state && p.state !== 'running') { s.state = p.state; s.secs = p.secs != null ? p.secs : s.secs; s.reason = p.reason || s.reason; }
    else if (s.state !== 'done' && s.state !== 'failed') { s.state = 'skipped'; s.reason = 'timeout'; }
    return s;
  });
  return json;
}
function onProgress(p) { if (p && p.key) progress.set(p.key, { state: p.state, secs: p.secs, reason: p.reason }); }

// ---------------------------------------------------------------- run
async function run(cli, ctx) {
  const report = require('./report'), audit = require('./audit'), policy = require('./policy');
  const pol = safe(() => ctx.getPolicy && ctx.getPolicy()) || null;
  const polData = policy.effective(ctx);
  const rs = resolveSteps(cli, polData);
  const profile = rs.profile || 'unattended';
  openLog(ctx, cli, profile); active = true;
  const host = ctx.hostname || os.hostname(), user = ctx.user || safe(() => os.userInfo().username, '');
  log(`NodeMend ${ctx.productName || ''} v${ctx.version || '?'} build=${ctx.build || '?'} host=${host} user=${user} pid=${process.pid} mode=unattended`);
  log(`args: profile=${cli.profile || '-'} steps=${cli.steps ? cli.steps.join(',') : '-'} report-dir=${cli.reportDir || '-'} policy=${cli.policy || '-'} license=${cli.license ? (/^TIDYWIN1\./.test(cli.license.trim()) ? '<token>' : cli.license) : '-'} timeout-min=${cli.timeoutMin || '-'} reboot-exit-code=${cli.rebootExitCode}`);
  if (cli.errors.length) return exit(ctx, EXIT.ARGS, 'bad arguments: ' + cli.errors.join('; '));
  if (rs.error) return exit(ctx, EXIT.ARGS, rs.error);
  const steps = rs.steps;
  log(`profile=${profile} steps=${steps.join(',')}`);

  const lic = safe(() => ctx.getLicenseState()) || {};
  const features = Array.isArray(lic.features) ? lic.features : [];
  log(`license: edition=${lic.edition || 'evaluation'} status=${lic.status || 'none'} id=${(lic.license && lic.license.id) || '-'} features=${features.join(',') || '-'}`);
  if (lic.edition !== 'enterprise' || !features.includes('unattended')) return exit(ctx, EXIT.LICENSE, `LICENSE_REQUIRED (enterprise edition with the "unattended" feature; got edition=${lic.edition || 'evaluation'})`);

  if (pol && pol.found) log(`policy: ${pol.path} ok=${pol.ok}${pol.error ? ' error=' + pol.error : ''} enforced=${pol.enforced}`); else log('policy: none');
  if (pol && pol.ok === false) return exit(ctx, EXIT.POLICY, `policy invalid: ${pol.error}`);
  if (polData.unattended && polData.unattended.allow === false) return exit(ctx, EXIT.POLICY, 'policy forbids unattended runs (unattended.allow = false)');

  if (!safe(() => ctx.app.requestSingleInstanceLock(), true)) return exit(ctx, EXIT.RUNNING, 'another NodeMend instance holds the single-instance lock');

  const elevated = !!safe(() => ctx.isElevated && ctx.isElevated(), false);
  if (!elevated) {
    log('WARNING: not elevated - repairs, cleanup of system folders and installs will be limited');
    if (polData.unattended && polData.unattended.requireElevation === true) return exit(ctx, EXIT.ELEVATION, 'policy requires elevation (unattended.requireElevation = true)');
  }
  const timeoutMin = cli.timeoutMin || (polData.unattended && polData.unattended.timeoutMin) || DEFAULT_TIMEOUT_MIN;

  const fl = await report.flush(ctx).catch(e => ({ error: e.message }));
  log(`outbox: ${fl.error ? 'flush failed: ' + fl.error : `${fl.flushed} flushed, ${fl.remaining} remaining, ${fl.deleted} expired`}`);
  const opId = audit.write(ctx, 'run-start', { action: null, target: { profile, steps, timeoutMin } });
  const started = new Date().toISOString(); const t0 = Date.now();
  progress.clear();

  let finished = false;
  const finish = async (code, json, md, summary) => {
    if (finished) return code; finished = true;
    try {
      json = json || minimalJson(ctx, profile, steps, started, elevated);
      json.mode = 'unattended'; json.profile = profile; json.exitCode = code;
      json.finished = json.finished || new Date().toISOString(); json.durationSec = json.durationSec != null ? json.durationSec : Math.round((Date.now() - t0) / 1000);
      const r = await report.send(ctx, { json, md: md || '', profile });
      log(r.configured ? (r.queued ? `report queued to outbox (${r.dir} unreachable: ${r.error})` : `report sent to ${r.dir}`) : 'report: no report directory configured (local copy only)');
      for (const f of r.written) log('  wrote ' + f);
    } catch (e) { log('report write failed: ' + e.message); }
    audit.write(ctx, 'run-end', { opId, action: null, target: { profile }, result: { ok: code === EXIT.OK || code === EXIT.REBOOT, exitCode: code, ...summary }, secs: Math.round((Date.now() - t0) / 1000) });
    safe(() => hiddenWin && !hiddenWin.isDestroyed() && hiddenWin.destroy());
    return exit(ctx, code);
  };

  let timedOut = false;
  const timer = setTimeout(async () => {
    timedOut = true;
    log(`TIMEOUT after ${timeoutMin} min - stopping the step loop and killing ${ctx.running ? ctx.running.size : 0} child process(es)`);
    // 1. no new work: main refuses further task IPCs, and the renderer's runSteps() sees allStop
    //    as soon as the killed task returns, so nothing launches while finish() writes the report.
    safe(() => ctx.stopNewTasks && ctx.stopNewTasks());
    let json = null, md = '';
    try {
      const snap = await Promise.race([hiddenWin.webContents.executeJavaScript(`(state.allStop = true, { json: buildReportJson(${JSON.stringify(profile)}), md: buildReport() })`, true),
        new Promise((_, rej) => setTimeout(() => rej(new Error('renderer busy')), 3000))]);
      json = snap && snap.json; md = (snap && snap.md) || '';
    } catch (e) { log('snapshot unavailable: ' + e.message); safe(() => hiddenWin && !hiddenWin.isDestroyed() && hiddenWin.webContents.executeJavaScript('state.allStop = true', true)); }
    // 2. only now kill the current child
    if (ctx.running) for (const p of ctx.running.values()) { try { p.kill(); } catch { /* gone */ } }
    json = applyProgress(json || minimalJson(ctx, profile, steps, started, elevated), steps);
    const done = json.steps.filter(s => s.state === 'done').length, failed = json.steps.filter(s => s.state === 'failed').length;
    log(`RESULT: TIMEOUT (${done} ok, ${failed} failed, ${json.steps.length - done - failed} skipped)`);
    await finish(EXIT.TIMEOUT, json, md, { done, failed, skipped: json.steps.length - done - failed, error: 'timeout' });
  }, timeoutMin * 60e3);

  // Hidden window with the same webPreferences as createWindow(); ctx.setWindow lets main's
  // send() reach it so task:line output flows to the renderer (and, via logLine, into this log).
  try {
    hiddenWin = new ctx.BrowserWindow({ show: false, webPreferences: { preload: path.join(APP_DIR, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    safe(() => ctx.setWindow && ctx.setWindow(hiddenWin));
    hiddenWin.webContents.on('console-message', (e, a, b) => { const m = e && e.message !== undefined ? e : { level: a, message: b }; if (m.level === 'error' || m.level === 'warning' || m.level >= 2) log('[renderer] ' + m.message); });
    await hiddenWin.loadFile(path.join(APP_DIR, 'renderer', 'index.html'));
    let ready = false;
    for (let i = 0; i < READY_POLL_S && !timedOut; i++) {
      ready = await hiddenWin.webContents.executeJavaScript('!!(state.sys && state.cats.length)', true).catch(() => false);
      if (ready) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    log(ready ? 'renderer ready' : `renderer not ready after ${READY_POLL_S} s - running anyway`);
  } catch (e) {
    clearTimeout(timer);
    log('window failed: ' + e.message);
    return finish(EXIT.FAILED, null, '', { done: 0, failed: steps.length, skipped: 0, error: e.message });
  }
  if (timedOut) return;

  let result;
  try {
    result = await hiddenWin.webContents.executeJavaScript(`runUnattended(${JSON.stringify({ steps, profile, policy: polData })})`, true);
  } catch (e) {
    if (timedOut) return;
    clearTimeout(timer);
    log('renderer error: ' + (e && e.message || e));
    return finish(EXIT.FAILED, null, '', { done: 0, failed: steps.length, skipped: 0, error: String(e && e.message || e) });
  }
  if (timedOut) return;
  clearTimeout(timer);
  result = result || {};
  const done = result.done | 0, failed = result.failed | 0, skipped = result.skipped | 0;
  const code = failed > 0 ? EXIT.FAILED : (result.rebootRequired && cli.rebootExitCode ? EXIT.REBOOT : EXIT.OK);
  log(`RESULT: ${failed > 0 ? 'FAIL' : 'OK'} (${done} ok, ${failed} failed, ${skipped} skipped)${result.rebootRequired ? ' reboot required' : ''}`);
  return finish(code, result.json || null, result.markdown || '', { done, failed, skipped, rebootRequired: !!result.rebootRequired });
}

// ---------------------------------------------------------------- --install-license
function verify(ctx, text) {
  if (typeof ctx.verifyLicense === 'function') return ctx.verifyLicense(text);
  const codec = require('../lib/license-codec'); // lazy: only needed on this path
  const keys = codec.PUBLIC_KEYS.slice();
  if (ctx.app && !ctx.app.isPackaged && process.env.TIDYWIN_TEST_PUBKEY) keys.push(process.env.TIDYWIN_TEST_PUBKEY);
  return codec.verifyToken(text, { keys, today: today(), builtAt: ctx.builtAt || null });
}

// Copies a verified Enterprise key to <dataDir>\TidyWin.lic and writes activation.json. No window.
async function installLicense(cli, ctx) {
  const P = paths(ctx);
  openLog(ctx, cli, 'install-license'); active = true;
  const file = P.resolveArgPath(expandEnv(cli.installLicense));
  log(`install-license: ${file}`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return exit(ctx, EXIT.ARGS, `license file not readable: ${file} (${e.code || e.message})`); }
  let v;
  try { v = verify(ctx, text); } catch (e) { return exit(ctx, EXIT.LICENSE, 'verifier unavailable: ' + e.message); }
  if (!v || v.status !== 'valid') return exit(ctx, EXIT.LICENSE, `license ${v ? v.status : 'invalid'}${v && v.detail ? ': ' + v.detail : ''}`);
  const p = v.payload;
  if (p.edition !== 'enterprise') return exit(ctx, EXIT.LICENSE, `license edition is "${p.edition}"; an Enterprise key is required`);
  const dest = path.join(P.dataDir, 'TidyWin.lic');
  try { fs.mkdirSync(P.dataDir, { recursive: true }); require('./report').writeAtomic(dest, text); }
  catch (e) { return exit(ctx, EXIT.LICENSE, `cannot write ${dest}: ${e.code || e.message}`); }
  const record = { licenseId: p.id, edition: p.edition, licensee: p.licensee, seats: p.seats, hostname: ctx.hostname || os.hostname(),
    user: ctx.user || safe(() => os.userInfo().username, ''), activatedAt: new Date().toISOString(), appVersion: ctx.version || null, buildEdition: ctx.build || 'enterprise' };
  let actPath = null;
  if (typeof ctx.writeActivation === 'function') actPath = safe(() => ctx.writeActivation(record, p), null);
  else for (const d of [P.dataDir, P.userDataDir]) { try { fs.mkdirSync(d, { recursive: true }); actPath = require('./report').writeAtomic(path.join(d, 'activation.json'), JSON.stringify(record, null, 2)); break; } catch { /* next */ } }
  log(`activation record: ${actPath || 'not written'}`);
  safe(() => require('./audit').write(ctx, 'license-activate', { action: 'install-license', target: { source: 'programdata', path: dest, licenseId: p.id }, result: { ok: true } }));
  return exit(ctx, EXIT.OK, `installed ${p.id} (${p.licensee}, ${p.seats} seats) to ${dest}`);
}

// Read-only command line for the License tab / scheduled task. Dev mode needs the app path first.
function commandLine(ctx) {
  const report = require('./report');
  const q = s => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const polData = safe(() => require('./policy').effective(ctx)) || {};
  const rd = safe(() => report.resolveDir(ctx)) || {};
  const args = [];
  if (ctx.app && !ctx.app.isPackaged) args.push(q(safe(() => ctx.app.getAppPath(), APP_DIR)));
  args.push('--unattended', `--profile=${(polData.unattended && polData.unattended.profile) || 'quick'}`);
  if (rd.dir && rd.source !== 'policy') args.push(`--report-dir=${q(rd.dir)}`);
  args.push('--reboot-exit-code');
  // Portable build: execPath is the %TEMP% copy the launcher deletes on exit; the launcher exports the real exe path.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const schedule = require('../lib/schedule').eligibility(exe, {
    packaged: !!(ctx.app && ctx.app.isPackaged), portable: !!process.env.PORTABLE_EXECUTABLE_FILE
  });
  return { exe, args: args.join(' '), line: `${q(exe)} ${args.join(' ')}`, schedule };
}

module.exports = { EXIT, EXIT_LEGEND, ALL_STEP_KEYS, PROFILES, DEFAULT_TIMEOUT_MIN, parseArgv, resolveSteps, run, installLicense, commandLine,
  logLine, isActive: () => active, logPath: () => logPath, window: () => hiddenWin, onProgress, progress };

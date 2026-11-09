// NodeMend — main process
// All privileged work happens here: PowerShell scripts in ./ps, Windows exes (DISM, SFC,
// winget, cleanmgr) and a native file walker for the cleaner. The renderer only talks to
// this process through the typed bridge in preload.js.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const BRAND = require('./lib/brand');
BRAND.applyEnvironmentAliases(process.env);

const codec = require('./lib/license-codec');
const LIC = require('./lib/license');
const GATE = require('./lib/gate');
const PATHS = require('./lib/paths');
const PLATFORM = require('./lib/platform');
const INPUTS = require('./lib/main-inputs');
const RECOVERY = require('./lib/recovery').createRecoveryService({ bundledDirectory: path.join(__dirname, 'vendor', 'photorec', process.platform) });
const PERFORMANCE = require('./lib/performance').createPerformanceService({ mainPID: process.pid, scriptPath: path.join(__dirname, 'ps', 'performance.ps1') });
const PRIVACY = require('./lib/privacy').createPrivacyCleaner({ isBrowserClosed: async browser => {
  const { execFileSync } = require('child_process');
  const pattern = INPUTS.browserPattern(String(browser).toLowerCase());
  if (!pattern) return false;
  try {
    const listing = process.platform === 'win32'
      ? execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 1024 * 1024 }).toString()
      : execFileSync('/bin/ps', ['-A', '-o', 'comm='], { maxBuffer: 1024 * 1024 }).toString();
    return !pattern.test(listing);
  } catch { return false; }
} });

const PS_DIR = path.join(__dirname, 'ps');
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWERSHELL = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// The UAC relaunch goes through AppInfo, which builds a fresh environment for the elevated
// process, so the portable launcher's PORTABLE_EXECUTABLE_* variables are re-imported from argv
// (relaunchArgs() forwards them as --portable-dir= / --portable-file=).
for (const a of process.argv) {
  const pm = /^--portable-(dir|file)=(.+)$/i.exec(a);
  if (pm) process.env['PORTABLE_EXECUTABLE_' + pm[1].toUpperCase()] = pm[2];
}
const previousUserData = app.getPath('userData'), appDataRoot = app.getPath('appData');
app.setName(BRAND.NAME);
const storageUserData = process.env.PORTABLE_EXECUTABLE_DIR ? path.join(os.tmpdir(), 'NodeMend-portable')
  : ['tidywin', 'nodemend'].includes(path.basename(previousUserData).toLowerCase()) && path.dirname(previousUserData).toLowerCase() === appDataRoot.toLowerCase()
    ? path.join(appDataRoot, 'nodemend') : previousUserData;
const migrationWarnings = [];
try {
  for (const result of PATHS.migrateLegacyData({ appData: appDataRoot, userDataDir: storageUserData, isPackaged: app.isPackaged })) {
    if (!result.migrated && result.reason !== 'absent') migrationWarnings.push('Legacy data preserved at ' + result.legacy + '; migration skipped: ' + result.reason);
  }
  if (!migrationWarnings.length) {
    fs.mkdirSync(storageUserData, { recursive: true });
    app.setPath('userData', storageUserData);
  }
} catch (error) { migrationWarnings.push('Legacy data migration refused: ' + error.message); }

// ---------------------------------------------------------------- edition / CLI
// Build edition comes from the generated edition.json (scripts/build.js); dev defaults to
// enterprise so the whole feature set is exercised. TIDYWIN_EDITION is dev-only. A tree
// without enterprise/ (Solo artifacts physically omit it) is always Solo.
const EDITION_JSON = (() => { try { return require('./edition.json'); } catch { return {}; } })();
const BUILD = (() => {
  let e = EDITION_JSON.edition || null;
  if (!e) e = app.isPackaged ? 'solo' : (process.env.TIDYWIN_EDITION || 'enterprise');
  if (!fs.existsSync(path.join(__dirname, 'enterprise', 'index.js'))) e = 'solo';
  return process.platform === 'win32' && e === 'enterprise' ? 'enterprise' : 'solo';
})();
const ENT = BUILD === 'enterprise' ? require('./enterprise') : null;
const PRODUCT_NAME = BUILD === 'enterprise' ? 'NodeMend' : 'NodeMend Solo';
const BUILT_AT = EDITION_JSON.builtAt || null;
const VERSION = require('./package.json').version;

// CLI switches (section 5.1). The full parser lives in enterprise/unattended.js; Solo builds
// carry this minimal twin so --unattended / --install-license can still be refused (exit 3)
// and --license / --policy / --report-dir are still understood.
const CLI_SWITCHES = { unattended: ['unattended', 'flag'], profile: ['profile', 'str'], steps: ['steps', 'list'], 'report-dir': ['reportDir', 'str'],
  policy: ['policy', 'str'], license: ['license', 'str'], log: ['log', 'str'], 'timeout-min': ['timeoutMin', 'num'], 'reboot-exit-code': ['rebootExitCode', 'flag'],
  'no-elevate': ['noElevate', 'flag'], 'install-license': ['installLicense', 'str'], quiet: ['quiet', 'flag'], elevated: ['elevated', 'flag'] };
function parseArgvInline(argv) {
  const cli = { unattended: false, profile: null, steps: null, reportDir: null, policy: null, license: null, log: null, timeoutMin: null,
    rebootExitCode: false, noElevate: false, installLicense: null, quiet: false, elevated: false, errors: [] };
  const a = (argv || []).map(String);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const eq = a[i].indexOf('='), name = (eq < 0 ? a[i].slice(2) : a[i].slice(2, eq)).toLowerCase();
    const def = CLI_SWITCHES[name]; if (!def) continue;
    const [key, type] = def;
    if (type === 'flag') { cli[key] = true; continue; }
    let v = eq < 0 ? null : a[i].slice(eq + 1);
    if (v === null) { if (i + 1 < a.length && !a[i + 1].startsWith('--')) v = a[++i]; else { cli.errors.push(`--${name} needs a value`); continue; } }
    if (type === 'num') { const n = Number(v); if (!Number.isFinite(n) || n <= 0) { cli.errors.push(`--${name}: not a positive number: ${v}`); continue; } cli[key] = n; }
    else if (type === 'list') cli[key] = v.split(',').map(s => s.trim()).filter(Boolean);
    else cli[key] = v;
  }
  return cli;
}
const cli = (ENT ? ENT.unattended.parseArgv : parseArgvInline)(process.argv);
if (cli.unattended) { app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu'); } // headless: no GPU process

let win = null;
let tasksClosed = false;    // set by the unattended timeout: no new work once the run is finishing
let licReady = null;        // promise of the first license/policy resolution (settled at whenReady)
const running = new Map(); // taskId -> ChildProcess

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 980, minHeight: 640,
    backgroundColor: '#0b1220',
    title: windowTitle(),
    autoHideMenuBar: true,
    icon: fs.existsSync(path.join(__dirname, 'icon.ico')) ? path.join(__dirname, 'icon.ico') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('page-title-updated', e => { e.preventDefault(); win.setTitle(windowTitle()); }); // the edition owns the title, not <title>
  win.on('closed', () => { win = null; });
}

// Section 9: 'NodeMend' / 'NodeMend – <org>' (optional organisation key or policy) / 'NodeMend Solo'.
function windowTitle() {
  const s = licState;
  if (s.edition === 'enterprise') {
    const l = s.license || {}, org = (l.brand && l.brand.name) || (s.policy && s.policy.data && s.policy.data.orgName) || l.licensee;
    return 'NodeMend' + (org ? ' – ' + org : '');
  }
  return s.edition === 'solo' ? 'NodeMend Solo' : 'NodeMend';
}
function applyTitle() { if (win && !win.isDestroyed()) win.setTitle(windowTitle()); }

// Section 5.6: user switches (--license, --policy, --report-dir ...) survive the UAC relaunch.
// Windows CommandLineToArgv quoting: wrap when the value has whitespace or quotes, double the
// backslashes that precede a quote, escape the quote. Without this a --license path with a
// space is split by Start-Process and the elevated instance runs as Evaluation.
function winQuote(a) {
  a = String(a);
  if (!/[\s"]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
function relaunchArgs() {
  const userArgs = process.argv.slice(app.isPackaged ? 1 : 2).filter(a => a !== '--elevated' && !/^--portable-(dir|file)=/i.test(a));
  const portable = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) portable.push('--portable-dir=' + process.env.PORTABLE_EXECUTABLE_DIR);
  if (process.env.PORTABLE_EXECUTABLE_FILE) portable.push('--portable-file=' + process.env.PORTABLE_EXECUTABLE_FILE);
  return (app.isPackaged ? [] : [app.getAppPath()]).concat(userArgs, portable, ['--elevated']).map(winQuote);
}

// Bootstrap (section 1 (c)/(j)): license + policy first (bounded: every candidate read races a
// 3 s timeout), then the headless paths, then UAC, then the window. Under TIDYWIN_NO_WINDOW
// (smoke test) only the resolution runs; the test drives everything else itself.
licReady = app.whenReady().then(() => migrationWarnings.length ? licState : resolveLicense());
app.whenReady().then(async () => {
  await licReady;
  if (migrationWarnings.length) {
    const detail = 'DATA_MIGRATION_REQUIRED: ' + migrationWarnings.join('\n');
    const logFile = cli.log ? PATHS.resolveArgPath(cli.log, { app }) : path.join(os.tmpdir(), `NodeMend-migration-${PATHS.runId()}.log`);
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `[${new Date().toISOString()}] EXIT 4 ${detail}\n`); } catch { /* stderr remains available */ }
    process.stderr.write(detail + '\nLog: ' + logFile + '\n');
    if (!cli.unattended && !cli.quiet && !process.env.TIDYWIN_NO_WINDOW) dialog.showErrorBox('NodeMend data migration needs attention', detail + '\nResolve the directory conflict before starting NodeMend.\nLog: ' + logFile);
    app.exit(4);
    return;
  }
  if (process.env.TIDYWIN_NO_WINDOW) return;
  if (cli.unattended) { if (ENT && licState.edition === 'enterprise') ENT.audit.rotate(ctx); return ENT ? ENT.unattended.run(cli, ctx) : refuseSoloUnattended(); }
  if (cli.installLicense) return ENT ? ENT.unattended.installLicense(cli, ctx) : app.exit(3);
  // Free cleaning starts as the current user; elevation is requested explicitly from the UI.
  if (ENT && licState.edition === 'enterprise') ENT.startup(ctx).catch(e => mainLog('startup: ' + e.message)); // audit rotation + outbox flush
  createWindow();
});
app.on('window-all-closed', () => {
  for (const p of running.values()) { try { p.kill(); } catch { /* ignore */ } }
  app.quit();
});

// ---------------------------------------------------------------- helpers
function refuseSoloUnattended() {
  const reason = 'LICENSE_REQUIRED (enterprise edition with the "unattended" feature; got build=solo)';
  const name = `${PATHS.stamp()}-${PATHS.runId()}-unattended.log`;
  const candidates = cli.log ? [PATHS.resolveArgPath(cli.log, { app })]
    : [PATHS.dataDir({ app }), PATHS.userDataDir({ app })].map(d => path.join(d, 'logs', name));
  for (const file of candidates) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] EXIT 3 (license does not permit): ${reason}\n`, 'utf8');
      break;
    } catch { /* try the per-user fallback */ }
  }
  app.exit(3);
}

let elevatedCache = null; // a process never changes its token, so ask net.exe once
function isElevated() {
  if (process.platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0;
  // `net session` succeeds only in an elevated console.
  if (elevatedCache === null) { const r = spawnSync(path.join(SYS32, 'net.exe'), ['session'], { windowsHide: true }); elevatedCache = r.status === 0; }
  return elevatedCache;
}

function send(channel, payload) {
  const w = (win && !win.isDestroyed()) ? win : (ENT ? ENT.unattended.window() : null);
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  if (channel === 'task:line' && ENT && ENT.unattended.isActive() && payload) ENT.unattended.logLine(payload.line); // (k) run log
}

// Main-process log sink: the renderer's log pane (it prints every task:line) plus the
// unattended run log via send(); never stdout (Electron is a GUI-subsystem exe).
function mainLog(line) { send('task:line', { id: 'main', line: String(line) }); }

function decodeChunk(buf) {
  // sfc.exe writes UTF-16LE to a pipe; everything else is UTF-8/ANSI. Detect by NUL density.
  let nul = 0;
  const n = Math.min(buf.length, 512);
  for (let i = 1; i < n; i += 2) if (buf[i] === 0) nul++;
  return nul > n / 5 ? buf.toString('utf16le') : buf.toString('utf8');
}

function expandEnv(p) {
  return p.replace(/%([^%]+)%/g, (_, k) => process.env[k] || process.env[k.toUpperCase()] || '');
}

// Run a PowerShell script that prints a single JSON document. Resolves with the parsed object.
function psJson(script, args = []) {
  if (process.platform !== 'win32') {
    if (script === 'sysinfo.ps1') return Promise.resolve(PLATFORM.systemInfo());
    if (script === 'diag.ps1') return Promise.resolve(PLATFORM.healthSummary());
    if (script === 'programs.ps1') return Promise.resolve(PLATFORM.listInstalledApps());
    PLATFORM.assertWindows(script);
  }
  return new Promise((resolve, reject) => {
    const file = path.join(PS_DIR, script);
    const t0 = Date.now();
    if (process.env.TIDYWIN_DEBUG) console.error(`[psJson] start ${script}`);
    const p = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { windowsHide: true });
    const out = []; const err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', code => {
      if (process.env.TIDYWIN_DEBUG) console.error(`[psJson] close ${script} exit=${code} ${Date.now() - t0} ms stderr=${Buffer.concat(err).toString().slice(0, 200)}`);
      const text = Buffer.concat(out).toString('utf8').trim();
      const start = text.indexOf('{') >= 0 ? Math.min(...['{', '['].map(c => text.indexOf(c)).filter(i => i >= 0)) : -1;
      if (start < 0) return reject(new Error(`${script} produced no JSON (exit ${code}): ${Buffer.concat(err).toString()} ${text.slice(0, 400)}`));
      try { resolve(JSON.parse(text.slice(start))); }
      catch (e) { reject(new Error(`${script}: bad JSON: ${e.message}\n${text.slice(0, 400)}`)); }
    });
  });
}

// Run a long process and stream its output lines to the renderer as task:line events.
// Lines beginning with "@@JSON " are captured as the task's structured result instead.
function streamTask(id, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    running.set(id, p);
    let result = null; let carry = '';
    const onData = (buf) => {
      const text = carry + decodeChunk(buf);
      const lines = text.split(/\r?\n|\r/);
      carry = lines.pop();
      for (let line of lines) {
        line = line.replace(/\0/g, '').replace(/[\u2588\u2592\u2591]+/g, '').trim();
        if (!line || /^[-\\|/]$/.test(line)) continue;              // spinner frames
        if (/^\[\s*=*\s*[\d.]+%\s*=*\s*\]$/.test(line)) continue;    // DISM progress bars
        if (/^\d+(\.\d+)?%$/.test(line)) continue;
        if (line.startsWith('@@JSON ')) { try { result = JSON.parse(line.slice(7)); } catch { /* ignore */ } continue; }
        send('task:line', { id, line });
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', e => { send('task:line', { id, line: 'ERROR: ' + e.message }); });
    p.on('close', code => {
      if (carry.trim()) send('task:line', { id, line: carry.replace(/\0/g, '').trim() });
      running.delete(id);
      resolve({ id, code, result });
    });
  });
}

function psStream(id, script, args = []) {
  PLATFORM.assertWindows(script);
  return streamTask(id, POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, script), ...args]);
}

// ---------------------------------------------------------------- cleaner categories
// Paths may contain %ENV% tokens and a single "*" segment (expanded to every subfolder).
const WINDOWS_CATEGORIES = [
  { id: 'user-temp', group: 'System', name: 'User temporary files', desc: '%TEMP% — leftovers from installers and apps', on: true,
    paths: ['%TEMP%'] },
  { id: 'win-temp', group: 'System', name: 'Windows temporary files', desc: 'C:\\Windows\\Temp', on: true,
    paths: ['%SystemRoot%\\Temp'] },
  { id: 'do-cache', group: 'System', name: 'Delivery Optimization cache', desc: 'Peer-to-peer Windows Update cache', on: true,
    paths: ['%SystemRoot%\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization\\Cache'] },
  { id: 'wu-cache', group: 'System', name: 'Windows Update downloads', desc: 'SoftwareDistribution\\Download (files older than 1 day)', on: true, minAgeDays: 1,
    paths: ['%SystemRoot%\\SoftwareDistribution\\Download'] },
  { id: 'thumbs', group: 'System', name: 'Thumbnail cache', desc: 'Explorer thumbcache_*.db (rebuilt automatically)', on: true, pattern: /^thumbcache_.*\.db$/i,
    paths: ['%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer'] },
  { id: 'crash', group: 'System', name: 'Crash dumps & error reports', desc: 'Minidumps, LiveKernelReports, WER queue, user CrashDumps', on: true,
    paths: ['%SystemRoot%\\Minidump', '%SystemRoot%\\LiveKernelReports', '%LOCALAPPDATA%\\CrashDumps',
            '%ProgramData%\\Microsoft\\Windows\\WER\\ReportQueue', '%ProgramData%\\Microsoft\\Windows\\WER\\ReportArchive', '%ProgramData%\\Microsoft\\Windows\\WER\\Temp'] },
  { id: 'shader', group: 'System', name: 'GPU shader caches', desc: 'DirectX / NVIDIA / AMD compiled shaders (rebuilt on demand)', on: true,
    paths: ['%LOCALAPPDATA%\\D3DSCache', '%LOCALAPPDATA%\\NVIDIA\\DXCache', '%LOCALAPPDATA%\\NVIDIA\\GLCache', '%LOCALAPPDATA%\\AMD\\DxCache', '%LOCALAPPDATA%\\AMD\\GLCache'] },
  { id: 'wer-logs', group: 'System', name: 'Windows log leftovers', desc: 'CBS logs, setup logs, Panther', on: false,
    paths: ['%SystemRoot%\\Logs\\CBS', '%SystemRoot%\\Panther', '%SystemRoot%\\Logs\\DISM'] },

  { id: 'edge', group: 'Browsers', name: 'Microsoft Edge cache', desc: 'Cache + Code Cache (all profiles)', on: true,
    paths: ['%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\Cache', '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\Code Cache', '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\GPUCache'] },
  { id: 'chrome', group: 'Browsers', name: 'Google Chrome cache', desc: 'Cache + Code Cache (all profiles)', on: true,
    paths: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Cache', '%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Code Cache', '%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\GPUCache'] },
  { id: 'brave', group: 'Browsers', name: 'Brave cache', desc: 'Cache + Code Cache (all profiles)', on: true,
    paths: ['%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data\\*\\Cache', '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data\\*\\Code Cache'] },
  { id: 'opera', group: 'Browsers', name: 'Opera / Opera GX cache', desc: 'Cache + Code Cache', on: true,
    paths: ['%LOCALAPPDATA%\\Opera Software\\*\\Cache', '%LOCALAPPDATA%\\Opera Software\\*\\Code Cache'] },
  { id: 'firefox', group: 'Browsers', name: 'Firefox cache', desc: 'cache2 for every profile', on: true,
    paths: ['%LOCALAPPDATA%\\Mozilla\\Firefox\\Profiles\\*\\cache2'] },

  { id: 'discord', group: 'Apps', name: 'Discord cache', desc: 'Cache, Code Cache, GPUCache', on: true,
    paths: ['%APPDATA%\\discord\\Cache', '%APPDATA%\\discord\\Code Cache', '%APPDATA%\\discord\\GPUCache'] },
  { id: 'teams', group: 'Apps', name: 'Microsoft Teams cache', desc: 'New Teams WebView cache', on: true,
    paths: ['%LOCALAPPDATA%\\Packages\\MSTeams_8wekyb3d8bbwe\\LocalCache\\Microsoft\\MSTeams\\EBWebView\\*\\Cache'] },
  { id: 'spotify', group: 'Apps', name: 'Spotify cache', desc: 'Offline storage of streamed audio', on: false,
    paths: ['%LOCALAPPDATA%\\Spotify\\Storage', '%LOCALAPPDATA%\\Spotify\\Data'] },
  { id: 'steam', group: 'Apps', name: 'Steam web cache', desc: 'htmlcache only — game files untouched', on: true,
    paths: ['%LOCALAPPDATA%\\Steam\\htmlcache', '%ProgramFiles(x86)%\\Steam\\appcache\\httpcache'] },

  { id: 'npm', group: 'Developer', name: 'npm cache', desc: '%LOCALAPPDATA%\\npm-cache (packages re-download on demand)', on: false,
    paths: ['%LOCALAPPDATA%\\npm-cache'] },
  { id: 'pip', group: 'Developer', name: 'pip cache', desc: 'Python wheel cache', on: false,
    paths: ['%LOCALAPPDATA%\\pip\\Cache'] },
  { id: 'yarn-pnpm', group: 'Developer', name: 'yarn / pnpm / bun caches', desc: 'Package manager stores', on: false,
    paths: ['%LOCALAPPDATA%\\Yarn\\Cache', '%LOCALAPPDATA%\\pnpm\\store', '%USERPROFILE%\\.bun\\install\\cache'] },
  { id: 'nuget-gradle', group: 'Developer', name: 'NuGet / Gradle / Maven caches', desc: 'Restored on next build', on: false,
    paths: ['%USERPROFILE%\\.nuget\\packages', '%USERPROFILE%\\.gradle\\caches', '%USERPROFILE%\\.m2\\repository'] },
  { id: 'vscode-cache', group: 'Developer', name: 'VS Code caches', desc: 'Cache, CachedData, CachedExtensionVSIXs (settings untouched)', on: false,
    paths: ['%APPDATA%\\Code\\Cache', '%APPDATA%\\Code\\CachedData', '%APPDATA%\\Code\\CachedExtensionVSIXs', '%APPDATA%\\Code\\Code Cache', '%APPDATA%\\Code\\GPUCache'] },

  { id: 'recycle', group: 'System', name: 'Recycle Bin', desc: 'Permanently removes everything in the Recycle Bin', on: false, special: 'recycle' }
];

const CATEGORIES = PLATFORM.cleanerCategories(process.platform, { windowsCategories: WINDOWS_CATEGORIES });
const SMART = require('./lib/smart-clean').createSmartCleaner({
  allowedCategories: CATEGORIES.filter(c => c.on && !c.special && c.group !== 'Developer').map(c => c.id),
  isAllowed: () => !GATE.decide('smart-clean', licCtx()),
  canRun: () => running.size === 0 && !tasksClosed,
  clean: async ids => {
    const op = guard('clean:run', ids, undefined, ids), t0 = Date.now();
    try {
      const result = await cleanRun(ids);
      auditDone(op, 'clean:run', ids, undefined, result, t0);
      return result;
    } catch (error) {
      auditDone(op, 'clean:run', ids, undefined, { ok: false, error: error.message }, t0);
      throw error;
    }
  }, onResult: r => mainLog(r.ok ? `Automatic cache cleaning freed ${r.freed || 0} bytes.` : r.error)
});
let finishingPerformance = false;
let shuttingDown = false;
app.on('before-quit', e => {
  SMART.stop();
  if (finishingPerformance) return;
  if (shuttingDown) { e.preventDefault(); return; }
  shuttingDown = true;
  e.preventDefault();
  PERFORMANCE.resumeAll().then(async r => {
    if (!r.ok) {
      const response = await dialog.showMessageBox({ type: 'warning', buttons: ['Keep NodeMend open', 'Quit anyway'], defaultId: 0, cancelId: 0,
        message: 'Some paused apps could not be resumed.', detail: 'Keep NodeMend open and retry Resume apps. If you force quit, those apps may remain paused until restarted.' });
      if (response.response === 0) { shuttingDown = false; if (!win || win.isDestroyed()) createWindow(); return; }
    }
    finishingPerformance = true; app.quit();
  }).catch(() => { shuttingDown = false; if (!win || win.isDestroyed()) createWindow(); mainLog('Could not resume paused apps; keep NodeMend open and retry.'); });
});

// Anything with these substrings in its full path is never touched (active tool sessions).
// ...and NodeMend itself: the portable build unpacks into %TEMP%, which the cleaner walks.
const PROTECTED = ['\\claude\\', '\\.git\\', '\\.codex\\', '\\.openclaw\\', '/.git/', '/.claude/', '/.codex/', '/.openclaw/'];
function protectSelf() {
  for (const d of [app.getAppPath(), path.dirname(process.execPath), app.getPath('userData'), process.env.PORTABLE_EXECUTABLE_DIR, PATHS.dataDir({ app })].filter(Boolean)) {
    const norm = path.resolve(d).toLowerCase() + path.sep;
    if (!PROTECTED.includes(norm)) PROTECTED.push(norm);
  }
}
app.whenReady().then(protectSelf);
const isProtected = (p) => { const l = p.toLowerCase(); return PROTECTED.some(s => l.includes(s) || (l + path.sep) === s); };

function resolvePaths(specs) {
  const out = [];
  for (const spec of specs) {
    const p = expandEnv(spec);
    const star = p.indexOf('*');
    if (star < 0) { if (fs.existsSync(p)) out.push(p); continue; }
    const base = path.dirname(p.slice(0, star + 1));
    const rest = p.slice(star + 1);
    let subs = [];
    try { subs = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(base, d.name)); } catch { /* no base */ }
    for (const s of subs) { const full = s + rest; if (fs.existsSync(full)) out.push(full); }
  }
  return out;
}

// Iterative walk, never follows reparse points, never throws.
function walk(root, cat) {
  const files = []; const dirs = []; const stack = [root];
  try { PLATFORM.assertPlainDirectorySync(root); if (isProtected(root)) return { files, dirs, size: 0 }; } catch { return { files, dirs, size: 0 }; }
  const cutoff = cat.minAgeDays ? Date.now() - cat.minAgeDays * 86400e3 : Infinity;
  let size = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (isProtected(full)) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { dirs.push(full); stack.push(full); continue; }
      if (!e.isFile()) continue;
      if (cat.pattern && !cat.pattern.test(e.name)) continue;
      let st; try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.mtimeMs > cutoff) continue;
      files.push({ p: full, s: st.size }); size += st.size;
    }
  }
  return { files, dirs, size };
}

function scanCategory(cat) {
  let size = 0, count = 0;
  const roots = resolvePaths(cat.paths || []);
  for (const r of roots) { const w = walk(r, cat); size += w.size; count += w.files.length; }
  return { size, count, roots };
}

function cleanCategory(cat, progress) {
  let freed = 0, deleted = 0, skipped = 0;
  for (const r of resolvePaths(cat.paths || [])) {
    const w = walk(r, cat);
    let n = 0;
    for (const f of w.files) {
      try {
        PLATFORM.assertPlainDirectorySync(path.dirname(f.p));
        const now = fs.lstatSync(f.p);
        if (!now.isFile() || now.isSymbolicLink() || now.nlink > 1 || isProtected(f.p) || (cat.minAgeDays && now.mtimeMs > Date.now() - cat.minAgeDays * 86400e3)) { skipped++; continue; }
        fs.unlinkSync(f.p); freed += now.size; deleted++;
      }
      catch { skipped++; }
      if (++n % 1000 === 0) progress(`${cat.name}: ${deleted} files, ${(freed / 1048576).toFixed(0)} MB…`);
    }
    // Leave directories intact: only approved cache files are removed.
  }
  return { freed, deleted, skipped };
}

// ---------------------------------------------------------------- winget parsing
function stripWinget(text) {
  return text.replace(/\r/g, '\n').split('\n')
    .map(l => l.replace(/[\u2588\u2592\u2591]+/g, '').replace(/^[\s\\|/-]{0,3}$/, ''))   // drop spinner frames, keep the ---- rule
    .filter(l => l.trim().length);
}

function parseWingetTable(text) {
  const lines = stripWinget(text);
  const items = [];
  let explicit = false;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i];
    if (/require explicit targeting/i.test(h)) { explicit = true; continue; }
    const m = /^Name\s+Id\s+Version\s+Available\s+Source\s*$/.exec(h);
    if (!m) continue;
    const cId = h.indexOf('Id'), cVer = h.indexOf('Version'), cAv = h.indexOf('Available'), cSrc = h.indexOf('Source');
    for (let j = i + 2; j < lines.length; j++) {          // skip the ---- rule
      const row = lines[j];
      if (/^-{5,}/.test(row) || /upgrades? available/i.test(row) || /^Name\s+Id/.test(row) || /explicit targeting/i.test(row)) break;
      if (row.length < cSrc) continue;
      const rec = {
        name: row.slice(0, cId).trim(), id: row.slice(cId, cVer).trim(),
        version: row.slice(cVer, cAv).trim(), available: row.slice(cAv, cSrc).trim(), source: row.slice(cSrc).trim(),
        explicit
      };
      if (rec.id && /^[\w.+-]+$/.test(rec.id)) items.push(rec);
    }
  }
  return items;
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('app:info', async () => {
  await licReady;
  return {
    elevated: isElevated(), version: VERSION, electron: process.versions.electron, platform: process.platform, capabilities: PLATFORM.getCapabilities(),
    packaged: app.isPackaged, hostname: os.hostname(), user: os.userInfo().username, domain: process.env.USERDOMAIN || null,
    edition: licState.edition, build: currentBuild(), productName: productName(), lic: licState
  };
});

ipcMain.handle('app:relaunchElevated', () => {
  PLATFORM.assertWindows('Restart as administrator');
  const exe = process.execPath;
  const args = relaunchArgs();
  const arglist = `-ArgumentList '${args.map(a => a.replace(/'/g, "''")).join("','")}'`;
  spawn(POWERSHELL, ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process -FilePath '${exe.replace(/'/g, "''")}' ${arglist} -Verb RunAs`], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 400);
  return true;
});

// (e) Scripts are bare file names inside ./ps — never a path, never anything but .ps1.
function checkScript(script) {
  if (typeof script !== 'string' || !script || path.basename(script) !== script || !/\.ps1$/i.test(script)) throw new Error('invalid script: ' + script);
  return script;
}
function normalizePublicScript(script, args) {
  const validated = GATE.validateScriptArgs(script, args);
  const argv = [];
  for (const [name, value] of Object.entries(validated.params)) {
    if (name === 'enable') argv.push('-Enable', value ? '$true' : '$false');
    else if (typeof value === 'boolean') { if (value) argv.push('-' + name); }
    else argv.push('-' + name, String(value));
  }
  return { script: validated.script, args: argv };
}

async function confirmUninstall(info) {
  const result = await dialog.showMessageBox({ type: 'warning', buttons: ['Cancel', 'Run uninstaller'], defaultId: 0, cancelId: 0,
    message: 'Uninstall ' + info.name + '?',
    detail: 'Registry scope: ' + info.scope + (info.scope === 'user' ? ' (this entry can be changed by the signed-in user)' : '') +
      '\n\nResolved registered command:\n' + info.command + '\n\n' +
      'This command will run with NodeMend’s current privileges. MSI commands are normalized to product removal; selected silent options may be added.' });
  return result.response === 1;
}

ipcMain.handle('ps:json', async (e, script, args) => {
  ({ script, args } = normalizePublicScript(script, args));
  checkScript(script); await licReady; if (tasksClosed) throw new Error('TIMEOUT: run is finishing');
  const op = guard('ps:json', script, args, targetOf('ps:json', script, args));
  const t0 = Date.now();
  const trustedArgs = await INPUTS.resolveUninstallArgs(script, args || [], id => psJson('uninstall-info.ps1', ['-Id', id]), confirmUninstall);
  const r = await psJson(script, trustedArgs);
  auditDone(op, 'ps:json', script, args, { ok: !(r && r.ok === false), error: (r && r.error) || null }, t0);
  return r;
});
ipcMain.handle('task:ps', async (e, id, script, args) => {
  ({ script, args } = normalizePublicScript(script, args));
  checkScript(script); await licReady; if (tasksClosed) throw new Error('TIMEOUT: run is finishing');
  const op = guard('task:ps', script, args, targetOf('task:ps', script, args));
  const t0 = Date.now();
  const trustedArgs = await INPUTS.resolveUninstallArgs(script, args || [], id => psJson('uninstall-info.ps1', ['-Id', id]), confirmUninstall);
  const r = await psStream(id, script, trustedArgs);
  auditDone(op, 'task:ps', script, args, { ok: r.code === 0 && !(r.result && r.result.ok === false), exitCode: r.code, error: (r.result && r.result.error) || null }, t0);
  return r;
});
const cancelled = new Set(); // ids of in-process (JS) tasks asked to stop
ipcMain.handle('task:cancel', (e, id) => { cancelled.add(id); const p = running.get(id); if (p) { try { p.kill(); } catch { /* ignore */ } return true; } return false; });

const EXE_TASKS = {
  'dism-scan':    () => [path.join(SYS32, 'Dism.exe'), ['/Online', '/Cleanup-Image', '/ScanHealth']],
  'dism-restore': () => [path.join(SYS32, 'Dism.exe'), ['/Online', '/Cleanup-Image', '/RestoreHealth']],
  'dism-cleanup': () => [path.join(SYS32, 'Dism.exe'), ['/Online', '/Cleanup-Image', '/StartComponentCleanup']],
  'sfc':          () => [path.join(SYS32, 'sfc.exe'), ['/scannow']],
  'chkdsk':       (a) => [path.join(SYS32, 'chkdsk.exe'), [INPUTS.chkdskDrive(a), '/scan']],
  'maintenance':  () => [path.join(SYS32, 'MSchedExe.exe'), ['Start']],
  'winget-all':   () => ['winget', ['upgrade', '--all', '--include-unknown', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity']],
  'winget-id':    (a) => ['winget', ['upgrade', '--id', a.id, '--exact', '--include-unknown', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity']]
};
ipcMain.handle('task:exe', async (e, id, kind, args) => {
  PLATFORM.assertWindows(kind);
  if (tasksClosed) throw new Error('TIMEOUT: run is finishing');
  const f = EXE_TASKS[kind];
  if (!f) throw new Error('unknown task ' + kind);
  await licReady;
  const op = guard('task:exe', kind, args, targetOf('task:exe', kind, args));
  const [cmd, argv] = f(args || {});
  const t0 = Date.now();
  const r = await streamTask(id, cmd, argv, cmd === 'winget' ? { shell: false, env: { ...process.env } } : {});
  auditDone(op, 'task:exe', kind, args, { ok: r.code === 0, exitCode: r.code }, t0);
  return r;
});

ipcMain.handle('winget:list', async () => {
  const r = await new Promise((resolve) => {
    const p = spawn('winget', ['upgrade', '--include-unknown', '--accept-source-agreements'], { windowsHide: true });
    const out = [];
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => out.push(d));
    p.on('error', err => resolve({ error: err.message, text: '' }));
    p.on('close', code => resolve({ code, text: Buffer.concat(out).toString('utf8') }));
  });
  if (r.error) return { error: 'winget not found: ' + r.error, items: [] };
  return { items: parseWingetTable(r.text) };
});

// Section 6.3: policy.cleaner.on/off override the defaults; lock pins the whole list.
ipcMain.handle('clean:categories', async () => {
  await licReady;
  const c = policyData().cleaner || {}, on = c.on || [], off = c.off || [], locked = c.lock === true;
  return CATEGORIES.map(({ id, group, name, desc, on: def, special }) => ({ id, group, name, desc, on: on.includes(id) ? true : off.includes(id) ? false : def, special: !!special, locked }));
});

ipcMain.handle('clean:scan', async () => {
  await licReady;
  const results = [];
  for (const cat of CATEGORIES) {
    send('task:line', { id: 'scan', line: 'Scanning ' + cat.name + '…' });
    if (cat.special === 'recycle') {
      try { const rb = await psJson('recyclebin.ps1'); results.push({ id: cat.id, size: rb.size, count: rb.count, roots: ['Recycle Bin'] }); }
      catch (e) { results.push({ id: cat.id, size: 0, count: 0, roots: [], error: e.message }); }
      continue;
    }
    results.push({ id: cat.id, ...scanCategory(cat) });
  }
  return results;
});

ipcMain.handle('clean:run', async (e, ids) => {
  ids = Array.isArray(ids) ? ids : [];
  await licReady; if (tasksClosed) throw new Error('TIMEOUT: run is finishing');
  const op = guard('clean:run', ids, undefined, ids);
  const t0 = Date.now();
  const r = await cleanRun(ids);
  auditDone(op, 'clean:run', ids, undefined, { ok: true, freed: r.totalFreed, deleted: r.results.reduce((a, b) => a + (b.deleted || 0), 0), skipped: r.results.reduce((a, b) => a + (b.skipped || 0), 0) }, t0);
  return r;
});
async function cleanRun(ids) {
  const systemVolume = process.platform === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : os.homedir();
  const before = fs.statfsSync ? fs.statfsSync(systemVolume) : null;
  const out = [];
  for (const cat of CATEGORIES.filter(c => ids.includes(c.id))) {
    send('task:line', { id: 'clean', line: 'Cleaning ' + cat.name + '…' });
    if (cat.special === 'recycle') {
      try { const rb = await psJson('recyclebin.ps1', ['-Empty']); out.push({ id: cat.id, freed: rb.size, deleted: rb.count, skipped: 0 }); }
      catch (err) { out.push({ id: cat.id, freed: 0, deleted: 0, skipped: 0, error: err.message }); }
      continue;
    }
    const r = cleanCategory(cat, line => send('task:line', { id: 'clean', line }));
    send('task:line', { id: 'clean', line: `  ${cat.name}: freed ${(r.freed / 1048576).toFixed(0)} MB, ${r.deleted} files removed, ${r.skipped} in use` });
    out.push({ id: cat.id, ...r });
  }
  const after = fs.statfsSync ? fs.statfsSync(systemVolume) : null;
  const bsize = before ? before.bsize : 0;
  return { results: out, totalFreed: out.reduce((a, b) => a + b.freed, 0),
           freeBefore: before ? before.bavail * bsize : null, freeAfter: after ? after.bavail * bsize : null };
}

ipcMain.handle('shell:open', (e, target) => {
  if (/^ms-settings:/.test(target) || /^https?:/.test(target)) return shell.openExternal(target);
  if (target === 'taskmgr-startup') { spawn(path.join(SYS32, 'Taskmgr.exe'), ['/0', '/startup'], { detached: true, stdio: 'ignore' }).unref(); return true; }
  if (target === 'cleanmgr') { spawn(path.join(SYS32, 'cleanmgr.exe'), ['/d', 'C:'], { detached: true, stdio: 'ignore' }).unref(); return true; }
  if (target === 'eventvwr') { spawn(path.join(SYS32, 'eventvwr.exe'), [], { detached: true, stdio: 'ignore' }).unref(); return true; }
  if (target === 'reliability') { spawn(path.join(SYS32, 'perfmon.exe'), ['/rel'], { detached: true, stdio: 'ignore' }).unref(); return true; }
  if (target === 'msinfo') { spawn(path.join(SYS32, 'msinfo32.exe'), [], { detached: true, stdio: 'ignore' }).unref(); return true; }
  if (target === 'devmgmt') { spawn(path.join(SYS32, 'mmc.exe'), [path.join(SYS32, 'devmgmt.msc')], { detached: true, stdio: 'ignore' }).unref(); return true; }
  return shell.openPath(target);
});

// Recovery is a separate audited engine. No renderer-provided executable or shell command.
ipcMain.handle('recovery:status', async () => ({ platform: process.platform, bundled: RECOVERY.detectBundledEngine('photorec'), gui: RECOVERY.detectBundledEngine(), windowsFileRecovery: await RECOVERY.detectEngine() }));
ipcMain.handle('recovery:pickImage', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Disk images', extensions: ['img', 'dd', 'raw'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('recovery:pickDestination', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('recovery:plan', async (e, options = {}) => options.kind === 'image'
  ? RECOVERY.planImage({ source: options.source, destination: options.destination, fileTypes: options.fileTypes })
  : RECOVERY.plan({ source: options.source, destination: options.destination, mode: options.mode, filters: options.filters }));
ipcMain.handle('recovery:run', async (e, options = {}) => {
  await licReady;
  const op = guard('recovery:run', options.kind, undefined, { engine: options.kind });
  if (tasksClosed) throw new Error('TIMEOUT: run is finishing');
  const id = typeof options.id === 'string' && /^t\d+$/.test(options.id) ? options.id : 'recovery';
  if (running.has(id)) throw new Error('RECOVERY_BUSY');
  const request = options.kind === 'image'
    ? { source: options.source, destination: options.destination, fileTypes: options.fileTypes }
    : { source: options.source, destination: options.destination, mode: options.mode, filters: options.filters };
  const plan = options.kind === 'image' ? RECOVERY.planImage(request) : await RECOVERY.plan(request);
  if (!plan.ok) throw new Error(plan.code + ': ' + plan.message);
  if (plan.requiresAdministrator && !isElevated()) throw new Error('ADMIN_REQUIRED: Restart as administrator first.');
  const consent = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Recover files'], defaultId: 0, cancelId: 0,
    message: 'Start file recovery?', detail: `Source: ${plan.source}\nDestination: ${plan.destination}\n\n${plan.limitations}\nThe source is read only. Save drive recovery to a separate physical drive.` });
  if (consent.response !== 1) return { ok: false, status: 'cancelled', code: null };
  const t0 = Date.now();
  const callbacks = { onProgress: p => { if (p.text || p.line) send('task:line', { id, line: p.text || p.line }); } };
  const handle = options.kind === 'image' ? RECOVERY.runImage(request, callbacks) : RECOVERY.run(request, callbacks);
  running.set(id, { kill: () => handle.cancel() });
  try {
    const result = await handle.result;
    auditDone(op, 'recovery:run', options.kind, undefined, { ok: result.ok, exitCode: result.code, status: result.status }, t0);
    return result;
  } finally { running.delete(id); }
});
ipcMain.handle('recovery:launch', async () => {
  await licReady; guard('recovery:launch');
  const engine = RECOVERY.detectBundledEngine();
  if (!engine.ok) throw new Error(engine.code + ': ' + engine.message);
  const consent = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Open recovery tool'], defaultId: 0, cancelId: 0,
    message: 'Open QPhotoRec for drive recovery?', detail: 'Choose the drive to scan and save recovered files to another physical drive. Recovery is best effort. QPhotoRec is a separate open-source tool by CGSecurity; Windows may request administrator access.' });
  if (consent.response !== 1) return { ok: false, cancelled: true };
  const error = await shell.openPath(engine.executable);
  return { ok: !error, error: error || null, launched: !error };
});
ipcMain.handle('disk:analyze', async (e, { id = 'disk', root } = {}) => {
  await licReady; guard('disk:analyze'); cancelled.delete(id);
  return PLATFORM.analyzeDisk(root, { shouldCancel: () => cancelled.has(id) });
});
ipcMain.handle('privacy:scan', () => PRIVACY.scan());
ipcMain.handle('privacy:clean', async (e, selection) => {
  await licReady; guard('privacy:clean');
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Clear selected data'], defaultId: 0, cancelId: 0,
    message: 'Clear selected browsing history and advertising-tracker cookies?', detail: 'This cannot be undone. Close the selected browsers first. Passwords, bookmarks and ordinary login cookies are excluded.' });
  return r.response === 1 ? PRIVACY.clean(selection) : { ok: false, cancelled: true };
});
ipcMain.handle('performance:list', () => PERFORMANCE.list());
ipcMain.handle('performance:pause', async (e, pid) => {
  await licReady; guard('performance:pause');
  if (shuttingDown) throw new Error('SHUTTING_DOWN');
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Pause app'], defaultId: 0, cancelId: 0,
    message: 'Pause this optional background app?', detail: 'The app cannot play audio, sync or handle background work while paused. NodeMend will resume it on normal exit. A crash or force quit may leave it paused until restarted.' });
  if (shuttingDown) throw new Error('SHUTTING_DOWN');
  return r.response === 1 ? PERFORMANCE.pause(pid) : { ok: false, cancelled: true };
});
// Resume is a safety undo: allowed even if a license expires while an app is paused.
ipcMain.handle('performance:resume', (e, pid) => PERFORMANCE.resume(pid));
ipcMain.handle('performance:resumeAll', () => PERFORMANCE.resumeAll());
ipcMain.handle('smart:status', () => SMART.status());
ipcMain.handle('smart:configure', async (e, config) => {
  await licReady;
  if (config?.enabled !== false) guard('smart:configure');
  return SMART.configure(config);
});

ipcMain.handle('dialog:saveText', async (e, { defaultName, text }) => {
  const filters = /\.json$/i.test(defaultName || '') ? [{ name: 'JSON', extensions: ['json'] }, { name: 'Text', extensions: ['txt', 'md'] }] : [{ name: 'Text', extensions: ['txt', 'md'] }, { name: 'JSON', extensions: ['json'] }];
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text, 'utf8');
  return r.filePath;
});

// ---------------------------------------------------------------- duplicate finder
// Three passes: size buckets -> quick hash (first + last 64 KB) -> full SHA-256. Only files
// that still collide after the full hash are reported. Never follows reparse points.
const crypto = require('crypto');
const DUP_SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', 'windows', 'appdata', '.vscode', '.gradle', '.nuget', '.m2', '.cache']);

function defaultDupRoots() {
  const out = [];
  for (const k of ['desktop', 'documents', 'downloads', 'pictures', 'videos', 'music']) {
    try { const p = app.getPath(k); if (p && fs.existsSync(p) && !out.includes(p)) out.push(p); } catch { /* not available */ }
  }
  return out;
}

const tick = () => new Promise(r => setImmediate(r));

async function walkForDup(root, minSize, id, stats) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    if (cancelled.has(id)) break;
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink() || isProtected(full)) continue;
      if (e.isDirectory()) { if (!DUP_SKIP_DIRS.has(e.name.toLowerCase())) stack.push(full); continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      stats.seen++;
      if (st.size >= minSize) files.push({ p: full, s: st.size, m: st.mtimeMs });
    }
    if (++stats.dirs % 200 === 0) { send('task:line', { id, line: `  scanned ${stats.dirs.toLocaleString()} folders, ${stats.seen.toLocaleString()} files…` }); await tick(); }
  }
  return files;
}

function hashRange(file, size, algo, quick) {
  return new Promise((resolve) => {
    const h = crypto.createHash(algo);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      if (quick) {
        const n = 65536; const buf = Buffer.alloc(Math.min(n, size));
        fs.readSync(fd, buf, 0, buf.length, 0); h.update(buf);
        if (size > n) { const tail = Buffer.alloc(n); fs.readSync(fd, tail, 0, n, size - n); h.update(tail); }
        fs.closeSync(fd); resolve(h.digest('hex'));
      } else {
        fs.closeSync(fd);
        const s = fs.createReadStream(file, { highWaterMark: 1 << 20 });
        s.on('data', d => h.update(d)); s.on('end', () => resolve(h.digest('hex'))); s.on('error', () => resolve(null));
      }
    } catch { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ } resolve(null); }
  });
}

ipcMain.handle('dup:defaults', () => defaultDupRoots());
ipcMain.handle('dialog:pickFolders', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dup:scan', async (e, { id, roots, minSize }) => {
  cancelled.delete(id);
  const stats = { dirs: 0, seen: 0 };
  let files = [];
  for (const r of roots) { send('task:line', { id, line: 'Walking ' + r }); files = files.concat(await walkForDup(r, minSize || 1, id, stats)); }
  // pass 1: size buckets
  const bySize = new Map();
  for (const f of files) { (bySize.get(f.s) || bySize.set(f.s, []).get(f.s)).push(f); }
  let cands = [].concat(...[...bySize.values()].filter(l => l.length > 1));
  send('task:line', { id, line: `${files.length.toLocaleString()} files ≥ min size; ${cands.length.toLocaleString()} share a size with another file. Quick-hashing…` });
  // pass 2: quick hash
  const byQuick = new Map(); let n = 0;
  for (const f of cands) {
    if (cancelled.has(id)) break;
    const q = await hashRange(f.p, f.s, 'sha1', true); if (!q) continue;
    const k = f.s + ':' + q; (byQuick.get(k) || byQuick.set(k, []).get(k)).push(f);
    if (++n % 500 === 0) { send('task:line', { id, line: `  quick-hashed ${n}/${cands.length}` }); await tick(); }
  }
  cands = [].concat(...[...byQuick.values()].filter(l => l.length > 1));
  send('task:line', { id, line: `${cands.length.toLocaleString()} candidates after quick hash. Full-hashing (${fmtMB(cands.reduce((a, f) => a + f.s, 0))})…` });
  // pass 3: full hash
  const byFull = new Map(); n = 0; let bytes = 0;
  for (const f of cands) {
    if (cancelled.has(id)) break;
    const h = await hashRange(f.p, f.s, 'sha256', false); if (!h) continue;
    const k = f.s + ':' + h; (byFull.get(k) || byFull.set(k, []).get(k)).push(f);
    bytes += f.s;
    if (++n % 50 === 0) { send('task:line', { id, line: `  full-hashed ${n}/${cands.length} (${fmtMB(bytes)})` }); await tick(); }
  }
  const groups = [...byFull.entries()].filter(([, l]) => l.length > 1).map(([k, l]) => ({
    hash: k.split(':')[1], size: l[0].s, wasted: l[0].s * (l.length - 1),
    files: l.sort((a, b) => a.m - b.m || a.p.length - b.p.length).map(f => ({ path: f.p, mtime: f.m }))
  })).sort((a, b) => b.wasted - a.wasted);
  const wasCancelled = cancelled.has(id); cancelled.delete(id);
  return { groups, wasted: groups.reduce((a, g) => a + g.wasted, 0), filesScanned: stats.seen, foldersScanned: stats.dirs, cancelled: wasCancelled };
});

function fmtMB(b) { return b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + ' GB' : (b / 1048576).toFixed(0) + ' MB'; }

ipcMain.handle('dup:trash', async (e, paths) => {
  paths = Array.isArray(paths) ? paths : [];
  await licReady;
  const op = guard('dup:trash', paths, undefined, paths);
  const t0 = Date.now();
  let ok = 0, failed = 0, bytes = 0;
  for (const p of paths) {
    try { const st = fs.statSync(p); await shell.trashItem(p); ok++; bytes += st.size; }
    catch { failed++; }
  }
  auditDone(op, 'dup:trash', paths, undefined, { ok: failed === 0, freed: bytes, deleted: ok, skipped: failed }, t0);
  return { ok, failed, bytes };
});

// ---------------------------------------------------------------- licensing (sections 3, 4, 6)
// licState is the spec 4.3 payload; it is the single source of truth for guard(), the window
// title, app:info and the enterprise modules (through ctx.getLicenseState()). Defaults to
// Evaluation until resolveLicense() has run, so nothing machine-changing can slip through early.
const LIC_TARGET_SCOPES = ['exe', 'machine', 'user'];
let buildOverride = null;      // setBuildForTest (dev only)
let testLicense = undefined;   // setLicenseForTest: undefined = real discovery, string = inline token
let testPolicy = undefined;    // setPolicyForTest: undefined = real discovery, object = validated in place
let resolved = null;           // last lib/license resolve() result
let policyResult = null;       // last enterprise/policy load() result (null in Solo builds)
let activationsCache = null;   // count of <reportDir>\_activations files, refreshed in the background

const currentBuild = () => buildOverride || BUILD;
const productName = () => (currentBuild() === 'enterprise' ? 'NodeMend' : 'NodeMend Solo');
const dataDir = () => process.platform === 'win32' ? PATHS.dataDir({ app }) : app.getPath('userData');
const exeDir = () => PATHS.exeDir({ app });
const userDataDir = () => app.getPath('userData');
let licState = baseState();
function licKeys() {
  const keys = codec.PUBLIC_KEYS.slice();
  if (!app.isPackaged && process.env.TIDYWIN_TEST_PUBKEY) keys.push(process.env.TIDYWIN_TEST_PUBKEY); // dev/test only
  return keys;
}
function verifyText(text) { return codec.verifyToken(text, { keys: licKeys(), today: codec.today(), builtAt: BUILT_AT }); }

function baseState() {
  return { build: currentBuild(), productName: productName(), edition: 'evaluation', licensed: false, status: 'none', warnings: [], license: null,
    candidates: [], features: [], paidActions: GATE.LICENSE_GATED, policy: null, paths: {}, seats: { licensed: null, recorded: null }, elevated: false, links: BRAND.LINKS, publisher: BRAND.PUBLISHER,
    version: VERSION, builtAt: BUILT_AT, targets: null, unattended: null };
}

// The policy that is actually in force: loaded data when enforced and valid, else {} (allow-all).
function policyData() { return policyResult && policyResult.ok && policyResult.enforced && policyResult.data ? policyResult.data : {}; }
const licCtx = () => ({ edition: licState.edition, features: licState.features, policy: policyData() });
const policyCtx = () => ({ policy: policyData(), categories: CATEGORIES });

function discoverCtx() {
  const base = { argv: process.argv, env: process.env, exeDir: exeDir(), dataDir: dataDir(), userDataDir: userDataDir(), today: codec.today(),
    builtAt: BUILT_AT, keys: licKeys(), readFile: fs.promises.readFile, isPackaged: app.isPackaged };
  // Test hook: an inline token as the only candidate (no files, no env), or nothing at all.
  if (testLicense !== undefined) return { ...base, argv: testLicense ? ['--license', testLicense] : [], env: {}, exeDir: null, dataDir: null, userDataDir: null };
  return base;
}

async function loadPolicy() {
  if (!ENT) return null;
  if (testPolicy !== undefined && testPolicy !== null) {
    const v = ENT.policy.validate(testPolicy);
    return { path: '<test>', source: 'test', found: true, ok: v.ok, error: v.error, data: v.data, enforced: ENT.policy.enforced(ctx), candidates: [] };
  }
  return await ENT.policy.load(ctx);
}

// Section 3.4: <dataDir>\activation.json (userData fallback), written once per license id.
function activationFile() { return [path.join(dataDir(), 'activation.json'), path.join(userDataDir(), 'activation.json')].find(p => fs.existsSync(p)) || null; }
function writeActivation(record) {
  for (const d of [dataDir(), userDataDir()]) {
    try { fs.mkdirSync(d, { recursive: true }); return writeAtomic(path.join(d, 'activation.json'), JSON.stringify(record, null, 2) + '\n'); } catch { /* next */ }
  }
  return null;
}
function writeAtomic(file, text) { fs.writeFileSync(file + '.tmp', text, 'utf8'); fs.renameSync(file + '.tmp', file); return file; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }

// Sections 3.1-3.2 + 4.2 + 6.1, in one bounded pass. Policy enforcement depends on the edition
// and allowUserLicense depends on the policy, so the resolution runs twice only when a policy
// actually removes the userdata candidate.
let resolving = null;
function resolveLicense() {
  if (resolving) return resolving;
  resolving = (async () => {
    let cands = [];
    try { cands = await LIC.discover(discoverCtx()); } catch (e) { mainLog('license discovery failed: ' + e.message); }
    let r = LIC.resolve(cands, {});
    setState(r, await loadPolicyFor(r));
    const pd = policyData();
    if (pd.allowUserLicense === false && r.chosen && r.chosen.source === 'userdata') {
      r = LIC.resolve(cands, { policy: pd });
      setState(r, await loadPolicyFor(r));
    }
    recordActivation();
    applyTitle();
    refreshActivations();
    return licState;
  })().finally(() => { resolving = null; });
  return resolving;
}
async function loadPolicyFor(r) {
  // enforced() reads ctx.getLicenseState(), so the provisional state must be in place first.
  licState = buildState(r, null);
  policyResult = await loadPolicy();
  return policyResult;
}
function setState(r, pol) { resolved = r; policyResult = pol; licState = buildState(r, pol); }

// Open-source release (1.5.0): every build runs with its whole feature set and needs no key.
// A valid signed key is optional. It only supplies the licensee/brand shown in the title and
// reports; it can neither unlock nor restrict anything. lib/gate.js still refuses
// machine-changing calls while the state is the pre-resolution 'evaluation' default.
function openEdition(build) {
  const edition = build === 'enterprise' ? 'enterprise' : 'solo';
  return { edition, features: edition === 'enterprise' ? LIC.ALL_FEATURES.slice() : [], warnings: [] };
}

function buildState(r, pol) {
  const eff = openEdition(currentBuild());
  const lic = r.license ? { ...r.license } : null;
  const dd = dataDir(), reportDir = ENT ? safe(() => ENT.report.resolveDir(ctx).dir, null) : null;
  const s = {
    ...baseState(),
    edition: eff.edition, licensed: !!lic, status: r.status, warnings: eff.warnings,
    license: lic, candidates: r.candidates, features: eff.features,
    policy: pol && (pol.found || pol.error) ? { path: pol.path, source: pol.source, found: !!pol.found, ok: pol.ok, error: pol.error, data: pol.data, enforced: !!pol.enforced } : null,
    paths: { dataDir: dd, exeDir: exeDir(), userDataDir: userDataDir(), logDir: path.join(dd, 'logs'),
      auditDir: ENT && eff.features.includes('audit') ? safe(() => ENT.audit.dir(ctx), path.join(dd, 'audit')) : path.join(dd, 'audit'),
      reportDir, outboxDir: ENT ? safe(() => ENT.report.outboxDir(ctx, false), path.join(dd, 'outbox')) : null, localReportDir: ENT ? path.join(dd, 'reports') : null,
      activation: activationFile() },
    seats: { licensed: lic ? lic.seats : null, recorded: activationsCache },
    elevated: isElevated(),
    targets: LIC.writeTargets({ exeDir: exeDir(), dataDir: dd, userDataDir: userDataDir(), env: process.env, elevated: isElevated() }),
    unattended: ENT ? { commandLine: safe(() => ENT.unattended.commandLine(ctx).line, null), schedule: safe(() => ENT.unattended.commandLine(ctx).schedule, null), exitLegend: ENT.unattended.EXIT_LEGEND, profiles: ENT.PROFILES } : null,
    detail: r.detail || null
  };
  if (r.status !== 'valid' && r.statusOf) s.statusOf = r.statusOf;
  return s;
}
function safe(fn, fb) { try { return fn(); } catch { return fb; } }

function recordActivation() {
  const lic = licState.license;
  if (!lic) return;
  const existing = readJson(activationFile() || '');
  if (existing && existing.licenseId === lic.id) return;
  const rec = LIC.activationRecord(lic, { appVersion: VERSION, buildEdition: currentBuild() });
  const p = writeActivation(rec);
  if (p) { licState.paths.activation = p; mainLog(`activation recorded for ${lic.id} in ${p}`); }
}

// seats.recorded = files in <reportDir>\_activations; refreshed in the background (a dead UNC
// path must never stall license:state) and served from the cache.
function refreshActivations() {
  if (!ENT || !licState.features.includes('report') || !licState.paths.reportDir) { activationsCache = null; return; }
  ENT.report.status(ctx).then(st => { activationsCache = st.reachable ? st.activations : null; licState.seats.recorded = activationsCache; }).catch(() => {});
}

// Section 4.5 guard(): the ONLY place a machine-changing IPC is refused. Returns the audit opId
// for the 'start' line (null when the action is not audited) so the handler can log 'done'.
function guard(channel, a, b, target) {
  const actions = GATE.actionFor(channel, a, b, policyCtx());
  for (const action of actions) {
    const d = GATE.decide(action, licCtx());
    if (d) { audit('denied', { action, target: target === undefined ? null : target, reason: d }); throw new Error(d); }
  }
  const first = actions.find(auditedAction);
  return first ? audit('start', { action: first, target: target === undefined ? null : target }) : null;
}
// Machine-changing actions get start/done lines; feature checks and UI-only tokens do not.
function auditedAction(a) { const d = GATE.ACTIONS[a]; return !!(d && !d.feature && !d.renderer && !d.implicit && a !== 'user-license'); }
function audit(event, f) { return ENT ? ENT.audit.write(ctx, event, f) : null; }
function auditDone(opId, channel, a, b, result, t0) {
  if (!opId) return;
  const action = GATE.actionFor(channel, a, b, policyCtx()).find(auditedAction);
  audit('done', { opId, action, target: targetOf(channel, a, b), result, secs: Math.round((Date.now() - t0) / 1000) });
}

// Section 6.4 target rules: category ids, dup paths, { kind, id, name }, { name, hive, key, enable }, package id / '--all', ids / 'pending'.
function psArgs(args) { const o = {}; const a = Array.isArray(args) ? args.map(String) : []; for (let i = 0; i < a.length; i++) if (a[i].startsWith('-')) o[a[i].slice(1).toLowerCase()] = (i + 1 < a.length && !a[i + 1].startsWith('-')) ? a[++i] : true; return o; }
function targetOf(channel, a, b) {
  const s = String(a || '').toLowerCase();
  switch (channel) {
    case 'clean:run': case 'dup:trash': return Array.isArray(a) ? a : [];
    case 'task:exe': return a === 'winget-all' ? '--all' : a === 'winget-id' ? ((b && b.id) || null) : (b && b.drive) || null;
    case 'task:ps': {
      const o = psArgs(b);
      if (s === 'uninstall.ps1') return { kind: o.kind || null, id: o.id || null, name: o.name || null };
      if (s === 'wu-install.ps1') return o.ids ? String(o.ids).split(',').filter(Boolean) : 'pending';
      if (s === 'defender.ps1') return o.action || null;
      return null;
    }
    case 'ps:json': { if (s !== 'startup-toggle.ps1') return null; const o = psArgs(b); return { name: o.name || null, hive: o.hive || null, key: o.key || null, enable: /true/i.test(String(o.enable)) }; }
    default: return null;
  }
}

// Settings (License tab): userData\settings.json, only known keys, written on demand.
const SETTINGS_FILE = () => path.join(userDataDir(), 'settings.json');
const SETTINGS_KEYS = ['reportDir'];
function readSettings() { const o = readJson(SETTINGS_FILE()); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
function writeSettings(patch) {
  const cur = readSettings();
  for (const k of SETTINGS_KEYS) if (patch && k in patch) { const v = patch[k]; if (v == null || v === '') delete cur[k]; else cur[k] = String(v); }
  fs.mkdirSync(userDataDir(), { recursive: true });
  writeAtomic(SETTINGS_FILE(), JSON.stringify(cur, null, 2) + '\n');
  return cur;
}

// ctx: the contract every enterprise module runs against (see enterprise/index.js).
const ctx = {
  app, BrowserWindow, ipcMain, shell,
  paths: { dataDir, exeDir, userDataDir, resolveArgPath: p => PATHS.resolveArgPath(p, { app }), stamp: PATHS.stamp },
  cli,
  getLicenseState: () => licState,
  getPolicy: () => policyResult,
  setPolicy: p => { policyResult = p; licState = buildState(resolved || LIC.resolve([], {}), p); applyTitle(); },
  getSettings: readSettings,
  guard, isElevated, log: mainLog, running, send,
  setWindow: w => { win = w; },
  stopNewTasks: () => { tasksClosed = true; },
  runPs: psJson,
  verifyLicense: verifyText,
  writeActivation: record => writeActivation(record),
  hostname: os.hostname(), user: safe(() => os.userInfo().username, process.env.USERNAME || ''), version: VERSION, build: BUILD, productName: PRODUCT_NAME,
  builtAt: BUILT_AT, mode: cli.unattended ? 'unattended' : 'gui'
};

// ---- license IPC (section 3.3 and the License tab)
ipcMain.handle('license:state', async () => { await licReady; return licState; });
ipcMain.handle('license:reload', async () => { await licReady; await resolveLicense(); send('license:changed'); return licState; });

const publicPayload = p => p ? { id: p.id, edition: p.edition, licensee: p.licensee, email: p.email || null, seats: p.seats, issued: p.issued, expires: p.expires || null,
  maint: p.maint || null, features: p.features || null, brand: p.brand || null, notes: p.notes || null } : null;
ipcMain.handle('license:check', async (e, text) => {
  await licReady;
  const v = verifyText(String(text || ''));
  const eff = v.status === 'valid' ? LIC.effectiveEdition(currentBuild(), v.payload) : null;
  return { status: v.status, valid: v.status === 'valid', detail: v.detail || null, warnings: v.warnings || [], payload: publicPayload(v.payload),
    effective: eff ? { edition: eff.edition, features: eff.features, warnings: eff.warnings } : null };
});

ipcMain.handle('license:activate', async (e, { text, scope } = {}) => {
  await licReady;
  guard('license:activate', undefined, undefined, { scope });          // policy: user-license
  const v = verifyText(String(text || ''));
  if (v.status !== 'valid') return { ok: false, status: v.status, detail: v.detail || null };
  if (!LIC_TARGET_SCOPES.includes(scope)) return { ok: false, status: 'valid', error: 'unknown scope: ' + scope };
  if (scope === 'machine' && !isElevated()) return { ok: false, status: 'valid', error: 'machine-wide activation needs administrator rights', fallback: 'user' };
  const target = licState.targets[scope];
  if (!target) return { ok: false, status: 'valid', error: 'no target for scope ' + scope };
  const body = String(text).replace(/^\uFEFF/, '').trim() + '\n';    // stored as pasted (armor and all); normalize() handles it on read
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); writeAtomic(target, body); }
  catch (err) {
    const denied = ['EACCES', 'EROFS', 'EPERM'].includes(err.code);
    return { ok: false, status: 'valid', error: err.code || err.message, fallback: denied && scope !== 'user' ? 'user' : null };
  }
  await resolveLicense();
  audit('license-activate', { action: 'user-license', target: { scope, path: target, licenseId: v.payload.id }, result: { ok: true } });
  mainLog(`license ${v.payload.id} (${v.payload.edition}) written to ${target}`);
  send('license:changed');
  return { ok: true, path: target, scope, state: licState };
});

ipcMain.handle('license:remove', async () => {
  await licReady;
  const c = resolved && resolved.chosen;
  if (!c || !LIC.FILE_SOURCES.includes(c.source) || !c.path) return { ok: false, error: c ? 'license comes from ' + c.source + ' and cannot be removed here' : 'no license in effect' };
  const removed = { source: c.source, path: c.path, id: c.id };
  try { fs.unlinkSync(c.path); } catch (err) { return { ok: false, error: err.code || err.message, ...removed }; }
  await resolveLicense();
  audit('license-remove', { action: 'user-license', target: removed, result: { ok: true } });
  mainLog(`license ${removed.id || ''} removed from ${removed.path}`);
  send('license:changed');
  return { ok: true, ...removed, state: licState };
});

ipcMain.handle('dialog:openLicense', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'NodeMend license', extensions: ['lic', 'txt'] }, { name: 'All files', extensions: ['*'] }] });
  if (r.canceled || !r.filePaths.length) return null;
  const fd = fs.openSync(r.filePaths[0], 'r');
  try { const buf = Buffer.alloc(65536); const n = fs.readSync(fd, buf, 0, buf.length, 0); return buf.subarray(0, n).toString('utf8'); } // a key is < 1 KB; never slurp a stray big file
  finally { fs.closeSync(fd); }
});

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (e, obj) => { const s = writeSettings(obj || {}); refreshActivations(); return s; });

if (ENT) ENT.register({ ipcMain, ctx });

// ---- dev/test hooks (spec 10.2): no-ops returning false in packaged builds.
function setLicenseForTest(tokenOrNull) { if (app.isPackaged) return false; testLicense = tokenOrNull == null ? undefined : String(tokenOrNull); return app.isReady() ? resolveLicense() : true; }
function setPolicyForTest(objOrNull) { if (app.isPackaged) return false; testPolicy = objOrNull == null ? undefined : objOrNull; return app.isReady() ? resolveLicense() : true; }
function setBuildForTest(editionOrNull) { if (app.isPackaged) return false; buildOverride = editionOrNull === 'solo' || editionOrNull === 'enterprise' ? editionOrNull : null; return app.isReady() ? resolveLicense() : true; }
function getLicenseState() { return app.isPackaged ? false : licState; }

module.exports = { winQuote, relaunchArgs, parseWingetTable, CATEGORIES, setLicenseForTest, setPolicyForTest, setBuildForTest, getLicenseState, resolveLicense, guard }; // for smoke tests

// NodeMend — well-known paths (pure Node, no Electron imports)
// Every function takes an optional injected `o = { app, isPackaged, env, userDataDir }` so the
// same code runs under Electron (main.js passes `app`) and in plain-Node tests. Defaults come
// from process.env / process.execPath when nothing is injected.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomBytes } = require('crypto');

function envOf(o) { return (o && o.env) || process.env; }

function expandEnv(p, o) {
  const env = envOf(o);
  return String(p || '').replace(/%([^%]+)%/g, (_, k) => env[k] || env[k.toUpperCase()] || '');
}

// Directory the exe (or, in dev, the app) lives in: the thumb-drive slot for TidyWin.lic.
// PORTABLE_EXECUTABLE_DIR is set by the electron-builder portable launcher at runtime.
function exeDir(o = {}) {
  const env = envOf(o);
  if (env.PORTABLE_EXECUTABLE_DIR) return env.PORTABLE_EXECUTABLE_DIR;
  const packaged = o.isPackaged != null ? o.isPackaged : !!(o.app && o.app.isPackaged);
  if (packaged) return path.dirname(process.execPath);
  if (o.app && typeof o.app.getAppPath === 'function') return o.app.getAppPath();
  return o.appPath || path.resolve(__dirname, '..');
}

// Canonical machine-wide data dir: %ProgramData%\NodeMend (GPO/Intune drop location, audit,
// reports, logs). TIDYWIN_DATA_DIR overrides it only in dev/test (never when packaged).
function dataDir(o = {}) {
  const env = envOf(o);
  const packaged = o.isPackaged != null ? o.isPackaged : !!(o.app && o.app.isPackaged);
  if (!packaged && (env.NODEMEND_DATA_DIR || env.TIDYWIN_DATA_DIR)) return path.resolve(env.NODEMEND_DATA_DIR || env.TIDYWIN_DATA_DIR);
  return path.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'NodeMend');
}

// Electron's userData (folder build: %APPDATA%\nodemend; portable: %TEMP%\NodeMend-portable).
function userDataDir(o = {}) {
  if (o.userDataDir) return o.userDataDir;
  if (o.app && typeof o.app.getPath === 'function') return o.app.getPath('userData');
  const env = envOf(o);
  return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'nodemend');
}

// One-time same-volume directory move preserves every existing license, policy,
// report and ACL. Never merge over a nonempty destination or follow a junction.
// A conflict leaves both trees intact and is surfaced to the caller.
function migrateDirectory(legacy, destination) {
  legacy = path.resolve(legacy); destination = path.resolve(destination);
  if (path.dirname(legacy).toLowerCase() !== path.dirname(destination).toLowerCase() || legacy.toLowerCase() === destination.toLowerCase())
    throw new Error('INVALID_MIGRATION_PATH');
  function plainAncestors(target) {
    for (let p = target; ; p = path.dirname(p)) {
      try { const stat = fs.lstatSync(p); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('UNSAFE_MIGRATION_PATH'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (path.dirname(p) === p) break;
    }
  }
  try { fs.lstatSync(legacy); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { migrated: false, reason: 'absent' }; throw error; }
  plainAncestors(legacy); plainAncestors(destination);
  if (fs.existsSync(destination)) {
    if (fs.readdirSync(destination).length) return { migrated: false, reason: 'destination-exists', legacy, destination };
    fs.rmdirSync(destination); // empty directory only; never recursively delete user data
  }
  try { fs.renameSync(legacy, destination); }
  catch (error) { return { migrated: false, reason: error.code || 'move-failed', legacy, destination }; }
  return { migrated: true, legacy, destination };
}

function migrateLegacyData(o = {}) {
  const env = envOf(o), results = [];
  const packaged = o.isPackaged != null ? o.isPackaged : !!(o.app && o.app.isPackaged);
  if ((o.platform || process.platform) === 'win32' && (packaged || !(env.NODEMEND_DATA_DIR || env.TIDYWIN_DATA_DIR))) {
    const base = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
    results.push(migrateDirectory(path.join(base, 'TidyWin'), path.join(base, 'NodeMend')));
  }
  const appData = o.appData || (o.app && o.app.getPath && o.app.getPath('appData')) || env.APPDATA;
  if (appData && !env.PORTABLE_EXECUTABLE_DIR) {
    const destination = userDataDir(o);
    if (path.resolve(destination).toLowerCase() === path.resolve(appData, 'nodemend').toLowerCase())
      results.push(migrateDirectory(path.join(appData, 'tidywin'), destination));
  }
  if (env.PORTABLE_EXECUTABLE_DIR) {
    const base = o.tempDir || os.tmpdir();
    results.push(migrateDirectory(path.join(base, 'TidyWin-portable'), path.join(base, 'NodeMend-portable')));
  }
  return results;
}

// True when `dir` exists (created on demand) and a file can be written in it. accessSync(W_OK)
// only checks the read-only attribute on Windows, so a real probe file is used instead.
function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

// dataDir() when it is writable (normally: elevated), else the per-user userData fallback.
// `sub` (e.g. 'audit', 'reports', 'logs', 'outbox') is appended to whichever wins.
function writableDataDir(o = {}, sub) {
  const primary = dataDir(o);
  const base = isWritable(primary) ? primary : userDataDir(o);
  return sub ? path.join(base, sub) : base;
}

// CLI path arguments: %VAR% expanded; relative paths resolve against PORTABLE_EXECUTABLE_DIR
// (the portable launcher's cwd is %TEMP%\<unpackDirName>, which is useless to the user) or cwd.
function resolveArgPath(p, o = {}) {
  const env = envOf(o);
  const x = expandEnv(p, o);
  if (!x) return x;
  if (path.isAbsolute(x) || /^\\\\/.test(x)) return x; // untouched: normalize() appends '\' to a bare UNC share root
  return path.resolve(env.PORTABLE_EXECUTABLE_DIR || o.cwd || process.cwd(), x);
}

// Local timestamp for file names: yyyy-MM-dd_HHmm.
function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// Independent processes can finish at the same instant; a random run id prevents overwrites.
function runId() { return randomBytes(8).toString('hex'); }

module.exports = { exeDir, dataDir, userDataDir, migrateDirectory, migrateLegacyData, writableDataDir, isWritable, resolveArgPath, expandEnv, stamp, runId };

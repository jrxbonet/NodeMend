'use strict';

// Main-process dependencies only. Never forward renderer options into this factory.
// Audit exposes counts, never URLs, cookie values, or filesystem paths.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
let BuiltinDatabase;
try { BuiltinDatabase = require('node:sqlite').DatabaseSync; } catch { /* older Electron */ }

const TRACKERS = ['doubleclick.net', 'google-analytics.com', 'adnxs.com', 'criteo.com'];
const TRACKER_SQL = column => TRACKERS.map(() => `(lower(ltrim(${column}, '.')) = ? OR lower(ltrim(${column}, '.')) LIKE ?)`).join(' OR ');
const TRACKER_PARAMS = TRACKERS.flatMap(host => [host, '%.' + host]);

function knownRoots(platform = process.platform, home = os.homedir(), env = process.env) {
  const entry = (browser, kind, root) => ({ browser, kind, root });
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [entry('Chrome', 'chromium', path.join(local, 'Google', 'Chrome', 'User Data')),
      entry('Edge', 'chromium', path.join(local, 'Microsoft', 'Edge', 'User Data')),
      entry('Brave', 'chromium', path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')),
      entry('Firefox', 'firefox', path.join(roaming, 'Mozilla', 'Firefox', 'Profiles'))];
  }
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return [entry('Chrome', 'chromium', path.join(support, 'Google', 'Chrome')),
      entry('Edge', 'chromium', path.join(support, 'Microsoft Edge')),
      entry('Brave', 'chromium', path.join(support, 'BraveSoftware', 'Brave-Browser')),
      entry('Firefox', 'firefox', path.join(support, 'Firefox', 'Profiles'))];
  }
  if (platform === 'linux') {
    const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
    return [entry('Chrome', 'chromium', path.join(config, 'google-chrome')),
      entry('Edge', 'chromium', path.join(config, 'microsoft-edge')),
      entry('Brave', 'chromium', path.join(config, 'BraveSoftware', 'Brave-Browser')),
      entry('Firefox', 'firefox', path.join(home, '.mozilla', 'firefox'))];
  }
  return [];
}

// Reject symlinks/junctions at every ancestor, as well as hard-linked DBs and unsafe sidecars.
function safeStat(target, directory = false) {
  const full = path.resolve(target), parsed = path.parse(full);
  let current = parsed.root;
  for (const segment of full.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('UNSAFE_PATH');
    if (current !== full && !stat.isDirectory()) throw new Error('UNSAFE_PATH');
  }
  const stat = fs.lstatSync(full);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink > 1) throw new Error('UNSAFE_PATH');
  return stat;
}
function fingerprint(file) {
  return ['', '-wal', '-shm', '-journal'].map(suffix => {
    try {
      const stat = safeStat(file + suffix);
      return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
    } catch (error) { if (error.code === 'ENOENT' && suffix) return null; throw error; }
  });
}
function tables(db) { return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name)); }
function hasColumns(db, table, columns) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  return columns.every(column => present.has(column));
}
function supported(db, kind, mode) {
  const present = tables(db);
  if (mode === 'cookies') return present.has(kind === 'firefox' ? 'moz_cookies' : 'cookies') &&
    hasColumns(db, kind === 'firefox' ? 'moz_cookies' : 'cookies', [kind === 'firefox' ? 'host' : 'host_key']);
  if (kind === 'chromium') return present.has('urls') && present.has('visits') && hasColumns(db, 'urls', ['id']) && hasColumns(db, 'visits', ['url']);
  return present.has('moz_places') && present.has('moz_historyvisits') && present.has('moz_bookmarks') &&
    hasColumns(db, 'moz_places', ['id', 'visit_count', 'last_visit_date', 'frecency']) &&
    hasColumns(db, 'moz_historyvisits', ['place_id']) && hasColumns(db, 'moz_bookmarks', ['fk']);
}
function count(db, kind, mode) {
  if (mode === 'history') return Number(db.prepare(`SELECT count(*) AS n FROM ${kind === 'firefox' ? 'moz_historyvisits' : 'visits'}`).get().n);
  const table = kind === 'firefox' ? 'moz_cookies' : 'cookies', column = kind === 'firefox' ? 'host' : 'host_key';
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${TRACKER_SQL(column)}`).get(...TRACKER_PARAMS).n);
}
function erase(db, kind, mode) {
  if (mode === 'cookies') {
    const table = kind === 'firefox' ? 'moz_cookies' : 'cookies', column = kind === 'firefox' ? 'host' : 'host_key';
    return Number(db.prepare(`DELETE FROM ${table} WHERE ${TRACKER_SQL(column)}`).run(...TRACKER_PARAMS).changes);
  }
  if (kind === 'chromium') {
    const n = Number(db.prepare('DELETE FROM visits').run().changes);
    // Download tables, bookmarks (separate JSON), Login Data and sessions are never touched.
    db.exec('DELETE FROM urls');
    return n;
  }
  const n = Number(db.prepare('DELETE FROM moz_historyvisits').run().changes);
  db.exec('UPDATE moz_places SET visit_count = 0, last_visit_date = NULL, frecency = -1');
  // Keep bookmarked places and any places referenced by annotations/keywords. Unknown schemas
  // and browser-specific trigger failures roll back rather than bypassing integrity rules.
  const present = tables(db);
  let keep = 'id IN (SELECT fk FROM moz_bookmarks WHERE fk IS NOT NULL)';
  if (present.has('moz_annos')) keep += ' OR id IN (SELECT place_id FROM moz_annos)';
  if (present.has('moz_keywords')) keep += ' OR id IN (SELECT place_id FROM moz_keywords)';
  db.exec(`DELETE FROM moz_places WHERE NOT (${keep})`);
  return n;
}
const warningCode = error => error.message === 'UNSAFE_PATH' ? 'UNSAFE_PATH' :
  /locked|busy/i.test(String(error.message)) ? 'DATABASE_BUSY' : 'UNSUPPORTED_DATABASE';

function createPrivacyCleaner(options = {}) {
  const Database = Object.prototype.hasOwnProperty.call(options, 'DatabaseSync') ? options.DatabaseSync : BuiltinDatabase;
  const roots = options.roots || knownRoots(options.platform, options.home, options.env);
  const clock = options.now || Date.now;
  let plan = null;
  const closed = async browser => {
    if (typeof options.isBrowserClosed !== 'function') return false;
    try { return await options.isBrowserClosed(browser) === true; } catch { return false; }
  };
  const open = (file, readOnly) => {
    fingerprint(file);
    const db = new Database(file, { readOnly, allowExtension: false, enableForeignKeyConstraints: true, timeout: 1000 });
    try { db.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 1000;'); } catch (error) { db.close(); throw error; }
    return db;
  };
  async function scan() {
    plan = null;
    const result = { ok: !!Database, engineAvailable: !!Database, sessionId: null, profiles: [], warnings: [] };
    if (!Database) { result.warnings.push('ENGINE_UNAVAILABLE'); return result; }
    const session = { id: randomUUID(), created: clock(), profiles: new Map() };
    for (const root of roots) {
      if (!['chromium', 'firefox'].includes(root.kind)) continue;
      let entries;
      try { safeStat(root.root, true); entries = fs.readdirSync(root.root, { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') result.warnings.push(root.browser + ': UNSAFE_OR_UNREADABLE_ROOT'); continue; }
      const browserClosed = await closed(root.browser);
      for (const entry of entries) {
        if (root.kind === 'chromium' && !/^(Default|Profile \d+)$/.test(entry.name)) continue;
        if (root.kind === 'firefox' && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const folder = path.join(root.root, entry.name);
        try { safeStat(folder, true); } catch { result.warnings.push(root.browser + ': UNSAFE_PROFILE'); continue; }
        const files = root.kind === 'firefox' ? [['history', 'places.sqlite'], ['cookies', 'cookies.sqlite']] :
          [['history', 'History'], ['cookies', path.join('Network', 'Cookies')], ['cookies', 'Cookies']];
        const profile = { id: randomUUID(), browser: root.browser, history: 0, trackerCookies: 0, warnings: [] };
        const trusted = { browser: root.browser, kind: root.kind, folder, files: [] };
        if (!browserClosed) { profile.warnings.push('BROWSER_MUST_BE_CLOSED'); result.profiles.push(profile); continue; }
        let cookieFound = false;
        for (const [mode, relative] of files) {
          if (mode === 'cookies' && cookieFound) continue;
          const file = path.join(folder, relative);
          let db;
          try {
            db = open(file, true);
            if (!supported(db, root.kind, mode)) { profile.warnings.push(mode + ': UNSUPPORTED_DATABASE'); continue; }
            const n = count(db, root.kind, mode);
            if (mode === 'cookies') { cookieFound = true; profile.trackerCookies = n; } else profile.history = n;
            trusted.files.push({ file, mode });
          } catch (error) { if (error.code !== 'ENOENT') profile.warnings.push(mode + ': ' + warningCode(error)); }
          finally { if (db) db.close(); }
        }
        if (!trusted.files.length && !profile.warnings.length) continue;
        // Fingerprints after closing the read-only connections include any existing WAL sidecars.
        trusted.files = trusted.files.filter(item => {
          try { item.snapshot = JSON.stringify(fingerprint(item.file)); return true; }
          catch (error) { profile.warnings.push(item.mode + ': ' + warningCode(error)); return false; }
        });
        session.profiles.set(profile.id, trusted);
        result.profiles.push(profile);
      }
    }
    plan = session; result.sessionId = session.id;
    return result;
  }
  async function clean(selection) {
    const fail = code => ({ ok: false, code, historyDeleted: 0, trackerCookiesDeleted: 0, profiles: [] });
    if (!Database) return fail('ENGINE_UNAVAILABLE');
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
        Object.keys(selection).some(key => !['sessionId', 'profiles'].includes(key)) || !Array.isArray(selection.profiles) ||
        selection.profiles.length < 1 || selection.profiles.length > 100) return fail('INVALID_SELECTION');
    if (!plan || selection.sessionId !== plan.id || clock() - plan.created > 10 * 60 * 1000) return fail('STALE_PLAN');
    const seen = new Set();
    for (const item of selection.profiles) {
      if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['id', 'history', 'trackerCookies'].includes(key)) ||
          !plan.profiles.has(item.id) || seen.has(item.id) ||
          (item.history !== undefined && typeof item.history !== 'boolean') ||
          (item.trackerCookies !== undefined && typeof item.trackerCookies !== 'boolean') ||
          (!item.history && !item.trackerCookies)) return fail('INVALID_SELECTION');
      seen.add(item.id);
    }
    const session = plan; plan = null; // one attempt, even if the browser opens or a DB changes
    const result = { ok: true, historyDeleted: 0, trackerCookiesDeleted: 0, profiles: [] };
    for (const item of selection.profiles) {
      const trusted = session.profiles.get(item.id);
      const out = { id: item.id, historyDeleted: 0, trackerCookiesDeleted: 0, errors: [] };
      result.profiles.push(out);
      if (!await closed(trusted.browser)) { out.errors.push('BROWSER_MUST_BE_CLOSED'); result.ok = false; continue; }
      for (const mode of ['history', 'cookies']) {
        if ((mode === 'history' ? item.history : item.trackerCookies) && !trusted.files.some(file => file.mode === mode))
          out.errors.push(mode + ': DATABASE_UNAVAILABLE');
      }
      for (const stored of trusted.files) {
        if (!(stored.mode === 'history' ? item.history : item.trackerCookies)) continue;
        let db;
        try {
          safeStat(trusted.folder, true);
          if (JSON.stringify(fingerprint(stored.file)) !== stored.snapshot) { out.errors.push(stored.mode + ': DATABASE_CHANGED_RESCAN'); continue; }
          db = open(stored.file, false);
          db.exec('BEGIN IMMEDIATE');
          if (!supported(db, trusted.kind, stored.mode)) throw new Error('UNSUPPORTED_DATABASE');
          const n = erase(db, trusted.kind, stored.mode);
          db.exec('COMMIT');
          if (stored.mode === 'history') out.historyDeleted += n; else out.trackerCookiesDeleted += n;
        } catch (error) {
          if (db) { try { db.exec('ROLLBACK'); } catch { /* transaction did not begin */ } }
          out.errors.push(stored.mode + ': ' + warningCode(error));
        } finally { if (db) db.close(); }
      }
      if (out.errors.length) result.ok = false;
      result.historyDeleted += out.historyDeleted;
      result.trackerCookiesDeleted += out.trackerCookiesDeleted;
    }
    return result;
  }
  return { scan, clean };
}

module.exports = { createPrivacyCleaner, knownRoots, TRACKERS };

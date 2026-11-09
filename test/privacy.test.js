'use strict';
// Only isolated temporary fixtures are opened; never use the current user's browser roots.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createPrivacyCleaner, knownRoots } = require('../lib/privacy');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tidywin-privacy-test-'));
const tests = [];
const test = (name, run) => tests.push({ name, run });
let fixtureIndex = 0;
function database(file, sql) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try { db.exec(sql); } finally { db.close(); }
}
function scalar(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Object.values(db.prepare(sql).get())[0]; } finally { db.close(); }
}
function fixture() {
  const base = path.join(temp, String(++fixtureIndex));
  const chromeRoot = path.join(base, 'Chrome'), firefoxRoot = path.join(base, 'Firefox');
  const chrome = path.join(chromeRoot, 'Default'), firefox = path.join(firefoxRoot, 'abc.default-release');
  const history = path.join(chrome, 'History'), cookies = path.join(chrome, 'Network', 'Cookies');
  const places = path.join(firefox, 'places.sqlite'), firefoxCookies = path.join(firefox, 'cookies.sqlite');
  database(history, `CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT); CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER REFERENCES urls(id));
    INSERT INTO urls VALUES(1,'https://private.example/secret'); INSERT INTO visits VALUES(1,1),(2,1);
    CREATE TABLE downloads(id INTEGER PRIMARY KEY, target_path TEXT); INSERT INTO downloads VALUES(1,'preserved-download');`);
  const hosts = ['.doubleclick.net', 'ads.doubleclick.net', 'google-analytics.com', '.adnxs.com', 'x.criteo.com',
    'accounts.google.com', '.google.com', 'login.example.com', 'doubleclick.net.evil.example', 'notdoubleclick.net'];
  database(cookies, 'CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT);');
  const cookieDb = new DatabaseSync(cookies);
  try { for (const host of hosts) cookieDb.prepare('INSERT INTO cookies VALUES(?,?,?)').run(host, 'sid', 'private-cookie-value'); }
  finally { cookieDb.close(); }
  database(path.join(chrome, 'Login Data'), "CREATE TABLE logins(password_value TEXT); INSERT INTO logins VALUES('saved-password');");
  fs.writeFileSync(path.join(chrome, 'Bookmarks'), '{"bookmark":"saved"}');
  database(places, `CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER, last_visit_date INTEGER, frecency INTEGER);
    CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY, place_id INTEGER REFERENCES moz_places(id));
    CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY, fk INTEGER REFERENCES moz_places(id));
    INSERT INTO moz_places VALUES(1,'https://bookmark.example',1,100,10),(2,'https://history.example',1,100,10);
    INSERT INTO moz_historyvisits VALUES(1,1),(2,2); INSERT INTO moz_bookmarks VALUES(1,1);`);
  database(firefoxCookies, "CREATE TABLE moz_cookies(host TEXT, value TEXT); INSERT INTO moz_cookies VALUES('.criteo.com','tracker'),('accounts.google.com','login');");
  fs.writeFileSync(path.join(firefox, 'logins.json'), '{"encryptedPassword":"keep"}');
  const roots = [{ browser: 'Chrome', kind: 'chromium', root: chromeRoot }, { browser: 'Firefox', kind: 'firefox', root: firefoxRoot }];
  const factory = extra => createPrivacyCleaner({ roots, isBrowserClosed: async () => true, ...extra });
  return { base, chromeRoot, firefoxRoot, chrome, firefox, history, cookies, places, firefoxCookies, roots, factory };
}
function selection(scan, browser, extra = {}) {
  return { sessionId: scan.sessionId, profiles: scan.profiles.filter(profile => !browser || profile.browser === browser)
    .map(profile => ({ id: profile.id, history: true, trackerCookies: true, ...extra })) };
}
test('known roots cover Windows, macOS, Linux and restrict unsupported platforms', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const roots = knownRoots(platform, temp, {});
    assert.deepStrictEqual(roots.map(root => root.browser), ['Chrome', 'Edge', 'Brave', 'Firefox']);
    assert.ok(roots.every(root => path.isAbsolute(root.root)));
  }
  assert.deepStrictEqual(knownRoots('unsupported', temp, {}), []);
});
test('read-only scan returns only counts and generated IDs', async () => {
  const f = fixture(), cleaner = f.factory(), before = fs.readFileSync(f.history);
  const scan = await cleaner.scan();
  assert.strictEqual(scan.ok, true); assert.strictEqual(scan.profiles.length, 2);
  assert.strictEqual(scan.profiles[0].history, 2); assert.strictEqual(scan.profiles[0].trackerCookies, 5);
  assert.strictEqual(scan.profiles[1].history, 2); assert.strictEqual(scan.profiles[1].trackerCookies, 1);
  assert.deepStrictEqual(fs.readFileSync(f.history), before);
  const serialized = JSON.stringify(scan);
  for (const secret of ['private.example', 'private-cookie-value', f.base, 'abc.default-release']) assert.ok(!serialized.includes(secret));
});
test('clean clears history and tracker cookies while preserving logins, bookmarks and downloads', async () => {
  const f = fixture(), cleaner = f.factory();
  const result = await cleaner.clean(selection(await cleaner.scan()));
  assert.strictEqual(result.ok, true); assert.strictEqual(result.historyDeleted, 4); assert.strictEqual(result.trackerCookiesDeleted, 6);
  assert.strictEqual(scalar(f.history, 'SELECT count(*) FROM visits'), 0);
  assert.strictEqual(scalar(f.history, 'SELECT count(*) FROM urls'), 0);
  assert.strictEqual(scalar(f.history, 'SELECT count(*) FROM downloads'), 1);
  assert.strictEqual(scalar(f.cookies, 'SELECT count(*) FROM cookies'), 5);
  assert.strictEqual(scalar(f.cookies, "SELECT count(*) FROM cookies WHERE host_key='accounts.google.com'"), 1);
  assert.strictEqual(scalar(path.join(f.chrome, 'Login Data'), 'SELECT password_value FROM logins'), 'saved-password');
  assert.strictEqual(fs.readFileSync(path.join(f.chrome, 'Bookmarks'), 'utf8'), '{"bookmark":"saved"}');
  assert.strictEqual(scalar(f.places, 'SELECT count(*) FROM moz_places'), 1);
  assert.strictEqual(scalar(f.places, 'SELECT count(*) FROM moz_bookmarks'), 1);
  assert.strictEqual(scalar(f.places, 'SELECT visit_count FROM moz_places'), 0);
  assert.strictEqual(scalar(f.firefoxCookies, 'SELECT count(*) FROM moz_cookies'), 1);
  assert.strictEqual(fs.readFileSync(path.join(f.firefox, 'logins.json'), 'utf8'), '{"encryptedPassword":"keep"}');
});
test('explicit consent selects individual profiles and data types', async () => {
  const f = fixture(), cleaner = f.factory();
  const result = await cleaner.clean(selection(await cleaner.scan(), 'Chrome', { history: false }));
  assert.strictEqual(result.ok, true); assert.strictEqual(result.historyDeleted, 0); assert.strictEqual(result.trackerCookiesDeleted, 5);
  assert.strictEqual(scalar(f.history, 'SELECT count(*) FROM visits'), 2);
  assert.strictEqual(scalar(f.places, 'SELECT count(*) FROM moz_historyvisits'), 2);
});
test('engine unavailable reports graceful refusal', async () => {
  const cleaner = createPrivacyCleaner({ roots: [], DatabaseSync: null });
  const scan = await cleaner.scan(); assert.strictEqual(scan.engineAvailable, false); assert.deepStrictEqual(scan.warnings, ['ENGINE_UNAVAILABLE']);
  assert.strictEqual((await cleaner.clean({})).code, 'ENGINE_UNAVAILABLE');
});
test('no browser checker defaults to refusal; opening browser after scan prevents clean', async () => {
  const f = fixture(), noChecker = createPrivacyCleaner({ roots: f.roots });
  const blocked = await noChecker.scan();
  assert.ok(blocked.profiles.every(profile => profile.warnings.includes('BROWSER_MUST_BE_CLOSED')));
  let closed = true;
  const cleaner = f.factory({ isBrowserClosed: async () => closed });
  const scan = await cleaner.scan(); closed = false;
  const result = await cleaner.clean(selection(scan));
  assert.strictEqual(result.ok, false); assert.ok(result.profiles.every(profile => profile.errors.includes('BROWSER_MUST_BE_CLOSED')));
  assert.strictEqual(scalar(f.history, 'SELECT count(*) FROM visits'), 2);
});
test('unknown IDs, renderer paths, duplicate IDs and wrong consent types refused', async () => {
  const f = fixture(), cleaner = f.factory(), scan = await cleaner.scan(), item = selection(scan, 'Chrome');
  assert.strictEqual((await cleaner.clean({ ...item, path: f.history })).code, 'INVALID_SELECTION');
  assert.strictEqual((await cleaner.clean({ ...item, profiles: [{ id: f.history, history: true }] })).code, 'INVALID_SELECTION');
  assert.strictEqual((await cleaner.clean({ ...item, profiles: [item.profiles[0], item.profiles[0]] })).code, 'INVALID_SELECTION');
  assert.strictEqual((await cleaner.clean({ ...item, profiles: [{ id: scan.profiles[0].id, history: 'true' }] })).code, 'INVALID_SELECTION');
});
test('plans are expiring, superseded and single-use', async () => {
  const f = fixture(); let now = 0;
  const cleaner = f.factory({ now: () => now });
  const first = await cleaner.scan(), second = await cleaner.scan();
  assert.strictEqual((await cleaner.clean(selection(first))).code, 'STALE_PLAN');
  now = 600001; assert.strictEqual((await cleaner.clean(selection(second))).code, 'STALE_PLAN');
  const third = await cleaner.scan(), request = selection(third, 'Chrome');
  assert.strictEqual((await cleaner.clean(request)).ok, true);
  assert.strictEqual((await cleaner.clean(request)).code, 'STALE_PLAN');
});
test('changed database must be rescanned and errors contain no private content', async () => {
  const f = fixture(), cleaner = f.factory(), scan = await cleaner.scan();
  const db = new DatabaseSync(f.history); db.exec("INSERT INTO visits VALUES(3,1)"); db.close();
  const result = await cleaner.clean(selection(scan, 'Chrome', { trackerCookies: false }));
  assert.strictEqual(result.ok, false); assert.deepStrictEqual(result.profiles[0].errors, ['history: DATABASE_CHANGED_RESCAN']);
  assert.strictEqual(scalar(f.history, 'SELECT count(*) FROM visits'), 3);
  assert.ok(!JSON.stringify(result).includes(f.history));
});
test('unsupported schemas warn instead of deleting', async () => {
  const f = fixture(); fs.unlinkSync(f.history); database(f.history, 'CREATE TABLE unknown(content TEXT);');
  const cleaner = f.factory(), scan = await cleaner.scan();
  assert.ok(scan.profiles[0].warnings.includes('history: UNSUPPORTED_DATABASE'));
  const result = await cleaner.clean(selection(scan, 'Chrome', { trackerCookies: false }));
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.profiles[0].errors, ['history: DATABASE_UNAVAILABLE']);
});
test('failed database transaction rolls back, preserving history rows', async () => {
  const f = fixture();
  const db = new DatabaseSync(f.history); db.exec("CREATE TRIGGER refuse BEFORE DELETE ON urls BEGIN SELECT RAISE(ABORT,'secret-content'); END;"); db.close();
  const cleaner = f.factory(), result = await cleaner.clean(selection(await cleaner.scan(), 'Chrome', { trackerCookies: false }));
  assert.strictEqual(result.ok, false); assert.strictEqual(result.historyDeleted, 0);
  assert.strictEqual(scalar(f.history, 'SELECT count(*) FROM visits'), 2);
  assert.ok(!JSON.stringify(result).includes('secret-content'));
});
test('hard-linked database is refused', async () => {
  const f = fixture(); fs.linkSync(f.history, path.join(f.base, 'linked-history'));
  const scan = await f.factory().scan(); assert.ok(scan.profiles[0].warnings.includes('history: UNSAFE_PATH'));
});
test('symlink profile and sidecar rejected where filesystem permits symlinks', async () => {
  const f = fixture();
  try {
    fs.symlinkSync(f.chrome, path.join(f.chromeRoot, 'Profile 1'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  let scan = await f.factory().scan(); assert.ok(scan.warnings.includes('Chrome: UNSAFE_PROFILE'));
  try { fs.symlinkSync(f.history, f.history + '-wal', 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
  scan = await f.factory().scan(); assert.ok(scan.profiles[0].warnings.includes('history: UNSAFE_PATH'));
});

(async () => {
  let failed = 0;
  try {
    for (const { name, run } of tests) {
      try { await run(); console.log('ok ' + name); }
      catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();

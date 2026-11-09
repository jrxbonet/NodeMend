// NodeMend — pure-Node tests for the licensing core (no Electron, < 2 s).
// Run: node test/license.test.js   (every line prints `ok <name>`; exits 1 on any FAIL)
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const codec = require('../lib/license-codec');
const lic = require('../lib/license');
const gate = require('../lib/gate');
const paths = require('../lib/paths');
const F = require('./fixtures').make();

const TODAY = '2026-09-16';
const KEYS = [F.pubHex];
const TMP = path.join(__dirname, 'tmp');
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const v = (t, extra) => codec.verifyToken(t, { keys: KEYS, today: TODAY, ...extra });

// ---------------------------------------------------------------- codec
test('roundtrip solo valid', () => assert.strictEqual(v(F.tokens.solo).status, 'valid'));
test('roundtrip ent valid', () => { const r = v(F.tokens.ent); assert.strictEqual(r.status, 'valid'); assert.strictEqual(r.payload.seats, 250); assert.deepStrictEqual(r.warnings, []); });
test('wrapped ent valid', () => assert.strictEqual(v(F.wrap(F.tokens.ent)).status, 'valid'));
test('BOM-prefixed token valid', () => assert.strictEqual(v(String.fromCharCode(0xFEFF) + F.tokens.ent + '\r\n').status, 'valid'));
test('tampered -> signature', () => assert.strictEqual(v(F.tokens.tampered).status, 'signature'));
test('wrongKey -> signature', () => assert.strictEqual(v(F.tokens.wrongKey).status, 'signature'));
test('garbage -> format', () => assert.strictEqual(v(F.tokens.garbage).status, 'format'));
test('empty / null -> format', () => { assert.strictEqual(v('').status, 'format'); assert.strictEqual(v(null).status, 'format'); });
test('wrongProduct -> payload', () => { const r = v(F.tokens.wrongProduct); assert.strictEqual(r.status, 'payload'); assert.strictEqual(r.detail, 'product'); });
test('expired -> expired', () => { const r = v(F.tokens.expired); assert.strictEqual(r.status, 'expired'); assert.strictEqual(r.payload.expires, '2020-01-01'); });
test('maintOld + builtAt -> maint', () => assert.strictEqual(v(F.tokens.maintOld, { builtAt: '2026-09-16' }).status, 'maint'));
test('maintOld without builtAt -> valid', () => assert.strictEqual(v(F.tokens.maintOld, { builtAt: null }).status, 'valid'));
test('future -> valid + issued-in-future', () => { const r = v(F.tokens.future); assert.strictEqual(r.status, 'valid'); assert.ok(r.warnings.includes('issued-in-future')); });
test('expires in 10 days -> expires-soon', () => {
  const r = v(F.sign({ ...F.payloads.ent, expires: codec.addDays(TODAY, 10) }));
  assert.strictEqual(r.status, 'valid'); assert.ok(r.warnings.includes('expires-soon'));
});
test('expires in 31 days -> no warning', () => assert.deepStrictEqual(v(F.sign({ ...F.payloads.ent, expires: codec.addDays(TODAY, 31) })).warnings, []));
test('expires today -> still valid', () => assert.strictEqual(v(F.sign({ ...F.payloads.solo, expires: TODAY })).status, 'valid'));
test('no keys -> signature', () => assert.strictEqual(codec.verifyToken(F.tokens.solo, { keys: [], today: TODAY }).status, 'signature'));
test('bad key hex ignored', () => assert.strictEqual(codec.verifyToken(F.tokens.solo, { keys: ['zz', F.pubHex], today: TODAY }).status, 'valid'));
test('validatePayload rules', () => {
  const p = F.payloads.solo;
  assert.strictEqual(codec.validatePayload(p), null);
  assert.strictEqual(codec.validatePayload({ ...p, v: 2 }), 'v');
  assert.strictEqual(codec.validatePayload({ ...p, id: 'X' }), 'id');
  assert.strictEqual(codec.validatePayload({ ...p, edition: 'pro' }), 'edition');
  assert.strictEqual(codec.validatePayload({ ...p, licensee: ' ' }), 'licensee');
  assert.strictEqual(codec.validatePayload({ ...p, seats: 0 }), 'seats');
  assert.strictEqual(codec.validatePayload({ ...p, seats: 1.5 }), 'seats');
  assert.strictEqual(codec.validatePayload({ ...p, issued: '16/09/2026' }), 'issued');
  assert.strictEqual(codec.validatePayload({ ...p, expires: 'never' }), 'expires');
  assert.strictEqual(codec.validatePayload({ ...p, features: ['x'] }), 'features');
  assert.strictEqual(codec.validatePayload({ ...p, brand: 'acme' }), 'brand');
  assert.strictEqual(codec.validatePayload({ ...p, unknownField: 1 }), null);
  assert.strictEqual(v(F.sign({ ...p, seats: 'many' })).status, 'payload');
});
test('normalize strips armor, # lines, whitespace', () => assert.strictEqual(codec.normalize(F.wrap(F.tokens.solo)), F.tokens.solo));
test('decode without verify', () => { const d = codec.decode(F.tokens.tampered); assert.strictEqual(d.payload.seats, 9999); assert.strictEqual(codec.decode('x').error, 'format'); });
test('looksLikeToken', () => { assert.ok(codec.looksLikeToken(F.wrap(F.tokens.solo))); assert.ok(!codec.looksLikeToken('C:\\keys\\TidyWin.lic')); });
test('addDays / today', () => { assert.strictEqual(codec.addDays('2026-12-31', 1), '2027-01-01'); assert.match(codec.today(), /^\d{4}-\d{2}-\d{2}$/); });
test('worked example from spec 2.5 verifies', () => {
  const tok = 'TIDYWIN1.eyJ2IjoxLCJwcm9kdWN0IjoidGlkeXdpbiIsImlkIjoiVFctMjAyNi0wMDAwNDIiLCJlZGl0aW9uIjoiZW50ZXJwcmlzZSIsImxpY2Vuc2VlIjoiQ29udG9zbyBMdGQiLCJlbWFpbCI6Iml0QGNvbnRvc28uZXhhbXBsZSIsInNlYXRzIjoyNTAsImlzc3VlZCI6IjIwMjYtMDktMTYiLCJleHBpcmVzIjpudWxsLCJtYWludCI6IjIwMjctMDktMTYiLCJmZWF0dXJlcyI6WyJ1bmF0dGVuZGVkIiwicmVwb3J0IiwicG9saWN5IiwiYXVkaXQiLCJicmFuZCJdLCJicmFuZCI6eyJuYW1lIjoiTm9ydGh3aW5kIE1TUCIsInN1cHBvcnQiOiJoZWxwZGVza0Bub3J0aHdpbmQuZXhhbXBsZSJ9LCJub3RlcyI6IlBPIDQ0NzEifQ.9p0ctze1NDeGcgHgCvapwaGNbrAtln9Wf2WG9HIq1PVylCGF1uEpMxmdLu5CTJbqHdOe-AB99C35m75MVrQkCg';
  const r = codec.verifyToken(tok, { keys: ['5711e56256eea000cb1961e4b6350605fbf12b45819d140404eeaa343689d505'], today: TODAY, builtAt: TODAY });
  assert.strictEqual(r.status, 'valid'); assert.strictEqual(r.payload.id, 'TW-2026-000042');
});

// ---------------------------------------------------------------- effectiveEdition
test('effectiveEdition: 6 combinations', () => {
  const solo = F.payloads.solo, ent = F.payloads.ent;
  let r = lic.effectiveEdition('solo', null); assert.strictEqual(r.edition, 'evaluation'); assert.deepStrictEqual(r.features, []);
  r = lic.effectiveEdition('enterprise', null); assert.strictEqual(r.edition, 'evaluation');
  r = lic.effectiveEdition('solo', solo); assert.strictEqual(r.edition, 'solo'); assert.deepStrictEqual(r.warnings, []); assert.deepStrictEqual(r.features, []);
  r = lic.effectiveEdition('solo', ent); assert.strictEqual(r.edition, 'solo'); assert.ok(r.warnings.includes('enterprise-key-in-solo-build')); assert.deepStrictEqual(r.features, []);
  r = lic.effectiveEdition('enterprise', solo); assert.strictEqual(r.edition, 'solo'); assert.ok(r.warnings.includes('solo-key-in-enterprise-build'));
  r = lic.effectiveEdition('enterprise', ent); assert.strictEqual(r.edition, 'enterprise'); assert.deepStrictEqual(r.features, lic.ALL_FEATURES); assert.deepStrictEqual(r.warnings, []);
  r = lic.effectiveEdition('enterprise', F.payloads.entSubset); assert.deepStrictEqual(r.features, ['report', 'policy', 'audit', 'brand']);
});

// ---------------------------------------------------------------- discover / resolve (fake fs)
const DIRS = { exeDir: 'X:\\exe', dataDir: 'X:\\pd', userDataDir: 'X:\\ud' };
const fakeFs = files => p => { if (p in files) return Promise.resolve(files[p]); return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })); };
const ctx = (files, extra) => ({ argv: [], env: {}, ...DIRS, today: TODAY, builtAt: TODAY, keys: KEYS, readFile: fakeFs(files || {}), isPackaged: false, timeoutMs: 200, ...extra });
const at = (src, c) => c.find(x => x.source === src);
const P = { exe: 'X:\\exe\\TidyWin.lic', pd: 'X:\\pd\\TidyWin.lic', ud: 'X:\\ud\\TidyWin.lic' };

test('discover: five candidates in order, missing files', async () => {
  const c = await lic.discover(ctx());
  assert.deepStrictEqual(c.map(x => x.source), ['cli', 'env', 'exe', 'programdata', 'userdata']);
  assert.strictEqual(at('exe', c).path, P.exe); assert.strictEqual(at('exe', c).status, 'missing'); assert.strictEqual(at('exe', c).found, false);
  assert.strictEqual(at('cli', c).status, 'none');
  const r = lic.resolve(c, {}); assert.strictEqual(r.edition, 'evaluation'); assert.strictEqual(r.status, 'none'); assert.strictEqual(r.license, null);
});
test('resolve: cli token beats env beats files', async () => {
  const c = await lic.discover(ctx({ [P.exe]: F.wrap(F.tokens.ent) }, { argv: ['--license=' + F.tokens.solo], env: { TIDYWIN_LICENSE: F.tokens.ent } }));
  const r = lic.resolve(c, {}); assert.strictEqual(r.license.source, 'cli'); assert.strictEqual(r.edition, 'solo'); assert.strictEqual(r.license.path, null);
  const c2 = await lic.discover(ctx({ [P.exe]: F.wrap(F.tokens.ent) }, { env: { TIDYWIN_LICENSE: F.tokens.solo } }));
  assert.strictEqual(lic.resolve(c2, {}).license.source, 'env');
});
test('resolve: invalid cli falls through to files', async () => {
  const c = await lic.discover(ctx({ [P.pd]: F.tokens.solo }, { argv: ['--license', F.tokens.tampered] }));
  const r = lic.resolve(c, {}); assert.strictEqual(at('cli', c).status, 'signature'); assert.strictEqual(r.license.source, 'programdata');
});
test('cli/env path form is read from disk (relative -> PORTABLE_EXECUTABLE_DIR)', async () => {
  const c = await lic.discover(ctx({ 'X:\\usb\\k.lic': F.tokens.ent }, { argv: ['--license=k.lic'], env: { PORTABLE_EXECUTABLE_DIR: 'X:\\usb' } }));
  assert.strictEqual(at('cli', c).path, 'X:\\usb\\k.lic'); assert.strictEqual(lic.resolve(c, {}).license.source, 'cli');
});
test('resolve: valid enterprise in userdata beats valid solo in exe', async () => {
  const c = await lic.discover(ctx({ [P.exe]: F.tokens.solo, [P.ud]: F.tokens.ent }));
  const r = lic.resolve(c, {}); assert.strictEqual(r.edition, 'enterprise'); assert.strictEqual(r.license.source, 'userdata'); assert.strictEqual(r.license.path, P.ud);
});
test('resolve: ties keep table order (exe before programdata)', async () => {
  const c = await lic.discover(ctx({ [P.exe]: F.tokens.solo, [P.pd]: F.sign({ ...F.payloads.solo, id: 'TW-2026-000099' }) }));
  assert.strictEqual(lic.resolve(c, {}).license.source, 'exe');
});
test('resolve: expired in exe + valid solo in programdata -> solo, exe shows expired', async () => {
  const c = await lic.discover(ctx({ [P.exe]: F.tokens.expired, [P.pd]: F.tokens.solo }));
  const r = lic.resolve(c, {}); assert.strictEqual(r.edition, 'solo'); assert.strictEqual(r.license.source, 'programdata');
  assert.strictEqual(at('exe', r.candidates).status, 'expired'); assert.strictEqual(at('exe', r.candidates).found, true);
});
test('resolve: nothing valid -> evaluation with status of first found', async () => {
  const c = await lic.discover(ctx({ [P.pd]: F.tokens.tampered, [P.ud]: F.tokens.expired }));
  const r = lic.resolve(c, {}); assert.strictEqual(r.edition, 'evaluation'); assert.strictEqual(r.status, 'signature'); assert.strictEqual(r.license, null);
  const c2 = await lic.discover(ctx({ [P.ud]: F.tokens.expired }));
  assert.strictEqual(lic.resolve(c2, {}).status, 'expired');
});
test('resolve: allowUserLicense:false ignores userdata', async () => {
  const c = await lic.discover(ctx({ [P.ud]: F.tokens.ent }));
  assert.strictEqual(lic.resolve(c, {}).edition, 'enterprise');
  const r = lic.resolve(c, { policy: { allowUserLicense: false } });
  assert.strictEqual(r.edition, 'evaluation'); assert.strictEqual(r.status, 'none'); assert.strictEqual(at('userdata', r.candidates).ignored, true);
});
test('discover: slow read -> timeout, never blocks', async () => {
  const slow = p => p === P.exe ? new Promise(() => {}) : fakeFs({ [P.pd]: F.tokens.solo })(p);
  const t0 = Date.now();
  const c = await lic.discover(ctx({}, { readFile: slow, timeoutMs: 100 }));
  assert.ok(Date.now() - t0 < 1500); assert.strictEqual(at('exe', c).status, 'timeout'); assert.strictEqual(at('exe', c).found, false);
  assert.strictEqual(lic.resolve(c, {}).license.source, 'programdata');
  const c2 = await lic.discover(ctx({}, { readFile: () => new Promise(() => {}), timeoutMs: 50 }));
  assert.strictEqual(lic.resolve(c2, {}).status, 'timeout');
});
test('discover: throwing readFile -> missing', async () => {
  const c = await lic.discover(ctx({}, { readFile: () => { throw new Error('boom'); } }));
  assert.ok(c.slice(2).every(x => x.status === 'missing'));
});
test('discover with real fs via fixtures.writeAll', async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const fx = F.writeAll(path.join(TMP, 'fx'));
  assert.ok(fs.existsSync(fx['locked-unattended.json']));
  fs.mkdirSync(path.join(TMP, 'exe'), { recursive: true }); fs.copyFileSync(fx['ent.lic'], path.join(TMP, 'exe', 'TidyWin.lic'));
  const c = await lic.discover(ctx({}, { exeDir: path.join(TMP, 'exe'), dataDir: path.join(TMP, 'pd'), userDataDir: path.join(TMP, 'ud'), readFile: fs.promises.readFile, timeoutMs: 3000 }));
  const r = lic.resolve(c, {}); assert.strictEqual(r.edition, 'enterprise'); assert.strictEqual(r.license.source, 'exe');
  assert.strictEqual(r.license.brand.name, 'Northwind MSP'); assert.strictEqual(at('programdata', c).status, 'missing');
});
test('resolve license summary shape', async () => {
  const c = await lic.discover(ctx({ [P.exe]: F.tokens.ent }));
  const L = lic.resolve(c, {}).license;
  for (const k of ['id', 'edition', 'licensee', 'email', 'seats', 'issued', 'expires', 'maint', 'features', 'brand', 'source', 'path']) assert.ok(k in L, k);
  const s = lic.summarize(c[2]); assert.deepStrictEqual(Object.keys(s), ['source', 'path', 'found', 'status', 'edition', 'id', 'expires', 'maint', 'ignored']);
});
test('writeTargets + default scope', () => {
  let t = lic.writeTargets({ ...DIRS, env: { PORTABLE_EXECUTABLE_DIR: 'E:\\' }, elevated: true });
  assert.strictEqual(t.default, 'exe'); assert.strictEqual(t.exe, P.exe); assert.strictEqual(t.machine, P.pd); assert.strictEqual(t.user, P.ud);
  assert.strictEqual(lic.writeTargets({ ...DIRS, env: {}, elevated: true }).default, 'machine');
  assert.strictEqual(lic.writeTargets({ ...DIRS, env: {}, elevated: false }).default, 'user');
});
test('activationRecord', () => {
  const a = lic.activationRecord(F.payloads.ent, { hostname: 'PC1', user: 'joel', appVersion: '1.3.0', buildEdition: 'enterprise', now: new Date('2026-09-16T12:00:00Z') });
  assert.deepStrictEqual(a, { licenseId: 'TW-2026-000042', edition: 'enterprise', licensee: 'Contoso Ltd', seats: 250, hostname: 'PC1', user: 'joel', activatedAt: '2026-09-16T12:00:00.000Z', appVersion: '1.3.0', buildEdition: 'enterprise' });
  const b = lic.activationRecord(F.payloads.solo); assert.ok(b.hostname && b.user && b.activatedAt);
});
test('argValue forms', () => {
  assert.strictEqual(lic.argValue(['electron', '.', '--license=abc'], '--license'), 'abc');
  assert.strictEqual(lic.argValue(['--license', 'abc'], '--license'), 'abc');
  assert.strictEqual(lic.argValue(['--licensed=x'], '--license'), undefined);
  assert.strictEqual(lic.argValue(['--license'], '--license'), '');
});

// ---------------------------------------------------------------- gate
const GATED = ['advanced-clean', 'cleanmgr', 'dism-restore', 'dism-cleanup', 'sfc', 'wu-install', 'drivers-install', 'winget-upgrade', 'uninstall', 'startup-toggle', 'dup-trash', 'defender', 'maintenance', 'recovery', 'disk-analyze', 'privacy', 'performance', 'smart-clean'];
const E = { edition: 'evaluation', features: [], policy: null };
const S = { edition: 'solo', features: [], policy: null };
const X = { edition: 'enterprise', features: lic.ALL_FEATURES, policy: null };
test('gate.LICENSE_GATED matches the paid-action set', () => assert.deepStrictEqual([...gate.LICENSE_GATED].sort(), [...GATED].sort()));
test('gate.decide: paid actions x 3 editions', () => {
  for (const a of GATED) {
    assert.strictEqual(gate.decide(a, E), 'LICENSE_REQUIRED', a + ' eval');
    assert.strictEqual(gate.decide(a, S), null, a + ' solo');
    assert.strictEqual(gate.decide(a, X), null, a + ' ent');
  }
});
test('gate.decide: manual cleaning is free in all editions', () => {
  for (const a of ['clean', 'recycle']) for (const c of [E, S, X]) assert.strictEqual(gate.decide(a, c), null, a + ' ' + c.edition);
});
test('gate.decide: free cleaning retains enterprise policy controls', () => {
  for (const a of ['clean', 'recycle']) {
    assert.strictEqual(gate.decide(a, { ...X, policy: { disable: [a] } }), 'POLICY_DENIED:' + a);
    assert.strictEqual(gate.decide(a, { ...E, policy: { disable: [a] } }), null);
  }
});
test('gate.decide: policy denials only in enterprise with feature policy', () => {
  const pol = { disable: ['dup-trash', 'recycle', 'uninstall', 'defender', 'maintenance', 'recovery', 'user-license'] };
  assert.strictEqual(gate.decide('dup-trash', { ...X, policy: pol }), 'POLICY_DENIED:dup-trash');
  assert.strictEqual(gate.decide('recycle', { ...X, policy: pol }), 'POLICY_DENIED:recycle');
  assert.strictEqual(gate.decide('defender', { ...X, policy: pol }), 'POLICY_DENIED:defender');
  assert.strictEqual(gate.decide('maintenance', { ...X, policy: pol }), 'POLICY_DENIED:maintenance');
  assert.strictEqual(gate.decide('recovery', { ...X, policy: pol }), 'POLICY_DENIED:recovery');
  assert.strictEqual(gate.decide('user-license', { ...X, policy: pol }), 'POLICY_DENIED:user-license');
  assert.strictEqual(gate.decide('clean', { ...X, policy: pol }), null);
  assert.strictEqual(gate.decide('dup-trash', { ...S, policy: pol }), null);                               // solo ignores policy
  assert.strictEqual(gate.decide('dup-trash', { ...E, policy: pol }), 'LICENSE_REQUIRED');                 // license first
  assert.strictEqual(gate.decide('user-license', { ...E, policy: pol }), null);                            // policy-only token in eval
  assert.strictEqual(gate.decide('dup-trash', { edition: 'enterprise', features: ['report'], policy: pol }), null); // no policy feature
});
test('gate.decide: cleaner-lock', () => {
  assert.strictEqual(gate.decide('cleaner-lock', X), 'POLICY_DENIED:cleaner-lock');
  assert.strictEqual(gate.decide('cleaner-lock', S), null);
  assert.strictEqual(gate.decide('cleaner-lock', E), null);
});
test('gate.decide: enterprise features', () => {
  assert.strictEqual(gate.decide('feature:report', X), null);
  assert.strictEqual(gate.decide('feature:report', S), 'LICENSE_REQUIRED');
  assert.strictEqual(gate.decide('feature:report', E), 'LICENSE_REQUIRED');
  assert.strictEqual(gate.decide('feature:unattended', { edition: 'enterprise', features: ['report'], policy: null }), 'LICENSE_REQUIRED');
  assert.strictEqual(gate.decide('unknown-action', E), null);
});
test('gate.actionFor mapping', () => {
  const cats = [{ id: 'user-temp', on: true }, { id: 'npm', on: false }, { id: 'thumbs', on: true }, { id: 'recycle', on: false }];
  assert.deepStrictEqual(gate.actionFor('clean:run', ['user-temp']), ['clean']);
  assert.deepStrictEqual(gate.actionFor('clean:run', ['user-temp', 'recycle']), ['clean', 'recycle']);
  const locked = { policy: { cleaner: { on: ['npm'], off: ['thumbs'], lock: true } }, categories: cats };
  assert.deepStrictEqual(gate.actionFor('clean:run', ['user-temp', 'npm'], null, locked), ['clean', 'advanced-clean']);
  assert.deepStrictEqual(gate.actionFor('clean:run', ['thumbs'], null, locked), ['clean', 'cleaner-lock']);
  assert.deepStrictEqual(gate.actionFor('clean:run', ['recycle'], null, locked), ['clean', 'recycle', 'cleaner-lock']);
  assert.deepStrictEqual(gate.actionFor('clean:run', ['thumbs'], null, { policy: { cleaner: { lock: false } }, categories: cats }), ['clean']);
  assert.deepStrictEqual([...gate.allowedCategories(locked.policy, cats)].sort(), ['npm', 'user-temp']);
  assert.deepStrictEqual(gate.actionFor('task:ps', 'cleanmgr.ps1', []), ['cleanmgr']);
  assert.deepStrictEqual(gate.actionFor('task:ps', 'uninstall.ps1', ['-Kind', 'appx']), ['uninstall']);
  assert.deepStrictEqual(gate.actionFor('task:ps', 'wu-install.ps1', ['-Drivers']), ['drivers-install']);
  assert.deepStrictEqual(gate.actionFor('task:ps', 'wu-install.ps1', []), ['wu-install']);
  assert.deepStrictEqual(gate.actionFor('task:ps', 'defender.ps1', ['-Action', 'Update']), ['defender']);
  assert.deepStrictEqual(gate.actionFor('task:ps', 'diag.ps1', []), []);
  assert.throws(() => gate.actionFor('task:ps', '..\\..\\evil\\cleanmgr.ps1', []), /invalid script/);
  for (const k of ['dism-restore', 'dism-cleanup', 'sfc']) assert.deepStrictEqual(gate.actionFor('task:exe', k), [k]);
  assert.deepStrictEqual(gate.actionFor('task:exe', 'winget-all'), ['winget-upgrade']);
  assert.deepStrictEqual(gate.actionFor('task:exe', 'winget-id', { id: 'x' }), ['winget-upgrade']);
  for (const k of ['dism-scan', 'chkdsk']) assert.deepStrictEqual(gate.actionFor('task:exe', k), []);
  assert.deepStrictEqual(gate.actionFor('task:exe', 'maintenance'), ['maintenance']);
  assert.throws(() => gate.actionFor('task:exe', 'unknown'), /invalid exe/);
  for (const channel of ['recovery:run', 'recovery:launch']) assert.deepStrictEqual(gate.actionFor(channel), ['recovery']);
  for (const channel of ['recovery:status', 'recovery:plan']) assert.deepStrictEqual(gate.actionFor(channel), []);
  assert.deepStrictEqual(gate.actionFor('ps:json', 'startup-toggle.ps1', ['-Name', 'x', '-Hive', 'HKCU:', '-Key', 'Run', '-Enable', '$true']), ['startup-toggle']);
  assert.deepStrictEqual(gate.actionFor('ps:json', 'sysinfo.ps1'), []);
  assert.deepStrictEqual(gate.actionFor('dup:trash', ['C:\\a']), ['dup-trash']);
  assert.deepStrictEqual(gate.actionFor('license:activate'), ['user-license']);
  assert.deepStrictEqual(gate.actionFor('report:send'), ['feature:report']);
  assert.deepStrictEqual(gate.actionFor('policy:reload'), ['feature:policy']);
  assert.deepStrictEqual(gate.actionFor('audit:tail'), ['feature:audit']);
  assert.deepStrictEqual(gate.actionFor('schedule'), ['feature:unattended']);
  // channel-independent script table preserves policy and license enforcement
  assert.deepStrictEqual(gate.actionFor('ps:json', 'recyclebin.ps1', ['-Empty']), ['recycle']);
  assert.deepStrictEqual(gate.actionFor('task:ps', 'recyclebin.ps1', ['-Empty']), ['recycle']);
  assert.deepStrictEqual(gate.actionFor('ps:json', 'recyclebin.ps1', []), []);
  assert.deepStrictEqual(gate.actionFor('ps:json', 'uninstall.ps1', []), ['uninstall']);
  assert.deepStrictEqual(gate.actionFor('ps:json', 'cleanmgr.ps1', []), ['cleanmgr']);
  assert.deepStrictEqual(gate.actionFor('ps:json', 'wu-install.ps1', ['-Drivers']), ['drivers-install']);
  assert.throws(() => gate.actionFor('task:ps', 'startup-toggle.ps1', []), /invalid script arguments/);
  for (const ro of gate.READ_ONLY_SCRIPTS) assert.deepStrictEqual(gate.actionFor('ps:json', ro, []), []);
  assert.throws(() => gate.actionFor('ps:json', 'schedule.ps1', ['-Install']), /invalid script/);
  assert.throws(() => gate.actionFor('task:ps', 'schedule.ps1', ['-Status']), /invalid script/);
  assert.throws(() => gate.actionFor('task:ps', 'nope.ps1'), /invalid script/);
  assert.deepStrictEqual(gate.actionFor('clean:scan'), []);
  assert.deepStrictEqual(gate.actionFor('app:info'), []);
});
test('gate: public PS channels reject abbreviated parameters and script path escapes', () => {
  for (const channel of ['task:ps', 'ps:json']) {
    for (const arg of ['-E', '-Em', '-E:$true', '-EmptyExtra'])
      assert.throws(() => gate.actionFor(channel, 'recyclebin.ps1', [arg]), /invalid script arguments/);
    for (const arg of ['-D', '-Dr', '-Dr:$true', '-DriversExtra'])
      assert.throws(() => gate.actionFor(channel, 'wu-install.ps1', [arg]), /invalid script arguments/);
    for (const script of ['../recyclebin.ps1', '..\\recyclebin.ps1', './recyclebin.ps1', '.\\recyclebin.ps1',
      'C:\\evil\\recyclebin.ps1', 'C:recyclebin.ps1', '/tmp/recyclebin.ps1', '\\\\host\\recyclebin.ps1', 'recyclebin.ps1 ',
      'recyclebin.ps1:payload', '...ps1', null, { toString: () => 'recyclebin.ps1' }])
      assert.throws(() => gate.actionFor(channel, script, ['-Empty']), /invalid script/);
    for (const args of [['--%'], ['-Unknown'], ['-Empty', '$true'], ['-Empty', 'extra'], ['-Empty', '-empty'],
      ['-Empty:maybe'], ['-Empty:'], ['\u2013Empty'], [' -Empty'], ['-Empty\n'], ['-Empty', 1], '-Empty', {}, null])
      assert.throws(() => gate.actionFor(channel, 'recyclebin.ps1', args), /invalid script arguments/);
    for (const args of [['positional'], ['-Drive'], ['-Drive', '-Empty'], ['-Drive:-Empty'], ['-Drive', '\u2014Empty'],
      ['-Drive', 'C:', '-NoProfile'], ['-Drive', 'C:', 'unbound'], ['-Drive', 'C:', '-Drive', 'D:']])
      assert.throws(() => gate.actionFor(channel, 'cleanmgr.ps1', args), /invalid script arguments/);
    assert.throws(() => gate.actionFor(channel, 'sysinfo.ps1', ['-Days', '7']), /invalid script arguments/);
    assert.throws(() => gate.actionFor(channel, 'defender.ps1', ['-Update']), /invalid script arguments/);
    assert.throws(() => gate.actionFor(channel, 'defender.ps1', ['-Action', 'FullScan']), /invalid script arguments/);
    assert.throws(() => gate.actionFor(channel, 'diag.ps1', ['-Days', '7x']), /invalid script arguments/);
    assert.throws(() => gate.actionFor(channel, 'diag.ps1', ['-Days', '-7']), /invalid script arguments/);
    assert.throws(() => gate.actionFor(channel, 'startup-toggle.ps1', ['-Name', 'x']), /invalid script arguments/);
    assert.throws(() => gate.actionFor(channel, 'performance.ps1', ['-Action', 'Resume']), /invalid script/);
  }
});
test('gate: full PS parameter names, case, colon forms and current renderer arguments work', () => {
  for (const channel of ['task:ps', 'ps:json']) {
    assert.deepStrictEqual(gate.actionFor(channel, 'RECYCLEBIN.PS1', ['-EMPTY']), ['recycle']);
    assert.deepStrictEqual(gate.actionFor(channel, 'recyclebin.ps1', ['-Empty:$true']), ['recycle']);
    assert.deepStrictEqual(gate.actionFor(channel, 'recyclebin.ps1', ['-Empty:$FALSE']), []);
    assert.deepStrictEqual(gate.actionFor(channel, 'wu-install.ps1', ['-dRiVeRs:$TRUE', '-Ids', 'update-a,update-b']), ['drivers-install']);
    assert.deepStrictEqual(gate.actionFor(channel, 'wu-install.ps1', ['-Drivers:$false']), ['wu-install']);
    assert.deepStrictEqual(gate.actionFor(channel, 'wu-install.ps1', ['-Drivers', '-Ids:update-a,update-b']), ['drivers-install']);
    assert.deepStrictEqual(gate.actionFor(channel, 'defender.ps1', ['-Action:QuickScan']), ['defender']);
    assert.deepStrictEqual(gate.actionFor(channel, 'defender.ps1', ['-aCtIoN', 'uPdAtE']), ['defender']);
    assert.deepStrictEqual(gate.actionFor(channel, 'cleanmgr.ps1', ['-Drive:C:']), ['cleanmgr']);
    assert.deepStrictEqual(gate.actionFor(channel, 'diag.ps1', ['-Days', '14']), []);
    assert.deepStrictEqual(gate.actionFor(channel, 'startup-toggle.ps1', ['-Name', 'App With Spaces', '-Hive', 'HKCU:', '-Key', 'Run', '-Enable', '$false']), ['startup-toggle']);
    assert.deepStrictEqual(gate.actionFor(channel, 'startup-toggle.ps1', ['-Name:App', '-Hive:HKLM:', '-Key:StartupFolder', '-Enable:$TRUE']), ['startup-toggle']);
    assert.deepStrictEqual(gate.actionFor(channel, 'uninstall.ps1', ['-Kind', 'registry', '-Id', '{guid}', '-Silent']), ['uninstall']);
    assert.deepStrictEqual(gate.actionFor(channel, 'uninstall.ps1', ['-Kind', 'appx', '-Id', 'Package.Name']), ['uninstall']);
    for (const script of gate.READ_ONLY_SCRIPTS) assert.deepStrictEqual(gate.actionFor(channel, script), []);
  }
});
test('gate: full switches cannot bypass action policy or licensing', () => {
  const policy = { disable: ['recycle', 'drivers-install', 'wu-install'] };
  for (const channel of ['task:ps', 'ps:json']) {
    const actions = gate.actionFor(channel, 'recyclebin.ps1', ['-Empty:$true']);
    assert.strictEqual(gate.decide(actions[0], { ...X, policy }), 'POLICY_DENIED:recycle');
    for (const [args, action] of [[['-Drivers'], 'drivers-install'], [['-Drivers:$true'], 'drivers-install'], [['-Drivers:$false'], 'wu-install']]) {
      const classified = gate.actionFor(channel, 'wu-install.ps1', args);
      assert.deepStrictEqual(classified, [action]);
      assert.strictEqual(gate.decide(classified[0], { ...X, policy }), 'POLICY_DENIED:' + action);
      assert.strictEqual(gate.decide(classified[0], E), 'LICENSE_REQUIRED');
    }
  }
});
test('gate: guard walk (Free allows cleaning and scans, refuses paid extra actions)', () => {
  const walk = (ch, a, b, c) => { for (const act of gate.actionFor(ch, a, b, {})) { const d = gate.decide(act, c); if (d) return d; } return null; };
  assert.strictEqual(walk('clean:run', ['user-temp'], null, E), null);
  assert.strictEqual(walk('clean:run', [], null, E), null);
  assert.strictEqual(walk('clean:run', ['recycle'], null, E), null);
  for (const channel of ['task:ps', 'ps:json']) {
    assert.strictEqual(walk(channel, 'cleanmgr.ps1', [], E), 'LICENSE_REQUIRED');
    assert.strictEqual(walk(channel, 'recyclebin.ps1', ['-Empty'], E), null);
    for (const script of ['defender.ps1', 'uninstall.ps1', 'wu-install.ps1']) assert.strictEqual(walk(channel, script, [], E), 'LICENSE_REQUIRED');
    assert.strictEqual(walk(channel, 'startup-toggle.ps1', ['-Name', 'x', '-Hive', 'HKCU:', '-Key', 'Run', '-Enable', '$true'], E), 'LICENSE_REQUIRED');
  }
  for (const kind of ['sfc', 'maintenance', 'dism-restore', 'dism-cleanup', 'winget-all', 'winget-id']) assert.strictEqual(walk('task:exe', kind, null, E), 'LICENSE_REQUIRED');
  for (const kind of ['dism-scan', 'chkdsk']) assert.strictEqual(walk('task:exe', kind, null, E), null);
  for (const channel of ['dup:trash', 'recovery:run', 'recovery:launch']) assert.strictEqual(walk(channel, [], null, E), 'LICENSE_REQUIRED');
  for (const channel of ['recovery:status', 'recovery:plan']) assert.strictEqual(walk(channel, null, null, E), null);
  assert.strictEqual(walk('clean:scan', null, null, E), null);
  assert.strictEqual(walk('clean:run', ['recycle'], null, { ...X, policy: { disable: ['recycle'] } }), 'POLICY_DENIED:recycle');
  assert.strictEqual(walk('clean:run', ['user-temp'], null, S), null);
});

// ---------------------------------------------------------------- policy validation
test('policy: unknown keys ignored', () => { const r = gate.validatePolicy({ version: 1, bogus: 1, orgName: 'X' }); assert.ok(r.ok); assert.deepStrictEqual(r.data, { version: 1, orgName: 'X' }); });
test('policy: hideTabs string -> error, data allow-all', () => { const r = gate.validatePolicy({ hideTabs: 'x' }); assert.ok(!r.ok); assert.match(r.error, /hideTabs/); assert.deepStrictEqual(r.data, {}); });
test('policy: disable normalized to unique strings', () => { const r = gate.validatePolicy({ disable: ['clean', 'clean', ' recycle ', ''] }); assert.ok(r.ok); assert.deepStrictEqual(r.data.disable, ['clean', 'recycle']); });
test('policy: full example validates', () => {
  const r = gate.validatePolicy({ version: 1, orgName: 'Contoso IT', supportText: 's', hideTabs: ['programs'], disable: ['clean'], cleaner: { on: ['user-temp'], off: ['npm'], lock: true },
    defaults: { dupMinSize: 1048576 }, unattended: { allow: true, profile: 'quick', steps: ['diag'], timeoutMin: 150, requireElevation: false }, reportDir: '\\\\srv\\tidywin$', audit: { eventLog: false }, lockLicensePanel: false, allowUserLicense: true });
  assert.ok(r.ok, r.error); assert.strictEqual(r.data.cleaner.lock, true); assert.strictEqual(r.data.unattended.timeoutMin, 150); assert.strictEqual(r.data.reportDir, '\\\\srv\\tidywin$');
});
test('policy: wrong types rejected', () => {
  for (const bad of [null, [], 'x', { disable: 'clean' }, { cleaner: { lock: 'yes' } }, { unattended: { allow: 'no' } }, { audit: { eventLog: 1 } }, { defaults: { dupMinSize: '1' } }, { allowUserLicense: 'false' }, { version: '1' }])
    assert.ok(!gate.validatePolicy(bad).ok, JSON.stringify(bad));
  assert.ok(gate.validatePolicy(F.policies.locked).ok); assert.ok(gate.validatePolicy(F.policies.noUnattended).ok);
});

// ---------------------------------------------------------------- paths
test('paths.stamp format', () => assert.match(paths.stamp(new Date(2026, 8, 16, 3, 7)), /^2026-09-16_0307$/));
test('paths.resolveArgPath', () => {
  const e = { PORTABLE_EXECUTABLE_DIR: 'E:\\usb', TEMP: 'C:\\t' };
  assert.strictEqual(paths.resolveArgPath('rep', { env: e }), 'E:\\usb\\rep');
  assert.strictEqual(paths.resolveArgPath('C:\\x\\y', { env: e }), 'C:\\x\\y');
  assert.strictEqual(paths.resolveArgPath('\\\\srv\\share', { env: e }), '\\\\srv\\share');
  assert.strictEqual(paths.resolveArgPath('%TEMP%\\z', { env: e }), 'C:\\t\\z');
  assert.strictEqual(paths.resolveArgPath('rep', { env: {}, cwd: 'D:\\cwd' }), 'D:\\cwd\\rep');
});
test('paths.dataDir / exeDir / userDataDir', () => {
  assert.strictEqual(paths.dataDir({ env: { ProgramData: 'C:\\PD' }, isPackaged: true }), 'C:\\PD\\NodeMend');
  assert.strictEqual(paths.dataDir({ env: { ProgramData: 'C:\\PD', TIDYWIN_DATA_DIR: 'D:\\t' }, isPackaged: true }), 'C:\\PD\\NodeMend');  // never in packaged builds
  assert.strictEqual(paths.dataDir({ env: { ProgramData: 'C:\\PD', TIDYWIN_DATA_DIR: 'D:\\t' }, isPackaged: false }), 'D:\\t');
  assert.strictEqual(paths.exeDir({ env: { PORTABLE_EXECUTABLE_DIR: 'E:\\usb' }, isPackaged: true }), 'E:\\usb');
  assert.strictEqual(paths.exeDir({ env: {}, isPackaged: true }), path.dirname(process.execPath));
  assert.strictEqual(paths.exeDir({ env: {}, app: { isPackaged: false, getAppPath: () => 'D:\\app' } }), 'D:\\app');
  assert.strictEqual(paths.userDataDir({ app: { getPath: k => 'UD-' + k } }), 'UD-userData');
  const w = paths.writableDataDir({ env: { TIDYWIN_DATA_DIR: path.join(TMP, 'pdw') }, isPackaged: false, userDataDir: 'X:\\ud' }, 'audit');
  assert.strictEqual(w, path.join(TMP, 'pdw', 'audit')); assert.ok(fs.existsSync(path.join(TMP, 'pdw')));
  assert.strictEqual(paths.writableDataDir({ env: { TIDYWIN_DATA_DIR: 'Q:\\no\\such\\drive' }, isPackaged: false, userDataDir: 'X:\\ud' }), 'X:\\ud');
});
test('lib has no electron imports', () => {
  for (const f of ['license-codec.js', 'license.js', 'gate.js', 'paths.js']) assert.ok(!/require\(['"]electron['"]\)/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8')), f);
});

// ---------------------------------------------------------------- production key (conditional)
test('prodKey', () => {
  const f = path.join(__dirname, 'fixtures', 'prod-expired.lic');
  if (!fs.existsSync(f) || !codec.PUBLIC_KEYS.length) { console.log('skip prodKey'); return; }
  const r = codec.verifyToken(fs.readFileSync(f, 'utf8'), { keys: codec.PUBLIC_KEYS, today: codec.today() });
  assert.strictEqual(r.status, 'expired', 'embedded PUBLIC_KEYS must verify the real-key fixture: got ' + r.status);
});

(async () => {
  const t0 = Date.now();
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.message || e)); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed in ${Date.now() - t0} ms`);
  process.exit(failed ? 1 : 0);
})();

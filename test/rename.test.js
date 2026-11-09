'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const paths = require('../lib/paths');
const brand = require('../lib/brand');
const codec = require('../lib/license-codec');
const license = require('../lib/license');
const policy = require('../enterprise/policy');
const F = require('./fixtures').make();
const ROOT = path.resolve(__dirname, '..');

async function main() {
  assert.equal(brand.NAME, 'NodeMend');
  assert.equal(brand.EDITIONS.solo, 'NodeMend Solo');
  assert.equal(brand.EDITIONS.enterprise, 'NodeMend');
  assert.equal(brand.PUBLISHER, 'Namer-Lavan');
  assert(Object.values(brand.LINKS).every(link => link.startsWith('https://namer-lavan.com/')));
  assert.equal(require('../package.json').name, 'nodemend');
  const env = brand.applyEnvironmentAliases({ NODEMEND_LICENSE: F.tokens.ent, TIDYWIN_LICENSE: F.tokens.solo, NODEMEND_DATA_DIR: 'new', TIDYWIN_DATA_DIR: 'old' });
  assert.equal(env.TIDYWIN_LICENSE, F.tokens.ent);
  assert.equal(env.TIDYWIN_DATA_DIR, 'new');
  assert.equal(brand.applyEnvironmentAliases({ TIDYWIN_LICENSE: F.tokens.solo }).TIDYWIN_LICENSE, F.tokens.solo);
  const fingerprint = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
  assert.equal(fingerprint('lib/license.js'), '7865882c35da3b6638d466f2674921b10ab58402df2a2fb6d3eae1e94c8d57d8');
  assert.equal(fingerprint('lib/license-codec.js'), 'ef8119facbdf3556591e2941dc869c367f9326c85bc1e8c335484bb7854ed05b');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodemend-rename-'));
  const originalEnv = { NODEMEND_POLICY: process.env.NODEMEND_POLICY, TIDYWIN_POLICY: process.env.TIDYWIN_POLICY };
  try {
    delete process.env.NODEMEND_POLICY; delete process.env.TIDYWIN_POLICY;
    const pd = path.join(tmp, 'pd'), appData = path.join(tmp, 'appdata');
    const legacy = path.join(pd, 'TidyWin');
    fs.mkdirSync(path.join(legacy, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'TidyWin.lic'), F.tokens.ent);
    fs.writeFileSync(path.join(legacy, 'TidyWin.policy.json'), JSON.stringify({ version: 1, orgName: 'Migrated Org' }));
    fs.writeFileSync(path.join(legacy, 'reports', 'keep.json'), '{"keep":true}');
    fs.mkdirSync(path.join(appData, 'tidywin'), { recursive: true });
    fs.writeFileSync(path.join(appData, 'tidywin', 'settings.json'), '{"keep":true}');
    const options = { env: { ProgramData: pd, APPDATA: appData }, isPackaged: true, platform: 'win32', appData };
    const results = paths.migrateLegacyData(options);
    assert.equal(results.filter(r => r.migrated).length, 2);
    assert(!fs.existsSync(legacy));
    const dataDir = paths.dataDir(options);
    assert.equal(dataDir, path.join(pd, 'NodeMend'));
    assert.equal(fs.readFileSync(path.join(dataDir, 'reports', 'keep.json'), 'utf8'), '{"keep":true}');
    assert.equal(fs.readFileSync(path.join(appData, 'nodemend', 'settings.json'), 'utf8'), '{"keep":true}');
    assert(paths.migrateLegacyData(options).every(r => !r.migrated && r.reason === 'absent'));
    const candidates = await license.discover({ dataDir, readFile: fs.promises.readFile, keys: [F.pubHex], today: '2026-10-17', builtAt: '2026-10-16' });
    const resolved = license.resolve(candidates);
    assert.equal(resolved.status, 'valid'); assert.equal(resolved.edition, 'enterprise');
    assert.equal(codec.decode(F.tokens.ent).payload.product, 'tidywin');
    assert(F.tokens.ent.startsWith('TIDYWIN1.'));
    const ctx = { paths: { dataDir, exeDir: path.join(tmp, 'exe') }, getLicenseState: () => ({ edition: 'enterprise', features: ['policy'] }) };
    assert.equal((await policy.load(ctx)).data.orgName, 'Migrated Org');
    fs.writeFileSync(path.join(dataDir, 'NodeMend.policy.json'), JSON.stringify({ version: 1, orgName: 'Preferred New Policy' }));
    assert.equal((await policy.load(ctx)).data.orgName, 'Preferred New Policy');

    const conflictOld = path.join(tmp, 'conflict-old'), conflictNew = path.join(tmp, 'conflict-new');
    fs.mkdirSync(conflictOld); fs.mkdirSync(conflictNew);
    fs.writeFileSync(path.join(conflictOld, 'keep'), 'old'); fs.writeFileSync(path.join(conflictNew, 'keep'), 'new');
    assert.equal(paths.migrateDirectory(conflictOld, conflictNew).reason, 'destination-exists');
    assert.equal(fs.readFileSync(path.join(conflictOld, 'keep'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(conflictNew, 'keep'), 'utf8'), 'new');
    const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty);
    assert(paths.migrateDirectory(conflictOld, empty).migrated);
    assert.equal(fs.readFileSync(path.join(empty, 'keep'), 'utf8'), 'old');

    const portable = path.join(tmp, 'TidyWin-portable'); fs.mkdirSync(portable);
    fs.writeFileSync(path.join(portable, 'TidyWin.lic'), F.tokens.solo);
    assert(paths.migrateLegacyData({ env: { ProgramData: pd, PORTABLE_EXECUTABLE_DIR: path.join(tmp, 'usb') }, isPackaged: true, platform: 'win32', tempDir: tmp }).some(r => r.migrated));
    assert.equal(fs.readFileSync(path.join(tmp, 'NodeMend-portable', 'TidyWin.lic'), 'utf8'), F.tokens.solo);
    const target = path.join(tmp, 'valuable'); fs.mkdirSync(target);
    const link = path.join(tmp, 'legacy-link'); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    try { assert.throws(() => paths.migrateDirectory(link, path.join(tmp, 'new-link')), /UNSAFE_MIGRATION_PATH/); }
    finally { fs.unlinkSync(link); }
    if (process.platform === 'win32') {
      const nativeRoot = path.join(tmp, 'native'); fs.mkdirSync(nativeRoot);
      const harness = path.join(nativeRoot, 'boot.js');
      fs.writeFileSync(harness, `const {app}=require('electron');\nObject.defineProperty(app,'isPackaged',{get:()=>process.env.RENAME_PACKAGED==='1'});\napp.setPath('appData',process.env.RENAME_APPDATA);\nrequire(${JSON.stringify(path.join(ROOT, 'main.js'))});\n`);
      const electron = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
      for (const mode of ['conflict', 'portable']) {
        const base = path.join(nativeRoot, mode); fs.mkdirSync(base);
        const appData = path.join(base, 'appdata'); fs.mkdirSync(appData);
        const programData = path.join(base, 'pd'); fs.mkdirSync(programData);
        const nativeEnv = { ...process.env, RENAME_APPDATA: appData, ProgramData: programData, PROGRAMDATA: programData, TEMP: base, TMP: base };
        for (const key of Object.keys(nativeEnv)) if (/^(?:TIDYWIN_|NODEMEND_|PORTABLE_EXECUTABLE_)/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete nativeEnv[key];
        if (mode === 'conflict') {
          nativeEnv.RENAME_PACKAGED = '0'; nativeEnv.TIDYWIN_TEST_PUBKEY = F.pubHex;
          for (const name of ['TidyWin', 'NodeMend']) fs.mkdirSync(path.join(programData, name));
          fs.writeFileSync(path.join(programData, 'TidyWin', 'TidyWin.policy.json'), '{"unattended":{"allow":false}}');
          fs.writeFileSync(path.join(programData, 'NodeMend', 'preserve'), 'new data');
        } else {
          nativeEnv.RENAME_PACKAGED = '1';
          nativeEnv.PORTABLE_EXECUTABLE_DIR = path.join(base, 'usb'); fs.mkdirSync(nativeEnv.PORTABLE_EXECUTABLE_DIR);
          assert(!fs.existsSync(path.join(base, 'NodeMend-portable')));
        }
        const log = path.join(base, 'run.log');
        const child = spawnSync(electron, [harness, '--unattended', '--profile=smoke', '--log=' + log, ...(mode === 'conflict' ? ['--license=' + F.tokens.ent] : [])], { env: nativeEnv, windowsHide: true, timeout: 30000, stdio: 'ignore' });
        assert.ifError(child.error);
        assert.equal(child.status, mode === 'conflict' ? 4 : 3, mode);
        assert.match(fs.readFileSync(log, 'utf8'), mode === 'conflict' ? /EXIT 4 DATA_MIGRATION_REQUIRED/ : /EXIT 3 .*LICENSE_REQUIRED/);
        if (mode === 'conflict') {
          assert.equal(fs.readFileSync(path.join(programData, 'TidyWin', 'TidyWin.policy.json'), 'utf8'), '{"unattended":{"allow":false}}');
          assert.equal(fs.readFileSync(path.join(programData, 'NodeMend', 'preserve'), 'utf8'), 'new data');
          assert(!fs.existsSync(path.join(programData, 'NodeMend', 'reports')));
        } else assert(fs.statSync(path.join(base, 'NodeMend-portable')).isDirectory());
      }
    }
    console.log('RESULT: PASS (NodeMend identity, migration idempotence/conflicts/junction refusal, old signed licenses and policy aliases)');
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

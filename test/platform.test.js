// Fixture-only read-only adapter tests; never scans or cleans real cache locations.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const adapter = require('../lib/platform');

async function main() {
  for (const platform of ['darwin', 'linux']) {
    const caps = adapter.getCapabilities(platform);
    assert.strictEqual(caps.cleaner, true);
    assert.strictEqual(caps.diskAnalysis, true);
    for (const key of ['windowsControls', 'repair', 'updates', 'startup', 'uninstall', 'defender', 'smart', 'recycle', 'performance', 'elevation']) {
      assert.strictEqual(caps[key], false, key);
    }
    assert.throws(() => adapter.assertWindows('DISM', platform), /UNSUPPORTED_PLATFORM/);
    const cats = adapter.cleanerCategories(platform, { home: '/home/fixture' });
    assert(cats.length > 0);
    for (const cat of cats) {
      assert.strictEqual(cat.minAgeDays, 7);
      for (const root of cat.paths) {
        assert(root.startsWith('/home/fixture/'));
        assert(!root.includes('..'));
        assert(!/Cookies|Login Data|\.config|Application Support/.test(root));
      }
    }
    assert.throws(() => adapter.cleanerCategories(platform, { home: 'relative' }), /absolute/);
  }
  assert.strictEqual(adapter.getCapabilities('win32').windowsControls, true);
  const winCats = [{ id: 'existing-windows-category' }];
  assert.strictEqual(adapter.cleanerCategories('win32', { windowsCategories: winCats }), winCats);
  assert.deepStrictEqual(adapter.cleanerCategories('unsupported'), []);
  assert.strictEqual(adapter.getCapabilities('unsupported').supported, false);
  assert.strictEqual(adapter.classifyDirectory('/home/user/Downloads'), 'Downloads');
  assert.strictEqual(adapter.classifyDirectory('/home/user/mydownloads'), 'Other');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tidywin-platform-'));
  try {
    const root = path.join(tmp, 'data');
    fs.mkdirSync(path.join(root, 'Downloads'), { recursive: true });
    fs.writeFileSync(path.join(root, 'small.txt'), Buffer.alloc(3));
    fs.writeFileSync(path.join(root, 'Downloads', 'large.dat'), Buffer.alloc(20));
    const scan = await adapter.analyzeDisk(root, { largestLimit: 1 });
    assert.strictEqual(scan.size, 23);
    assert.strictEqual(scan.files, 2);
    assert.strictEqual(scan.directoriesScanned, 2);
    assert.strictEqual(scan.largestFiles.length, 1);
    assert.strictEqual(scan.largestFiles[0].size, 20);
    assert.strictEqual(scan.directories.find(d => path.basename(d.path) === 'Downloads').classification, 'Downloads');
    assert.strictEqual(scan.readOnly, true);
    assert.strictEqual(scan.truncated, false);
    assert.strictEqual(fs.readFileSync(path.join(root, 'small.txt')).length, 3);
    const short = await adapter.analyzeDisk(root, { maxEntries: 1 });
    assert.strictEqual(short.truncated, true);
    assert.strictEqual(short.entriesScanned, 1);
    const stop = await adapter.analyzeDisk(root, { shouldCancel: () => true });
    assert.strictEqual(stop.cancelled, true);
    assert.strictEqual(stop.files, 0);
    // A directory symlink/junction must never be traversed, including a linked root ancestor.
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), Buffer.alloc(500));
    fs.mkdirSync(path.join(outside, 'child'));
    const link = path.join(root, 'linked');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await adapter.analyzeDisk(root);
    assert.strictEqual(linked.size, 23);
    assert(linked.skipped >= 1);
    await assert.rejects(adapter.analyzeDisk(link), /SYMLINK_PATH/);
    await assert.rejects(adapter.analyzeDisk(path.join(link, 'child')), /SYMLINK_PATH/);
    const appsRoot = path.join(tmp, 'Applications');
    fs.mkdirSync(path.join(appsRoot, 'Example.app'), { recursive: true });
    fs.writeFileSync(path.join(appsRoot, 'Readme.txt'), 'not an app');
    const macApps = await adapter.listInstalledApps('darwin', { home: tmp, roots: [appsRoot] });
    assert.strictEqual(macApps.length, 1);
    assert.strictEqual(macApps[0].name, 'Example');
    assert.strictEqual(macApps[0].uninstall, '');
    const desktopRoot = path.join(tmp, 'desktop');
    fs.mkdirSync(desktopRoot);
    fs.writeFileSync(path.join(desktopRoot, 'example.desktop'), '[Desktop Entry]\nName=Example Linux\nExec=NEVER_EXECUTE\nType=Application\n');
    fs.writeFileSync(path.join(desktopRoot, 'hidden.desktop'), '[Desktop Entry]\nName=Hidden\nHidden=true\n');
    const linuxApps = await adapter.listInstalledApps('linux', { home: tmp, roots: [desktopRoot] });
    assert.deepStrictEqual(linuxApps.map(a => a.name), ['Example Linux']);
    assert.strictEqual(linuxApps[0].readOnly, true);
    const sys = await adapter.systemInfo();
    assert(sys.ramTotal > 0);
    assert(Array.isArray(sys.volumes));
    assert.deepStrictEqual(sys.disks, []);
    assert.strictEqual(sys.defender, null);
    assert.strictEqual(sys.pendingReboot, null);
    assert.strictEqual(sys.cpuLoad, null);
    assert(sys.unavailable.includes('SMART'));
    const health = await adapter.healthSummary();
    assert.strictEqual(health.readOnly, true);
    assert(Array.isArray(health.findings));
    console.log('RESULT: PASS (platform adapter capabilities, bounded fixture scan, metadata listing, native read-only snapshot)');
  } finally {
    // This exact directory was created above for this test; symlinks are removed, not traversed.
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });

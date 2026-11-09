// Builds isolated release trees; never changes root edition.json or copies credentials.
const fs = require('fs'); const path = require('path'); const packager = require('@electron/packager');
const ROOT = path.resolve(__dirname, '..');
const platform = process.argv[2], arch = process.argv[3] || 'x64';
if (!['linux', 'darwin'].includes(platform) || arch !== 'x64') throw new Error('Use build-cross.js linux|darwin x64');
const temp = path.join(ROOT, '.tmp'); fs.mkdirSync(temp, { recursive: true });
const stage = fs.mkdtempSync(path.join(temp, `cross-${platform}-`));
for (const name of ['main.js', 'preload.js', 'package.json', 'lib', 'renderer']) fs.cpSync(path.join(ROOT, name), path.join(stage, name), { recursive: true });
for (const name of [platform, 'source', 'NOTICE.md']) fs.cpSync(path.join(ROOT, 'vendor', 'photorec', name), path.join(stage, 'vendor', 'photorec', name), { recursive: true });
fs.writeFileSync(path.join(stage, 'edition.json'), JSON.stringify({ edition: 'solo', productName: 'NodeMend Solo', version: require('../package.json').version, builtAt: '2026-10-13' }));
const engine = path.join(stage, 'vendor', 'photorec', platform, 'photorec'); if (fs.existsSync(engine)) fs.chmodSync(engine, 0o755);
packager({ dir: stage, name: 'NodeMend', platform, arch, out: path.join(ROOT, 'dist', 'cross'), overwrite: true, asar: false,
  appBundleId: 'com.namerlavan.nodemend', appVersion: require('../package.json').version, prune: false,
  darwinDarkModeSupport: true }).then(paths => {
  for (const built of paths) {
    const appRoot = platform === 'darwin' ? path.join(built, 'NodeMend.app', 'Contents', 'Resources', 'app') : path.join(built, 'resources', 'app');
    for (const file of ['main.js', 'preload.js', 'lib/gate.js', 'lib/recovery.js', 'lib/platform.js', 'renderer/js/extras.js', `vendor/photorec/${platform}/photorec`, 'vendor/photorec/source/testdisk-7.2.tar.bz2']) if (!fs.existsSync(path.join(appRoot, file))) throw new Error('Missing release file ' + file);
    for (const forbidden of ['keys', 'test', '.git', '.tmp', 'tools', 'enterprise']) if (fs.existsSync(path.join(appRoot, forbidden))) throw new Error('Forbidden release content ' + forbidden);
  }
  console.log(JSON.stringify({ ok: true, platform, arch, paths, nativeExecutionVerified: false }));
}).catch(e => { console.error(e.message); process.exitCode = 1; });

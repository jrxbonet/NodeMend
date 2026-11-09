// Only scans a synthetic regular file. Never opens a physical drive.
const fs = require('fs'); const path = require('path'); const assert = require('assert'); const crypto = require('crypto');
const root = path.resolve(__dirname, '..', '.tmp', 'recovery-live');
const sourceDir = path.join(root, 'source'), outputDir = path.join(root, 'output');
fs.mkdirSync(sourceDir, { recursive: true }); fs.mkdirSync(outputDir, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0e0AAAAASUVORK5CYII=', 'base64');
const image = Buffer.alloc(16 * 1024 * 1024); png.copy(image, 65536);
const source = path.join(sourceDir, 'fixture.img'); fs.writeFileSync(source, image);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const before = hash(fs.readFileSync(source));
const service = require('../lib/recovery').createRecoveryService({ bundledDirectory: path.join(__dirname, '..', 'vendor', 'photorec', process.platform) });
(async () => {
  const engine = service.detectBundledEngine('photorec'); assert.equal(engine.ok, true, engine.message);
  const handle = service.runImage({ source, destination: outputDir, fileTypes: ['png'] }, { timeoutMs: 30000 });
  const result = await handle.result;
  assert.equal(result.ok, true, JSON.stringify(result));
  const files = [];
  function collect(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) collect(p); else if (/\.png$/i.test(e.name)) files.push(p); } }
  collect(outputDir);
  assert(files.some(file => hash(fs.readFileSync(file)) === hash(png)), 'Expected PNG bytes were not recovered');
  assert.equal(hash(fs.readFileSync(source)), before, 'Source image was modified');
  console.log(JSON.stringify({ ok: true, platform: process.platform, engine: 'PhotoRec 7.2', recoveredMatchingPng: true, sourceUnchanged: true, physicalDrivesAccessed: false, filesRecovered: files.length }));
})().catch(e => { console.error(e.message); process.exitCode = 1; });

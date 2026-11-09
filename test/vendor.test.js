'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ensureVendor, extractSelected, installed, safeName } = require('../scripts/fetch-vendor');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
// Tiny uncompressed tar fixture, including adversarial paths and a symlink.
function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || ''); const h = Buffer.alloc(512);
    h.write(entry.name, 0, 100); h.write('0000755\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.fill(32, 148, 156); h.write(entry.type || '0', 156);
    if (entry.link) h.write(entry.link, 157, 100);
    h.write('ustar\0', 257); h.write('00', 263);
    const sum = h.reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidywin-vendor-test-'));
  try {
    for (const name of ['../escape', '/absolute', 'C:/escape', 'a\\b', 'a/../b', 'a:b', 'a/*', 'a.']) assert.throws(() => safeName(name), /Unsafe/);
    const payload = Buffer.from('fixture engine');
    const spec = { url: 'https://www.cgsecurity.org/fixture.tar', files: { photorec: { member: 'release/photorec', sha256: hash(payload), executable: true } } };
    const archive = path.join(root, 'fixture.tar');
    fs.writeFileSync(archive, tar([{ name: '../escape', data: 'must never be written' }, { name: 'release/photorec', data: payload }]));
    const stage = path.join(root, 'stage'); fs.mkdirSync(stage);
    await extractSelected(archive, spec, stage);
    assert.equal(fs.readFileSync(path.join(stage, 'photorec'), 'utf8'), payload.toString());
    assert(!fs.existsSync(path.join(root, 'escape')));
    assert(installed(stage, spec));
    fs.writeFileSync(path.join(stage, 'unlisted.dll'), 'unexpected'); assert(!installed(stage, spec));
    fs.unlinkSync(path.join(stage, 'unlisted.dll'));
    fs.writeFileSync(path.join(stage, 'photorec'), 'tampered'); assert(!installed(stage, spec));
    const linkStage = path.join(root, 'link-stage'); fs.mkdirSync(linkStage);
    fs.writeFileSync(archive, tar([{ name: 'release/photorec', type: '2', link: '../outside' }]));
    await assert.rejects(extractSelected(archive, spec, linkStage), /SHA-256/);
    assert.equal(fs.readdirSync(linkStage).length, 0);
    const badStage = path.join(root, 'bad-stage'); fs.mkdirSync(badStage);
    await assert.rejects(extractSelected(archive, { ...spec, files: { '../escape': spec.files.photorec } }, badStage), /Unsafe/);
    const vendor = path.join(root, 'vendor'); fs.mkdirSync(path.join(vendor, 'win32'), { recursive: true });
    fs.writeFileSync(path.join(vendor, 'win32', 'old'), 'keep previous install');
    const bytes = Buffer.from('corrupt download');
    await assert.rejects(ensureVendor('win32', { root: vendor, manifest: { platforms: { win32: { ...spec, sha256: hash('expected archive') } } }, download: async () => bytes }), /SHA-256/);
    assert.equal(fs.readFileSync(path.join(vendor, 'win32', 'old'), 'utf8'), 'keep previous install');
    assert.deepEqual(fs.readdirSync(vendor), ['win32']);
    // Archive checksum succeeds but a selected member fails: never replace the previous tree.
    const wrongFile = tar([{ name: 'release/photorec', data: 'wrong engine' }]);
    await assert.rejects(ensureVendor('win32', { root: vendor, manifest: { platforms: { win32: { ...spec, sha256: hash(wrongFile) } } }, download: async () => wrongFile }), /SHA-256/);
    assert.equal(fs.readFileSync(path.join(vendor, 'win32', 'old'), 'utf8'), 'keep previous install');
    assert.deepEqual(fs.readdirSync(vendor), ['win32']);
    const goodFile = tar([{ name: 'release/photorec', data: payload }]);
    const source = Buffer.from('fixture matching source');
    const fixtureManifest = { version: 'fixture', platforms: {
      win32: { ...spec, sha256: hash(goodFile) },
      source: { url: 'https://www.cgsecurity.org/fixture-source.tar.bz2', sha256: hash(source), files: { 'fixture-source.tar.bz2': { sha256: hash(source) } } }
    } };
    let requests = 0;
    await ensureVendor('win32', { root: vendor, manifest: fixtureManifest, download: async url => { requests++; return url.endsWith('source.tar.bz2') ? source : goodFile; } });
    assert.equal(requests, 2); assert(!fs.existsSync(path.join(vendor, 'win32', 'old')));
    assert(installed(path.join(vendor, 'win32'), spec));
    await ensureVendor('win32', { root: vendor, manifest: fixtureManifest, download: async () => { throw Error('must remain offline when installed'); } });
    console.log('vendor: PASS (offline archive/member corruption, traversal, links, staged replacement, cleanup)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });

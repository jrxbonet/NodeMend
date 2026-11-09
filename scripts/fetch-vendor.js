// Build-time only. Never shipped or called by the application.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', 'vendor', 'photorec');
const MANIFEST = require('../vendor/photorec/HASHES.json');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function verify(data, expected, label) {
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(data) !== expected) throw new Error(`SHA-256 mismatch: ${label}`);
}
function safeName(name) {
  if (typeof name !== 'string' || !name || /[\\:\x00-\x1f*?\[\]]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) {
    throw new Error(`Unsafe vendor path: ${name}`);
  }
  return name;
}
function ordinaryAncestors(target) {
  for (let p = path.resolve(target); ; p = path.dirname(p)) {
    if (fs.existsSync(p)) {
      const s = fs.lstatSync(p);
      if (s.isSymbolicLink() || !s.isDirectory()) throw new Error(`Unsafe vendor directory: ${p}`);
    }
    if (path.dirname(p) === p) break;
  }
}
async function download(url) {
  if (new URL(url).origin !== 'https://www.cgsecurity.org') throw new Error('Vendor URL must use official CGSecurity HTTPS origin');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Vendor HTTP ${response.status}: ${url}`);
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > 100 * 1024 * 1024) throw new Error('Vendor archive exceeds 100 MiB');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
function zipFiles(archive, wanted) {
  // yauzl is already installed with Electron's build toolchain; lazy-load for tar-only hosts.
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const found = new Map();
      const fail = e => { zip.close(); reject(e); };
      zip.on('error', fail);
      zip.on('end', () => resolve(found));
      zip.on('entry', entry => {
        if (!wanted.has(entry.fileName)) return zip.readEntry();
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if ((mode && mode !== 0x8000) || entry.uncompressedSize > 64 * 1024 * 1024 || found.has(entry.fileName)) return fail(new Error('Unsafe ZIP member: ' + entry.fileName));
        zip.openReadStream(entry, (e, stream) => {
          if (e) return fail(e);
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', c => chunks.push(c));
          stream.on('end', () => { found.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}
async function extractSelected(archive, spec, destination) {
  // Never extract archive paths to disk. Read only exact pinned members to stdout,
  // verify their bytes, then create ordinary files at validated manifest paths.
  const files = Object.entries(spec.files);
  for (const [name, file] of files) { safeName(name); safeName(file.member); }
  const zip = spec.url.endsWith('.zip') ? await zipFiles(archive, new Set(files.map(([, f]) => f.member))) : null;
  for (const [name, file] of files) {
    let data;
    if (zip) data = zip.get(file.member);
    else {
      const result = spawnSync('tar', ['-xOf', path.basename(archive), '--', file.member], { cwd: path.dirname(archive), maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`Cannot read ${file.member}: ${result.error || result.stderr}`);
      data = result.stdout;
    }
    if (!data) throw new Error('Missing archive member: ' + file.member);
    verify(data, file.sha256, file.member);
    const target = path.join(destination, name);
    ordinaryAncestors(path.dirname(target));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
  }
}
function installed(target, spec) {
  try {
    ordinaryAncestors(target);
    const expected = new Set(Object.keys(spec.files));
    function inventory(directory, prefix = '') {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isSymbolicLink()) return false;
        if (entry.isDirectory()) {
          if (![...expected].some(f => f.startsWith(name + '/')) || !inventory(path.join(directory, entry.name), name + '/')) return false;
        } else if (!entry.isFile() || !expected.has(name)) return false;
      }
      return true;
    }
    if (!inventory(target)) return false;
    return Object.entries(spec.files).every(([name, file]) => {
      safeName(name);
      const targetFile = path.join(target, name);
      ordinaryAncestors(path.dirname(targetFile));
      if (!fs.lstatSync(targetFile).isFile() || fs.lstatSync(targetFile).isSymbolicLink()) return false;
      verify(fs.readFileSync(targetFile), file.sha256, name);
      return !file.executable || process.platform === 'win32' || (fs.statSync(targetFile).mode & 0o111) !== 0;
    });
  } catch { return false; }
}
async function ensureVendor(platform = process.platform, options = {}) {
  const manifest = options.manifest || MANIFEST;
  if (!Object.hasOwn(manifest.platforms, platform)) throw new Error('Unsupported PhotoRec platform: ' + platform);
  const root = options.root || ROOT;
  ordinaryAncestors(root);
  fs.mkdirSync(root, { recursive: true });
  for (const key of [platform, 'source']) {
    const spec = manifest.platforms[key];
    const target = path.join(root, key);
    ordinaryAncestors(target);
    if (installed(target, spec)) continue;
    const temp = fs.mkdtempSync(path.join(root, '.fetch-'));
    try {
      const archive = path.join(temp, path.basename(new URL(spec.url).pathname));
      const data = await (options.download || download)(spec.url);
      verify(data, spec.sha256, spec.url);
      fs.writeFileSync(archive, data);
      const stage = path.join(temp, 'stage'); fs.mkdirSync(stage);
      if (key === 'source') {
        const [name, file] = Object.entries(spec.files)[0]; safeName(name);
        verify(data, file.sha256, name); fs.writeFileSync(path.join(stage, name), data);
      } else await extractSelected(archive, spec, stage);
      if (fs.existsSync(target)) {
        // Preserve the previous tree until every replacement file has verified.
        fs.renameSync(target, path.join(temp, 'previous'));
      }
      try { fs.renameSync(stage, target); }
      catch (e) { if (fs.existsSync(path.join(temp, 'previous'))) fs.renameSync(path.join(temp, 'previous'), target); throw e; }
      console.log(`vendor: verified PhotoRec ${manifest.version} ${key}`);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
}
if (require.main === module) {
  const platform = process.argv[2] || process.platform;
  (async () => { for (const p of platform === '--all' ? ['win32', 'linux', 'darwin'] : [platform]) await ensureVendor(p); })()
    .catch(e => { console.error('vendor: ' + e.message); process.exitCode = 1; });
}
module.exports = { ensureVendor, extractSelected, verify, safeName, installed };

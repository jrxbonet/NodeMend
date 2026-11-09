// NodeMend edition-aware builder (spec 7.2). Never shipped.
//   node scripts/build.js --edition=solo|enterprise --format=folder|portable|both [--skip-smoke]
// Writes edition.json (the only thing that tells main.js which edition it is), runs
// @electron/packager (folder) and/or electron-builder (portable) programmatically, asserts the
// produced trees, and ALWAYS deletes edition.json afterwards so it can never leak into
// `npm start` or the next build.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const EDITION_FILE = path.join(ROOT, 'edition.json');
// A stale edition.json from an interrupted build would silently turn `npm start` / the smoke test
// into that edition; remove it first and on Ctrl+C.
try { fs.rmSync(EDITION_FILE, { force: true }); } catch { /* ignore */ }
process.on('SIGINT', () => { try { fs.rmSync(EDITION_FILE, { force: true }); } catch { /* ignore */ } process.exit(130); });
const PS_COUNT = 15;                         // includes the private registry-uninstall lookup
const SECRET = 'PRIVATE' + ' KEY';           // split so this file never trips its own grep

function arg(name, def) {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
}
function fail(msg) { console.error('build: ' + msg); process.exit(1); }
function today() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

const edition = String(arg('edition', ''));
const format = String(arg('format', 'both'));
const skipSmoke = arg('skip-smoke', false) === true;
if (!['solo', 'enterprise'].includes(edition)) fail('--edition must be solo or enterprise');
if (!['folder', 'portable', 'both'].includes(format)) fail('--format must be folder, portable or both');

// The full (internally "enterprise") build is the public one and is simply "NodeMend".
const NAME = edition === 'enterprise' ? 'NodeMend' : 'NodeMend Solo';
const SLUG = edition === 'enterprise' ? 'NodeMend' : 'NodeMend-Solo';

// Folder build: packager copies everything except these (paths are relative to ROOT, '/'-prefixed).
const IGNORE = [/^\/dist($|\/)/, /^\/node_modules($|\/)/, /^\/\.git($|\/)/, /^\/keys($|\/)/, /^\/tools($|\/)/, /^\/test($|\/)/, /^\/docs($|\/)/, /^\/\.tmp($|\/)/, /^\/release($|\/)/, /^\/website($|\/)/, /^\/vendor\/photorec\/(darwin|linux)($|\/)/,
  /^\/scripts\/(build|fetch-vendor)\.js$/, /^\/vendor\/photorec\/\.fetch-/, /^\/(smoketest|shot|makeicon)\.js$/, /^\/icon\.png$/, /\.log$/, /^\/\.git(ignore|attributes)$/, /^\/start\.cmd$/];
if (edition === 'solo') IGNORE.push(/^\/enterprise($|\/)/);
// Portable build: electron-builder gets a whitelist instead (keys/, tools/, test/, smoketest/shot/build are out by omission).
const FILES = ['main.js', 'preload.js', 'package.json', 'edition.json', 'icon.ico', 'LICENSE', 'README.md', 'lib/**', 'ps/**', 'renderer/**', 'scripts/png2ico.js', 'vendor/photorec/win32/**', 'vendor/photorec/source/**', 'vendor/photorec/NOTICE.md', 'vendor/photorec/HASHES.json'];
if (edition === 'enterprise') FILES.push('enterprise/**');

const CONFIG = {
  appId: 'com.namerlavan.nodemend', productName: NAME, asar: false,
  directories: { output: 'dist/portable' }, files: FILES,
  win: { target: ['portable'], icon: 'icon.ico', requestedExecutionLevel: 'asInvoker', signAndEditExecutable: true },
  portable: { artifactName: SLUG + '-portable.exe', unpackDirName: SLUG },
  electronDownload: { cache: path.join(process.env.LOCALAPPDATA || require('os').homedir(), 'electron', 'Cache') }
};

// ---------------------------------------------------------------- steps
function runSmoke() {
  console.log('build: npm run smoke');
  const r = spawnSync('npm run smoke', { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) fail(`smoke test failed (exit ${r.status}); use --skip-smoke to bypass`);
}

function writeEdition() {
  const e = { edition, productName: NAME, version: PKG.version, builtAt: today() };
  fs.writeFileSync(EDITION_FILE, JSON.stringify(e, null, 2) + '\n');
  console.log('build: wrote edition.json ' + JSON.stringify(e));
}

async function buildFolder() {
  const packager = require('@electron/packager');
  console.log(`build: packager -> dist/${SLUG}-win32-x64`);
  const out = await packager({
    dir: ROOT, name: SLUG, platform: 'win32', arch: 'x64', out: path.join(ROOT, 'dist'), overwrite: true, icon: path.join(ROOT, 'icon.ico'),
    asar: false, ignore: IGNORE,
    win32metadata: { CompanyName: 'Namer-Lavan', ProductName: NAME, FileDescription: NAME + ' maintenance toolkit', InternalName: SLUG }
  });
  console.log('build: packager wrote ' + out.join(', '));
  const exe = path.join(ROOT, 'dist', `${SLUG}-win32-x64`, `${SLUG}.exe`);
  if (!fs.existsSync(exe)) fail('missing ' + exe);
  return path.join(ROOT, 'dist', `${SLUG}-win32-x64`, 'resources', 'app');
}

async function buildPortable() {
  const eb = require('electron-builder');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';    // never go looking for a code-signing cert
  console.log(`build: electron-builder -> dist/portable/${SLUG}-portable.exe`);
  const out = await eb.build({ targets: eb.Platform.WINDOWS.createTarget('portable', eb.Arch.x64), config: CONFIG, projectDir: ROOT });
  console.log('build: electron-builder wrote ' + (out || []).join(', '));
  const exe = path.join(ROOT, 'dist', 'portable', `${SLUG}-portable.exe`);
  if (!fs.existsSync(exe)) fail('missing ' + exe);
  return path.join(ROOT, 'dist', 'portable', 'win-unpacked', 'resources', 'app');
}

// ---------------------------------------------------------------- assertions (spec 7.2 step 6)
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}
function assertTree(app) {
  const problems = [];
  const has = rel => fs.existsSync(path.join(app, rel));
  const must = rel => { if (!has(rel)) problems.push('missing ' + rel); };
  const mustNot = rel => { if (has(rel)) problems.push('must not ship: ' + rel); };
  if (!fs.existsSync(app)) return [`tree not found: ${app}`];
  let ed = null;
  try { ed = JSON.parse(fs.readFileSync(path.join(app, 'edition.json'), 'utf8')); } catch { problems.push('edition.json missing or unreadable'); }
  if (ed && ed.edition !== edition) problems.push(`edition.json says ${ed.edition}, wanted ${edition}`);
  ['lib/license-codec.js', 'lib/license.js', 'lib/gate.js', 'lib/paths.js', 'main.js', 'preload.js', 'package.json', 'renderer/index.html'].forEach(must);
  const ps = has('ps') ? fs.readdirSync(path.join(app, 'ps')).filter(f => /\.ps1$/i.test(f)) : [];
  if (ps.length !== PS_COUNT) problems.push(`ps/*.ps1: expected ${PS_COUNT}, found ${ps.length}`);
  ['keys', 'tools', 'test', 'docs', 'smoketest.js', 'shot.js', 'scripts/build.js', 'makeicon.js', 'node_modules', '.git'].forEach(mustNot);
  if (edition === 'solo') mustNot('enterprise'); else must('enterprise/index.js');
  const files = walk(app);
  for (const f of files) {
    if (/\.(key|pem)$/i.test(f)) problems.push('secret-looking file: ' + path.relative(app, f));
    if (/\.(js|json)$/i.test(f) && fs.readFileSync(f, 'utf8').includes(SECRET)) problems.push(`"${SECRET}" found in ` + path.relative(app, f));
  }
  return problems;
}

// ---------------------------------------------------------------- main
(async () => {
  let failed = false;
  try {
    await require('./fetch-vendor').ensureVendor('win32');
    if (!skipSmoke) runSmoke();
    writeEdition();
    const trees = [];
    if (format === 'folder' || format === 'both') trees.push(await buildFolder());
    if (format === 'portable' || format === 'both') trees.push(await buildPortable());
    for (const t of trees) {
      const problems = assertTree(t);
      if (problems.length) { failed = true; console.error(`build: FAIL ${t}\n  - ` + problems.join('\n  - ')); }
      else console.log(`build: OK ${path.relative(ROOT, t)} (${edition})`);
    }
  } catch (e) {
    failed = true;
    console.error('build: ' + (e && e.stack || e));
  } finally {
    try { fs.rmSync(EDITION_FILE, { force: true }); console.log('build: removed edition.json'); } catch (e) { console.error('build: could not remove edition.json: ' + e.message); failed = true; }
  }
  process.exit(failed ? 1 : 0);
})();

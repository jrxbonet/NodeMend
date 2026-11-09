#!/usr/bin/env node
// NodeMend — developer license keygen (NEVER shipped; excluded from every build).
// Touches nothing outside <keys-dir> (default ./keys, gitignored) and test/fixtures/.
// The private key + passphrase belong in the password manager, not in the repo or OneDrive.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Writable } = require('stream');
const codec = require('../lib/license-codec');

const ROOT = path.resolve(__dirname, '..');
const KEY_NAME = 'tidywin-ed25519';
const SEATS_DEFAULT = { solo: 1, enterprise: 25 };
const USAGE = `NodeMend license keygen

  node tools/keygen.js init [--force] [--no-passphrase]
      Generates an Ed25519 keypair: <keys>/${KEY_NAME}.key (PKCS8 PEM, aes-256-cbc unless
      --no-passphrase) and <keys>/${KEY_NAME}.pub.hex. Passphrase from TIDYWIN_KEY_PASSPHRASE or
      a hidden prompt. Prints the PUBLIC_KEYS entry to paste into lib/license-codec.js.
  node tools/keygen.js issue --edition solo|enterprise --licensee "Contoso Ltd" [--email x]
      [--seats N] [--expires YYYY-MM-DD] [--maint YYYY-MM-DD] [--features unattended,report,policy,audit,brand]
      [--brand-name "Northwind MSP"] [--brand-support "..."] [--notes "PO 4471"] [--id TW-2026-000042]
      [--out path] [--bare] [--allow-unlisted]
      Signs a key, verifies it, writes <keys>/issued/<id>.lic (armored) and appends <keys>/issued.jsonl.
      Refuses when the local public key is not in PUBLIC_KEYS (unless --allow-unlisted, for tests).
  node tools/keygen.js verify <file|token> [--pub <hex>] [--local]
      Verifies against PUBLIC_KEYS (or --pub, or --local = the key in <keys>). Exit 0 valid / 1 otherwise.
  node tools/keygen.js show <file|token>
      Decodes the payload WITHOUT verifying (support use).
  node tools/keygen.js rotate [--force] [--no-passphrase]
      Writes ${KEY_NAME}.2.key/.2.pub.hex and prints the 2nd PUBLIC_KEYS entry.
  node tools/keygen.js fixture-expired [--allow-unlisted]
      Writes test/fixtures/prod-expired.lic (signed by the real key, expires 2020-01-01).

Global: --keys-dir <dir>   key directory (default ${path.join(ROOT, 'keys')})
        --help
`;

// ---------------------------------------------------------------- args
const FLAGS = new Set(['force', 'no-passphrase', 'bare', 'allow-unlisted', 'local', 'quiet', 'help', 'h']);
function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const eq = a.indexOf('=');
    const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) o[k] = a.slice(eq + 1);
    else if (FLAGS.has(k)) o[k] = true;
    else o[k] = argv[++i];
  }
  return o;
}

const die = (msg, code = 1) => { console.error('keygen: ' + msg); process.exit(code); };
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function askHidden(prompt) {
  if (process.env.TIDYWIN_KEY_PASSPHRASE) return Promise.resolve(process.env.TIDYWIN_KEY_PASSPHRASE);
  if (!process.stdin.isTTY) return Promise.reject(new Error('no TTY: set TIDYWIN_KEY_PASSPHRASE or use --no-passphrase'));
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const muted = new Writable({ write(c, e, cb) { cb(); } }); // echo off: readline echoes into a sink
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    rl.question('', a => { rl.close(); process.stdout.write('\n'); resolve(a); });
    rl.on('error', reject);
  });
}

// ---------------------------------------------------------------- key files
function keyPaths(o, suffix = '') {
  const dir = path.resolve(o['keys-dir'] || path.join(ROOT, 'keys'));
  return { dir, priv: path.join(dir, `${KEY_NAME}${suffix}.key`), pub: path.join(dir, `${KEY_NAME}${suffix}.pub.hex`), issued: path.join(dir, 'issued.jsonl'), issuedDir: path.join(dir, 'issued') };
}
function pubHexOf(publicKey) { const der = publicKey.export({ type: 'spki', format: 'der' }); return der.subarray(der.length - 32).toString('hex'); }

async function generate(o, suffix, label) {
  const k = keyPaths(o, suffix);
  if ((fs.existsSync(k.priv) || fs.existsSync(k.pub)) && !o.force) die(`${k.priv} exists; pass --force to overwrite (this orphans every key issued with it)`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  let pem;
  if (o['no-passphrase']) pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  else {
    const pass = await askHidden('Passphrase for the new private key: ');
    if (!pass) die('empty passphrase; use --no-passphrase to write an unencrypted key on purpose');
    if (!process.env.TIDYWIN_KEY_PASSPHRASE) { const again = await askHidden('Repeat passphrase: '); if (again !== pass) die('passphrases differ'); }
    pem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: pass });
  }
  fs.mkdirSync(k.dir, { recursive: true });
  fs.writeFileSync(k.priv, pem, { mode: 0o600 });
  const hex = pubHexOf(publicKey);
  fs.writeFileSync(k.pub, hex + '\n');
  console.log(`${label} written:\n  private: ${k.priv}${o['no-passphrase'] ? '  (UNENCRYPTED)' : '  (aes-256-cbc)'}\n  public:  ${k.pub}\n`);
  console.log(`PUBLIC_KEYS entry for lib/license-codec.js:\n  '${hex}',\n`);
  console.log('BACK IT UP: copy the private key and its passphrase into your password manager. Do not keep the only copy\n' +
    'inside the repo, OneDrive or any synced folder. Losing it means every customer key must be re-issued.');
  return hex;
}

function loadPrivate(o) {
  const k = keyPaths(o);
  if (!fs.existsSync(k.priv)) die(`${k.priv} not found; run "keygen init" first`);
  const pem = fs.readFileSync(k.priv, 'utf8');
  if (!/ENCRYPTED PRIVATE KEY/.test(pem)) return crypto.createPrivateKey(pem);
  return askHidden('Private key passphrase: ').then(pass => { try { return crypto.createPrivateKey({ key: pem, passphrase: pass }); } catch { return die('wrong passphrase'); } });
}
function loadPubHex(o) {
  const k = keyPaths(o);
  if (!fs.existsSync(k.pub)) die(`${k.pub} not found; run "keygen init" first`);
  const hex = fs.readFileSync(k.pub, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) die(`${k.pub} does not contain 64 hex chars`);
  return hex.toLowerCase();
}
function requireListed(o, hex) {
  if (codec.PUBLIC_KEYS.includes(hex) || o['allow-unlisted']) return;
  die(`local public key ${hex.slice(0, 12)}… is not in PUBLIC_KEYS (lib/license-codec.js); the app would reject keys signed with it.\n` +
    '        Paste the entry printed by "keygen init" first, or pass --allow-unlisted for test keys.');
}

// ---------------------------------------------------------------- token files
function armor(token, header) {
  const lines = ['-----BEGIN TIDYWIN LICENSE-----', ...header.map(h => '# ' + h)];
  for (let i = 0; i < token.length; i += 64) lines.push(token.slice(i, i + 64));
  lines.push('-----END TIDYWIN LICENSE-----');
  return lines.join('\r\n') + '\r\n';
}
function readTokenArg(arg) {
  if (!arg) die('expected a .lic file path or a token');
  if (fs.existsSync(arg) && fs.statSync(arg).isFile()) return fs.readFileSync(arg, 'utf8');
  return arg;
}
function nextId(o) {
  const k = keyPaths(o);
  let n = 0;
  if (fs.existsSync(k.issued)) n = fs.readFileSync(k.issued, 'utf8').split(/\r?\n/).filter(Boolean).length;
  return `TW-${new Date().getFullYear()}-${String(n + 1).padStart(6, '0')}`;
}
function printPayload(p) {
  const rows = [['id', p.id], ['edition', p.edition], ['licensee', p.licensee], ['email', p.email || '-'], ['seats', p.seats], ['issued', p.issued],
    ['expires', p.expires || 'never (perpetual)'], ['maint', p.maint || '-'], ['features', p.features ? p.features.join(',') : (p.edition === 'enterprise' ? 'all' : '-')],
    ['brand', p.brand ? `${p.brand.name}${p.brand.support ? ' <' + p.brand.support + '>' : ''}` : '-'], ['notes', p.notes || '-']];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(9)} ${v}`);
}

// ---------------------------------------------------------------- commands
async function cmdInit(o) { await generate(o, '', 'Keypair'); }
async function cmdRotate(o) {
  const k = keyPaths(o);
  if (!fs.existsSync(k.priv)) die('no primary key to rotate from; run "keygen init"');
  await generate(o, '.2', 'Rotation keypair');
  console.log('\nNext: append the entry above to PUBLIC_KEYS (keep the old one while issued keys are in use), ship a build,\n' +
    `then rename ${KEY_NAME}.2.* over ${KEY_NAME}.* to issue with the new key.`);
}

async function cmdIssue(o) {
  const edition = o.edition;
  if (edition !== 'solo' && edition !== 'enterprise') die('--edition solo|enterprise is required');
  if (!o.licensee || !String(o.licensee).trim()) die('--licensee is required');
  const hex = loadPubHex(o);
  requireListed(o, hex);
  const seats = o.seats != null ? Number(o.seats) : SEATS_DEFAULT[edition];
  if (!Number.isInteger(seats) || seats < 1) die('--seats must be an integer >= 1');
  for (const k of ['expires', 'maint']) if (o[k] != null && !YMD.test(o[k])) die(`--${k} must be YYYY-MM-DD`);
  const id = o.id || nextId(o);
  const p = { v: 1, product: 'tidywin', id, edition, licensee: String(o.licensee).trim() };
  if (o.email) p.email = String(o.email);
  p.seats = seats;
  p.issued = codec.today();
  p.expires = o.expires || null;
  if (o.maint) p.maint = o.maint;
  if (edition === 'enterprise') {
    if (o.features) {
      const f = String(o.features).split(',').map(s => s.trim()).filter(Boolean);
      const bad = f.filter(x => !codec.FEATURES.includes(x));
      if (bad.length) die(`unknown feature(s): ${bad.join(', ')} (valid: ${codec.FEATURES.join(', ')})`);
      p.features = [...new Set(f)];
    }
    if (o['brand-name']) p.brand = { name: String(o['brand-name']), support: o['brand-support'] ? String(o['brand-support']) : undefined };
    if (p.brand && p.brand.support === undefined) delete p.brand.support;
  } else if (o.features || o['brand-name'] || o['brand-support']) die('--features / --brand-* only apply to --edition enterprise');
  if (o.notes) p.notes = String(o.notes);
  const bad = codec.validatePayload(p); if (bad) die('payload invalid: ' + bad);

  const priv = await loadPrivate(o);
  const token = codec.encode(p, priv);
  const r = codec.verifyToken(token, { keys: [hex], today: codec.today() });
  if (r.status !== 'valid') die(`self-check failed: ${r.status}${r.detail ? ' (' + r.detail + ')' : ''}`);

  const k = keyPaths(o);
  const out = o.out ? path.resolve(o.out) : path.join(k.issuedDir, `${id}.lic`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const text = o.bare ? token + '\n' : armor(token, [
    `NodeMend ${edition} license for ${p.licensee} (${id})`,
    `Issued ${p.issued}, expires ${p.expires || 'never'}. Place next to NodeMend.exe as TidyWin.lic or paste into the License tab.`]);
  fs.writeFileSync(out, text);
  fs.mkdirSync(k.dir, { recursive: true });
  fs.appendFileSync(k.issued, JSON.stringify({ id, issuedAt: new Date().toISOString(), sha256: crypto.createHash('sha256').update(token).digest('hex'), payload: p }) + '\n');
  if (!o.quiet) { console.log(`Issued ${id} -> ${out}`); printPayload(p); console.log(''); }
  console.log(token);
}

function cmdVerify(o) {
  const text = readTokenArg(o._[1]);
  let keys = codec.PUBLIC_KEYS;
  if (o.pub) keys = [String(o.pub).toLowerCase()];
  else if (o.local) keys = [loadPubHex(o)];
  if (!keys.length) console.error('keygen: PUBLIC_KEYS is empty; pass --pub <hex> or --local');
  const r = codec.verifyToken(text, { keys, today: codec.today(), builtAt: o['built-at'] || null });
  console.log(`status: ${r.status}${r.detail ? ' (' + r.detail + ')' : ''}${r.warnings && r.warnings.length ? '  warnings: ' + r.warnings.join(',') : ''}`);
  if (r.payload) printPayload(r.payload);
  process.exit(r.status === 'valid' ? 0 : 1);
}

function cmdShow(o) {
  const d = codec.decode(readTokenArg(o._[1]));
  if (d.error) die('cannot decode: ' + d.error);
  console.log('(decoded WITHOUT signature verification)');
  printPayload(d.payload);
  console.log(JSON.stringify(d.payload));
}

async function cmdFixtureExpired(o) {
  const hex = loadPubHex(o);
  requireListed(o, hex);
  const p = { v: 1, product: 'tidywin', id: 'TW-2020-000000', edition: 'solo', licensee: 'TEST FIXTURE - not for use', seats: 1, issued: '2020-01-01', expires: '2020-01-01', notes: 'committed test fixture; proves PUBLIC_KEYS matches the signing key' };
  const token = codec.encode(p, await loadPrivate(o));
  const r = codec.verifyToken(token, { keys: [hex], today: codec.today() });
  if (r.status !== 'expired') die('self-check expected expired, got ' + r.status);
  const out = path.join(ROOT, 'test', 'fixtures', 'prod-expired.lic');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, armor(token, ['NodeMend TEST FIXTURE - expired 2020-01-01, not for use', 'Signed by the production key so test/license.test.js can prove PUBLIC_KEYS matches it']));
  console.log('written ' + out);
}

(async () => {
  const o = parse(process.argv.slice(2));
  const cmd = o._[0];
  if (!cmd || o.help || o.h || cmd === 'help') { console.log(USAGE); process.exit(cmd || o.help || o.h ? 0 : 1); }
  const cmds = { init: cmdInit, issue: cmdIssue, verify: cmdVerify, show: cmdShow, rotate: cmdRotate, 'fixture-expired': cmdFixtureExpired };
  if (!cmds[cmd]) die(`unknown command "${cmd}"\n\n${USAGE}`);
  try { await cmds[cmd](o); } catch (e) { die(e && e.message || String(e)); }
})();

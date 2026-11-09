// NodeMend — test fixtures: an EPHEMERAL Ed25519 keypair (generated per process, never written
// anywhere, never committed) plus signed tokens and policy files. Shared by test/license.test.js
// and smoketest.js (which passes pubHex through TIDYWIN_TEST_PUBKEY, honored only in dev).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const codec = require('../lib/license-codec');

const ISSUED = '2026-09-16'; // fixed so token bytes are stable across runs and clocks

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, publicKey, pubHex: der.subarray(der.length - 32).toString('hex') };
}

function base(over) {
  return { v: 1, product: 'tidywin', id: 'TW-2026-000001', edition: 'solo', licensee: 'Test Person', email: 'test@example.com', seats: 1, issued: ISSUED, expires: null, ...over };
}

function make() {
  const k = keypair(), other = keypair();
  const sign = payload => codec.encode(payload, k.privateKey);
  const solo = base({ id: 'TW-2026-000001', edition: 'solo', licensee: 'Test Person', seats: 1 });
  const ent = base({ id: 'TW-2026-000042', edition: 'enterprise', licensee: 'Contoso Ltd', email: 'it@contoso.example', seats: 250,
    features: ['unattended', 'report', 'policy', 'audit', 'brand'], brand: { name: 'Northwind MSP', support: 'helpdesk@northwind.example' }, notes: 'PO 4471' });
  const payloads = {
    solo, ent,
    entSubset: { ...ent, id: 'TW-2026-000043', features: ['report', 'policy', 'audit', 'brand'] },
    expired: base({ id: 'TW-2026-000002', expires: '2020-01-01' }),
    maintOld: base({ id: 'TW-2026-000003', maint: '2020-01-01' }),
    future: base({ id: 'TW-2026-000004', issued: '2099-01-01' }),
    wrongProduct: base({ id: 'TW-2026-000005', product: 'notepad' })
  };
  const tokens = {};
  for (const [name, p] of Object.entries(payloads)) tokens[name] = sign(p);
  // tampered: the enterprise payload re-encoded with seats:9999 but carrying the ORIGINAL signature
  const sig = tokens.ent.split('.')[2];
  tokens.tampered = 'TIDYWIN1.' + Buffer.from(JSON.stringify({ ...ent, seats: 9999 }), 'utf8').toString('base64url') + '.' + sig;
  tokens.wrongKey = codec.encode(ent, other.privateKey);
  tokens.garbage = 'hello';

  // What an emailed key looks like: armor, two '#' header lines, CRLF, 64-column wrapping.
  const wrap = token => {
    const lines = ['-----BEGIN TIDYWIN LICENSE-----', '# NodeMend license file — keep next to NodeMend.exe or paste into the License tab', '# Issued by BoHadashTech'];
    for (let i = 0; i < token.length; i += 64) lines.push(token.slice(i, i + 64));
    lines.push('-----END TIDYWIN LICENSE-----');
    return lines.join('\r\n') + '\r\n';
  };

  const locked = { version: 1, orgName: 'Contoso IT', supportText: 'Problems? Call the service desk on 4444', hideTabs: ['programs'],
    disable: ['dup-trash', 'recycle', 'uninstall'], cleaner: { on: ['user-temp', 'win-temp', 'crash'], lock: true }, unattended: { allow: true } };
  const policies = {
    locked,
    lockedUnattended: { ...locked, unattended: { allow: true, profile: 'smoke', timeoutMin: 5 } },
    noUnattended: { version: 1, unattended: { allow: false } }
  };

  const writeAll = dir => {
    fs.mkdirSync(dir, { recursive: true });
    const files = {
      'solo.lic': wrap(tokens.solo), 'ent.lic': wrap(tokens.ent), 'ent-subset.lic': wrap(tokens.entSubset), 'expired.lic': wrap(tokens.expired),
      'maint-old.lic': wrap(tokens.maintOld), 'tampered.lic': tokens.tampered, 'wrong-key.lic': tokens.wrongKey, 'wrong-product.lic': tokens.wrongProduct,
      'locked.json': JSON.stringify(policies.locked, null, 2), 'locked-unattended.json': JSON.stringify(policies.lockedUnattended, null, 2),
      'no-unattended.json': JSON.stringify(policies.noUnattended, null, 2)
    };
    const out = {};
    for (const [name, text] of Object.entries(files)) { const p = path.join(dir, name); fs.writeFileSync(p, text); out[name] = p; }
    return out;
  };

  return { pubHex: k.pubHex, privateKey: k.privateKey, otherPubHex: other.pubHex, sign, payloads, tokens, wrap, policies, writeAll };
}

module.exports = { make, keypair, ISSUED };

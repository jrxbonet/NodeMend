// TidyWin — license token codec (pure Node, no Electron imports)
// Shared by the app (main.js), the developer keygen (tools/keygen.js) and the tests.
// Token: TIDYWIN1.<base64url payload>.<base64url Ed25519 signature>. The signature covers the
// exact payload bytes, so the verifier checks the signature first and only then JSON.parses;
// there is no canonicalization anywhere (the sorted-keys replacer bug is thereby avoided).
const crypto = require('crypto');

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // Ed25519 SubjectPublicKeyInfo
// Raw 32-byte Ed25519 public keys as 64 hex chars. `node tools/keygen.js init` prints the entry to
// paste here; append a 2nd entry on rotation (`keygen rotate`) and keep the old one while issued
// keys are still in use. Example entry:
//   '5711e56256eea000cb1961e4b6350605fbf12b45819d140404eeaa343689d505',
const PUBLIC_KEYS = [
  'eb89e85fe99638b51efcb183bebb4ec0fc93ecf8046123e7fcae55f060196e47', // BoHadashTech production key, generated 2026-09-16 (keys/tidywin-ed25519.key)
];
const RE = /^(TIDYWIN1)\.([A-Za-z0-9_-]{20,12000})\.([A-Za-z0-9_-]{86})$/;
const FEATURES = ['unattended', 'report', 'policy', 'audit', 'brand'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^TW-\d{4}-\d{6}$/;

function pubFromHex(h) { return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(h, 'hex')]), format: 'der', type: 'spki' }); }
function normalize(t) { return String(t || '').replace(/^\uFEFF/, '').replace(/-----[^-\r\n]+-----/g, '').replace(/^#.*$/gm, '').replace(/\s+/g, ''); }
function encode(payload, privateKey) { const b = Buffer.from(JSON.stringify(payload), 'utf8'); return `TIDYWIN1.${b.toString('base64url')}.${crypto.sign(null, b, privateKey).toString('base64url')}`; }

// Local calendar date as YYYY-MM-DD (day granularity; the app never stores clock state).
function today(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Date-string arithmetic in UTC so DST never shifts a day boundary.
function addDays(ymd, n) {
  const [y, m, d] = String(ymd || today()).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Returns null when the payload matches section 2.3, else a short reason ('seats', 'edition', ...).
// Unknown fields are ignored for forward compatibility.
function validatePayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'object';
  if (p.v !== 1) return 'v';
  if (p.product !== 'tidywin') return 'product';
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) return 'id';
  if (p.edition !== 'solo' && p.edition !== 'enterprise') return 'edition';
  if (typeof p.licensee !== 'string' || !p.licensee.trim()) return 'licensee';
  if (p.email != null && typeof p.email !== 'string') return 'email';
  if (!Number.isInteger(p.seats) || p.seats < 1) return 'seats';
  if (typeof p.issued !== 'string' || !YMD.test(p.issued)) return 'issued';
  if (p.expires != null && (typeof p.expires !== 'string' || !YMD.test(p.expires))) return 'expires';
  if (p.maint != null && (typeof p.maint !== 'string' || !YMD.test(p.maint))) return 'maint';
  if (p.features != null && !(Array.isArray(p.features) && p.features.every(f => FEATURES.includes(f)))) return 'features';
  if (p.brand != null && !(typeof p.brand === 'object' && !Array.isArray(p.brand) && typeof p.brand.name === 'string' && (p.brand.support == null || typeof p.brand.support === 'string'))) return 'brand';
  if (p.notes != null && typeof p.notes !== 'string') return 'notes';
  return null;
}

// opts: { keys: string[] (hex), today: 'YYYY-MM-DD', builtAt: 'YYYY-MM-DD'|null }
// Statuses: valid | expired | maint | signature | payload | format. Clock problems never hard-stop:
// a future `issued` only warns (fail-open) and expiry degrades to Evaluation.
function verifyToken(text, opts = {}) {
  const m = RE.exec(normalize(text));
  if (!m) return { status: 'format' };
  const pb = Buffer.from(m[2], 'base64url'), sb = Buffer.from(m[3], 'base64url');
  if (pb.length > 8192) return { status: 'format' };
  const sigOk = (opts.keys || PUBLIC_KEYS).some(h => { try { return crypto.verify(null, pb, pubFromHex(h), sb); } catch { return false; } });
  if (!sigOk) return { status: 'signature' };
  let p; try { p = JSON.parse(pb.toString('utf8')); } catch { return { status: 'payload' }; }
  const bad = validatePayload(p); if (bad) return { status: 'payload', detail: bad, payload: p };
  const tod = opts.today || today();
  const warnings = [];
  if (p.issued > addDays(tod, 1)) warnings.push('issued-in-future');           // fail-open
  if (p.expires && p.expires < tod) return { status: 'expired', payload: p, warnings };
  if (p.expires && p.expires <= addDays(tod, 30)) warnings.push('expires-soon');
  if (p.maint && opts.builtAt && opts.builtAt > p.maint) return { status: 'maint', payload: p, warnings };
  return { status: 'valid', payload: p, warnings };
}

// Decode WITHOUT verifying (support use: `keygen show`). Returns { payload } or { error }.
function decode(text) {
  const m = RE.exec(normalize(text));
  if (!m) return { error: 'format' };
  try { return { payload: JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8')), sigB64: m[3] }; }
  catch { return { error: 'payload' }; }
}

// True when the text is a bare/armored token rather than a file path (used by --license / TIDYWIN_LICENSE).
function looksLikeToken(text) { return RE.test(normalize(text)); }

module.exports = { PUBLIC_KEYS, SPKI_PREFIX, RE, FEATURES, pubFromHex, normalize, encode, verifyToken, validatePayload, decode, looksLikeToken, today, addDays };

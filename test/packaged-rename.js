// Explicit post-build QA. Boots the packaged portable builds headlessly in isolated temporary
// directories; never installs tasks or performs maintenance.
//   Solo build: has no unattended module, so --unattended is refused with exit 3.
//   Full build: needs no key. It is started with an invalid --steps value, which must be
//   rejected as bad arguments (exit 2) and not as a licence refusal, before any step runs.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodemend-packaged-'));
const BUILDS = [
  { label: 'Solo', file: 'NodeMend-Solo-portable.exe', args: [], status: 3, log: /EXIT 3 .*LICENSE_REQUIRED/ },
  { label: 'Full', file: 'NodeMend-portable.exe', args: ['--steps=bogus'], status: 2, log: /EXIT 2 / }
];
try {
  for (const build of BUILDS.filter(b => !process.argv.includes('--full-only') || b.label === 'Full')) {
    const base = path.join(tmp, build.label); fs.mkdirSync(base);
    const exe = path.join(base, build.file);
    fs.copyFileSync(path.join(ROOT, 'dist', 'portable', build.file), exe);
    fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'prod-expired.lic'), path.join(base, 'TidyWin.lic'));
    const env = { ...process.env, TEMP: base, TMP: base, ProgramData: path.join(base, 'pd'), PROGRAMDATA: path.join(base, 'pd') };
    for (const key of Object.keys(env)) if (/^(?:TIDYWIN_|NODEMEND_|PORTABLE_EXECUTABLE_)/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
    const log = path.join(base, 'run.log');
    const child = spawnSync(exe, ['--unattended', ...build.args, '--log=' + log, '--quiet'], { env, windowsHide: true, timeout: 90000, stdio: 'ignore' });
    assert.ifError(child.error);
    assert.equal(child.status, build.status, `${build.label} exit code`);
    const text = fs.readFileSync(log, 'utf8');
    assert.match(text, build.log);
    if (build.label === 'Full') assert.doesNotMatch(text, /LICENSE_REQUIRED/, 'the full build must never ask for a licence');
    assert(fs.statSync(path.join(base, 'NodeMend-portable')).isDirectory());
    assert(!fs.existsSync(path.join(base, 'pd', 'NodeMend', 'reports')));
    assert.equal(fs.readFileSync(path.join(base, 'TidyWin.lic'), 'utf8'), fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'prod-expired.lic'), 'utf8'));
    console.log(`PASS packaged ${build.label}: NodeMend portable starts, isolated storage, legacy key file retained, exit ${build.status}/log, no maintenance`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

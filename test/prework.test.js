'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { chkdskDrive, browserPattern, resolveUninstallArgs } = require('../lib/main-inputs');
const { eligibility } = require('../lib/schedule');
const gate = require('../lib/gate');

async function main() {
  assert.equal(chkdskDrive(), 'C:');
  assert.equal(chkdskDrive({ drive: 'e:' }), 'E:');
  for (const drive of ['', null, [], 'C:\\', 'C: /f', '/f', 'C:\n', 'CC:'])
    assert.throws(() => chkdskDrive({ drive }), /INVALID_DRIVE/);
  const edge = browserPattern('edge', 'win32');
  assert.equal(edge.test('"msedgewebview2.exe","123","Console"\r\n'), false);
  assert.equal(edge.test('"msedge.exe","123","Console"\r\n'), true);
  assert.equal(edge.test('"fake-msedge.exe","123"'), false);
  assert.equal(browserPattern('edge', 'darwin').test('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge\n'), true);
  for (const listing of ['/opt/microsoft/msedge/msedge\n', 'msedge\n'])
    assert.equal(browserPattern('edge', 'linux').test(listing), true);
  for (const listing of ['/opt/microsoft/msedge/msedgewebview2\n', 'fake-msedge\n'])
    assert.equal(browserPattern('edge', 'linux').test(listing), false);
  const publicArgs = ['-Kind', 'registry', '-Id', '{fixture}', '-Silent'];
  let lookup;
  const args = await resolveUninstallArgs('uninstall.ps1', publicArgs, async id => {
    lookup = id; return { ok: true, uninstall: '"C:\\Program Files\\Fixture\\uninstall.exe"', quiet: '"C:\\Program Files\\Fixture\\uninstall.exe" /S' };
  });
  assert.equal(lookup, '{fixture}');
  assert.equal(args.at(-2), '-quiet');
  assert.equal(publicArgs.length, 5, 'caller args are not mutated');
  let presented;
  const lookupInfo = async () => ({ ok: true, name: 'Fixture App', scope: 'user', uninstall: 'normal.exe', quiet: 'quiet.exe /S' });
  await assert.rejects(resolveUninstallArgs('uninstall.ps1', publicArgs, lookupInfo, async info => { presented = info; return false; }), /UNINSTALL_CANCELLED/);
  assert.equal(presented.command, 'quiet.exe /S');
  assert.equal(presented.scope, 'user');
  assert.equal(presented.name, 'Fixture App');
  await resolveUninstallArgs('uninstall.ps1', publicArgs.filter(a => a !== '-Silent'), lookupInfo, async info => { assert.equal(info.command, 'normal.exe'); return true; });
  for (const flag of ['-Uninstall', '-Quiet']) {
    assert.throws(() => gate.validateScriptArgs('uninstall.ps1', [...publicArgs, flag, 'evil.exe']), /invalid script arguments/);
    await assert.rejects(resolveUninstallArgs('uninstall.ps1', [...publicArgs, flag, 'evil.exe'], async () => { throw Error('must not read'); }), /invalid script arguments/);
  }
  for (const id of ['', '..', 'child\\escape', 'child/escape'])
    await assert.rejects(resolveUninstallArgs('uninstall.ps1', ['-Id', id], async () => { throw Error('must not read'); }), /INVALID_PROGRAM_ID/);
  await assert.rejects(resolveUninstallArgs('uninstall.ps1', publicArgs, async () => ({ ok: false, error: 'missing or ambiguous' })), /missing or ambiguous/);
  const appx = ['-Kind', 'appx', '-Id', 'Fixture_1.0_x64'];
  assert.deepEqual(await resolveUninstallArgs('uninstall.ps1', appx, async () => { throw Error('must not read'); }), appx);

  const options = { packaged: true, portable: false, platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' } };
  assert.equal(eligibility('C:\\Program Files\\NodeMend\\NodeMend.exe', options).allowed, true);
  for (const exe of ['C:\\Users\\Fixture\\Downloads\\NodeMend.exe', 'C:\\Program Files Fake\\NodeMend.exe', 'C:\\Program Files\\..\\Users\\NodeMend.exe', '\\\\host\\Program Files\\NodeMend.exe'])
    assert.equal(eligibility(exe, options).allowed, false, exe);
  for (const override of [{ portable: true }, { packaged: false }, { platform: 'linux' }])
    assert.equal(eligibility('C:\\Program Files\\NodeMend\\NodeMend.exe', { ...options, ...override }).allowed, false);
  // Exercise the real install entry point. The portable path must fail BEFORE any
  // ScheduledTasks calls; this test never creates/removes a scheduled task.
  if (process.platform === 'win32') {
    const root = path.resolve(__dirname, '..');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tidywin-schedule-refusal-'));
    try {
      const exe = path.join(tmp, 'NodeMend.exe'); fs.writeFileSync(exe, 'fixture, never executed');
      const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'ps/schedule.ps1'), '-Install', '-Exe', exe], { encoding: 'utf8' });
      assert.equal(result.status, 1, result.stderr);
      const refusal = JSON.parse(result.stdout.trim());
      assert.equal(refusal.ok, false); assert.match(refusal.error, /protected Program Files/);
      const aclTests = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'schedule-protection.ps1')], { encoding: 'utf8' });
      assert.equal(aclTests.status, 0, aclTests.stdout + aclTests.stderr);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  console.log('RESULT: PASS (main input validation, registry command ownership, schedule path/ACL/refusal fixtures; no machine changes)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });

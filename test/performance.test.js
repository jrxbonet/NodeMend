// No native actions. All pause/resume calls below use an injected fixture provider.
const assert = require('assert');
const { createPerformanceService } = require('../lib/performance');
function fixture() {
  const records = [
    { pid: 900001, ppid: 900002, name: 'NodeMend', owner: 'self', startTime: '1' },
    { pid: 900002, ppid: 1, name: 'Spotify', owner: 'self', startTime: '2' },
    { pid: 900010, ppid: 1, name: 'Spotify', owner: 'self', startTime: '10', state: 'S' },
    { pid: 900011, ppid: 1, name: 'Discord', owner: 'someone-else', startTime: '11' },
    { pid: 900012, ppid: 1, name: 'bash', owner: 'self', startTime: '12' },
    { pid: 900013, ppid: 1, name: 'chrome', owner: 'self', startTime: '13' },
    { pid: 900014, ppid: 1, name: 'steam.exe', owner: 'self', startTime: '14', state: 'S' },
    { pid: 900015, ppid: 1, name: 'Spotify', owner: 'self', startTime: '15', state: 'T' },
    { pid: 900016, ppid: 1, name: 'notepad.exe', owner: 'self', startTime: '16' },
    { pid: 900017, ppid: 1, name: 'Discord', owner: 'self', startTime: '' }
  ];
  const calls = [];
  const provider = { owner: 'self', list: async () => records.map(r => ({ ...r })),
    pause: async r => { calls.push(['pause', r.pid, r.startTime]); return { ok: true }; },
    resume: async r => { calls.push(['resume', r.pid, r.startTime]); return { ok: true }; } };
  return { records, calls, provider, service: createPerformanceService({ platform: 'linux', mainPID: 900001, provider }) };
}
async function main() {
  const f = fixture();
  const listed = await f.service.list();
  assert.deepStrictEqual(listed.map(r => r.pid), [900010, 900014, 900015]);
  assert.strictEqual(listed.every(r => r.readOnly), true);
  for (const pid of [1, 900001, 900002, 900011, 900012, 900013, 900016, 900017]) {
    await assert.rejects(f.service.pause(pid), /PROCESS_NOT_ELIGIBLE|INVALID_PID/);
  }
  await assert.rejects(f.service.pause('900010'), /INVALID_PID/);
  await assert.rejects(f.service.pause(1.5), /INVALID_PID/);
  await assert.rejects(f.service.pause(900015), /PROCESS_ALREADY_STOPPED/);
  await assert.rejects(f.service.resume(900010), /NOT_PAUSED_BY_TIDYWIN/);
  assert.strictEqual(f.calls.length, 0);
  assert.strictEqual((await f.service.pause(900010)).paused, true);
  assert.strictEqual(f.service.getPaused().length, 1);
  assert.strictEqual((await f.service.list()).find(r => r.pid === 900010).paused, true);
  await assert.rejects(f.service.pause(900010), /ALREADY_PAUSED/);
  assert.strictEqual((await f.service.resume(900010)).resumed, true);
  assert.strictEqual(f.service.getPaused().length, 0);
  assert.deepStrictEqual(f.calls.map(r => r[0]), ['pause', 'resume']);
  // Reused PID must never receive the saved process's resume signal.
  await f.service.pause(900010);
  f.records.find(r => r.pid === 900010).startTime = 'reused';
  const before = f.calls.length;
  assert.strictEqual((await f.service.resume(900010)).ended, true);
  assert.strictEqual(f.calls.length, before);
  assert.strictEqual(f.service.getPaused().length, 0);
  const changedOwner = fixture();
  await changedOwner.service.pause(900010);
  changedOwner.records.find(r => r.pid === 900010).owner = 'different-user';
  assert.strictEqual((await changedOwner.service.resume(900010)).ended, true);
  assert.strictEqual(changedOwner.calls.length, 1);
  const exited = fixture();
  await exited.service.pause(900010);
  exited.records.splice(exited.records.findIndex(r => r.pid === 900010), 1);
  assert.strictEqual((await exited.service.resume(900010)).ended, true);
  assert.strictEqual(exited.calls.length, 1);
  await f.service.pause(900010);
  await f.service.pause(900014);
  const result = await f.service.resumeAll();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.remaining, 0);
  assert.strictEqual(result.results.length, 2);
  // Failed pause and cancelled provider operations are never claimed as paused.
  const failure = fixture();
  failure.provider.pause = async () => ({ ok: false });
  await assert.rejects(failure.service.pause(900010), /PAUSE_FAILED/);
  assert.deepStrictEqual(failure.service.getPaused(), []);
  failure.provider.pause = async () => { throw new Error('CANCELLED'); };
  await assert.rejects(failure.service.pause(900010), /CANCELLED/);
  assert.deepStrictEqual(failure.service.getPaused(), []);
  // A failed resume remains tracked for retry/shutdown recovery.
  const retry = fixture();
  await retry.service.pause(900010);
  retry.provider.resume = async () => { throw new Error('native error'); };
  const failedResume = await retry.service.resumeAll();
  assert.strictEqual(failedResume.ok, false);
  assert.strictEqual(failedResume.remaining, 1);
  retry.provider.resume = async () => ({ ok: true });
  assert.strictEqual((await retry.service.resumeAll()).remaining, 0);
  // Concurrent calls are serialized: suspension can only be applied once.
  const concurrent = fixture();
  const raced = await Promise.allSettled([concurrent.service.pause(900010), concurrent.service.pause(900010)]);
  assert.deepStrictEqual(raced.map(r => r.status), ['fulfilled', 'rejected']);
  assert.strictEqual(concurrent.calls.length, 1);
  const unavailable = createPerformanceService({ platform: 'unsupported' });
  assert.strictEqual(unavailable.capabilities.available, false);
  await assert.rejects(unavailable.list(), /PERFORMANCE_UNAVAILABLE/);
  console.log('RESULT: PASS (mocked allowlist, owner/ancestor protection, PID reuse, failure tracking, shutdown resume, serialized actions)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });

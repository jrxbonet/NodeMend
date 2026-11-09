// Focused regression: reports sharing a clock tick and Solo's actual no-Enterprise boot path.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const paths = require('../lib/paths');
const report = require('../enterprise/report');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tidywin-report-paths-'));

async function main() {
  const clock = new Date(2026, 9, 9, 3, 7);
  const ctx = { hostname: 'TEST-HOST', paths: { dataDir: path.join(tmp, 'pd'), userDataDir: path.join(tmp, 'ud'), stamp: () => paths.stamp(clock) },
    cli: { reportDir: path.join(tmp, 'remote') } };
  const names = new Set();
  for (let run = 0; run < 8; run++) {
    const result = await report.send(ctx, { json: { run }, md: `run ${run}`, profile: 'smoke' });
    assert.strictEqual(result.queued, false);
    const local = result.written.find(f => path.dirname(f) === path.join(tmp, 'pd', 'reports') && f.endsWith('.json'));
    assert.match(path.basename(local), /^2026-10-09_0307-[a-f0-9]{16}-smoke\.json$/);
    names.add(local);
    assert.strictEqual(JSON.parse(fs.readFileSync(local)).run, run);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'remote', '_latest', 'TEST-HOST.json'))).run, run);
  }
  assert.strictEqual(names.size, 8);
  const concurrent = await Promise.all(Array.from({ length: 16 }, (_, run) => report.send({ ...ctx, cli: {} },
    { json: { concurrentRun: run }, md: `concurrent ${run}`, profile: 'smoke' })));
  const concurrentFiles = concurrent.map(r => r.written.find(f => f.endsWith('.json')));
  assert.strictEqual(new Set(concurrentFiles).size, 16);
  concurrentFiles.forEach((f, run) => assert.strictEqual(JSON.parse(fs.readFileSync(f)).concurrentRun, run));
  const ids = new Set(Array.from({ length: 1000 }, () => paths.runId()));
  assert.strictEqual(ids.size, 1000);
  console.log('PASS same-clock and concurrent report pairs remain distinct; _latest preserved');

  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const harness = path.join(tmp, 'solo-harness.js');
  fs.writeFileSync(harness, `const { app } = require('electron');
Object.defineProperty(app, 'isPackaged', { get: () => true });
app.setPath('userData', process.env.SOLO_TEST_USERDATA);
require(${JSON.stringify(path.join(ROOT, 'main.js'))});\n`);
  for (const mode of ['default', 'explicit', 'fallback']) {
    const pd = path.join(tmp, mode, 'pd'), ud = path.join(tmp, mode, 'ud');
    fs.mkdirSync(path.dirname(pd), { recursive: true });
    if (mode === 'fallback') fs.writeFileSync(pd, 'not a directory');
    const env = { ...process.env, ProgramData: pd, PROGRAMDATA: pd, SOLO_TEST_USERDATA: ud };
    for (const key of ['TIDYWIN_NO_WINDOW', 'ELECTRON_RUN_AS_NODE', 'TIDYWIN_LICENSE', 'TIDYWIN_POLICY']) delete env[key];
    const explicit = path.join(tmp, mode, 'explicit.log');
    const args = [harness, '--unattended', ...(mode === 'explicit' ? ['--log=' + explicit] : [])];
    const child = spawnSync(electron, args, { env, windowsHide: true, timeout: 30000, stdio: 'ignore' });
    assert.ifError(child.error);
    assert.strictEqual(child.status, 3, mode);
    const logDir = mode === 'fallback' ? path.join(ud, 'logs') : path.join(pd, 'NodeMend', 'logs');
    const logFile = mode === 'explicit' ? explicit : path.join(logDir, fs.readdirSync(logDir).find(f => f.endsWith('-unattended.log')));
    assert.match(fs.readFileSync(logFile, 'utf8'), /EXIT 3 .*LICENSE_REQUIRED .*got build=solo/);
    if (mode === 'explicit') assert.strictEqual(fs.existsSync(path.join(pd, 'NodeMend', 'logs')), false);
    console.log(`PASS packaged Solo/no-ENT --unattended exit 3 with ${mode} log and reason`);
  }
}

main().then(() => { fs.rmSync(tmp, { recursive: true, force: true }); console.log('RESULT: PASS'); })
  .catch(e => { console.error(e); process.exitCode = 1; });

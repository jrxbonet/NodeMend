'use strict';
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const recovery = require('../lib/recovery');

const root = 'C:\\Program Files\\WindowsApps';
const pkg = 'Microsoft.WindowsFileRecovery_0.2.20162.0_x64__8wekyb3d8bbwe';
const engine = path.win32.join(root, pkg, 'winfr.exe');
const bundle = 'D:\\Apps\\NodeMend\\vendor\\photorec';
const files = new Map([
  [engine, { file: true }],
  [path.win32.join(bundle, 'qphotorec_win.exe'), { file: true }],
  [path.win32.join(bundle, 'photorec_win.exe'), { file: true }],
  [path.win32.join(bundle, '63', 'cygwin'), { file: true }],
  ['D:\\Images\\fixture.img', { file: true, size: 8192 }],
  ['E:\\Recovery', { directory: true }],
  ['D:\\Images', { directory: true }],
  ['D:\\', { directory: true }]
]);
function fakeFs(overrides = {}) {
  return {
    readdirSync: location => { assert.strictEqual(location, root); return [pkg, 'malicious_winfr.exe']; },
    realpathSync: location => {
      if ([root, bundle].includes(location) || files.has(location)) return location;
      const error = new Error('missing'); error.code = 'ENOENT'; throw error;
    },
    statSync: location => {
      const item = files.get(location);
      if (!item) throw new Error('missing');
      return { isFile: () => !!item.file, isDirectory: () => !!item.directory, size: item.size || 1 };
    }, ...overrides
  };
}
function harness(overrides = {}) {
  const calls = [];
  let child;
  const service = recovery.createRecoveryService({ platform: 'win32', systemRoot: 'C:\\Windows',
    bundledDirectory: bundle, fs: fakeFs(),
    spawn: (filename, args, options) => {
      calls.push({ filename, args, options });
      child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; };
      return child;
    }, ...overrides });
  return { service, calls, get child() { return child; } };
}
const request = { source: 'c:', destination: 'e:', mode: 'regular', filters: ['*.pdf', '\\Users\\Alice\\My Documents\\'] };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function main() {
  assert.strictEqual(recovery.validateRequest(request).ok, true);
  assert.strictEqual(recovery.validateRequest({ ...request, destination: 'C:' }).code, 'SAME_VOLUME');
  for (const source of ['C:\\', 'C: & whoami', '\\\\.\\PhysicalDrive0', 'C:\\image.img', '/dev/sda', '-C:'])
    assert.strictEqual(recovery.validateRequest({ ...request, source }).code, 'INVALID_DRIVE', source);
  for (const filter of ['*.pdf /a', '/a', '-x', '..\\x.pdf', '\\..\\x.pdf', '\\\\server\\x.pdf',
    'C:\\Users\\x.pdf', 'x.pdf&whoami', 'x.pdf;whoami', 'x.pdf|whoami', 'x.pdf\n/a',
    'x.pdf" /a', '$(whoami).pdf', '%TEMP%\\*.pdf', 'CON.txt', '*.pdf:stream', '*', '*.*', 'x'.repeat(241)])
    assert.strictEqual(recovery.validateRequest({ ...request, filters: [filter] }).code, 'INVALID_FILTER', filter);
  for (const mode of ['/regular', 'regular /a', 'signature', null])
    assert.strictEqual(recovery.validateRequest({ ...request, mode }).code, 'INVALID_MODE');
  assert.strictEqual(recovery.validateRequest({ ...request, filters: [] }).code, 'INVALID_FILTER');
  assert.strictEqual(recovery.validateRequest({ ...request, filters: Array(21).fill('*.pdf') }).code, 'INVALID_FILTER');
  assert.strictEqual(recovery.validateRequest({ ...request, executablePath: 'evil.exe' }).code, 'INVALID_REQUEST');
  console.log('PASS drive/filter/mode validation rejects same-volume and argument injection');

  const h = harness();
  const availability = await h.service.detectEngine();
  assert.strictEqual(availability.executable, engine);
  const plan = await h.service.plan(request);
  assert.deepStrictEqual(plan.args, ['C:', 'E:', '/regular', '/n', '*.pdf', '/n', '\\Users\\Alice\\My Documents\\', '/a']);
  assert.strictEqual(h.calls.length, 0, 'planning must not start recovery');
  assert.strictEqual((await harness({ platform: 'linux' }).service.detectEngine()).code, 'UNSUPPORTED_PLATFORM');
  assert.strictEqual((await harness({ fs: fakeFs({ readdirSync: () => [] }) }).service.detectEngine()).code, 'ENGINE_UNAVAILABLE');
  assert.strictEqual((await harness({ fs: fakeFs({ realpathSync: () => 'C:\\Users\\Alice\\evil.exe' }) }).service.detectEngine()).code, 'ENGINE_UNAVAILABLE');
  assert.strictEqual((await harness({ fs: fakeFs({ readdirSync: () => { const err = new Error('denied'); err.code = 'EACCES'; throw err; } }) }).service.detectEngine()).reason, 'EACCES');
  assert.strictEqual((await harness({ systemRoot: '.\\Windows' }).service.detectEngine()).code, 'UNTRUSTED_SYSTEM_ROOT');
  console.log('PASS trusted absolute package discovery, no PATH/cwd fallback, and unavailable/access-denied status');

  const events = [];
  const run = h.service.run(request, { onProgress: event => events.push(event) });
  await tick();
  assert.strictEqual(run.getStatus(), 'running');
  const call = h.calls[0];
  assert.strictEqual(call.filename, engine);
  assert.strictEqual(call.options.shell, false);
  assert.deepStrictEqual(call.args, plan.args);
  h.child.stdout.emit('data', Buffer.from('Scanning 42%\r\n'));
  h.child.stderr.emit('data', Buffer.from('x'.repeat(90000)));
  h.child.emit('close', 0, null);
  const completed = await run.result;
  assert.strictEqual(completed.ok, true);
  assert.strictEqual(completed.output.length, 65536);
  assert.strictEqual(events.find(event => event.type === 'output').percent, 42);
  assert.strictEqual(run.cancel(), false);
  console.log('PASS argv spawn, progress, bounded output and completion without claims of recovered-file count');

  const cancelHarness = harness();
  const cancelled = cancelHarness.service.run(request);
  await tick();
  const busy = cancelHarness.service.run(request);
  assert.strictEqual((await busy.result).code, 'RECOVERY_BUSY');
  cancelled.cancel();
  assert.strictEqual((await cancelled.result).code, 'CANCELLED');
  assert.strictEqual(cancelHarness.child.killed, true);
  const early = cancelHarness.service.run(request); early.cancel();
  assert.strictEqual((await early.result).status, 'cancelled');
  const aborted = new AbortController(); aborted.abort();
  assert.strictEqual((await cancelHarness.service.run(request, { signal: aborted.signal }).result).code, 'CANCELLED');
  assert.strictEqual((await h.service.run(request, { timeoutMs: 0 }).result).code, 'INVALID_TIMEOUT');
  assert.strictEqual((await h.service.run({ ...request, destination: 'C:' }).result).code, 'SAME_VOLUME');
  const startError = harness({ spawn: () => { throw new Error('cannot start'); } });
  assert.strictEqual((await startError.service.run(request).result).code, 'START_FAILED');
  const engineError = harness(); const failed = engineError.service.run(request); await tick();
  const accessError = new Error('administrator required'); accessError.code = 'EACCES';
  engineError.child.emit('error', accessError);
  assert.strictEqual((await failed.result).code, 'ADMIN_REQUIRED');
  const exitError = harness(); const exitRun = exitError.service.run(request); await tick(); exitError.child.emit('close', 2, null);
  assert.strictEqual((await exitRun.result).code, 'ENGINE_FAILED');
  const timeoutHarness = harness();
  assert.strictEqual((await timeoutHarness.service.run(request, { timeoutMs: 1000 }).result).code, 'TIMEOUT');
  console.log('PASS cancellation, already-running guard, invalid timeout and engine failures');

  const image = { source: 'D:\\Images\\fixture.img', destination: 'E:\\Recovery', fileTypes: ['jpg', 'png', 'pdf', 'docx'] };
  const imagePlan = h.service.planImage(image);
  assert.strictEqual(imagePlan.ok, true);
  assert.strictEqual(imagePlan.cwd, image.destination);
  assert.strictEqual(imagePlan.runAsInvoker, true);
  assert.strictEqual(imagePlan.env, undefined, 'plans must not expose process environment/secrets');
  assert.deepStrictEqual(imagePlan.args.slice(2), ['/cmd', image.source, 'partition_none,fileopt,everything,disable,jpg,enable,png,enable,pdf,enable,zip,enable,search']);
  assert.match(imagePlan.outputPrefix, /^E:\\Recovery\\NodeMend-Recovery-[a-f0-9-]+$/);
  assert.notStrictEqual(h.service.planImage(image).outputPrefix, imagePlan.outputPrefix);
  for (const source of ['\\\\.\\PhysicalDrive0', 'C:', 'D:\\Images\\fixture.img:stream', 'D:\\Images\\..\\fixture.img', 'D:\\Images\\fixture.img&whoami'])
    assert.strictEqual(h.service.planImage({ ...image, source }).ok, false, source);
  assert.strictEqual(h.service.planImage({ ...image, destination: 'D:\\Images' }).code, 'SOURCE_DESTINATION_OVERLAP');
  assert.strictEqual(h.service.planImage({ ...image, destination: 'D:\\' }).code, 'SOURCE_DESTINATION_OVERLAP');
  assert.strictEqual(h.service.planImage({ ...image, fileTypes: ['jpg,enable,search'] }).code, 'INVALID_FILE_TYPES');
  assert.strictEqual(h.service.planImage({ ...image, executablePath: 'evil' }).code, 'INVALID_REQUEST');
  const imageRun = h.service.runImage(image); await tick();
  assert.strictEqual(h.calls.at(-1).options.cwd, image.destination);
  assert.strictEqual(h.calls.at(-1).options.env.__COMPAT_LAYER, 'RunAsInvoker');
  assert.strictEqual(h.calls.at(-1).options.env.TERM, 'cygwin');
  assert.strictEqual(h.calls.at(-1).options.env.TERMINFO, '/cygdrive/d/Apps/NodeMend/vendor/photorec');
  const supportPath = path.win32.join(bundle, '63', 'cygwin');
  const supportFile = files.get(supportPath); files.delete(supportPath);
  assert.strictEqual(h.service.planImage(image).code, 'ENGINE_SUPPORT_UNAVAILABLE');
  files.set(supportPath, supportFile);
  h.child.emit('close', 0, null);
  assert.strictEqual((await imageRun.result).engine, 'photorec');
  const guiRun = h.service.launchPhotoRec(); await tick();
  assert.deepStrictEqual(h.calls.at(-1).args, []);
  assert.strictEqual(h.calls.at(-1).options.windowsHide, false);
  h.child.emit('close', 0, null);
  assert.match((await guiRun.result).message, /QPhotoRec closed/);
  console.log('PASS bounded image-only PhotoRec plans, isolated destination cwd, format mapping and GUI launch');

  // Native paths are exercised independently of this test host. Actual native binaries
  // still require their own synthetic-image test on Linux/macOS release machines.
  for (const platform of ['linux', 'darwin']) {
    const unixBundle = '/opt/tidywin/vendor/photorec';
    const unixSource = '/home/test/images/fixture.img';
    const unixDestination = '/home/test/recovered';
    const unixFiles = new Map([
      [unixBundle, { directory: true }],
      [unixBundle + '/photorec', { file: true, mode: 0o100755 }],
      [unixBundle + (platform === 'darwin' ? '/78/xterm-color' : '/l/linux'), { file: true, mode: 0o100644 }],
      [unixSource, { file: true, size: 8192 }],
      [unixDestination, { directory: true }],
      ['/home/test/images', { directory: true }],
      ['/home/test', { directory: true }]
    ]);
    const unixFs = {
      realpathSync: filename => {
        if (unixFiles.has(filename)) return filename;
        const error = new Error('missing'); error.code = 'ENOENT'; throw error;
      },
      statSync: filename => {
        const item = unixFiles.get(filename); if (!item) throw new Error('missing');
        return { isFile: () => !!item.file, isDirectory: () => !!item.directory,
          size: item.size || 1, mode: item.mode || 0o40755 };
      }
    };
    const unix = harness({ platform, fs: unixFs, bundledDirectory: unixBundle });
    assert.strictEqual((await unix.service.detectEngine()).code, 'UNSUPPORTED_PLATFORM');
    assert.strictEqual(unix.service.detectBundledEngine('photorec').executable, unixBundle + '/photorec');
    assert.strictEqual(unix.service.detectBundledEngine().code, 'ENGINE_UNAVAILABLE', 'absent optional Unix GUI');
    const unixRequest = { source: unixSource, destination: unixDestination };
    const unixPlan = unix.service.planImage(unixRequest);
    assert.strictEqual(unixPlan.ok, true, platform);
    assert.strictEqual(unixPlan.runAsInvoker, false);
    assert.match(unixPlan.outputPrefix, /^\/home\/test\/recovered\/NodeMend-Recovery-[a-f0-9-]+$/);
    assert.deepStrictEqual(unixPlan.args.slice(2), ['/cmd', unixSource, 'partition_none,fileopt,everything,disable,jpg,enable,png,enable,pdf,enable,search']);
    for (const source of ['/dev/fixture.img', '/dev/../home/test/images/fixture.img', '/proc/fixture.img',
      '/sys/fixture.img', '//host/fixture.img', 'relative.img', '/home/test/images/../fixture.img',
      '/home/test/images/fixture.img;whoami', '/home/test/images/fixture.img\n/a',
      '/home/test/images\\fixture.img', 'C:\\Images\\fixture.img'])
      assert.strictEqual(unix.service.planImage({ ...unixRequest, source }).code, 'INVALID_IMAGE_PATH', source);
    assert.strictEqual(unix.service.planImage({ ...unixRequest, destination: '/home/test/images' }).code, 'SOURCE_DESTINATION_OVERLAP');
    assert.strictEqual(unix.service.planImage({ ...unixRequest, destination: '/home/test' }).code, 'SOURCE_DESTINATION_OVERLAP');
    const unixRun = unix.service.runImage(unixRequest); await tick();
    assert.strictEqual(unix.calls[0].filename, unixBundle + '/photorec');
    assert.strictEqual(unix.calls[0].options.cwd, unixDestination);
    assert.strictEqual(unix.calls[0].options.env.TERM, platform === 'darwin' ? 'xterm-color' : 'linux');
    assert.strictEqual(unix.calls[0].options.env.TERMINFO, unixBundle);
    assert.strictEqual(unix.calls[0].options.env.__COMPAT_LAYER, process.env.__COMPAT_LAYER, 'Windows compatibility flag must not be introduced on Unix');
    assert.strictEqual(unix.calls[0].options.shell, false);
    unix.child.emit('close', 0, null);
    assert.strictEqual((await unixRun.result).ok, true);
    unixFiles.get(unixBundle + '/photorec').mode = 0o100644;
    assert.strictEqual(unix.service.detectBundledEngine('photorec').code, 'ENGINE_UNAVAILABLE', 'nonexecutable Unix engine');
    unixFiles.get(unixBundle + '/photorec').mode = 0o100755;
    const symlink = harness({ platform, bundledDirectory: unixBundle,
      fs: { ...unixFs, realpathSync: filename => filename.endsWith('/photorec') ? '/tmp/evil-photorec' : unixFs.realpathSync(filename) } });
    assert.strictEqual(symlink.service.detectBundledEngine('photorec').code, 'ENGINE_UNAVAILABLE');
    console.log('PASS ' + platform + ' native image paths, device/traversal rejection, trusted executable mode and child options (mocked)');
  }

  const current = await recovery.detectEngine();
  assert.strictEqual(typeof current.ok, 'boolean');
  console.log('READ-ONLY current engine status: ' + (current.ok ? current.engine + ' available' : current.code));
  console.log('RESULT: PASS (mocked execution only; no real drive/image recovery performed)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// Main-process only. Never pass renderer-controlled dependencies or executable paths.
// Syntax: https://support.microsoft.com/en-us/windows/experience/backup-recovery/windows-file-recovery
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const SUPPORT_URL = 'https://support.microsoft.com/en-us/windows/experience/backup-recovery/windows-file-recovery';
const STORE_URL = 'https://apps.microsoft.com/detail/9n26s50ln705';
const MAX_OUTPUT = 65536;
const PACKAGE = /^Microsoft\.WindowsFileRecovery_(\d+\.\d+\.\d+\.\d+)_(?:x64|arm64|x86)__8wekyb3d8bbwe$/i;

function failure(code, message) { return { ok: false, code, message }; }

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    return failure('INVALID_REQUEST', 'Recovery requires a source, destination, mode and filters.');
  const allowed = new Set(['source', 'destination', 'mode', 'filters']);
  if (Object.keys(request).some(key => !allowed.has(key)))
    return failure('INVALID_REQUEST', 'Unexpected recovery option.');
  const drive = value => typeof value === 'string' && /^[a-z]:$/i.test(value);
  if (!drive(request.source) || !drive(request.destination))
    return failure('INVALID_DRIVE', 'Choose local drive letters such as C: and E:.');
  const source = request.source.toUpperCase(), destination = request.destination.toUpperCase();
  if (source === destination)
    return failure('SAME_VOLUME', 'Recovery must save to a different drive. An external drive is recommended.');
  if (!['regular', 'extensive'].includes(request.mode))
    return failure('INVALID_MODE', 'Choose regular or extensive recovery.');
  if (!Array.isArray(request.filters) || request.filters.length < 1 || request.filters.length > 20)
    return failure('INVALID_FILTER', 'Supply between 1 and 20 file or folder filters.');
  const filters = [];
  for (const filter of request.filters) {
    // /n accepts relative filename patterns or source-root-relative Windows paths.
    // Shell punctuation, drive prefixes, UNC/device names, traversal and option syntax are rejected.
    if (typeof filter !== 'string' || !filter.length || filter.length > 240 ||
        filter !== filter.trim() || /[\x00-\x1f\x7f<>:"/|&;$`%]/.test(filter) ||
        filter.startsWith('-') || filter.startsWith('\\\\') || filter.includes('\\\\') ||
        filter.split('\\').some(segment => segment === '.' || segment === '..' ||
          segment.startsWith('-') || /[. ]$/.test(segment) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment)))
      return failure('INVALID_FILTER', 'Use a bounded filename pattern or source-relative path, without commands or traversal.');
    if (!/[\p{L}\p{N}]/u.test(filter))
      return failure('INVALID_FILTER', 'Choose a file type, filename or folder; unrestricted wildcard scans are disabled.');
    filters.push(filter);
  }
  if (filters.reduce((sum, item) => sum + item.length, 0) > 2048)
    return failure('INVALID_FILTER', 'The combined filter text is too long.');
  return { ok: true, source, destination, mode: request.mode, filters };
}

function createRecoveryService(dependencies = {}) {
  const io = dependencies.fs || fs;
  const launch = dependencies.spawn || spawn;
  const platform = dependencies.platform || process.platform;
  const nativePath = platform === 'win32' ? path.win32 : path.posix;
  const comparable = value => platform === 'win32' ? value.toLowerCase() : value;
  const systemRoot = dependencies.systemRoot || process.env.SystemRoot || 'C:\\Windows';
  // Do not use PATH, the working directory, user-writable app execution aliases,
  // or a user-supplied executable. Store packages live in the protected WindowsApps directory.
  const windowsApps = /^[a-z]:\\Windows$/i.test(systemRoot)
    ? path.win32.join(systemRoot.slice(0, 3), 'Program Files', 'WindowsApps') : null;
  // Optional trusted configuration from main.js after extracting an audited bundled distribution.
  const bundledDirectory = dependencies.bundledDirectory || null;
  let active = false;

  function trustedFile(filename, root, executable = true) {
    try {
      if (!nativePath.isAbsolute(filename) || !root) return false;
      const rootReal = io.realpathSync(root);
      const fileReal = io.realpathSync(filename);
      const relative = nativePath.relative(rootReal, fileReal);
      const stat = io.statSync(filename);
      return relative && !relative.startsWith('..') && !nativePath.isAbsolute(relative) &&
        comparable(fileReal) === comparable(filename) && stat.isFile() &&
        (!executable || platform === 'win32' || !!(stat.mode & 0o111));
    } catch (_) { return false; }
  }

  async function detectEngine() {
    if (platform !== 'win32') return failure('UNSUPPORTED_PLATFORM', 'Windows File Recovery requires Windows.');
    if (!windowsApps) return failure('UNTRUSTED_SYSTEM_ROOT', 'The Windows installation path could not be validated.');
    let entries;
    try { entries = io.readdirSync(windowsApps); }
    catch (error) {
      return { ...failure('ENGINE_UNAVAILABLE', 'Windows File Recovery could not be inspected. Install it from Microsoft Store and run NodeMend as administrator.'),
        reason: error.code || 'DISCOVERY_FAILED', storeUrl: STORE_URL };
    }
    const packages = entries.filter(name => PACKAGE.test(name)).sort((a, b) => {
      const av = a.match(PACKAGE)[1].split('.').map(Number), bv = b.match(PACKAGE)[1].split('.').map(Number);
      for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return bv[i] - av[i];
      return a.localeCompare(b);
    });
    for (const name of packages) {
      const executable = path.win32.join(windowsApps, name, 'winfr.exe');
      if (trustedFile(executable, windowsApps))
        return { ok: true, available: true, engine: 'winfr', executable, requiresAdministrator: true, supportUrl: SUPPORT_URL };
    }
    return { ...failure('ENGINE_UNAVAILABLE', 'Install Microsoft Windows File Recovery from Microsoft Store to use drive recovery.'),
      available: false, storeUrl: STORE_URL, supportUrl: SUPPORT_URL };
  }

  function detectBundledEngine(engine = 'qphotorec') {
    if (!['win32', 'linux', 'darwin'].includes(platform))
      return failure('UNSUPPORTED_PLATFORM', 'Bundled PhotoRec supports Windows, Linux and macOS.');
    if (!bundledDirectory || !nativePath.isAbsolute(bundledDirectory))
      return failure('ENGINE_UNAVAILABLE', 'A trusted bundled PhotoRec directory is not configured.');
    if (!['qphotorec', 'photorec'].includes(engine)) return failure('INVALID_ENGINE', 'Unsupported bundled engine.');
    const executable = nativePath.join(bundledDirectory,
      platform === 'win32' ? (engine === 'qphotorec' ? 'qphotorec_win.exe' : 'photorec_win.exe') : engine);
    if (!trustedFile(executable, bundledDirectory))
      return failure('ENGINE_UNAVAILABLE', 'The bundled recovery executable is unavailable, not executable, or its path is unsafe.');
    return { ok: true, available: true, engine, executable,
      requiresAdministrator: true, supportUrl: 'https://www.cgsecurity.org/wiki/PhotoRec' };
  }

  function planImage(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(key => !['source', 'destination', 'fileTypes'].includes(key)))
      return failure('INVALID_REQUEST', 'Image recovery accepts only source, destination and fileTypes.');
    const localPath = value => {
      if (typeof value !== 'string' || !value.length || value.length > 240 ||
          /[\x00-\x1f\x7f<>"|&;$`%]/.test(value)) return false;
      if (platform === 'win32') return /^[a-z]:\\/i.test(value) &&
        !value.includes('/') && !value.slice(2).includes(':') && !value.includes('\\\\') &&
        !value.split('\\').some(segment => segment === '..' || segment === '.');
      return value.startsWith('/') && !value.includes('//') && !value.includes('\\') && !value.includes(':') &&
        !/^\/(?:dev|proc|sys)(?:\/|$)/.test(value) &&
        !value.split('/').some(segment => segment === '..' || segment === '.');
    };
    if (!localPath(request.source) || !localPath(request.destination) || !/\.(?:img|dd|raw)$/i.test(request.source))
      return failure('INVALID_IMAGE_PATH', 'Choose an absolute local .img, .dd or .raw file and an existing destination folder. Device paths are forbidden.');
    const fileTypes = request.fileTypes === undefined ? ['jpg', 'png', 'pdf'] : request.fileTypes;
    if (!Array.isArray(fileTypes) || !fileTypes.length || fileTypes.length > 6 ||
        fileTypes.some(type => !['jpg', 'png', 'pdf', 'zip', 'doc', 'docx'].includes(type)))
      return failure('INVALID_FILE_TYPES', 'Choose jpg, png, pdf, zip, doc or docx.');
    let source, destination, stat;
    try {
      source = io.realpathSync(request.source);
      destination = io.realpathSync(request.destination);
      stat = io.statSync(source);
      const trimSeparator = value => value.length > nativePath.parse(value).root.length && value.endsWith(nativePath.sep)
        ? value.slice(0, -1) : value;
      if (comparable(source) !== comparable(nativePath.normalize(request.source)) ||
          comparable(trimSeparator(destination)) !== comparable(trimSeparator(nativePath.normalize(request.destination))) ||
          !stat.isFile() || stat.size <= 0 || stat.size > 512 * 1024 ** 3 || !io.statSync(destination).isDirectory())
        return failure('INVALID_IMAGE_PATH', 'Image and destination must be direct local paths. The source must be a nonempty regular file of at most 512 GiB.');
      const relative = nativePath.relative(destination, source);
      if (!relative.startsWith('..') && !nativePath.isAbsolute(relative))
        return failure('SOURCE_DESTINATION_OVERLAP', 'Choose a destination folder that does not contain the source image.');
    } catch (error) { return failure('IMAGE_UNAVAILABLE', 'The image file or destination directory cannot be read: ' + error.code); }
    const engine = detectBundledEngine('photorec');
    if (!engine.ok) return engine;
    // Upstream src/intrfn.c uses ncurses newterm(), including the Cygwin
    // terminal description shipped in 63/cygwin. TERMINFO names its parent
    // directory. Resolve it explicitly so session/config files stay in destination cwd.
    const terminal = platform === 'win32' ? ['63', 'cygwin'] : platform === 'darwin' ? ['78', 'xterm-color'] : ['l', 'linux'];
    if (!trustedFile(nativePath.join(bundledDirectory, ...terminal), bundledDirectory, false))
      return failure('ENGINE_SUPPORT_UNAVAILABLE', 'The bundled PhotoRec terminal support file is missing or unsafe.');
    // PhotoRec recognizes Office Open XML via its zip handler, not a docx fileopt token.
    const formats = [...new Set(fileTypes.map(type => type === 'docx' ? 'zip' : type))];
    const commands = ['partition_none', 'fileopt', 'everything', 'disable'];
    for (const format of formats) commands.push(format, 'enable');
    commands.push('search');
    const outputPrefix = nativePath.join(destination, 'NodeMend-Recovery-' + randomUUID());
    return { ...engine, ok: true, source, destination, fileTypes: [...fileTypes], outputPrefix,
      args: ['/d', outputPrefix, '/cmd', source, commands.join(',')], cwd: destination,
      requiresAdministrator: false,
      // CGSecurity documents RunAsInvoker for image recovery. This applies only to this child.
      runAsInvoker: platform === 'win32',
      terminfoDirectory: bundledDirectory, terminfoTerminal: terminal[1],
      limitations: 'Scans a copied image for file signatures. Original names and folders are generally lost. Fragmented, overwritten or TRIM-cleared files may not recover. docx enables zip recovery and may also produce other ZIP-based files.' };
  }

  async function plan(request) {
    const validated = validateRequest(request);
    if (!validated.ok) return validated;
    const engine = await detectEngine();
    if (!engine.ok) return engine;
    const args = [validated.source, validated.destination, '/' + validated.mode];
    for (const filter of validated.filters) args.push('/n', filter);
    // /a is Microsoft's documented automation switch. No stdin prompt guessing.
    args.push('/a');
    return { ...validated, engine: 'winfr', executable: engine.executable, args,
      requiresAdministrator: true, destinationFolder: validated.destination + '\\Recovery_<date and time>',
      supportUrl: SUPPORT_URL,
      limitations: 'Best effort recovery. Regular mode requires healthy NTFS. Extensive mode supports other file systems. SSD TRIM, overwrites and fragmentation can prevent recovery. Different drive letters can alias the same partition; WinFR must reject that configuration.' };
  }

  function execute(prepare, callbacks = {}) {
    let status = 'preparing', child = null, cancelled = false, timedOut = false, timer = null;
    let output = '', settled = false;
    let resolveResult;
    const result = new Promise(resolve => { resolveResult = resolve; });
    const emit = event => {
      if (typeof callbacks.onProgress === 'function') {
        try { callbacks.onProgress(event); } catch (_) { /* UI callbacks cannot break cancellation/cleanup. */ }
      }
    };
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (callbacks.signal) callbacks.signal.removeEventListener('abort', cancel);
      status = value.status || 'failed';
      active = false;
      emit({ type: 'status', status });
      resolveResult({ ...value, output });
    };
    function cancel() {
      if (settled) return false;
      cancelled = true;
      status = 'cancelling';
      if (child) {
        try { child.kill(); } catch (_) { /* close/error still determines final state. */ }
      }
      return true;
    }
    const timeoutMs = callbacks.timeoutMs === undefined ? 30 * 60 * 1000 : callbacks.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2 * 60 * 60 * 1000) {
      settled = true;
      status = 'failed';
      resolveResult({ ...failure('INVALID_TIMEOUT', 'Recovery timeout must be between one second and two hours.'), status, output });
      return { result, cancel, getStatus: () => status };
    }
    if (active) {
      settled = true;
      status = 'failed';
      resolveResult({ ...failure('RECOVERY_BUSY', 'A recovery process is already running.'), status, output });
      return { result, cancel, getStatus: () => status };
    }
    active = true;
    if (callbacks.signal) {
      callbacks.signal.addEventListener('abort', cancel, { once: true });
      if (callbacks.signal.aborted) cancel();
    }
    (async () => {
      let prepared;
      try { prepared = await prepare(); }
      catch (error) { finish({ ...failure('PREPARE_FAILED', error.message), status: 'failed' }); return; }
      if (cancelled) { finish({ ok: false, code: 'CANCELLED', status: 'cancelled' }); return; }
      if (!prepared.ok) { finish({ ...prepared, status: 'failed' }); return; }
      try {
        const imageEnv = prepared.runAsInvoker ? {
          ...process.env, __COMPAT_LAYER: 'RunAsInvoker', TERM: 'cygwin',
          // Cygwin's POSIX path avoids drive-colon interpretation in ncurses path handling.
          TERMINFO: '/cygdrive/' + prepared.terminfoDirectory[0].toLowerCase() +
            prepared.terminfoDirectory.slice(2).replace(/\\/g, '/')
        } : prepared.terminfoDirectory ? { ...process.env, TERM: prepared.terminfoTerminal, TERMINFO: prepared.terminfoDirectory } : null;
        child = launch(prepared.executable, prepared.args || [], {
          shell: false, windowsHide: prepared.engine !== 'qphotorec',
          cwd: prepared.cwd || nativePath.dirname(prepared.executable),
          ...(imageEnv ? { env: imageEnv } : {}),
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        finish({ ...failure('START_FAILED', error.message), status: 'failed' }); return;
      }
      status = 'running';
      emit({ type: 'status', status, engine: prepared.engine });
      let lastProgress = 0;
      const read = chunk => {
        const text = chunk.toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
        output = (output + text).slice(-MAX_OUTPUT);
        const percent = [...text.matchAll(/\b(\d{1,3})(?:\.\d+)?\s*%/g)].pop();
        if (Date.now() - lastProgress >= 200) {
          lastProgress = Date.now();
          emit({ type: 'output', text: text.slice(-2048), percent: percent ? Math.min(100, Number(percent[1])) : null });
        }
      };
      if (child.stdout) child.stdout.on('data', read);
      if (child.stderr) child.stderr.on('data', read);
      child.once('error', error => finish({ ...failure(error.code === 'EACCES' || error.code === 'EPERM' ? 'ADMIN_REQUIRED' : 'START_FAILED', error.message), status: 'failed' }));
      child.once('close', (exitCode, signal) => {
        if (cancelled) finish({ ok: false, code: timedOut ? 'TIMEOUT' : 'CANCELLED', status: timedOut ? 'timed-out' : 'cancelled', exitCode, signal });
        else if (exitCode === 0) finish({ ok: true, status: 'completed', exitCode, engine: prepared.engine,
          destination: prepared.destination, outputPrefix: prepared.outputPrefix,
          message: prepared.engine === 'qphotorec' ? 'QPhotoRec closed. Check its destination folder for recovery results.' : 'Recovery engine finished. Check the destination recovery folder; exit success does not guarantee recovered files.' });
        else finish({ ...failure('ENGINE_FAILED', 'Recovery exited unsuccessfully. Review the engine output; administrator rights and supported local drives are required.'), status: 'failed', exitCode, signal });
      });
      timer = setTimeout(() => {
        timedOut = true;
        cancel();
        // Wait for process close so a new recovery cannot race a still-running engine.
        emit({ type: 'timeout', message: 'Recovery timed out; stopping the engine.' });
      }, timeoutMs);
      if (cancelled) cancel();
    })();
    return { result, cancel, getStatus: () => status };
  }

  return {
    detectEngine, detectBundledEngine, plan, planImage,
    run: (request, callbacks) => execute(() => plan(request), callbacks),
    runImage: (request, callbacks) => execute(() => planImage(request), callbacks),
    launchPhotoRec: callbacks => execute(() => ({ ...detectBundledEngine(), args: [] }), callbacks)
  };
}

const service = createRecoveryService();
module.exports = { validateRequest, createRecoveryService, detectEngine: service.detectEngine,
  detectBundledEngine: service.detectBundledEngine, createPlan: service.plan,
  runRecovery: service.run, launchPhotoRec: service.launchPhotoRec, SUPPORT_URL, STORE_URL };

// Read-only native platform information. No shell execution or OS configuration changes.
const fs = require('fs');
const path = require('path');
const os = require('os');
const DAY = 86400000;

function getCapabilities(platform = process.platform) {
  const supported = ['win32', 'darwin', 'linux'].includes(platform);
  const windows = platform === 'win32';
  return { platform, supported, systemInfo: supported, cleaner: supported, duplicates: supported,
    diskAnalysis: supported, recoveryImages: supported, installedApps: supported,
    windowsControls: windows, repair: windows, updates: windows, startup: windows,
    uninstall: windows, defender: windows, smart: windows, recycle: windows,
    performance: windows, elevation: windows };
}

function assertWindows(operation, platform = process.platform) {
  if (platform !== 'win32') {
    const e = new Error(`UNSUPPORTED_PLATFORM: ${operation} requires Windows (${platform})`);
    e.code = 'UNSUPPORTED_PLATFORM';
    throw e;
  }
}

// Deliberately limited to disposable subfolders; no generic ~/.cache sweep or browser profiles.
// Absolute home comes from os.homedir() in production. Injection supports fixture-only tests.
function cleanerCategories(platform = process.platform, options = {}) {
  if (platform === 'win32') return options.windowsCategories || [];
  if (!['darwin', 'linux'].includes(platform)) return [];
  const home = options.home || os.homedir();
  const p = platform === process.platform ? path : path.posix;
  if (!p.isAbsolute(home)) throw new Error('Home must be an absolute path');
  const root = p.join(home, platform === 'darwin' ? 'Library/Caches' : '.cache');
  const category = (id, group, name, suffixes, on = true) => ({ id, group, name, on,
    minAgeDays: 7, desc: 'Disposable cache files older than 7 days; settings and sign-in data excluded',
    paths: suffixes.map(s => p.join(root, s)) });
  const cats = platform === 'darwin' ? [
    category('mac-browser-cache', 'Browsers', 'Browser caches', ['com.apple.Safari', 'Google/Chrome', 'Microsoft Edge', 'Firefox']),
    category('mac-app-cache', 'Apps', 'Application caches', ['com.spotify.client', 'com.apple.helpd']),
    category('mac-dev-cache', 'Developer', 'Developer caches', ['pip', 'Yarn'], false),
    { id: 'mac-user-logs', group: 'System', name: 'User application logs', on: false,
      minAgeDays: 7, desc: 'User Library/Logs files older than 7 days', paths: [p.join(home, 'Library/Logs')] }
  ] : [
    category('linux-thumbnails', 'System', 'Thumbnail caches', ['thumbnails']),
    category('linux-browser-cache', 'Browsers', 'Browser caches', ['google-chrome', 'chromium', 'mozilla/firefox', 'microsoft-edge']),
    category('linux-dev-cache', 'Developer', 'Developer caches', ['pip', 'yarn'], false)
  ];
  // Defense against accidentally adding an escaping suffix in a later change.
  for (const c of cats) for (const dir of c.paths) {
    const rel = p.relative(home, dir);
    if (!rel || rel === '..' || rel.startsWith('../') || p.isAbsolute(rel)) throw new Error('Unsafe cache path');
  }
  return cats;
}

async function systemInfo(options = {}) {
  const platform = options.platform || process.platform;
  const capabilities = getCapabilities(platform);
  if (!capabilities.systemInfo) throw new Error(`UNSUPPORTED_PLATFORM: ${platform}`);
  const cpus = os.cpus();
  const uptime = os.uptime();
  const volumes = [];
  // statfs is native and read-only. These are filesystem capacities, not physical-disk SMART.
  const probes = platform === 'win32' ? [path.parse(options.home || os.homedir()).root] : ['/'];
  for (const probe of probes) {
    try {
      const s = await fs.promises.statfs(probe);
      volumes.push({ letter: probe, label: 'Filesystem', fs: `type ${s.type}`, size: s.blocks * s.bsize,
        free: s.bavail * s.bsize, health: 'Not assessed', path: probe });
    } catch { /* inaccessible filesystem: leave unavailable, not healthy */ }
  }
  return { platform, capabilities, os: platform === 'darwin' ? 'macOS' : platform === 'linux' ? os.type() : 'Windows',
    version: os.release(), build: os.release(), displayVersion: '',
    lastBoot: new Date(Date.now() - uptime * 1000).toISOString(), uptimeHours: Math.round(uptime / 360) / 10,
    model: `${os.hostname()} (${os.arch()})`, bios: null, ramTotal: os.totalmem(), ramFree: os.freemem(),
    cpu: cpus[0]?.model || os.arch(), cpuLoad: null, cores: null, threads: cpus.length,
    loadAverage: platform === 'win32' ? null : os.loadavg(), gpu: null, gpuDriver: null,
    volumes, disks: [], pendingReboot: null, defender: null, lastHotfix: null,
    unavailable: ['physicalDiskHealth', 'SMART', 'gpu', 'bios', 'securityStatus', 'pendingReboot', 'cpuLoad', 'physicalCores'] };
}

async function healthSummary(options = {}) {
  const sys = await systemInfo(options);
  return { platform: sys.platform, capabilities: sys.capabilities, uptimeHours: sys.uptimeHours,
    ramTotal: sys.ramTotal, ramFree: sys.ramFree, volumes: sys.volumes,
    findings: sys.volumes.filter(v => v.size > 0 && v.free / v.size < .1)
      .map(v => ({ level: 'warning', code: 'LOW_FREE_SPACE', path: v.path, message: 'Filesystem has less than 10% available space.' })),
    unavailable: sys.unavailable, readOnly: true };
}

// Refuse symlink roots AND symlink ancestors. Walkers must not enter a linked directory.
async function assertPlainDirectory(root) {
  const absolute = path.resolve(root);
  let current = absolute;
  while (true) {
    const st = await fs.promises.lstat(current);
    if (st.isSymbolicLink()) throw new Error('SYMLINK_PATH: linked directories are excluded');
    if (current === absolute && !st.isDirectory()) throw new Error('NOT_DIRECTORY');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return absolute;
}

function assertPlainDirectorySync(root) {
  const absolute = path.resolve(root);
  let current = absolute;
  while (true) {
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) throw new Error('SYMLINK_PATH: linked directories are excluded');
    if (current === absolute && !st.isDirectory()) throw new Error('NOT_DIRECTORY');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return absolute;
}

function classifyDirectory(dir) {
  const segments = dir.replace(/\\/g, '/').toLowerCase().split('/');
  if (segments.some(s => ['.cache', 'caches', 'cache', 'code cache', 'gpucache'].includes(s))) return 'Cache';
  if (segments.some(s => ['logs', 'log'].includes(s))) return 'Logs';
  if (segments.some(s => ['downloads', 'download'].includes(s))) return 'Downloads';
  if (segments.some(s => ['node_modules', '.git', '.gradle'].includes(s))) return 'Developer';
  if (segments.some(s => ['pictures', 'videos', 'music', 'movies'].includes(s))) return 'Media';
  return 'Other';
}

// Logical file sizes only, bounded memory/output, no deletion, no symlink traversal.
async function analyzeDisk(root, options = {}) {
  const absolute = await assertPlainDirectory(root);
  const bounded = (n, fallback, max) => Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback;
  const maxEntries = bounded(options.maxEntries, 100000, 1000000);
  const maxDepth = bounded(options.maxDepth, 40, 100);
  const largestLimit = bounded(options.largestLimit, 30, 100);
  const directoryLimit = bounded(options.directoryLimit, 200, 1000);
  const cancelled = () => !!(options.signal?.aborted || options.shouldCancel?.());
  const dirs = [{ path: absolute, size: 0, files: 0, classification: classifyDirectory(absolute), parent: -1 }];
  const stack = [{ path: absolute, depth: 0, index: 0 }];
  const largestFiles = [];
  let files = 0, entries = 0, skipped = 0, errors = 0, truncated = false, wasCancelled = false;
  outer: while (stack.length) {
    if (cancelled()) { wasCancelled = true; break; }
    const item = stack.pop();
    let handle;
    try {
      if ((await fs.promises.lstat(item.path)).isSymbolicLink()) { skipped++; continue; }
      handle = await fs.promises.opendir(item.path);
      for await (const e of handle) {
        if (cancelled()) { wasCancelled = true; break outer; }
        if (entries >= maxEntries) { truncated = true; break outer; }
        entries++;
        const full = path.join(item.path, e.name);
        if (e.isSymbolicLink()) { skipped++; continue; }
        let st;
        try { st = await fs.promises.lstat(full); } catch { errors++; continue; }
        if (st.isSymbolicLink()) { skipped++; continue; }
        if (st.isDirectory()) {
          if (item.depth >= maxDepth) { skipped++; truncated = true; continue; }
          const index = dirs.length;
          dirs.push({ path: full, size: 0, files: 0, classification: classifyDirectory(full), parent: item.index });
          stack.push({ path: full, depth: item.depth + 1, index });
        } else if (st.isFile()) {
          files++;
          for (let index = item.index; index >= 0; index = dirs[index].parent) { dirs[index].size += st.size; dirs[index].files++; }
          largestFiles.push({ path: full, size: st.size, modified: st.mtime.toISOString() });
          largestFiles.sort((a, b) => b.size - a.size);
          if (largestFiles.length > largestLimit) largestFiles.pop();
        } else skipped++;
        if (entries % 128 === 0) await new Promise(resolve => setImmediate(resolve));
      }
    } catch { errors++; }
  }
  const directories = dirs.map(({ parent, ...dir }) => dir).sort((a, b) => b.size - a.size).slice(0, directoryLimit);
  return { root: absolute, size: dirs[0].size, totalSize: dirs[0].size, files, filesScanned: files,
    directoriesScanned: dirs.length, entriesScanned: entries, directories, largestFiles, skipped, errors,
    truncated, cancelled: wasCancelled, readOnly: true, sizeMethod: 'logical' };
}

async function listInstalledApps(platform = process.platform, options = {}) {
  if (platform === 'win32') { assertWindows('programs.ps1', platform); return []; }
  if (!['darwin', 'linux'].includes(platform)) throw new Error(`UNSUPPORTED_PLATFORM: ${platform}`);
  const home = options.home || os.homedir();
  const roots = options.roots || (platform === 'darwin' ? ['/Applications', path.join(home, 'Applications')]
    : ['/usr/share/applications', '/usr/local/share/applications', path.join(home, '.local/share/applications')]);
  const apps = [];
  for (const root of roots) {
    try {
      await assertPlainDirectory(root);
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      for (const e of entries.slice(0, 5000)) {
        if (e.isSymbolicLink()) continue;
        const location = path.join(root, e.name);
        let name;
        if (platform === 'darwin' && e.isDirectory() && e.name.endsWith('.app')) name = e.name.slice(0, -4);
        else if (platform === 'linux' && e.isFile() && e.name.endsWith('.desktop')) {
          // Treat desktop entries as untrusted metadata. Never read/execute their Exec field.
          const st = await fs.promises.lstat(location);
          if (st.isSymbolicLink() || st.size > 65536) continue;
          const text = await fs.promises.readFile(location, 'utf8');
          const entry = text.split(/^\[Desktop Entry\]\s*$/m)[1]?.split(/^\[/m)[0] || '';
          if (/^(Hidden|NoDisplay)=true\s*$/m.test(entry)) continue;
          name = /^Name=([^\r\n]+)$/m.exec(entry)?.[1];
        }
        if (name) apps.push({ id: location, name, location, version: '', publisher: '', installDate: null,
          sizeMB: null, scope: location.startsWith(home + path.sep) ? 'user' : 'machine', kind: 'native',
          uninstall: '', quiet: '', icon: '', url: '', readOnly: true });
      }
    } catch { /* roots may not exist or be accessible */ }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { getCapabilities, assertWindows, cleanerCategories, systemInfo, healthSummary,
  assertPlainDirectory, assertPlainDirectorySync, classifyDirectory, analyzeDisk, listInstalledApps };

// Optional, reversible pausing of a small allowlist of user background applications.
// No auto-pausing, process termination, priority, registry, or startup changes.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);
const ALLOWED = new Set(['spotify', 'spotify.exe', 'discord', 'discord.exe', 'steam', 'steam.exe']);
const identityName = r => path.basename(String(r.name || '').replace(/\\/g, '/')).toLowerCase();
function fail(code) { const e = new Error(code); e.code = code; return e; }
function validPID(pid) { return Number.isSafeInteger(pid) && pid > 1; }

function createUnixProvider(platform) {
  if (!['darwin', 'linux'].includes(platform)) throw fail('PERFORMANCE_UNAVAILABLE');
  const ps = '/bin/ps';
  if (!fs.existsSync(ps)) throw fail('PERFORMANCE_UNAVAILABLE');
  const owner = String(os.userInfo().uid);
  async function list() {
    const { stdout } = await exec(ps, ['-axo', 'pid=,ppid=,uid=,stat=,lstart=,comm='],
      { shell: false, timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    const records = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      let startTime = m[5].replace(/\s+/g, ' ');
      // Linux kernel birth token is more precise than ps's one-second display.
      if (platform === 'linux') {
        try {
          const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
          startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
          if (!/^\d+$/.test(startTime)) continue;
        } catch { continue; }
      }
      records.push({ pid, ppid: Number(m[2]), owner: m[3], state: m[4], startTime, name: path.basename(m[6]), location: m[6] });
    }
    return records;
  }
  async function signal(record, sig) {
    const current = (await list()).find(r => r.pid === record.pid);
    if (!current || current.startTime !== record.startTime || current.owner !== owner ||
      identityName(current) !== identityName(record) || !ALLOWED.has(identityName(current))) throw fail('PROCESS_CHANGED');
    if (sig === 'SIGSTOP' && /[TZ]/.test(current.state)) throw fail('PROCESS_ALREADY_STOPPED');
    process.kill(record.pid, sig);
    return { ok: true };
  }
  return { owner, list, pause: r => signal(r, 'SIGSTOP'), resume: r => signal(r, 'SIGCONT') };
}

function createWindowsProvider(options = {}) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = options.scriptPath || path.join(__dirname, '..', 'ps', 'performance.ps1');
  if (!fs.existsSync(executable) || !fs.existsSync(script)) throw fail('PERFORMANCE_UNAVAILABLE');
  async function invoke(action, record) {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action];
    if (record) args.push('-TargetProcessId', String(record.pid), '-ExpectedStartTime', String(record.startTime));
    // Do not terminate this short native action via task cancellation: suspension must receive
    // its response and be tracked so shutdown can resume it. Native calls do not spawn children.
    const { stdout } = await exec(executable, args, { shell: false, windowsHide: true, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout.trim());
    if (action !== 'List' && result.ok !== true) throw fail('NATIVE_ACTION_FAILED');
    return result;
  }
  return { owner: 'current-user', async list() {
    const rows = await invoke('List');
    const deduped = new Map();
    for (const r of (Array.isArray(rows) ? rows : [rows]).filter(Boolean))
      deduped.set(r.pid, { ...r, owner: r.owner ? 'current-user' : '' });
    return [...deduped.values()];
  }, pause: r => invoke('Pause', r), resume: r => invoke('Resume', r) };
}

function createPerformanceService(options = {}) {
  const platform = options.platform || process.platform;
  const mainPID = options.mainPID || process.pid;
  let provider = options.provider;
  let unavailable = null;
  if (!provider) {
    try { provider = platform === 'win32' ? createWindowsProvider(options) : createUnixProvider(platform); }
    catch (e) { unavailable = e.code || 'PERFORMANCE_UNAVAILABLE'; }
  }
  const protectedPids = new Set([1, mainPID, process.pid, process.ppid, ...(options.ancestorPids || [])]);
  const paused = new Map();
  let pending = Promise.resolve();
  const serialize = fn => { const task = pending.then(fn); pending = task.catch(() => {}); return task; };
  const requireProvider = () => { if (!provider || unavailable) throw fail('PERFORMANCE_UNAVAILABLE'); };
  function protectAncestors(rows) {
    const indexed = new Map(rows.map(r => [r.pid, r]));
    let pid = mainPID;
    const seen = new Set();
    while (validPID(pid) && !seen.has(pid)) {
      seen.add(pid); protectedPids.add(pid); pid = indexed.get(pid)?.ppid;
    }
  }
  function eligible(r) {
    return validPID(r.pid) && !protectedPids.has(r.pid) && String(r.owner) === String(provider.owner) &&
      typeof r.startTime === 'string' && !!r.startTime && ALLOWED.has(identityName(r));
  }
  async function rows() {
    requireProvider();
    const list = await provider.list();
    if (!Array.isArray(list)) throw fail('INVALID_PROCESS_LIST');
    protectAncestors(list);
    return list;
  }
  async function resumeInternal(pid) {
    const saved = paused.get(pid);
    if (!saved) throw fail('NOT_PAUSED_BY_TIDYWIN');
    const current = (await rows()).find(r => r.pid === pid);
    if (!current || current.startTime !== saved.startTime || String(current.owner) !== String(saved.owner) || identityName(current) !== identityName(saved)) {
      paused.delete(pid);
      return { ok: true, resumed: false, ended: true, pid };
    }
    if (!eligible(current)) throw fail('PROCESS_NOT_ELIGIBLE');
    const result = await provider.resume(saved);
    if (!result || result.ok !== true) throw fail('RESUME_FAILED');
    paused.delete(pid);
    return { ok: true, resumed: true, pid };
  }
  return {
    capabilities: { available: !!provider && !unavailable, platform, reversible: true, allowlist: [...ALLOWED], reason: unavailable },
    getPaused: () => [...paused.values()].map(r => ({ ...r })),
    list: () => serialize(async () => (await rows()).filter(eligible).map(r => ({ ...r,
      paused: paused.get(r.pid)?.startTime === r.startTime, readOnly: true }))),
    pause: pid => serialize(async () => {
      if (!validPID(pid)) throw fail('INVALID_PID');
      const current = (await rows()).find(r => r.pid === pid && eligible(r));
      if (!current || !eligible(current)) throw fail('PROCESS_NOT_ELIGIBLE');
      const saved = paused.get(pid);
      if (saved?.startTime === current.startTime) throw fail('ALREADY_PAUSED');
      if (saved) paused.delete(pid);
      if (/[TZ]/.test(current.state || '')) throw fail('PROCESS_ALREADY_STOPPED');
      const result = await provider.pause(current);
      if (!result || result.ok !== true) throw fail('PAUSE_FAILED');
      paused.set(pid, { ...current });
      return { ok: true, paused: true, pid };
    }),
    resume: pid => serialize(() => resumeInternal(pid)),
    resumeAll: () => serialize(async () => {
      const results = [];
      for (const pid of [...paused.keys()]) {
        try { results.push(await resumeInternal(pid)); }
        catch (e) { results.push({ ok: false, pid, error: e.code || e.message }); }
      }
      return { ok: results.every(r => r.ok), results, remaining: paused.size };
    })
  };
}

module.exports = { createPerformanceService, createUnixProvider, createWindowsProvider };

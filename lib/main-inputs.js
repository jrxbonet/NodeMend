'use strict';

function chkdskDrive(args = {}) {
  const drive = args.drive === undefined ? 'C:' : args.drive;
  if (typeof drive !== 'string' || !/^[A-Za-z]:$/.test(drive)) throw new Error('INVALID_DRIVE');
  return drive.toUpperCase();
}

function browserPattern(browser, platform = process.platform) {
  if (browser === 'edge') {
    if (platform === 'win32') return /(?:^|["\r\n])msedge\.exe(?=["\r\n]|$)/i;
    if (platform === 'linux') return /(?:^|\/)msedge(?:\r?\n|$)/im;
    return /(?:^|\/)Microsoft Edge(?:\r?\n|$)/im;
  }
  return { chrome: /chrome|chromium/i, brave: /brave/i, firefox: /firefox/i }[browser];
}

// Public args were validated before this call. Only the private read-only registry
// lookup may append executable strings; unknown/ambiguous ids fail before launch.
async function resolveUninstallArgs(script, args, readRegistry, confirm) {
  if (script !== 'uninstall.ps1') return args;
  const params = require('./gate').validateScriptArgs(script, args).params;
  if (typeof params.id !== 'string' || !params.id || params.id.length > 255 ||
      /[\\/\x00-\x1f]/.test(params.id) || ['.', '..'].includes(params.id)) throw new Error('INVALID_PROGRAM_ID');
  if (params.kind === 'appx') return args;
  const result = await readRegistry(params.id);
  if (!result || result.ok !== true || (!result.uninstall && !result.quiet))
    throw new Error(result && result.error || 'UNINSTALL_COMMAND_UNAVAILABLE');
  const argv = args.slice();
  for (const key of ['uninstall', 'quiet']) {
    const value = result[key] || '';
    if (typeof value !== 'string' || value.length > 32768 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('INVALID_UNINSTALL_COMMAND');
    if (value) argv.push('-' + key, value);
  }
  const command = params.silent && result.quiet ? result.quiet : result.uninstall || result.quiet;
  if (confirm && !await confirm({ id: params.id, name: result.name || params.id, scope: result.scope || 'unknown', command, silent: !!params.silent }))
    throw new Error('UNINSTALL_CANCELLED');
  return argv;
}

module.exports = { chkdskDrive, browserPattern, resolveUninstallArgs };

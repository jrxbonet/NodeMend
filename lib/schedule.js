'use strict';
const path = require('path');

// UI preflight only. schedule.ps1 independently checks known OS folders, reparse
// points and ACLs immediately before registration.
function eligibility(exe, { packaged, portable, platform = process.platform, env = process.env } = {}) {
  const reason = 'SYSTEM scheduling requires an installed build in a protected Program Files folder. Portable and development builds cannot install this task.';
  const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  const protectedPath = typeof exe === 'string' && path.win32.isAbsolute(exe) && roots.some(root => {
    const relative = path.win32.relative(root, exe);
    return relative && relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative);
  });
  const allowed = platform === 'win32' && !!packaged && !portable && !!protectedPath;
  return { allowed, reason: allowed ? null : reason };
}

module.exports = { eligibility };

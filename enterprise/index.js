// NodeMend Enterprise — entry point. main.js requires this only when the build edition is
// enterprise (the folder is physically absent from Solo artifacts). register() wires the
// enterprise IPC channels; everything else is exported for main.js (unattended bootstrap,
// audit calls from guard(), the report sink used by Export).
const policy = require('./policy');
const report = require('./report');
const audit = require('./audit');
const unattended = require('./unattended');
const { PROFILES, EXIT } = unattended;

// Feature each enterprise channel needs (checked here even when main's guard() already did).
const FEATURE = { 'report:send': 'report', 'report:status': 'report', 'report:open': 'report', 'policy:reload': 'policy',
  'audit:tail': 'audit', 'audit:open': 'audit', schedule: 'unattended' };
const SCHEDULE_ACTIONS = ['install', 'remove', 'status'];

function requireFeature(ctx, channel) {
  const lic = policy.helpers.safe(() => ctx.getLicenseState()) || {};
  if (lic.edition !== 'enterprise' || !Array.isArray(lic.features) || !lic.features.includes(FEATURE[channel])) throw new Error('LICENSE_REQUIRED');
}

function shellOf(ctx) { return ctx.shell || require('electron').shell; }

// Called once at every start (GUI and unattended): audit rotation + outbox flush.
async function startup(ctx) {
  const rotated = audit.rotate(ctx);
  const flushed = await report.flush(ctx).catch(e => ({ error: e.message }));
  return { rotated, flushed };
}

function register({ ipcMain, ctx }) {
  const h = (channel, fn) => ipcMain.handle(channel, async (e, ...a) => {
    if (typeof ctx.guard === 'function') ctx.guard(channel, ...a); // audits + throws LICENSE_REQUIRED / POLICY_DENIED
    requireFeature(ctx, channel);
    return fn(...a);
  });

  h('report:send', ({ json, md, profile } = {}) => report.send(ctx, { json, md, profile }));
  h('report:status', () => report.status(ctx));
  h('report:open', async () => {
    const st = await report.status(ctx);
    const dir = st.configured && st.reachable ? st.dir : st.localDir;
    return shellOf(ctx).openPath(dir).then(err => ({ ok: !err, dir, error: err || null }));
  });

  h('policy:reload', async () => {
    const p = await policy.load(ctx);
    policy.helpers.safe(() => ctx.setPolicy && ctx.setPolicy(p));
    audit.write(ctx, 'policy-load', { action: null, target: p.path, result: { ok: p.ok, error: p.error } });
    policy.helpers.safe(() => ctx.send && ctx.send('license:changed'));
    return p;
  });

  h('audit:tail', () => audit.tail(ctx, 20));
  h('audit:open', () => { const dir = audit.dir(ctx); return shellOf(ctx).openPath(dir).then(err => ({ ok: !err, dir, error: err || null })); });

  // 'NodeMend Maintenance' weekly task (SYSTEM, highest privileges) through ps/schedule.ps1.
  h('schedule', async (action) => {
    if (!SCHEDULE_ACTIONS.includes(action)) throw new Error('unknown schedule action: ' + action);
    const args = action === 'install' ? (() => { const c = unattended.commandLine(ctx); if (!c.schedule.allowed) throw new Error(c.schedule.reason); return ['-Install', '-Exe', c.exe, '-Arguments', c.args]; })()
      : action === 'remove' ? ['-Remove'] : ['-Status'];
    const r = await ctx.runPs('schedule.ps1', args);
    if (action !== 'status') audit.write(ctx, 'done', { action: 'schedule-' + action, target: r && r.name || 'NodeMend Maintenance', result: { ok: !!(r && r.ok), error: (r && r.error) || null } });
    return r;
  });

  // Renderer progress pings during runUnattended() (ipcRenderer.send, not invoke).
  ipcMain.on('unattended:progress', (e, p) => unattended.onProgress(p));
}

module.exports = { register, startup, requireFeature, policy, report, audit, unattended, PROFILES, EXIT, FEATURE, SCHEDULE_ACTIONS };

// NodeMend renderer. Vanilla JS; everything privileged goes through window.tidy (preload bridge).
const DESKTOP = !!window.tidy;
const state = { info: null, sys: null, diag: null, cats: [], scan: null, lastClean: null, winget: [], wu: null, startup: [], busy: null, taskSeq: 0, taskLines: [], drivers: null, dup: null, dupRoots: [], programs: null, allRunning: false, allStop: false,
  // licensing (spec 4.3 payload from license:state), effective policy data ({} = allow-all), headless flag, last step run
  lic: null, policy: {}, unattended: false, allReboot: false, allStatus: {}, allStarted: null, allFinished: null, hiddenTabs: [] };

// ---------------------------------------------------------------- log + task plumbing
const logEl = $('#log');
function log(line, cls) {
  const t = new Date().toLocaleTimeString();
  logEl.appendChild(document.createTextNode(`[${t}] ${line}\n`));
  logEl.scrollTop = logEl.scrollHeight;
}
if (DESKTOP) window.tidy.onLine(({ id, line }) => { log(line); if (state.busy) state.taskLines.push(line); });

// Spec 5.3: every confirm()/alert() goes through these so the hidden unattended window never
// blocks on a modal. In GUI mode they are the plain browser dialogs.
function ask(msg) { if (state.unattended) { log('auto-confirm: ' + String(msg).split('\n')[0]); return true; } return confirm(msg); }
function notify(msg) { if (state.unattended) { log('notice: ' + msg); return; } alert(msg); }

function setBusy(label) {
  state.busy = label;
  $('#log-spinner').hidden = !label;
  $('#log-panel').classList.toggle('busy', !!label);
  $('#log-title').textContent = label ? `Running: ${label}` : 'Activity log';
  $('#btn-cancel').hidden = !label;
  $$('.needs-idle').forEach(b => { b.disabled = !!label || b.dataset.keepDisabled === '1' || !!b.dataset.locked; });
}
// Enable/disable a button unless policy has locked it (data-locked wins, see applyPolicy).
function setEnabled(sel, on) { const b = $(sel); if (b) b.disabled = !on || !!b.dataset.locked; }
// Run one long task at a time. `fn` receives a fresh task id and returns a promise.
async function runTask(label, fn) {
  if (state.busy) { log(`Busy with "${state.busy}" — wait for it to finish.`); return null; }
  const id = 't' + (++state.taskSeq);
  state.currentTask = id;
  setBusy(label); log(`▶ ${label}`); state.taskLines = [];
  const t0 = Date.now();
  try { const r = await fn(id); log(`✔ ${label} finished in ${((Date.now() - t0) / 1000).toFixed(0)} s` + (r && r.code != null ? ` (exit ${r.code})` : '')); return r; }
  catch (e) { gateFailure(label, e); return null; }
  finally { setBusy(null); state.currentTask = null; }
}
// main.js refuses machine-changing IPC with Error('LICENSE_REQUIRED') / Error('POLICY_DENIED:<token>');
// Electron wraps it as "Error invoking remote method '<channel>': Error: <text>". Returns true when handled.
function gateFailure(label, e) {
  const m = String(e && e.message || e), pol = /POLICY_DENIED:(\S+)/.exec(m);
  if (/LICENSE_REQUIRED/.test(m)) { log(`License required for ${label}.`); if (!state.unattended) showTab('license'); return true; }
  if (pol) { log(`Disabled by policy (${pol[1]}): ${label}`); return true; }
  log(`✖ ${label} failed: ${m}`); return false;
}
$('#btn-cancel').onclick = () => { if (state.currentTask && DESKTOP) { window.tidy.cancel(state.currentTask); log('Cancel requested.'); } };
$('#btn-log-clear').onclick = () => { logEl.textContent = ''; };
$('#btn-log-copy').onclick = () => navigator.clipboard.writeText(logEl.textContent);
$('#btn-log-toggle').onclick = () => { const p = $('#log-panel'); p.classList.toggle('collapsed'); $('#btn-log-toggle svg').style.transform = p.classList.contains('collapsed') ? 'rotate(180deg)' : ''; };

// ---------------------------------------------------------------- tabs
const TITLES = { dashboard: 'Dashboard', cleaner: 'Cleaner', health: 'Health & Repair', updates: 'Updates', startup: 'Startup programs', duplicates: 'Duplicate files', programs: 'Uninstall programs', license: 'About', recovery: 'File Recovery', storage: 'Disk Analyzer', privacy: 'Privacy', performance: 'Performance', smart: 'Smart Cleaning', cloud: 'Cloud Folders', vpn: 'VPN Setup' };
function showTab(name) {
  if (state.hiddenTabs.includes(name)) return;                 // policy hideTabs: stay where we are
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  $('#tab-title').textContent = TITLES[name] || name;
  if (name === 'startup' && !state.startup.length) loadStartup();
  if (name === 'cleaner' && !state.cats.length) loadCategories();
  if (name === 'duplicates' && !state.dupRoots.length) loadDupRoots();
  if (name === 'programs' && !state.programs) loadPrograms();
  if (name === 'license') refreshEnterprise();
}
$$('.nav-btn').forEach(b => b.onclick = () => showTab(b.dataset.tab));
$$('[data-open]').forEach(b => b.onclick = () => DESKTOP && window.tidy.open(b.dataset.open));

// ---------------------------------------------------------------- dashboard
function renderSys(s) {
  if (state.info && state.info.platform !== 'win32') {
    $('#sys-cards').innerHTML = `<div class="card"><h3>${esc(s.os)} ${esc(s.version)}</h3><p>${esc(s.cpu)} · ${s.threads} threads</p><p>Memory: ${fmtBytes(s.ramTotal - s.ramFree)} used of ${fmtBytes(s.ramTotal)}</p><p>Uptime: ${s.uptimeHours} hours</p></div><div class="card"><h3>Filesystem space</h3>${s.volumes.map(v => `<p>${esc(v.path)}: ${fmtBytes(v.free)} available of ${fmtBytes(v.size)}</p>`).join('')}</div><div class="card wide"><h3>Platform support</h3><p>Cleaning, duplicates, disk analysis, privacy tools and disk-image recovery are available. Windows repair, Defender, driver updates and enterprise unattended mode are not available on this system.</p><p class="hint">SMART, security status and reboot requirements are not assessed by this build.</p></div>`;
    return;
  }
  const ramUsed = s.ramTotal - s.ramFree; const rp = pct(ramUsed, s.ramTotal);
  const vols = s.volumes.map(v => { const used = v.size - v.free; const p = pct(used, v.size); return `
    <div class="vol">${gauge(p, p + '%')}
      <div class="meta"><b>${esc(v.letter)}:</b> ${esc(v.label || (v.letter === 'C' ? 'Windows' : 'Volume'))} <span class="dim small">${esc(v.fs)}</span>
        <div class="muted small">${fmtBytes(v.free)} free of ${fmtBytes(v.size)}</div></div>
      <span class="chip ${v.health === 'Healthy' ? 'ok' : 'bad'}">${esc(v.health)}</span></div>`; }).join('');
  const disks = s.disks.map(d => `<tr><td><b>${esc(d.name)}</b><div class="muted small">${esc(d.media)} · ${esc(d.bus)} · ${fmtBytes(d.size)}</div></td>
    <td><span class="chip ${d.health === 'Healthy' ? 'ok' : 'bad'}">${esc(d.health)}</span></td><td class="num">${d.temp != null ? d.temp + ' °C' : '—'}</td><td class="num">${d.wear != null ? d.wear + ' %' : '—'}</td><td class="num">${d.hours != null ? d.hours.toLocaleString() + ' h' : '—'}</td></tr>`).join('');
  const def = s.defender || {};
  const secure = def.realtime && def.sigAgeDays <= 3 && !s.pendingReboot;
  $('#sys-cards').innerHTML = `
    <div class="card accent wide"><div style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">
      <div>${gauge(rp, rp + '%')}</div>
      <div style="flex:1;min-width:220px"><div class="stat-big">${fmtBytes(ramUsed)} <small>of ${fmtBytes(s.ramTotal)} memory in use</small></div>
        <div class="muted small" style="margin-top:4px">${esc(s.cpu)} · ${s.cores} cores / ${s.threads} threads · CPU load ${s.cpuLoad ?? '?'}%</div></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <span class="chip ${secure ? 'ok' : 'warn'}">${icon(secure ? 'check' : 'alert')} ${secure ? 'Protected' : 'Attention'}</span>
        <span class="chip ${s.pendingReboot ? 'warn' : 'ok'}">${icon('power')} ${s.pendingReboot ? 'Reboot pending' : 'No reboot needed'}</span>
        <span class="chip ${s.uptimeHours > 168 ? 'warn' : ''}">${icon('clock')} Up ${s.uptimeHours} h</span>
      </div></div></div>
    <div class="card"><h3>${icon('chip')} System</h3><dl class="kv">
      <dt>Windows</dt><dd>${esc(s.os)} ${esc(s.displayVersion || '')} <span class="dim small">build ${esc(s.build)}</span></dd>
      <dt>Machine</dt><dd>${esc(s.model)}</dd><dt>BIOS</dt><dd>${esc(s.bios)}</dd>
      <dt>GPU</dt><dd>${esc(s.gpu || '—')} <span class="dim small">${esc(s.gpuDriver || '')}</span></dd>
      <dt>Last boot</dt><dd>${fmtDate(s.lastBoot)}</dd>
      <dt>Last hotfix</dt><dd>${esc(s.lastHotfix)}</dd></dl></div>
    <div class="card"><h3>${icon('shield')} Security</h3><dl class="kv">
      <dt>Real-time</dt><dd><span class="chip ${def.realtime ? 'ok' : 'bad'}">${def.realtime ? 'On' : 'OFF'}</span></dd>
      <dt>Signatures</dt><dd>${esc(def.sigVersion || '—')} <span class="${def.sigAgeDays > 3 ? 'warn' : 'ok'} small">(${def.sigAgeDays ?? '?'} d old)</span></dd>
      <dt>Quick scan</dt><dd>${fmtDate(def.lastQuick)}</dd><dt>Full scan</dt><dd>${fmtDate(def.lastFull)}</dd></dl></div>
    <div class="card"><h3>${icon('disk')} Volumes</h3>${vols}</div>
    <div class="card wide"><h3>${icon('memory')} Physical disks</h3><table><thead><tr><th>Disk</th><th>Health</th><th>Temp</th><th>Wear</th><th>Power-on</th></tr></thead><tbody>${disks}</tbody></table></div>`;
}
async function loadSys() {
  if (!DESKTOP) return;
  try { state.sys = await window.tidy.psJson('sysinfo.ps1'); renderSys(state.sys); }
  catch (e) { $('#sys-cards').innerHTML = `<div class="card bad">System info failed: ${esc(e.message)}</div>`; }
}
$('#btn-refresh-sys').onclick = loadSys;

// ---------------------------------------------------------------- cleaner
// Categories arrive with policy applied by main.js (on/off overridden, locked when cleaner.lock).
async function loadCategories() {
  if (!DESKTOP) return;
  state.cats = await window.tidy.categories();
  const groups = {};
  for (const c of state.cats) (groups[c.group] ||= []).push(c);
  const recycleDenied = gateDecision('recycle') === 'policy';
  $('#clean-groups').innerHTML = Object.entries(groups).map(([g, cats]) => `
    <div class="group"><div class="group-head"><input type="checkbox" class="grp" data-group="${esc(g)}" checked title="toggle group"> ${icon({System:'chip',Browsers:'ext',Apps:'list',Developer:'wrench'}[g] || 'list')} ${esc(g)}</div>
      ${cats.map(c => { const denied = c.id === 'recycle' && recycleDenied; const off = c.locked || denied; return `<label class="cat ${c.locked ? 'locked' : ''}" ${off ? 'title="Disabled by policy"' : ''}><input type="checkbox" class="catbox" data-id="${esc(c.id)}" ${c.on && !denied ? 'checked' : ''} ${off ? 'disabled' : ''}>
        <span><span class="name">${esc(c.name)}${c.special ? ' <span class="warn">⚠</span>' : ''}</span><div class="desc">${esc(c.desc)}</div></span>
        <span class="size" id="size-${esc(c.id)}"><span class="muted">?</span></span></label>`; }).join('')}
    </div>`).join('');
  $$('.grp').forEach(g => g.onchange = () => $$(`.catbox`).forEach(b => { const cat = state.cats.find(c => c.id === b.dataset.id); if (cat.group === g.dataset.group && !cat.special && !b.disabled) b.checked = g.checked; }));
  $$('.catbox').forEach(b => b.onchange = updateCleanSummary);
  if (state.scan) { for (const c of state.scan) { const e = $(`#size-${c.id}`); if (e) e.innerHTML = `<b>${fmtBytes(c.size)}</b><div class="n">${c.count} files</div>`; } updateCleanSummary(); }
  else if (state.cats.some(c => c.locked)) $('#clean-summary').textContent = 'Categories · pinned by policy';
}
function selectedCatIds() { return $$('.catbox:checked').map(b => b.dataset.id); }
function updateCleanSummary() {
  if (!state.scan) return;
  const ids = selectedCatIds();
  const total = state.scan.filter(r => ids.includes(r.id)).reduce((a, r) => a + r.size, 0);
  $('#clean-summary').textContent = `Selected: ${fmtBytes(total)} in ${ids.length} categories` + (state.cats.some(c => c.locked) ? ' · pinned by policy' : '');
  $('#btn-clean').dataset.keepDisabled = total > 0 ? '0' : '1';
  setEnabled('#btn-clean', !state.busy && total > 0);
}
async function analyze() {
  if (!state.cats.length) await loadCategories();
  const r = await runTask('Analyze cleanable files', () => window.tidy.scan());
  if (!r) return;
  state.scan = r;
  for (const c of r) { const e = $(`#size-${c.id}`); if (e) e.innerHTML = `<b>${fmtBytes(c.size)}</b><div class="n">${c.count} files</div>`; }
  const total = r.reduce((a, c) => a + c.size, 0);
  log(`Analysis complete: ${fmtBytes(total)} reclaimable across ${r.filter(c => c.size > 0).length} categories.`);
  updateCleanSummary();
}
async function clean(ids) {
  ids = ids || selectedCatIds();
  if (ids.includes('recycle') && !ask('Empty the Recycle Bin? Files in it will be permanently deleted.')) ids = ids.filter(i => i !== 'recycle');
  if (!ids.length) return;
  const r = await runTask('Clean selected categories', () => window.tidy.clean(ids));
  if (!r) return;
  state.lastClean = r;
  const rows = r.results.map(x => { const c = state.cats.find(k => k.id === x.id); return `<tr><td>${esc(c ? c.name : x.id)}</td><td class="num">${fmtBytes(x.freed)}</td><td class="num">${x.deleted}</td><td class="num">${x.skipped}</td></tr>`; }).join('');
  $('#clean-result').hidden = false;
  $('#clean-result').innerHTML = `<div class="stat-big">${fmtBytes(r.totalFreed)} <small>freed</small></div>
    <div class="muted small">C: free space ${fmtBytes(r.freeBefore)} → ${fmtBytes(r.freeAfter)}</div>
    <table style="margin-top:8px"><thead><tr><th>Category</th><th>Freed</th><th>Files</th><th>In use (skipped)</th></tr></thead><tbody>${rows}</tbody></table>`;
  await analyze();
}
$('#btn-analyze').onclick = analyze;
$('#btn-clean').onclick = () => clean();
$('#btn-cleanmgr').onclick = () => runTask('Windows Disk Cleanup (cleanmgr)', id => window.tidy.runPs(id, 'cleanmgr.ps1'));

// ---------------------------------------------------------------- health
function renderDiag(d) {
  if (state.info && state.info.platform !== 'win32') {
    $('#diag-cards').innerHTML = `<div class="card"><h3>System checks</h3><p>Memory: ${fmtBytes(d.ramFree)} free of ${fmtBytes(d.ramTotal)}</p>${(d.findings || []).map(f => `<p>${esc(f.message)}</p>`).join('') || '<p>No low-space warning found.</p>'}<p class="hint">This is a basic read-only check, not a full operating-system security or hardware diagnosis.</p></div>`;
    return;
  }
  const srcRows = d.bySource.map(s => `<tr><td>${esc(s.source)}</td><td class="num">${s.count}</td></tr>`).join('');
  const recent = table([
    { label: 'Time', render: r => esc(fmtDate(r.time)), cls: 'mono' }, { label: 'Source', key: 'source' }, { label: 'ID', key: 'id', cls: 'num' }, { label: 'Message', key: 'message' }], d.recent);
  const svc = d.stoppedAutoServices.map(s => `<li><b>${esc(s.display)}</b> <span class="muted small">(${esc(s.name)})</span></li>`).join('') || '<li class="muted">All automatic services are running</li>';
  const smart = d.smart.length ? d.smart.map(s => `<li class="${s.predictFailure ? 'bad' : 'ok'}">${s.predictFailure ? '⚠ FAILURE PREDICTED' : '✔ OK'} <span class="muted small">${esc(s.instance)}</span></li>`).join('') : '<li class="muted">No SMART data exposed by the driver</li>';
  const crashes = d.crashes.length ? d.crashes.map(c => `<li>${esc(fmtDate(c.time))} — ${c.id === 41 ? 'Kernel-Power 41 (unexpected power loss/reset)' : c.id === 6008 ? 'Unexpected shutdown' : 'Bugcheck (BSOD)'}</li>`).join('') : '<li class="ok">None in the last 30 days</li>';
  const app = d.appCrashes.length ? d.appCrashes.slice(0, 8).map(c => `<li>${esc(fmtDate(c.time))} — ${esc(c.message)}</li>`).join('') : '<li class="ok">No application crashes/hangs logged</li>';
  const top = d.topProcesses.map(p => `<tr><td>${esc(p.name)}</td><td class="num">${fmtBytes(p.ws)}</td></tr>`).join('');
  const rp = d.restorePoints.length ? d.restorePoints.map(r => `<li>${esc(fmtDate(r.time))} — ${esc(r.desc)}</li>`).join('') : '<li class="warn">No restore points (System Protection may be off)</li>';
  const verdictItems = [];
  if (d.pendingReboot) verdictItems.push(`<span class="chip warn">${icon('power')} Reboot pending</span>`);
  if (d.crashes.length) verdictItems.push(`<span class="chip bad">${icon('alert')} ${d.crashes.length} unexpected shutdown(s) in 30 days</span>`);
  if (d.smart.some(s => s.predictFailure)) verdictItems.push(`<span class="chip bad">${icon('alert')} Disk failure predicted — back up now</span>`);
  if (d.stoppedAutoServices.length > 6) verdictItems.push(`<span class="chip warn">${icon('info')} ${d.stoppedAutoServices.length} automatic services stopped</span>`);
  if (!verdictItems.length) verdictItems.push(`<span class="chip ok">${icon('check')} No critical findings</span>`);
  $('#diag-cards').innerHTML = `
    <div class="card accent wide"><h3>${icon('pulse')} Verdict</h3><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">${verdictItems.join('')}<span class="muted small">${d.errorCount} error/critical events in the last ${d.days} days · memory test: ${esc(d.memoryDiag || 'never run')}</span></div></div>
    <div class="card"><h3>${icon('list')} Errors by source (${d.days} d)</h3><table><tbody>${srcRows || '<tr><td class="muted">none</td></tr>'}</tbody></table></div>
    <div class="card"><h3>${icon('alert')} System crashes (30 d)</h3><ul>${crashes}</ul><h3 style="margin-top:12px">App crashes / hangs (${d.days} d)</h3><ul>${app}</ul></div>
    <div class="card"><h3>${icon('wrench')} Automatic services not running</h3><ul>${svc}</ul></div>
    <div class="card"><h3>${icon('disk')} Disk SMART</h3><ul>${smart}</ul><h3 style="margin-top:12px">Restore points</h3><ul>${rp}</ul></div>
    <div class="card"><h3>${icon('memory')} Top memory users</h3><table><tbody>${top}</tbody></table></div>
    <div class="card"><h3>${icon('chip')} Page file · network</h3><ul>${d.pagefile.map(p => `<li>${esc(p.name)}: ${p.currentMB} MB used, peak ${p.peakMB} MB of ${p.allocMB} MB</li>`).join('')}${d.network.map(n => `<li>${esc(n.name)} — ${esc(n.speed)}</li>`).join('')}</ul></div>
    <div class="card wide"><h3>${icon('clock')} Most recent errors</h3>${recent}</div>`;
}
$('#btn-diag').onclick = async () => {
  const d = await runTask('Diagnostics', () => window.tidy.psJson('diag.ps1'));
  if (d) { state.diag = d; renderDiag(d); }
};
$$('.exe').forEach(b => b.onclick = () => runTask(b.textContent.trim(), id => window.tidy.runExe(id, b.dataset.exe, { drive: 'C:' })));
$('#btn-defscan').onclick = () => runTask('Defender quick scan', id => window.tidy.runPs(id, 'defender.ps1', ['-Action', 'QuickScan']));

// ---------------------------------------------------------------- updates
function renderWu(w) {
  if (!w.ok) { $('#wu-body').innerHTML = `<span class="bad">Windows Update query failed: ${esc(w.error)}</span>`; return; }
  const pend = w.updates.length ? table([{ label: 'Update', key: 'title' }, { label: 'KB', key: 'kb' }, { label: 'Size', render: r => r.sizeMB + ' MB', cls: 'num' }, { label: 'Downloaded', render: r => r.downloaded ? 'yes' : 'no' }], w.updates)
    : '<div class="ok">✔ No pending updates.</div>';
  const hist = table([{ label: 'Date', render: r => esc(fmtDate(r.date)) }, { label: 'Update', key: 'title' }, { label: 'Result', render: r => `<span class="${/Fail|Abort/.test(r.result) ? 'bad' : 'ok'}">${esc(r.result)}</span>` }], w.history);
  $('#wu-body').innerHTML = `<div style="margin-bottom:10px">${pend}</div><details><summary class="muted">Recent update history</summary>${hist}</details>`;
  $('#btn-wu-install').dataset.keepDisabled = w.updates.length ? '0' : '1';
  setEnabled('#btn-wu-install', !!w.updates.length);
}
$('#btn-wu-check').onclick = async () => { const w = await runTask('Windows Update check', () => window.tidy.psJson('wu-check.ps1')); if (w) { state.wu = w; renderWu(w); } };
$('#btn-wu-install').onclick = async () => {
  const r = await runTask('Install Windows updates', id => window.tidy.runPs(id, 'wu-install.ps1'));
  if (r && r.result && r.result.rebootRequired) notify('Updates installed. A restart is required to finish.');
  $('#btn-wu-check').click();
};
$('#btn-defupdate').onclick = async () => {
  const r = await runTask('Defender signature update', id => window.tidy.runPs(id, 'defender.ps1', ['-Action', 'Update']));
  if (r && r.result) $('#def-body').innerHTML = r.result.ok ? `<span class="ok">✔ Signatures ${esc(r.result.before)} → ${esc(r.result.after)}</span>` : `<span class="bad">${esc(r.result.error)}</span>`;
  loadSys();
};

function renderWinget(items) {
  if (!items.length) { $('#wg-body').innerHTML = '<span class="ok">✔ All winget-managed apps are up to date.</span>'; $('#btn-wg-all').dataset.keepDisabled = '1'; $('#btn-wg-all').disabled = true; return; }
  $('#wg-body').innerHTML = `<div style="overflow:auto"><table><thead><tr><th><input type="checkbox" id="wg-all-box" checked></th><th>App</th><th>Id</th><th>Installed</th><th>Available</th><th></th></tr></thead><tbody>
    ${items.map(i => `<tr><td><input type="checkbox" class="wgbox" data-id="${esc(i.id)}" ${i.explicit ? '' : 'checked'}></td><td>${esc(i.name)}</td><td class="mono muted">${esc(i.id)}</td><td class="mono">${esc(i.version)}</td><td class="mono ok">${esc(i.available)}</td>
      <td>${i.explicit ? '<span class="pill warn" title="winget needs an explicit --id for this one; use the checkbox">explicit</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
  $('#wg-all-box').onchange = e => $$('.wgbox').forEach(b => b.checked = e.target.checked);
  $('#btn-wg-all').dataset.keepDisabled = '0'; setEnabled('#btn-wg-all', true);
  $('#btn-wg-selected').dataset.keepDisabled = '0'; setEnabled('#btn-wg-selected', true);
}
async function refreshWinget() {
  const r = await runTask('winget upgrade list', () => window.tidy.wingetList());
  if (!r) return;
  if (r.error) { $('#wg-body').innerHTML = `<span class="bad">${esc(r.error)}</span>`; return; }
  state.winget = r.items; renderWinget(r.items);
  log(`${r.items.length} app update(s) available.`);
}
$('#btn-wg-refresh').onclick = refreshWinget;
$('#btn-wg-all').onclick = async () => { await runTask('winget upgrade --all', id => window.tidy.runExe(id, 'winget-all')); refreshWinget(); };
$('#btn-wg-selected').onclick = async () => {
  const ids = $$('.wgbox:checked').map(b => b.dataset.id);
  if (!ids.length) return;
  await runTask(`winget upgrade ${ids.length} app(s)`, async (id) => { for (const pkg of ids) { log(`— ${pkg}`); await window.tidy.runExe(id, 'winget-id', { id: pkg }); } return { code: 0 }; });
  refreshWinget();
};

// ---------------------------------------------------------------- startup
async function loadStartup() {
  if (!DESKTOP) return;
  try { state.startup = await window.tidy.psJson('startup.ps1'); } catch (e) { $('#startup-body').innerHTML = `<span class="bad">${esc(e.message)}</span>`; return; }
  if (!Array.isArray(state.startup)) state.startup = [state.startup];
  $('#startup-body').innerHTML = table([
    { label: 'Program', render: r => `<b>${esc(r.name)}</b><div class="muted small mono">${esc(r.command)}</div>` },
    { label: 'Scope', render: r => `${esc(r.scope)}<div class="muted small">${esc(r.location)}</div>` },
    { label: 'Status', render: r => `<span class="pill ${r.enabled ? 'on' : 'off'}">${r.enabled ? 'Enabled' : 'Disabled'}</span>` },
    { label: '', render: r => r.key === 'RunOnce' ? '' : `<button class="tiny toggle" data-action="startup-toggle" data-name="${esc(r.name)}" data-hive="${esc(r.hive)}" data-key="${esc(r.key)}" data-enable="${r.enabled ? '0' : '1'}">${r.enabled ? 'Disable' : 'Enable'}</button>` }
  ], state.startup);
  applyGatedButtons($('#startup-body'));
  $$('.toggle').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { await window.tidy.psJson('startup-toggle.ps1', ['-Name', b.dataset.name, '-Hive', b.dataset.hive, '-Key', b.dataset.key, '-Enable', b.dataset.enable === '1' ? '$true' : '$false']); log(`${b.dataset.enable === '1' ? 'Enabled' : 'Disabled'} startup entry "${b.dataset.name}"`); }
    catch (e) { if (!gateFailure(`startup entry "${b.dataset.name}"`, e)) notify('Could not change this entry (machine-wide entries need administrator rights).'); }
    loadStartup();
  });
}
$('#btn-startup-refresh').onclick = loadStartup;

// ---------------------------------------------------------------- drivers
function renderDrivers(d) {
  const drv = d.drivers.length ? `<div style="overflow:auto"><table><thead><tr><th><input type="checkbox" id="drv-all-box" checked></th><th>Driver</th><th>Vendor</th><th>Class</th><th>Version</th><th>Size</th></tr></thead><tbody>
    ${d.drivers.map(u => `<tr><td><input type="checkbox" class="drvbox" data-id="${esc(u.id)}" checked></td><td>${esc(u.title)}${u.rebootRequired ? ' <span class="pill warn">reboot</span>' : ''}</td><td>${esc(u.provider || u.manufacturer)}</td><td>${esc(u.class)}</td><td class="mono">${esc(u.version)}</td><td class="num">${u.sizeMB} MB</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="ok">${icon('check')} No newer drivers offered by Microsoft Update for this hardware.</div>`;
  const prob = d.problemDevices.length ? `<h3 style="margin-top:14px">${icon('alert')} Devices reporting problems</h3><ul>${d.problemDevices.map(p => `<li><b>${esc(p.name)}</b> <span class="muted small">${esc(p.class)} · ${esc(p.status)} · ${esc(p.problem)}</span></li>`).join('')}</ul>`
    : `<div class="muted small" style="margin-top:10px">${icon('check')} Every present device reports OK.</div>`;
  const old = `<details style="margin-top:10px"><summary class="muted">Oldest third-party drivers installed (${d.installedCount} total)</summary>${table([{ label: 'Device', key: 'device' }, { label: 'Provider', key: 'provider' }, { label: 'Version', key: 'version', cls: 'mono' }, { label: 'Date', key: 'date', cls: 'mono' }], d.oldest)}<div class="hint" style="margin-top:6px">Old is not necessarily wrong. GPU, chipset and network drivers are worth checking on the vendor site if these are years old.</div></details>`;
  $('#drv-body').innerHTML = (d.ok ? '' : `<div class="bad">Microsoft Update query failed: ${esc(d.error)}</div>`) + drv + prob + old;
  const box = $('#drv-all-box'); if (box) box.onchange = e => $$('.drvbox').forEach(b => b.checked = e.target.checked);
  $('#btn-drv-install').dataset.keepDisabled = d.drivers.length ? '0' : '1';
  setEnabled('#btn-drv-install', !!d.drivers.length);
}
async function checkDrivers() {
  const d = await runTask('Driver check (Microsoft Update)', () => window.tidy.psJson('drivers.ps1'));
  if (d) { state.drivers = d; renderDrivers(d); log(`${d.drivers.length} driver update(s) offered; ${d.problemDevices.length} device(s) with problems.`); }
  return d;
}
$('#btn-drv-check').onclick = checkDrivers;
$('#btn-drv-install').onclick = async () => {
  const ids = $$('.drvbox:checked').map(b => b.dataset.id);
  if (!ids.length) return;
  const r = await runTask(`Install ${ids.length} driver(s)`, id => window.tidy.runPs(id, 'wu-install.ps1', ['-Drivers', '-Ids', ids.join(',')]));
  if (r && r.result && r.result.rebootRequired) notify('Drivers installed. A restart is required to finish.');
  checkDrivers();
};

// ---------------------------------------------------------------- duplicates
async function loadDupRoots() {
  if (!DESKTOP) return;
  state.dupRoots = await window.tidy.dupDefaults();
  renderDupRoots();
}
function renderDupRoots() {
  $('#dup-roots').innerHTML = state.dupRoots.map((r, i) => `<span class="chip root">${icon('file')} ${esc(r)} <button class="x" data-i="${i}" title="remove">&#x2715;</button></span>`).join('') || '<span class="hint">No folders selected. Click "Add folder" to choose some.</span>';
  $$('#dup-roots .x').forEach(b => b.onclick = () => { state.dupRoots.splice(+b.dataset.i, 1); renderDupRoots(); });
}
$('#btn-dup-add').onclick = async () => { const picked = await window.tidy.pickFolders(); for (const p of picked) if (!state.dupRoots.includes(p)) state.dupRoots.push(p); renderDupRoots(); };
function dupSelection() { return $$('.dupbox:checked').map(b => b.dataset.path); }
function updateDupSummary() {
  if (!state.dup) return;
  const sel = dupSelection(); let bytes = 0;
  for (const g of state.dup.groups) for (const f of g.files) if (sel.includes(f.path)) bytes += g.size;
  $('#dup-summary').textContent = `${state.dup.groups.length} duplicate groups · ${fmtBytes(state.dup.wasted)} wasted · ${sel.length} selected (${fmtBytes(bytes)})`;
  $('#btn-dup-trash').dataset.keepDisabled = sel.length ? '0' : '1'; setEnabled('#btn-dup-trash', sel.length && !state.busy);
  $('#btn-dup-auto').dataset.keepDisabled = '0'; $('#btn-dup-auto').disabled = !!state.busy;
}
function renderDup(d) {
  if (!d.groups.length) { $('#dup-body').innerHTML = `<div class="card"><span class="ok">${icon('check')} No duplicate files found</span> <span class="muted small">(${d.filesScanned.toLocaleString()} files in ${d.foldersScanned.toLocaleString()} folders)</span></div>`; $('#dup-summary').textContent = ''; return; }
  const shown = d.groups.slice(0, 400);
  $('#dup-body').innerHTML = shown.map((g, gi) => `<div class="dup-group">
      <div class="dup-head"><b>${fmtBytes(g.size)}</b> &times; ${g.files.length} copies <span class="muted">· ${fmtBytes(g.wasted)} recoverable</span><span class="grow"></span><span class="dim small mono">${esc(g.hash.slice(0, 12))}</span></div>
      ${g.files.map((f, fi) => `<label class="dup-file ${fi === 0 ? 'keep' : ''}"><input type="checkbox" class="dupbox" data-path="${esc(f.path)}" data-g="${gi}"><span>${esc(f.path)}</span><span class="d">${esc(fmtDate(new Date(f.mtime)))}${fi === 0 ? ' · oldest' : ''}</span></label>`).join('')}
    </div>`).join('') + (d.groups.length > shown.length ? `<div class="hint">Showing the ${shown.length} largest groups of ${d.groups.length}.</div>` : '');
  $$('.dupbox').forEach(b => b.onchange = updateDupSummary);
  updateDupSummary();
}
async function scanDuplicates() {
  if (!state.dupRoots.length) await loadDupRoots();
  if (!state.dupRoots.length) { notify('Add at least one folder to scan.'); return null; }
  const minSize = +$('#dup-min').value;
  const d = await runTask('Duplicate scan', id => window.tidy.dupScan({ id, roots: state.dupRoots.slice(), minSize }));
  if (!d) return null;
  state.dup = d; renderDup(d);
  log(`Duplicates: ${d.groups.length} groups, ${fmtBytes(d.wasted)} recoverable${d.cancelled ? ' (scan cancelled early)' : ''}.`);
  return d;
}
$('#btn-dup-scan').onclick = scanDuplicates;
$('#btn-dup-auto').onclick = () => { $$('.dupbox').forEach(b => { const first = b.closest('.dup-group').querySelector('.dupbox'); b.checked = b !== first; }); updateDupSummary(); };
$('#btn-dup-trash').onclick = async () => {
  const sel = dupSelection(); if (!sel.length) return;
  if (!ask(`Send ${sel.length} file(s) to the Recycle Bin?`)) return;
  const r = await runTask(`Recycle ${sel.length} duplicate(s)`, () => window.tidy.dupTrash(sel));
  if (r) { log(`Recycled ${r.ok} file(s), ${fmtBytes(r.bytes)}; ${r.failed} failed.`); await scanDuplicates(); }
};

// ---------------------------------------------------------------- programs (uninstaller)
function progIconChar(p) { return p.kind === 'appx' ? 'ext' : 'disk'; }
function filteredPrograms() {
  const q = ($('#prog-filter').value || '').toLowerCase().trim();
  const showAppx = $('#prog-appx').checked;
  const sort = $('#prog-sort').value;
  let list = state.programs.filter(p => showAppx || p.kind !== 'appx');
  if (q) list = list.filter(p => (p.name + ' ' + p.publisher).toLowerCase().includes(q));
  list = list.slice().sort((a, b) => {
    if (sort === 'sizeMB') return (b.sizeMB || 0) - (a.sizeMB || 0);
    if (sort === 'installDate') return String(b.installDate || '').localeCompare(String(a.installDate || ''));
    return a.name.localeCompare(b.name);
  });
  return list;
}
function renderPrograms() {
  const list = filteredPrograms();
  const totalSize = list.reduce((a, p) => a + (p.sizeMB || 0), 0);
  $('#prog-summary').textContent = `${list.length} shown · ${fmtBytes(totalSize * 1048576)} on disk (where reported)`;
  if (!list.length) { $('#prog-body').innerHTML = '<div class="card muted">No programs match.</div>'; return; }
  $('#prog-body').innerHTML = `<div class="card" style="padding:0;overflow:hidden">
    <div class="prog-head"><span></span><span>Program</span><span>Version</span><span style="text-align:right">Size</span><span></span></div>
    ${list.map((p, i) => `<div class="prog-row" data-i="${i}">
      <span class="ico">${icon(progIconChar(p))}</span>
      <span><span class="nm">${esc(p.name)}</span>${p.kind === 'appx' ? '<span class="tag-store">Store</span>' : ''}<div class="pub">${esc(p.publisher || 'Unknown publisher')}${p.installDate ? ' · ' + esc(p.installDate) : ''}</div></span>
      <span class="ver">${esc(p.version || '')}</span>
      <span class="sz">${p.sizeMB ? fmtBytes(p.sizeMB * 1048576) : '—'}</span>
      <span class="act"><button class="tiny danger prog-un" data-action="uninstall" data-i="${i}" data-icon="trash">Uninstall</button></span>
    </div>`).join('')}</div>`;
  const shown = list;
  applyIcons($('#prog-body'));
  applyGatedButtons($('#prog-body'));
  $$('#prog-body .prog-un').forEach(b => b.onclick = () => uninstallProgram(shown[+b.dataset.i]));
}
async function loadPrograms() {
  const list = await runTask('List installed programs', () => window.tidy.psJson('programs.ps1'));
  if (!list) return;
  state.programs = Array.isArray(list) ? list : [list];
  log(`${state.programs.length} programs found (${state.programs.filter(p => p.kind === 'appx').length} Store apps).`);
  renderPrograms();
}
async function uninstallProgram(p) {
  if (!p) return;
  const silent = p.kind === 'registry';
  const msg = p.kind === 'appx'
    ? `Uninstall the Store app “${p.name}”?`
    : `Uninstall “${p.name}”?\n\nThis launches its uninstaller. You may see the program's own uninstall window or UAC prompts; follow them to finish.`;
  if (!ask(msg)) return;
  const args = p.kind === 'appx'
    ? ['-Kind', 'appx', '-Id', p.id]
    : ['-Kind', 'registry', '-Id', p.id].concat(silent && p.quiet ? ['-Silent'] : []);
  const r = await runTask(`Uninstall ${p.name}`, id => window.tidy.runPs(id, 'uninstall.ps1', args));
  if (r && r.result) {
    if (r.result.ok) log(`✔ ${p.name} uninstalled.`);
    else log(`✖ ${p.name}: ${r.result.error || 'uninstaller exit code ' + r.result.exitCode}`);
    if (r.result.rebootRequired) notify('Uninstalled. A restart is required to finish.');
  }
  await loadPrograms();
}
$('#btn-prog-refresh').onclick = loadPrograms;
$('#prog-filter').oninput = () => { if (state.programs) renderPrograms(); };
$('#prog-appx').onchange = () => { if (state.programs) renderPrograms(); };
$('#prog-sort').onchange = () => { if (state.programs) renderPrograms(); };

// ---------------------------------------------------------------- do all the things
// `gate` = the lib/gate action the step's machine-changing part maps to; runSteps skips the whole
// step (reason license/policy) instead of letting it run into main's guard half-way through.
const ALL_STEPS = [
  { key: 'diag', label: 'Diagnostics', run: async () => { const d = await runTask('Diagnostics', () => window.tidy.psJson('diag.ps1')); if (d) { state.diag = d; renderDiag(d); } return !!d; } },
  { key: 'clean', label: 'Clean junk files', gate: 'clean', run: async () => { if (!state.cats.length) await loadCategories(); await analyze(); const ids = state.cats.filter(c => c.on && !c.special).map(c => c.id); const before = state.lastClean; await clean(ids); return state.lastClean !== before; } },
  { key: 'cleanmgr', label: 'Windows Disk Cleanup', gate: 'cleanmgr', run: async () => !!(await runTask('Windows Disk Cleanup (cleanmgr)', id => window.tidy.runPs(id, 'cleanmgr.ps1'))) },
  { key: 'dism', label: 'DISM health scan (+ repair if needed)', gate: 'dism-restore', run: async () => { const r = await runTask('DISM ScanHealth', id => window.tidy.runExe(id, 'dism-scan')); if (!r) return false; if (state.taskLines.some(l => /repairable/i.test(l))) { log('Component store is repairable, running RestoreHealth'); const r2 = await runTask('DISM RestoreHealth', id => window.tidy.runExe(id, 'dism-restore')); return !!r2; } return true; } },
  { key: 'sfc', label: 'System File Checker', gate: 'sfc', run: async () => !!(await runTask('SFC /scannow', id => window.tidy.runExe(id, 'sfc'))) },
  { key: 'chkdsk', label: 'CHKDSK online scan', run: async () => !!(await runTask('CHKDSK /scan', id => window.tidy.runExe(id, 'chkdsk', { drive: 'C:' }))) },
  { key: 'defupd', label: 'Defender signatures', run: async () => !!(await runTask('Defender signature update', id => window.tidy.runPs(id, 'defender.ps1', ['-Action', 'Update']))) },
  { key: 'defscan', label: 'Defender quick scan', run: async () => !!(await runTask('Defender quick scan', id => window.tidy.runPs(id, 'defender.ps1', ['-Action', 'QuickScan']))) },
  { key: 'wu', label: 'Windows Update', gate: 'wu-install', run: async () => { const w = await runTask('Windows Update check', () => window.tidy.psJson('wu-check.ps1')); if (!w) return false; state.wu = w; renderWu(w); if (w.updates.length) { const r = await runTask('Install Windows updates', id => window.tidy.runPs(id, 'wu-install.ps1')); if (r && r.result && r.result.rebootRequired) state.allReboot = true; return !!r; } return true; } },
  { key: 'drivers', label: 'Driver updates', gate: 'drivers-install', run: async () => { const d = await checkDrivers(); if (!d) return false; if (d.drivers.length) { const r = await runTask(`Install ${d.drivers.length} driver(s)`, id => window.tidy.runPs(id, 'wu-install.ps1', ['-Drivers'])); if (r && r.result && r.result.rebootRequired) state.allReboot = true; return !!r; } return true; } },
  { key: 'winget', label: 'App updates (winget)', gate: 'winget-upgrade', run: async () => { const r = await runTask('winget upgrade list', () => window.tidy.wingetList()); if (!r || r.error) return false; state.winget = r.items; renderWinget(r.items); if (r.items.some(i => !i.explicit)) { await runTask('winget upgrade --all', id => window.tidy.runExe(id, 'winget-all')); await refreshWinget(); } return true; } },
  { key: 'dup', label: 'Duplicate file scan (report only)', run: async () => { if (!state.dupRoots.length) await loadDupRoots(); return !!(await scanDuplicates()); } },
  { key: 'maint', label: 'Windows Automatic Maintenance', run: async () => !!(await runTask('Automatic maintenance', id => window.tidy.runExe(id, 'maintenance'))) },
  { key: 'refresh', label: 'Refresh dashboard', run: async () => { await loadSys(); return true; } }
];
function renderAllSteps(status = {}) {
  $('#all-steps').innerHTML = ALL_STEPS.map(s => { const st = status[s.key] || {}; return `<div class="step ${st.state || ''}">${esc(s.label)}<small>${st.secs != null ? st.secs + ' s' : st.reason ? esc(st.reason) : ''}</small></div>`; }).join('');
}
// winget is a per-user Appx and does not exist for the SYSTEM account (scheduled-task runs).
function isSystemAccount() { const u = String(state.info && state.info.user || ''); return /^(NT AUTHORITY\\)?SYSTEM$/i.test(u); }
const DOALL_TEXT = 'Do all the things?\n\nThis runs diagnostics, cleanup, Disk Cleanup, DISM/SFC/CHKDSK, Defender update + quick scan, Windows Update, driver updates, winget upgrades, a duplicate scan and Automatic Maintenance, one after another. Expect 30 to 90 minutes. Updates may require a restart afterwards.\n\nDuplicates are only reported, never deleted automatically.';

// Spec 5.3: shared step runner for "Do all the things" and unattended mode. `keys` are ALL_STEPS
// keys in the order to run; `onStatus(status)` is called after every state change. Returns counts.
async function runSteps(keys, onStatus) {
  const status = {}; state.allStatus = status; state.allStarted = new Date().toISOString(); state.allFinished = null;
  let done = 0, failed = 0, skipped = 0;
  const set = (s, st) => {
    status[s.key] = st;
    if (onStatus) { try { onStatus(status); } catch { /* rendering must never stop the run */ } }
    if (state.unattended && DESKTOP) { try { window.tidy.unattendedProgress({ key: s.key, state: st.state, secs: st.secs ?? null, reason: st.reason ?? null }); } catch { /* bridge missing */ } }
  };
  const btn = $('#btn-all');
  for (const key of keys) {
    const s = ALL_STEPS.find(x => x.key === key); if (!s) continue;
    let reason = null;
    if (state.allStop) reason = 'stop';
    else if (s.gate && gateDecision(s.gate)) reason = gateDecision(s.gate);        // 'license' | 'policy'
    else if (key === 'winget' && isSystemAccount()) reason = 'unavailable';
    if (reason) { set(s, { state: 'skipped', reason }); skipped++; log(`↷ ${s.label}: skipped (${reason})`); continue; }
    set(s, { state: 'running' }); $('#all-summary').textContent = `Running: ${s.label}`;
    const ts = Date.now(); let ok = false;
    try { ok = await s.run(); } catch (e) { log(`✖ ${s.label}: ${e.message || e}`); }
    set(s, { state: ok ? 'done' : 'failed', secs: Math.round((Date.now() - ts) / 1000) }); ok ? done++ : failed++;
    setBusy(null); if (state.allRunning && !btn.dataset.locked) btn.disabled = false;
  }
  state.allFinished = new Date().toISOString();
  return { status, done, failed, skipped };
}
async function doAllTheThings() {
  if (state.allRunning) return;
  if (edition() === 'evaluation') { log('License required for Do all the things — analysis and checks work in evaluation; cleaning, repairs and installs need a license.'); if (!state.unattended) showTab('license'); return; }
  if (gateDecision('do-all') === 'policy') { log('Disabled by policy (do-all).'); return; }
  if (!ask(DOALL_TEXT)) return;
  state.allRunning = true; state.allStop = false; state.allReboot = false;
  const card = $('#all-card'); card.hidden = false; applyIcons(card); renderAllSteps({});
  const btn = $('#btn-all');
  btn.textContent = ''; btn.insertAdjacentHTML('afterbegin', icon('stop') + 'Stop after current step'); btn.classList.add('danger'); btn.dataset.keepDisabled = '0'; btn.disabled = false;
  btn.onclick = () => { state.allStop = true; log('Will stop after the current step.'); };
  const t0 = Date.now();
  const r = await runSteps(ALL_STEPS.map(s => s.key), renderAllSteps);
  const mins = Math.round((Date.now() - t0) / 60000);
  $('#all-summary').innerHTML = `Finished in ${mins} min: ${r.done} steps done, ${r.failed} failed${r.skipped ? `, ${r.skipped} skipped` : ''}${state.allStop ? ', stopped early' : ''}.` +
    (state.lastClean ? ` Freed ${fmtBytes(state.lastClean.totalFreed)}.` : '') + (state.dup ? ` ${fmtBytes(state.dup.wasted)} in duplicates (see Duplicates tab).` : '') +
    (state.allReboot ? ' <span class="warn">A restart is required to finish installing updates.</span>' : '');
  log(`Do all the things: complete (${r.done} ok, ${r.failed} failed, ${r.skipped} skipped).`);
  state.allRunning = false;
  btn.textContent = ''; btn.insertAdjacentHTML('afterbegin', icon('rocket') + 'Do all the things'); btn.classList.remove('danger'); btn.onclick = doAllTheThings;
  showTab('dashboard');
  await sendReportToDir('manual');   // enterprise + report dir configured; no-op otherwise
}
$('#btn-all').onclick = doAllTheThings;

// Spec 5.3: entry point for enterprise/unattended.js (executeJavaScript in a hidden window).
// opts = { steps: string[], profile: string, policy: effective policy data }.
async function runUnattended(opts = {}) {
  state.unattended = true; state.allReboot = false; state.allStop = false;
  if (opts.policy && typeof opts.policy === 'object') state.policy = opts.policy;
  const wanted = Array.isArray(opts.steps) && opts.steps.length ? opts.steps : ALL_STEPS.map(s => s.key);
  const keys = wanted.filter(k => ALL_STEPS.some(s => s.key === k));
  log(`Unattended run (${opts.profile || 'custom'}): ${keys.join(', ')}`);
  const card = $('#all-card'); card.hidden = false; renderAllSteps({});
  state.allRunning = true;
  let r;
  try { r = await runSteps(keys, renderAllSteps); } finally { state.allRunning = false; }
  log(`Unattended run: ${r.done} ok, ${r.failed} failed, ${r.skipped} skipped${state.allReboot ? ', reboot required' : ''}.`);
  return { ...r, rebootRequired: !!state.allReboot, markdown: buildReport(), json: buildReportJson(opts.profile || 'unattended') };
}

// ---------------------------------------------------------------- quick maintenance + report
$('#btn-quick').onclick = async () => {
  if (edition() === 'evaluation') { log('License required for Quick maintenance — basic cleaning remains free.'); showTab('license'); return; }
  if (gateDecision('quick') === 'policy') { log('Disabled by policy (quick).'); return; }
  if (!state.cats.length) await loadCategories();
  showTab('cleaner');
  await analyze();
  const ids = state.cats.filter(c => c.on && !c.special).map(c => c.id);
  await clean(ids);
  await runTask('Defender signature update', id => window.tidy.runPs(id, 'defender.ps1', ['-Action', 'Update']));
  showTab('health');
  await runTask('DISM ScanHealth', id => window.tidy.runExe(id, 'dism-scan'));
  showTab('updates');
  await refreshWinget();
  showTab('dashboard'); await loadSys();
  log('Quick maintenance complete.');
};

// Spec 5.4: the Markdown report. The edition/licensing line follows the NodeMend title,
// then the product line.
function buildReport() {
  const s = state.sys, d = state.diag, L = [];
  const lic = state.lic || {}, l = lic.license || null, pd = policyData(), info = state.info || {};
  const ed = lic.edition || 'evaluation', brand = ed === 'enterprise' && hasFeature('brand') && l && l.brand ? l.brand : null;
  L.push(`# NodeMend maintenance report — ${new Date().toLocaleString()}`);
  if (brand && brand.name) L.push(`Prepared by ${brand.name} for ${info.hostname || 'this PC'}`);
  else if (l) L.push(`Licensed to ${l.licensee} (${l.id})`);
  else L.push('Free copy of NodeMend — cleaning included');
  L.push(`${lic.productName || 'NodeMend'} v${info.version || ''} on ${info.hostname || '?'} as ${info.user || '?'}${info.elevated ? ' (administrator)' : ''}`, '');
  if (s) {
    L.push('## System', `- ${s.os} ${s.displayVersion || ''} build ${s.build} on ${s.model}`, `- CPU: ${s.cpu} · GPU: ${s.gpu}`, `- RAM: ${fmtBytes(s.ramTotal - s.ramFree)} used of ${fmtBytes(s.ramTotal)}`, `- Uptime: ${s.uptimeHours} h · Reboot pending: ${s.pendingReboot ? 'YES' : 'no'}`);
    for (const v of s.volumes) L.push(`- ${v.letter}: ${fmtBytes(v.free)} free of ${fmtBytes(v.size)} (${v.health})`);
    for (const k of s.disks) L.push(`- Disk ${k.name}: ${k.health}, ${k.temp ?? '?'} °C, wear ${k.wear ?? '?'} %`);
    if (s.defender) L.push(`- Defender: real-time ${s.defender.realtime ? 'on' : 'OFF'}, signatures ${s.defender.sigVersion} (${s.defender.sigAgeDays} d), last hotfix ${s.lastHotfix}`, '');
  }
  const steps = ALL_STEPS.filter(x => state.allStatus[x.key]);
  if (steps.length) { L.push('## Steps'); for (const x of steps) { const st = state.allStatus[x.key]; L.push(`- ${x.label}: ${st.state}${st.secs != null ? ` (${st.secs} s)` : ''}${st.reason ? ` — ${st.reason}` : ''}`); } L.push(''); }
  if (state.lastClean) { L.push('## Cleanup', `- Freed ${fmtBytes(state.lastClean.totalFreed)} (C: ${fmtBytes(state.lastClean.freeBefore)} → ${fmtBytes(state.lastClean.freeAfter)})`); for (const r of state.lastClean.results) { const c = state.cats.find(k => k.id === r.id); L.push(`  - ${c ? c.name : r.id}: ${fmtBytes(r.freed)}, ${r.deleted} files, ${r.skipped} skipped`); } L.push(''); }
  if (d) {
    L.push('## Diagnostics', `- ${d.errorCount} error/critical events in ${d.days} days`);
    for (const b of d.bySource) L.push(`  - ${b.source}: ${b.count}`);
    L.push(`- Unexpected shutdowns/bugchecks (30 d): ${d.crashes.length}`, `- Automatic services not running: ${d.stoppedAutoServices.map(x => x.name).join(', ') || 'none'}`, `- SMART: ${d.smart.some(x => x.predictFailure) ? 'FAILURE PREDICTED' : 'ok'}`, '');
  }
  if (state.winget.length) { L.push('## App updates available (winget)'); for (const i of state.winget) L.push(`- ${i.name} ${i.version} → ${i.available}`); L.push(''); }
  if (state.programs) { L.push('## Installed programs', `- ${state.programs.filter(p => p.kind !== 'appx').length} classic programs, ${state.programs.filter(p => p.kind === 'appx').length} Store apps`, ''); }
  if (state.drivers) { L.push('## Drivers', `- ${state.drivers.drivers.length} driver update(s) offered by Microsoft Update`, ...state.drivers.drivers.map(u => `  - ${u.title}`), `- Devices with problems: ${state.drivers.problemDevices.map(p => p.name + ' (' + p.problem + ')').join(', ') || 'none'}`, ''); }
  if (state.dup) { L.push('## Duplicate files', `- ${state.dup.groups.length} groups, ${fmtBytes(state.dup.wasted)} recoverable, scanned ${state.dup.filesScanned} files in: ${state.dupRoots.join('; ')}`, ...state.dup.groups.slice(0, 30).map(g => `  - ${fmtBytes(g.size)} x ${g.files.length}: ${g.files.map(f => f.path).join(' | ')}`), ''); }
  if (state.wu) { L.push('## Windows Update', state.wu.updates.length ? state.wu.updates.map(u => `- ${u.title}`).join('\n') : '- No pending updates', ''); }
  if (ed === 'enterprise' && ((brand && brand.support) || pd.supportText)) { L.push('## Support'); if (brand && brand.support) L.push(`- ${brand.support}`); if (pd.supportText) L.push(`- ${pd.supportText}`); L.push(''); }
  L.push('## Activity log', '```', logEl.textContent.trim(), '```');
  if (ed === 'evaluation') L.push('', '---', 'Generated by NodeMend Free');
  return L.join('\n');
}
// Spec 5.4: machine-readable report, schema 1. exitCode is filled in by main in unattended mode.
function buildReportJson(profile) {
  const s = state.sys, d = state.diag, lic = state.lic || {}, l = lic.license || {}, info = state.info || {}, st = state.allStatus || {};
  const started = state.allStarted || null, finished = state.allFinished || new Date().toISOString();
  const names = a => (a || []).map(x => x.name);
  return {
    schema: 1, host: info.hostname || null, domain: info.domain || null, user: info.user || null, elevated: !!info.elevated,
    mode: state.unattended ? 'unattended' : 'gui', profile: profile || 'manual',
    started, finished, durationSec: started ? Math.max(0, Math.round((Date.parse(finished) - Date.parse(started)) / 1000)) : null, exitCode: null, rebootRequired: !!state.allReboot,
    app: { version: info.version || null, build: lic.build || null, edition: lic.edition || 'evaluation', licenseId: l.id || null, licensee: l.licensee || null, brand: l.brand || null },
    steps: ALL_STEPS.filter(x => st[x.key]).map(x => ({ key: x.key, label: x.label, state: st[x.key].state, secs: st[x.key].secs ?? null, reason: st[x.key].reason ?? null })),
    sys: s ? { os: s.os, build: s.build, displayVersion: s.displayVersion || null, model: s.model, ramTotal: s.ramTotal, ramFree: s.ramFree, uptimeHours: s.uptimeHours, pendingReboot: !!s.pendingReboot, lastHotfix: s.lastHotfix || null, volumes: s.volumes, disks: s.disks, defender: s.defender || null } : null,
    clean: state.lastClean ? { totalFreed: state.lastClean.totalFreed, freeBefore: state.lastClean.freeBefore, freeAfter: state.lastClean.freeAfter, results: state.lastClean.results } : null,
    diag: d ? { errorCount: d.errorCount, crashes: d.crashes.length, appCrashes: d.appCrashes.length, smartFailure: d.smart.some(x => x.predictFailure), pendingReboot: !!d.pendingReboot, stoppedAutoServices: names(d.stoppedAutoServices) } : null,
    wu: state.wu ? { pending: (state.wu.updates || []).length, titles: (state.wu.updates || []).map(u => u.title), rebootRequired: !!state.wu.rebootRequired } : null,
    drivers: state.drivers ? { offered: state.drivers.drivers.length, titles: state.drivers.drivers.map(u => u.title), problemDevices: names(state.drivers.problemDevices) } : null,
    winget: { available: state.winget.length, items: state.winget.map(i => ({ id: i.id, version: i.version, available: i.available })) },
    dup: state.dup ? { groups: state.dup.groups.length, wasted: state.dup.wasted, filesScanned: state.dup.filesScanned } : null,
    log: logEl.textContent.split('\n').filter(Boolean)
  };
}
// Enterprise + report feature + a configured report directory: hand the pair to main (report:send),
// which writes the local copy, the share and, on failure, the outbox. Silent no-op otherwise.
async function sendReportToDir(profile) {
  if (!DESKTOP || edition() !== 'enterprise' || !hasFeature('report') || !(state.lic.paths && state.lic.paths.reportDir)) return null;
  try {
    const r = await window.tidy.reportSend({ json: buildReportJson(profile), md: buildReport(), profile });
    if (r.queued) log(`Report queued (report directory unreachable${r.error ? ': ' + r.error : ''}).`);
    else log(`Report sent to ${r.dir || state.lic.paths.reportDir}`);
    return r;
  } catch (e) { gateFailure('Send report', e); return null; }
}
$('#btn-report').onclick = async () => {
  if (!DESKTOP) return notify('Reports are saved through the desktop app.');
  const p = await window.tidy.saveText({ defaultName: `NodeMend-report-${new Date().toISOString().slice(0, 10)}.md`, text: buildReport() });
  if (p) log('Report saved to ' + p);
  await sendReportToDir('manual');
};
$('#btn-report-json').onclick = async () => {
  if (!DESKTOP) return;
  const p = await window.tidy.saveText({ defaultName: `NodeMend-report-${new Date().toISOString().slice(0, 10)}.json`, text: JSON.stringify(buildReportJson('manual'), null, 2) });
  if (p) log('Report JSON saved to ' + p);
};

// ---------------------------------------------------------------- licensing (spec 4, 6.3, 9)
// The renderer never enforces anything: main.js's guard() does. What lives here is the cosmetic
// mirror of lib/gate (which buttons to lock, which steps to skip) and the License tab.
const LICENSE_GATED = ['advanced-clean', 'cleanmgr', 'dism-restore', 'dism-cleanup', 'sfc', 'wu-install', 'drivers-install', 'winget-upgrade', 'uninstall', 'startup-toggle', 'dup-trash', 'defender', 'maintenance', 'recovery', 'disk-analyze', 'privacy', 'performance', 'smart-clean'];
const FILE_SOURCES = ['exe', 'programdata', 'userdata'];
const STATUS_TEXT = { valid: 'valid', none: 'not set', missing: 'no file', expired: 'expired', maint: 'newer than maintenance period', signature: 'signature invalid', payload: 'unreadable payload', format: 'not a NodeMend key', timeout: 'unreachable (timed out)' };
function edition() { return state.lic ? state.lic.edition : 'evaluation'; }
function hasFeature(f) { return !!(state.lic && Array.isArray(state.lic.features) && state.lic.features.includes(f)); }
function policyData() { return state.policy || {}; }
function policyEnforced() { return edition() === 'enterprise' && hasFeature('policy'); }
// Mirror of lib/gate decide(): 'license' | 'policy' | null. Before license:state arrives nothing is locked.
function gateDecision(action) {
  if (!state.lic) return null;
  if ((state.lic.paidActions || LICENSE_GATED).includes(action) && state.lic.edition === 'evaluation') return 'license';
  if (policyEnforced() && (policyData().disable || []).includes(action)) return 'policy';
  return null;
}
function daysUntil(ymd) { return Math.ceil((Date.parse(ymd + 'T00:00:00') - Date.now()) / 86400000); }
function editionLabel(ed) { return ed === 'enterprise' ? 'full build' : ed === 'solo' ? 'Solo build' : 'starting'; }
function orgName() { const lic = state.lic || {}, l = lic.license || {}; return (hasFeature('brand') && l.brand && l.brand.name) || policyData().orgName || l.licensee || ''; }

// Everything that changes with the license: sidebar badge/org line, banners, gated buttons, policy effects, License tab.
function applyLicense(lic) {
  if (!lic) return;
  state.lic = lic;
  const p = lic.policy;
  state.policy = p && p.ok && p.enforced && p.data ? p.data : {};
  const l = lic.license, info = state.info || {};
  // sidebar
  const badge = $('#lic-badge');
  // Free and open source: no key is needed. An optional organisation key only adds a name here.
  const who = l ? ((hasFeature('brand') && l.brand && l.brand.name) || l.licensee) : '';
  badge.textContent = who || 'Free · open source'; badge.className = 'badge ' + (who ? 'ent' : 'ok');
  const org = $('.brand-org'); const on = lic.licensed && orgName(); org.textContent = on || ''; org.hidden = !on;
  $('#version').textContent = `${lic.productName || 'NodeMend'} v${lic.version || info.version || ''} · Electron ${info.electron || ''}`;
  // banner (spec 9)
  const b = $('#lic-banner'), bt = $('#lic-banner-text'), enter = $('#btn-lic-banner');
  // Nothing is sold or locked any more, so there is no licence banner. The element stays for layout.
  b.hidden = true; bt.textContent = ''; b.className = 'banner warn'; enter.hidden = true;
  // enterprise-only DOM (present in both builds; shown only in Enterprise builds)
  $$('[data-edition="enterprise"]').forEach(e => { e.hidden = lic.build !== 'enterprise'; });
  $('#btn-report-json').hidden = lic.edition !== 'enterprise';
  applyPolicy();
  renderLicenseTab();
}

// Spec 6.3 renderer effects. Everything here is cosmetic; main.js refuses the same actions.
function applyPolicy() {
  const pd = policyData(), enforced = policyEnforced();
  const hide = edition() === 'evaluation' ? Object.keys(TITLES).filter(t => !['dashboard', 'cleaner', 'license'].includes(t)) : (enforced && Array.isArray(pd.hideTabs) ? pd.hideTabs.filter(t => t !== 'dashboard' && t !== 'license') : []);
  $('#btn-quick').hidden = $('#btn-all').hidden = $('#btn-report').hidden = edition() === 'evaluation';
  state.hiddenTabs = hide;
  $$('.nav-btn').forEach(b => { b.hidden = hide.includes(b.dataset.tab); });
  $$('.tab').forEach(t => { t.hidden = hide.includes(t.id.replace(/^tab-/, '')); });
  const cur = $('.nav-btn.active'); if (cur && hide.includes(cur.dataset.tab)) showTab('dashboard');
  applyGatedButtons();
  if (enforced && pd.defaults && pd.defaults.dupMinSize) {
    const sel = $('#dup-min'), v = String(pd.defaults.dupMinSize);
    if (!$$('option', sel).some(o => o.value === v)) sel.appendChild(el(`<option value="${esc(v)}">${fmtBytes(+v)}</option>`));
    sel.value = v;
  }
  const mb = $('#managed-banner');
  if (enforced && (pd.orgName || pd.supportText)) { mb.textContent = `Managed by ${pd.orgName || 'your organization'} — some features are controlled by policy. ${pd.supportText || ''}`.trim(); mb.hidden = false; }
  else mb.hidden = true;
  if (state.cats.length) loadCategories();  // on/off/locked come from main; re-render with the current policy
}
// Buttons carrying data-action="<gate token>": policy-denied ones are disabled and stay disabled
// through setBusy(); license-gated ones stay enabled (the click runs into guard() -> License tab).
function applyGatedButtons(root = document) {
  $$('[data-action]', root).forEach(b => {
    const d = gateDecision(b.dataset.action);
    if (d === 'policy') {
      if (!b.dataset.locked) { if (b.title) b.dataset.titleOrig = b.title; b.dataset.locked = 'policy'; }
      b.title = 'Disabled by policy'; b.disabled = true;
    } else if (b.dataset.locked) {
      delete b.dataset.locked;
      if (b.dataset.titleOrig) { b.title = b.dataset.titleOrig; delete b.dataset.titleOrig; } else b.removeAttribute('title');
      b.disabled = !!state.busy || b.dataset.keepDisabled === '1';
    }
  });
}

function renderLicenseTab() {
  const lic = state.lic; if (!lic) return;
  const l = lic.license, pd = policyData(), info = state.info || {};
  // 1. status card
  const chip = `<span class="chip ok">${icon('check')} Free and open source · every feature unlocked</span>`;
  const rows = [];
  if (l) {
    rows.push(['Licensee', esc(l.licensee) + (l.email ? ` <span class="muted small">${esc(l.email)}</span>` : '')], ['License id', `<span class="mono">${esc(l.id)}</span>`],
      ['Seats', lic.edition === 'enterprise' ? `${l.seats} seats${lic.seats.recorded != null ? `, ${lic.seats.recorded} activations recorded` : ''}` : `${l.seats} seat${l.seats === 1 ? '' : 's'}`],
      ['Issued', esc(l.issued)], ['Expires', l.expires ? esc(l.expires) + (daysUntil(l.expires) <= 30 ? ` <span class="warn">(in ${daysUntil(l.expires)} days)</span>` : '') : 'never (perpetual)'],
      ['Maintenance until', l.maint ? esc(l.maint) : 'no limit'],
      ['Features', lic.edition === 'enterprise' ? (lic.features.length ? lic.features.map(f => `<span class="chip ok">${esc(f)}</span>`).join(' ') : '<span class="muted">none</span>') : '<span class="muted">—</span>'],
      ['Source', `<span class="mono">${esc(l.source)}${l.path ? ' · ' + esc(l.path) : ''}</span>`]);
  } else {
    rows.push(['Organisation key', 'none installed, and none is needed']);
    if (lic.statusOf && lic.statusOf.path) rows.push(['Key found at', `<span class="mono">${esc(lic.statusOf.path)}</span> <span class="muted small">${esc(STATUS_TEXT[lic.status] || lic.status)}; ignored</span>`]);
  }
  rows.push(['Build', `${esc(lic.productName)} v${esc(lic.version || info.version || '')}${lic.builtAt ? ` <span class="muted small">built ${esc(lic.builtAt)}</span>` : ''}`]);
  if (lic.warnings.length) rows.push(['Warnings', lic.warnings.map(w => `<span class="chip warn">${esc(w)}</span>`).join(' ')]);
  $('#lic-status-body').innerHTML = `<div style="margin-bottom:10px">${chip}</div><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  // 2. candidates
  $('#lic-candidates-body').innerHTML = table([
    { label: 'Source', key: 'source', cls: 'mono' },
    { label: 'Path', render: c => `<span class="mono">${esc(c.path || (c.inline ? '(inline token)' : '—'))}</span>`, cls: 'mono' },
    { label: 'Found', render: c => c.found ? '<span class="ok">yes</span>' : '<span class="muted">no</span>' },
    { label: 'Status', render: c => `<span class="${c.status === 'valid' ? 'ok' : c.found ? 'bad' : 'muted'}">${esc(STATUS_TEXT[c.status] || c.status)}</span>${c.ignored ? ' <span class="muted small">(ignored by policy)</span>' : ''}${c.edition ? ` <span class="muted small">${esc(c.edition)}${c.id ? ' ' + esc(c.id) : ''}</span>` : ''}` }
  ], lic.candidates || []);
  // 3. activate card (hidden when the panel is locked or user-license is policy-disabled)
  const managed = policyEnforced() && (pd.lockLicensePanel === true || gateDecision('user-license') === 'policy');
  $('#lic-activate').hidden = managed; $('#lic-managed').hidden = !managed;
  const t = lic.targets || {};
  const radio = v => $(`input[name=lic-scope][value=${v}]`);
  radio('exe').disabled = !t.exe; $('#lic-scope-exe-hint').textContent = t.exe || 'not available';
  radio('machine').disabled = !t.machine || !lic.elevated; $('#lic-scope-machine-hint').textContent = (t.machine || '') + (!lic.elevated ? ' — needs administrator' : '');
  radio('user').disabled = !t.user; $('#lic-scope-user-hint').textContent = t.user || '';
  if (!$$('input[name=lic-scope]').some(r => r.checked && !r.disabled)) { const d = radio(t.default || 'user'); if (d && !d.disabled) d.checked = true; else radio('user').checked = true; }
  $('#btn-lic-remove').hidden = !(l && FILE_SOURCES.includes(l.source));
  // 4. enterprise card
  const ent = $('#lic-enterprise');
  if (!ent.hidden) {
    const isEnt = lic.edition === 'enterprise';
    $('#lic-ent-locked').hidden = isEnt; $('#lic-ent-body').hidden = !isEnt;
    applyIcons(ent);
    if (isEnt) renderPolicyCard();
  }
}
function renderPolicyCard() {
  const lic = state.lic, p = lic.policy, pd = policyData();
  if (!p) { $('#lic-policy-body').innerHTML = `<div class="muted">No policy file found.</div><div class="muted small">Looked for --policy, NODEMEND_POLICY (legacy TIDYWIN_POLICY), ${esc(lic.paths.dataDir || '')}\\NodeMend.policy.json (legacy TidyWin.policy.json accepted) and ${esc(lic.paths.exeDir || '')}\\NodeMend.policy.json (legacy TidyWin.policy.json accepted).</div>`; return; }
  const chips = (label, arr) => arr && arr.length ? `<div class="lic-chip-row"><span class="muted small">${label}:</span>${arr.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : '';
  const locked = pd.cleaner && pd.cleaner.lock ? state.cats.filter(c => c.locked).map(c => c.name) : [];
  $('#lic-policy-body').innerHTML = `<dl class="kv"><dt>File</dt><dd class="mono">${esc(p.path)}</dd><dt>Source</dt><dd>${esc(p.source)}</dd>
    <dt>Status</dt><dd>${p.ok ? (p.enforced ? '<span class="ok">valid, enforced</span>' : '<span class="warn">valid, not enforced (license lacks the policy feature)</span>') : `<span class="bad">invalid: ${esc(p.error || 'unknown error')}</span>`}</dd></dl>
    ${chips('Hidden tabs', pd.hideTabs)}${chips('Disabled', pd.disable)}${pd.cleaner && pd.cleaner.lock ? chips('Locked categories', locked.length ? locked : ['all (open the Cleaner tab to list them)']) : ''}
    ${pd.unattended ? `<div class="muted small">Unattended: ${pd.unattended.allow === false ? 'not allowed' : 'allowed'}${pd.unattended.profile ? ', profile ' + esc(pd.unattended.profile) : ''}${pd.unattended.timeoutMin ? ', timeout ' + pd.unattended.timeoutMin + ' min' : ''}${pd.unattended.requireElevation ? ', elevation required' : ''}</div>` : ''}`;
}
// Enterprise sub-sections that need IPC (report status, audit tail, schedule status). Each call
// is independent and tolerant: a missing feature rejects with LICENSE_REQUIRED, shown inline.
async function refreshEnterprise() {
  const lic = state.lic; if (!DESKTOP || !lic || lic.build !== 'enterprise') return;
  if (lic.edition !== 'enterprise') return;
  const errText = e => /LICENSE_REQUIRED/.test(String(e && e.message)) ? 'not included in this license' : String(e && e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '');
  // reporting
  try {
    const st = await window.tidy.reportStatus();
    const seats = lic.license ? lic.license.seats : null;
    $('#lic-report-body').innerHTML = `<dl class="kv"><dt>Directory</dt><dd class="mono">${st.dir ? esc(st.dir) + ` <span class="muted small">(${esc(st.source)})</span>` : '<span class="muted">not configured</span>'}</dd>
      <dt>State</dt><dd>${!st.configured ? '<span class="muted">reports are kept locally only</span>' : st.reachable ? '<span class="ok">reachable</span>' : '<span class="bad">unreachable</span>'}</dd>
      <dt>Last sent</dt><dd>${st.lastSent ? esc(fmtDate(st.lastSent)) : '—'}</dd><dt>Outbox</dt><dd>${st.outboxCount ? `<span class="warn">${st.outboxCount} file(s) waiting</span>` : 'empty'}</dd>
      <dt>Activations</dt><dd>${st.activations != null ? `${st.activations} of ${seats ?? '?'} seats` : '—'}</dd>
      <dt>Local copies</dt><dd class="mono">${esc(st.localDir || lic.paths.localReportDir || '')}</dd></dl>`;
    const edit = $('#lic-report-edit'); edit.hidden = !!st.fixed;
    if (!st.fixed) { const s = await window.tidy.settingsGet().catch(() => ({})); $('#lic-report-dir').value = s.reportDir || ''; }
    $('#btn-report-open').disabled = !st.configured;
  } catch (e) { $('#lic-report-body').innerHTML = `<span class="muted">${esc(errText(e))}</span>`; $('#lic-report-edit').hidden = true; }
  // audit
  try {
    const a = await window.tidy.auditTail();
    $('#lic-audit-path').textContent = a.path || a.dir || lic.paths.auditDir || '';
    $('#lic-audit-tail').textContent = a.lines && a.lines.length ? a.lines.slice(-20).join('\n') : '(no audit entries yet)';
  } catch (e) { $('#lic-audit-path').textContent = lic.paths.auditDir || ''; $('#lic-audit-tail').textContent = errText(e); }
  // unattended
  const u = lic.unattended || {};
  $('#lic-cmdline').textContent = u.commandLine || '—';
  $('#lic-exit-legend').innerHTML = u.exitLegend ? 'Exit codes: ' + Object.entries(u.exitLegend).map(([k, v]) => `<b>${esc(k)}</b> ${esc(v)}`).join(' · ') : '';
  await refreshSchedule();
}
async function refreshSchedule() {
  try {
    const s = await window.tidy.schedule('status');
    $('#lic-sched-status').innerHTML = s.installed ? `<span class="ok">Task "${esc(s.name)}" installed</span> — ${esc(s.state || '')}${s.nextRunTime ? ', next run ' + esc(fmtDate(s.nextRunTime)) : ''}${s.lastResult != null ? ', last result ' + esc(s.lastResult) : ''}` : `<span class="muted">No scheduled task installed${s.error ? ' (' + esc(s.error) + ')' : ''}</span>`;
    const eligibility = state.lic && state.lic.unattended && state.lic.unattended.schedule;
    if (eligibility && !eligibility.allowed) $('#lic-sched-status').textContent += ' ' + eligibility.reason;
    $('#btn-sched-install').disabled = !!s.installed || !!(eligibility && !eligibility.allowed); $('#btn-sched-remove').disabled = !s.installed;
  } catch (e) { $('#lic-sched-status').textContent = /LICENSE_REQUIRED/.test(String(e && e.message)) ? 'Scheduling is not included in this license.' : String(e && e.message || e); $('#btn-sched-install').disabled = $('#btn-sched-remove').disabled = true; }
}
async function reloadLicense() {
  if (!DESKTOP) return;
  try { applyLicense(await window.tidy.licenseReload()); log(`License reloaded: ${editionLabel(edition())}${state.lic.license ? ' (' + state.lic.license.id + ')' : ''}.`); }
  catch (e) { log('License reload failed: ' + (e.message || e)); }
}
function describeCheck(r) {
  if (!r) return '';
  if (r.valid) { const p = r.payload; return `<span class="ok">${esc(p.edition)} key, ${p.seats} seat${p.seats === 1 ? '' : 's'}, ${esc(p.licensee)} — valid${p.expires ? ', expires ' + esc(p.expires) : ''}</span>` + (r.effective && r.effective.warnings.length ? ` <span class="warn small">${esc(r.effective.warnings.join(', '))}</span>` : ''); }
  const why = { format: 'This is not a NodeMend key (expected TIDYWIN1.<payload>.<signature>).', signature: 'The signature does not match — the key was altered or was not issued for this product.', payload: 'The key payload is not valid' + (r.detail ? ` (${esc(r.detail)})` : '') + '.', expired: `This key expired on ${r.payload ? esc(r.payload.expires) : '?'}.`, maint: 'This build is newer than the key\'s maintenance period.' };
  return `<span class="bad">${why[r.status] || esc(r.status)}</span>`;
}
async function activateLicense(scope) {
  const text = $('#lic-text').value;
  if (!text.trim()) { $('#lic-check-result').innerHTML = '<span class="warn">Paste a key first.</span>'; return; }
  scope = scope || ($$('input[name=lic-scope]').find(r => r.checked) || {}).value || 'user';
  let r;
  try { r = await window.tidy.licenseActivate({ text, scope }); }
  catch (e) { gateFailure('Activate license', e); $('#lic-check-result').innerHTML = `<span class="bad">${esc(String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, ''))}</span>`; return; }
  if (r.ok) {
    $('#lic-check-result').innerHTML = `<span class="ok">Activated — stored in ${esc(r.path)}</span>`;
    log(`License activated (${scope}): ${r.path}`);
    $('#lic-text').value = '';
    applyLicense(r.state || await window.tidy.licenseState());
    return;
  }
  if (r.fallback === 'user' && ask(`NodeMend cannot write the license to ${state.lic.targets[scope]} (${r.error}).\n\nStore it for your user account only instead?`)) return activateLicense('user');
  $('#lic-check-result').innerHTML = r.status !== 'valid' ? describeCheck({ status: r.status, detail: r.detail, payload: null }) : `<span class="bad">Could not write the license: ${esc(r.error || 'unknown error')}</span>`;
  log(`License not activated: ${r.status !== 'valid' ? r.status : r.error}`);
}
$('#lic-badge').onclick = () => showTab('license');
$('#btn-lic-banner').onclick = () => showTab('license');
$('#btn-lic-reload').onclick = reloadLicense;
$('#btn-lic-support').onclick = () => {
  const lic = state.lic || {}, l = lic.license || {}, info = state.info || {};
  const lines = [`Host: ${info.hostname || ''}`, `User: ${info.user || ''}`, `Version: ${lic.productName || 'NodeMend'} ${lic.version || info.version || ''}${lic.builtAt ? ' (built ' + lic.builtAt + ')' : ''}`, `Build: ${lic.build || ''}`, `Edition: ${lic.edition || ''}`, `License id: ${l.id || 'none'}`, `Source: ${l.source ? l.source + (l.path ? ' ' + l.path : '') : (lic.status || 'none')}`, `Elevated: ${lic.elevated ? 'yes' : 'no'}`];
  navigator.clipboard.writeText(lines.join('\n')); log('Support info copied to the clipboard.');
};
// Donate / source code: both open the project page, which decides where each one leads.
const openLink = key => { const links = (state.lic && state.lic.links) || {}; if (DESKTOP && links[key]) window.tidy.open(links[key]); };
$('#btn-about-donate').onclick = () => openLink('support');
$('#btn-about-source').onclick = () => openLink('source');
$('#btn-lic-open').onclick = async () => { const t = await window.tidy.openLicenseFile(); if (t != null) { $('#lic-text').value = t; $('#btn-lic-check').click(); } };
$('#btn-lic-check').onclick = async () => {
  const text = $('#lic-text').value; if (!text.trim()) { $('#lic-check-result').innerHTML = '<span class="warn">Paste a key first.</span>'; return; }
  try { $('#lic-check-result').innerHTML = describeCheck(await window.tidy.licenseCheck(text)); } catch (e) { $('#lic-check-result').innerHTML = `<span class="bad">${esc(e.message || e)}</span>`; }
};
$('#btn-lic-activate').onclick = () => activateLicense();
$('#btn-lic-remove').onclick = async () => {
  const l = state.lic && state.lic.license; if (!l) return;
  if (!ask(`Remove the organisation key ${l.id} stored at ${l.path}?\n\nNodeMend keeps every feature. Only the organisation name is removed.`)) return;
  try { const r = await window.tidy.licenseRemove(); if (r.ok) { log(`License removed from ${r.path}`); applyLicense(r.state || await window.tidy.licenseState()); } else log('License not removed: ' + r.error); }
  catch (e) { log('License not removed: ' + (e.message || e)); }
};
// enterprise card actions
$('#btn-policy-reload').onclick = async () => { try { const p = await window.tidy.policyReload(); log(p.found ? `Policy reloaded from ${p.path}: ${p.ok ? 'ok' : 'INVALID — ' + p.error}` : 'No policy file found.'); await reloadLicense(); } catch (e) { gateFailure('Reload policy', e); } };
$('#btn-report-send').onclick = async () => { const r = await sendReportToDir('manual'); if (!r && edition() === 'enterprise' && !(state.lic.paths && state.lic.paths.reportDir)) log('No report directory configured — set one below or in the policy.'); refreshEnterprise(); };
$('#btn-report-open').onclick = async () => { try { const r = await window.tidy.reportOpen(); if (!r.ok) log('Cannot open report folder: ' + (r.error || '')); } catch (e) { gateFailure('Open report folder', e); } };
$('#btn-report-dir-save').onclick = async () => { try { await window.tidy.settingsSet({ reportDir: $('#lic-report-dir').value.trim() }); log('Report directory saved.'); await reloadLicense(); } catch (e) { log('Could not save the report directory: ' + (e.message || e)); } };
$('#btn-audit-open').onclick = async () => { try { const r = await window.tidy.auditOpen(); if (!r.ok) log('Cannot open audit folder: ' + (r.error || '')); } catch (e) { gateFailure('Open audit folder', e); } };
$('#btn-cmd-copy').onclick = () => { navigator.clipboard.writeText($('#lic-cmdline').textContent); log('Command line copied to the clipboard.'); };
$('#btn-sched-install').onclick = async () => { if (!ask('Install the scheduled task "NodeMend Maintenance" (Sunday 03:00, runs as SYSTEM with the command line shown)?')) return; try { const r = await window.tidy.schedule('install'); log(r.ok ? 'Scheduled task installed.' : 'Task not installed: ' + (r.error || '')); } catch (e) { gateFailure('Install scheduled task', e); } refreshSchedule(); };
$('#btn-sched-remove').onclick = async () => { if (!ask('Remove the scheduled task "NodeMend Maintenance"?')) return; try { const r = await window.tidy.schedule('remove'); log(r.ok ? 'Scheduled task removed.' : 'Task not removed: ' + (r.error || '')); } catch (e) { gateFailure('Remove scheduled task', e); } refreshSchedule(); };

// ---------------------------------------------------------------- init
(async function init() {
  applyIcons();
  if (!DESKTOP) { $('#elev-badge').textContent = 'browser preview'; $('#elev-badge').className = 'badge warn'; $('#lic-badge').textContent = 'Free'; $('#lic-badge').className = 'badge warn'; log('Running outside Electron — desktop features disabled.'); return; }
  state.info = await window.tidy.info();
  $('#version').textContent = `v${state.info.version} · Electron ${state.info.electron}`;
  $('#elev-badge').textContent = state.info.elevated ? 'Administrator' : 'Standard user';
  $('#elev-badge').className = 'badge ' + (state.info.elevated ? 'ok' : 'warn');
  $('#elev-banner').hidden = state.info.elevated;
  $('#btn-elevate').onclick = () => window.tidy.relaunchElevated();
  try { applyLicense(state.info.lic || await window.tidy.licenseState()); } catch (e) { log('License state unavailable: ' + (e.message || e)); }
  window.tidy.onLicenseChanged(async () => { try { applyLicense(await window.tidy.licenseState()); if ($('#tab-license').classList.contains('active')) refreshEnterprise(); } catch { /* main will resend */ } });
  const lic = state.lic || {};
  log(`${lic.productName || 'NodeMend'} ready on ${state.info.hostname} as ${state.info.user}${state.info.elevated ? ' (elevated)' : ''} — ${editionLabel(lic.edition)}${lic.license ? ' licensed to ' + lic.license.licensee : ''}.`);
  setBusy(null);
  await loadSys();
  if (!state.cats.length) await loadCategories();
})();

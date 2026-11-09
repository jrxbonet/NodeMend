// Product extras. Each operation is enforced and confirmed in main, not by this UI.
(() => {
  let privacyPlan = null;
  const report = (selector, result) => { $(selector).textContent = JSON.stringify(result, null, 2); };
  const pick = async selector => { if (!DESKTOP) return; const result = await window.tidy.recoveryPickDestination(); if (result) $(selector).value = result; };
  async function engines() {
    if (!DESKTOP) return;
    try {
      const s = await window.tidy.recoveryStatus();
      $('#rec-engines').textContent = `PhotoRec: ${s.bundled.ok ? 'ready' : 'unavailable'} · Drive recovery GUI: ${s.gui.ok ? 'ready' : 'not included on this platform'} · Microsoft engine: ${s.windowsFileRecovery.ok ? 'ready' : 'not installed / not supported'}`;
      $('#rec-launch').hidden = !s.gui.ok;
      $('#rec-winfr').hidden = s.platform !== 'win32';
    } catch (e) { gateFailure('Recovery engine check', e); }
  }
  $('#rec-refresh').onclick = engines;
  $('#rec-launch').onclick = () => runTask('Open drive recovery', () => window.tidy.recoveryLaunch({}));
  $('#rec-pick-image').onclick = async () => { if (DESKTOP) { const p = await window.tidy.recoveryPickImage(); if (p) $('#rec-source').value = p; } };
  $('#rec-pick-destination').onclick = () => pick('#rec-destination');
  $('#rec-run').onclick = async () => {
    const sets = { photos: ['jpg', 'png'], documents: ['pdf', 'doc', 'docx'], all: ['jpg', 'png', 'pdf', 'doc', 'docx', 'zip'] };
    const r = await runTask('Recover from disk image', id => window.tidy.recoveryRun({ id, kind: 'image', source: $('#rec-source').value, destination: $('#rec-destination').value, fileTypes: sets[$('#rec-types').value] }));
    if (r) report('#rec-result', r);
  };
  $('#rec-winfr-run').onclick = async () => {
    const r = await runTask('Microsoft file recovery', id => window.tidy.recoveryRun({ id, kind: 'winfr', source: $('#rec-drive-source').value.trim(), destination: $('#rec-drive-destination').value.trim(), mode: $('#rec-mode').value, filters: $('#rec-filters').value.split(',').map(s => s.trim()).filter(Boolean) }));
    if (r) report('#rec-result', r);
  };
  $('#rec-store').onclick = () => DESKTOP && window.tidy.open('https://apps.microsoft.com/detail/9n26s50ln705');
  $('#disk-pick').onclick = () => pick('#disk-root');
  $('#cloud-pick').onclick = () => pick('#cloud-root');
  async function analyze(input, output) {
    const r = await runTask('Analyze storage', id => window.tidy.diskAnalyze({ id, root: $(input).value }));
    if (!r) return;
    $(output).innerHTML = `<p>${fmtBytes(r.totalSize)} · ${r.filesScanned} files${r.truncated ? ' · scan limit reached' : ''}${r.cancelled ? ' · cancelled' : ''}</p>` + table([{ key: 'path', label: 'Largest files' }, { label: 'Size', render: f => fmtBytes(f.size) }], r.largestFiles || []);
  }
  $('#disk-run').onclick = () => analyze('#disk-root', '#disk-results');
  $('#cloud-analyze').onclick = () => analyze('#cloud-root', '#cloud-results');
  $('#privacy-scan').onclick = async () => {
    const r = await runTask('Scan privacy data', () => window.tidy.privacyScan()); if (!r) return; privacyPlan = r;
    $('#privacy-results').innerHTML = (r.profiles || []).map(p => `<p><input type="checkbox" class="privacy-profile" data-id="${esc(p.id)}" checked> ${esc(p.browser)} · history ${p.history || 0} · tracker cookies ${p.trackerCookies || 0}</p>`).join('') + `<p class="hint">${esc((r.warnings || []).join(' · '))}</p>`;
    if (!r.engineAvailable) $('#privacy-results').textContent = 'SQLite privacy engine unavailable in this runtime.';
    else if (!r.profiles?.length) $('#privacy-results').appendChild(el('<p>No closed, supported browser profiles found.</p>'));
  };
  $('#privacy-clean').onclick = async () => {
    if (!privacyPlan) return notify('Scan closed browser profiles first.');
    const profiles = $$('.privacy-profile:checked').map(p => ({ id: p.dataset.id, history: true, trackerCookies: true }));
    const r = await runTask('Clear selected privacy data', () => window.tidy.privacyClean({ sessionId: privacyPlan.sessionId, profiles }));
    privacyPlan = null; if (r) report('#privacy-results', r);
  };
  async function performance() {
    if (!DESKTOP) return;
    try {
      const rows = await window.tidy.performanceList();
      $('#perf-results').innerHTML = rows.map(p => `<p>${esc(p.name)} · PID ${p.pid} <button class="perf-control" data-pid="${p.pid}" data-paused="${!!p.paused}">${p.paused ? 'Resume' : 'Pause'}</button></p>`).join('') || '<p class="hint">No supported optional apps found. Only your own Spotify, Discord and Steam processes qualify.</p>';
      $$('.perf-control').forEach(b => b.onclick = async () => { await runTask(b.dataset.paused === 'true' ? 'Resume app' : 'Pause app', () => b.dataset.paused === 'true' ? window.tidy.performanceResume(+b.dataset.pid) : window.tidy.performancePause(+b.dataset.pid)); performance(); });
    } catch (e) { gateFailure('Performance listing', e); }
  }
  $('#perf-refresh').onclick = performance;
  $('#perf-resume-all').removeAttribute('data-action');
  $('#perf-resume-all').onclick = async () => { await runTask('Resume paused apps', () => window.tidy.performanceResumeAll()); performance(); };
  const smartStatus = async () => { if (DESKTOP) { try { const s = await window.tidy.smartStatus(); $('#smart-status').textContent = s.enabled ? `Enabled every ${s.minutes} minutes while NodeMend is open.` : 'Off'; } catch (e) { gateFailure('Smart cleaning status', e); } } };
  $('#smart-enable').onclick = async () => {
    if (!ask('Enable automatic cleaning of default safe caches while NodeMend stays open? Recycle Bin and developer caches are excluded.')) return;
    const categories = state.cats.filter(c => c.on && !c.special && c.group !== 'Developer').map(c => c.id);
    await runTask('Enable automatic cleaning', () => window.tidy.smartConfigure({ enabled: true, minutes: +$('#smart-minutes').value, categories })); smartStatus();
  };
  $('#smart-disable').onclick = async () => { if (DESKTOP) { await window.tidy.smartConfigure({ enabled: false }); smartStatus(); } };
  for (const [id, url] of Object.entries({ 'vpn-proton': 'https://protonvpn.com/free-vpn', 'vpn-wireguard': 'https://protonvpn.com/support/wireguard-configurations', 'vpn-warp': 'https://one.one.one.one/' })) $(('#'+id)).onclick = () => DESKTOP && window.tidy.open(url);
  if (DESKTOP) window.tidy.info().then(info => {
    if (info.platform !== 'win32') {
      $$('.nav-btn').filter(b => ['updates', 'startup'].includes(b.dataset.tab)).forEach(b => b.hidden = true);
      $$('#tab-health button').filter(b => b.id !== 'btn-diag').forEach(b => b.hidden = true);
      $$('.exe, [data-open]').forEach(b => b.hidden = true);
      ['#btn-quick', '#btn-all', '#btn-cleanmgr', '#elev-banner', '#rec-winfr'].forEach(s => $(s).hidden = true);
      $('.nav-btn[data-tab="programs"]').textContent = 'Applications';
      new MutationObserver(() => $$('[data-action="uninstall"]').forEach(b => b.hidden = true)).observe($('#prog-body'), { childList: true, subtree: true });
    }
    engines(); smartStatus();
  });
})();

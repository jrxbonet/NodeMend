// Headless smoke test: loads the real renderer, exercises the bridge and pure helpers, then the
// licensing/policy/enterprise paths (spec 10.2) against an EPHEMERAL test keypair.
// Run: npm run smoke   (expects RESULT: PASS)
process.env.TIDYWIN_NO_WINDOW = '1';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os'); const fs = require('fs');
const { spawn } = require('child_process');

// ---- spec 10.2 setup, BEFORE main.js is required (it reads TIDYWIN_EDITION / TIDYWIN_DATA_DIR at load)
const F = require('./test/fixtures').make();
process.env.TIDYWIN_TEST_PUBKEY = F.pubHex;      // honored only when !app.isPackaged
process.env.TIDYWIN_EDITION = 'enterprise';
const TMP = path.join(os.tmpdir(), 'tidywin-smoke');
fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
process.env.TIDYWIN_DATA_DIR = path.join(TMP, 'pd');
app.setPath('userData', path.join(TMP, 'ud'));
delete process.env.TIDYWIN_LICENSE; delete process.env.TIDYWIN_POLICY;
const FX = F.writeAll(path.join(TMP, 'fx'));
const M = require('./main.js');
const { parseWingetTable, CATEGORIES } = M;
M.setLicenseForTest(F.tokens.solo); M.setPolicyForTest(null); // Exercise the full UI with a key fixture first, then with no key at all.
// UAC relaunch quoting (review finding: a --license path with a space was split by Start-Process)
const WQ = M.winQuote;
const winQuoteOk = WQ('plain') === 'plain' && WQ('C:\\Program Files\\x.lic') === '"C:\\Program Files\\x.lic"'
  && WQ('a"b') === '"a\\"b"' && WQ('C:\\dir\\') === 'C:\\dir\\' && WQ('C:\\My dir\\') === '"C:\\My dir\\\\"' && WQ('--license=C:\\My Keys\\k.lic') === '"--license=C:\\My Keys\\k.lic"';
const HOST = os.hostname();
const MONTH = new Date().toISOString().slice(0, 7);

const SAMPLE = `
   -
Name                              Id                          Version        Available      Source
--------------------------------------------------------------------------------------------------
7-Zip 26.02 (x64 edition)         7zip.7zip                   26.02.00.0     26.03          winget
Python 3.13.14 (64-bit)           Python.Python.3.13          3.13.14        3.13.15        winget
Python Launcher                   Python.Launcher             < 3.14.7       3.14.7         winget
3 upgrades available.

The following packages have an upgrade available, but require explicit targeting for upgrade:
Name           Id                   Version Available  Source
-------------------------------------------------------------
Android Studio Google.AndroidStudio 2026.1  2026.1.4.7 winget
`;

// fixture for the duplicate finder: 2 identical pairs (70000 B and 5000 B) + 2 same-size decoys
const DUP_FIXTURE = path.join(os.tmpdir(), 'tidywin-dup-fixture');
fs.rmSync(DUP_FIXTURE, { recursive: true, force: true }); fs.mkdirSync(path.join(DUP_FIXTURE, 'sub'), { recursive: true });
const big = Buffer.alloc(70000, 7), small = Buffer.from('x'.repeat(5000));
fs.writeFileSync(path.join(DUP_FIXTURE, 'a.bin'), big); fs.writeFileSync(path.join(DUP_FIXTURE, 'sub', 'a-copy.bin'), big);
fs.writeFileSync(path.join(DUP_FIXTURE, 'b.txt'), small); fs.writeFileSync(path.join(DUP_FIXTURE, 'sub', 'b-copy.txt'), small);
const decoy = Buffer.alloc(70000, 7); decoy[69999] = 8; fs.writeFileSync(path.join(DUP_FIXTURE, 'decoy-same-size.bin'), decoy);
fs.writeFileSync(path.join(DUP_FIXTURE, 'decoy-small.txt'), 'y'.repeat(5000));

const wait = ms => new Promise(r => setTimeout(r, ms));
const exists = p => { try { return fs.existsSync(p); } catch { return false; } };
const readText = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const readJson = p => { try { const t = readText(p); return JSON.parse(t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t); } catch { return null; } };
const listDir = p => { try { return fs.readdirSync(p); } catch { return []; } };

process.on('unhandledRejection', e => { console.log('RESULT: FAIL unhandled: ' + (e && e.stack || e)); app.exit(2); });
app.whenReady().then(async () => {
  const checks = {};
  console.log('S0 ready');
  const parsed = parseWingetTable(SAMPLE);
  console.log('S1 parsed', parsed.length);
  checks.wingetCount = parsed.length === 4;
  checks.wingetFields = parsed[0] && parsed[0].id === '7zip.7zip' && parsed[0].available === '26.03' && parsed[0].name.startsWith('7-Zip');
  checks.wingetExplicit = parsed[3] && parsed[3].id === 'Google.AndroidStudio' && parsed[3].explicit === true;
  checks.categoriesDefined = CATEGORIES.length > 15 && CATEGORIES.every(c => c.id && c.name && c.group);
  checks.winQuote = winQuoteOk;

  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2) console.log('[renderer]', msg); });
  console.log('S2 window');
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  console.log('S3 loaded');
  // wait until init() has loaded system info and categories (slow on a busy machine), max 90 s
  for (let i = 0; i < 90; i++) {
    const ready = await win.webContents.executeJavaScript('!!(state.sys && state.cats.length)');
    if (ready) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  const r = await win.webContents.executeJavaScript(`const DUP_FIXTURE = ${JSON.stringify(DUP_FIXTURE)}; (async function(){
    const c = {};
    c.bridge = !!window.tidy;
    c.info = !!(state.info && typeof state.info.elevated === 'boolean');
    c.sysLoaded = !!(state.sys && state.sys.volumes && state.sys.volumes.length > 0);
    c.sysRendered = document.querySelectorAll('#sys-cards .card').length >= 4;
    c.catsLoaded = state.cats.length > 15 && document.querySelectorAll('.catbox').length === state.cats.length;
    c.tabs = (showTab('health'), document.querySelector('#tab-health').classList.contains('active'));
    c.fmt = fmtBytes(1536) === '2 KB' && fmtBytes(3*1024*1024*1024) === '3.00 GB';
    c.startup = await (async () => { await loadStartup(); return Array.isArray(state.startup) && document.querySelectorAll('#startup-body tr').length > 1; })();
    c.report = buildReport().includes('# NodeMend maintenance report') && buildReport().includes('## System');
    c.scan = await (async () => { const s = await window.tidy.scan(); state.scan = s; return Array.isArray(s) && s.length === state.cats.length && s.every(x => typeof x.size === 'number'); })();
    // duplicate finder against a fixture folder with 2 identical pairs + decoys (same size, different bytes)
    c.dup = await (async () => { const r = await window.tidy.dupScan({ id: 'smoke-dup', roots: [DUP_FIXTURE], minSize: 1 }); state.dup = r; renderDup(r);
      return r.groups.length === 2 && r.groups.every(g => g.files.length === 2) && r.wasted === 70000 + 5000 && document.querySelectorAll('.dupbox').length === 4; })();
    c.dupRoots = await (async () => { await loadDupRoots(); return state.dupRoots.length > 0 && document.querySelectorAll('#dup-roots .chip').length === state.dupRoots.length; })();
    c.allSteps = ALL_STEPS.length >= 12 && (renderAllSteps({}), document.querySelectorAll('#all-steps .step').length === ALL_STEPS.length);
    c.tabDup = (showTab('duplicates'), document.querySelector('#tab-duplicates').classList.contains('active'));
    c.programs = await (async () => { await loadPrograms(); return Array.isArray(state.programs) && state.programs.length > 5 && document.querySelectorAll('#prog-body .prog-row').length > 0; })();
    c.progFilter = (function(){ const q = document.querySelector('#prog-filter'); q.value = 'zzzznomatch'; renderPrograms(); const none = document.querySelectorAll('#prog-body .prog-row').length === 0; q.value = ''; renderPrograms(); return none && document.querySelectorAll('#prog-body .prog-row').length > 0; })();
    c.tabProg = (showTab('programs'), document.querySelector('#tab-programs').classList.contains('active'));
    return c;
  })()`);
  Object.assign(checks, r);
  if (!r.sysLoaded) {
    console.log('DIAG sys-cards:', await win.webContents.executeJavaScript(`document.querySelector('#sys-cards').textContent.trim().slice(0, 400)`));
    console.log('DIAG log:', await win.webContents.executeJavaScript(`document.querySelector('#log').textContent.slice(0, 600)`));
  }

  // ================================================================ spec 10.2: licensing scenarios
  // Each hook call from Node is followed by a licenseReload in the page so the DOM reflects the new
  // state before asserting; applyLicense() is called directly instead of waiting for license:changed.
  const js = code => win.webContents.executeJavaScript(code);
  const reload = async () => { await js(`window.tidy.licenseReload().then(s => { applyLicense(s); return true; })`); await wait(1500); }; // loadCategories() re-renders async
  const page = code => js(`(async function(){ const rejects = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e && e.message || e)); } };
    const c = {}; ${code}; return c; })()`);
  const group = async (name, fn) => { try { Object.assign(checks, await fn()); } catch (e) { checks[name + 'Group'] = false; console.log(`DIAG ${name} group threw: ${e && e.stack || e}`); } };

  // ---- No key (free and open source): every feature is open, and nothing is sold or locked.
  // Nothing destructive is executed: only empty inputs go through the IPC layer, and the gate
  // itself is asked about every formerly paid action using the state main.js resolved.
  await group('open', async () => {
    const snapshot = () => exists(path.join(TMP, 'pd')) ? fs.readdirSync(path.join(TMP, 'pd'), { recursive: true }).sort().filter(name => !/^audit(\\|\/|$)/.test(name)).map(name => { const stat = fs.statSync(path.join(TMP, 'pd', name)); return [name, stat.size, stat.mtimeMs]; }) : [];
    const before = JSON.stringify(snapshot());
    await M.setLicenseForTest(null);
    await reload();
    const c = await page(`
      const s = await window.tidy.licenseState();
      c.openState = s.edition === 'enterprise' && s.licensed === false && s.license === null && s.warnings.length === 0
        && ['unattended', 'report', 'policy', 'audit'].every(f => s.features.includes(f));
      c.openBadge = document.querySelector('#lic-badge').textContent.includes('open source');
      const emptyClean = await window.tidy.clean([]);
      c.openClean = Array.isArray(emptyClean.results) && emptyClean.results.length === 0 && emptyClean.totalFreed === 0;
      c.openCategories = state.cats.some(cat => cat.id === 'wu-cache') && state.cats.length === (await window.tidy.categories()).length;
      c.openNavigation = !document.querySelector('[data-tab=health]').hidden && !document.querySelector('[data-tab=cleaner]').hidden
        && !document.querySelector('#btn-all').hidden && !document.querySelector('#btn-quick').hidden;
      c.openIpc = (await window.tidy.dupTrash([])).ok === 0 && await rejects(() => window.tidy.psJson('schedule.ps1', ['-Status']), /invalid script/);
      c.openNoBanner = document.querySelector('#lic-banner').hidden;
      c.openReadOnly = Array.isArray(await window.tidy.scan());
      c.openReport = !buildReport().includes('NodeMend Free');
      c.openAbout = (showTab('license'), document.querySelector('#tab-license').classList.contains('active')
        && !!document.querySelector('#btn-about-donate') && !!document.querySelector('#btn-about-source')
        && !!s.links && String(s.links.support).startsWith('https://namer-lavan.com/') && String(s.links.source).startsWith('https://namer-lavan.com/')
        && s.publisher === 'Namer-Lavan' && document.querySelectorAll('#lic-candidates tr').length >= 3);
    `);
    const st = M.getLicenseState(), GATE = require('./lib/gate');
    const ctxNow = { edition: st.edition, features: st.features, policy: {} };
    c.openGate = GATE.LICENSE_GATED.length >= 18 && GATE.LICENSE_GATED.every(a => GATE.decide(a, ctxNow) === null)
      && ['feature:unattended', 'feature:report', 'feature:policy', 'feature:audit'].every(a => GATE.decide(a, ctxNow) === null);
    c.openNoWrites = JSON.stringify(snapshot()) === before; // no key means no licence or activation state is written
    return c;
  });

  // ---- optional key: it adds a name, and can neither unlock nor restrict anything
  await group('solo', async () => {
    await M.setLicenseForTest(F.tokens.solo); await reload();
    const c = await page(`
      const s = await window.tidy.licenseState();
      c.soloState = s.edition === 'enterprise' && s.licensed === true && !!(s.license && s.license.id);
      c.soloGateOpen = (await window.tidy.dupTrash([])).ok === 0;
      const ent = document.querySelector('#lic-enterprise');
      c.soloEntOpen = !ent.hidden && document.querySelector('#lic-ent-locked').hidden && !document.querySelector('#lic-ent-body').hidden;
      c.soloNoWarn = s.warnings.length === 0;
      c.soloTitle = buildReport().includes('Licensed to');
    `);
    await M.setPolicyForTest({ disable: ['dup-trash'] }); await reload();
    // Policy is an admin feature that is now always available, so it applies whatever key is present.
    Object.assign(c, await page(`c.soloPolicyApplies = await rejects(() => window.tidy.dupTrash([]), /POLICY_DENIED:dup-trash/);`));
    return c;
  });

  // ---- enterprise: brand, policy effects (hide/disable/lock), audit, reports, outbox
  await group('enterprise', async () => {
    const locked = { ...F.policies.locked, reportDir: path.join(TMP, 'reports') };
    await M.setLicenseForTest(F.tokens.ent); await M.setPolicyForTest(locked); await reload();
    const c = await page(`
      const s = await window.tidy.licenseState();
      c.entState = s.edition === 'enterprise' && !!(s.license && s.license.seats === 250);
      c.entBrand = ['Northwind MSP', 'Contoso Ltd'].includes(document.querySelector('.brand-org').textContent.trim());
      c.policyHide = document.querySelector('[data-tab=programs]').hidden && document.querySelector('#tab-programs').hidden
        && (showTab('dashboard'), showTab('programs'), document.querySelector('#tab-dashboard').classList.contains('active') && !document.querySelector('#tab-programs').classList.contains('active'));
      const dt = document.querySelector('#btn-dup-trash');
      c.policyDisable = dt.disabled && dt.title === 'Disabled by policy';
      c.policyRecycle = await rejects(() => window.tidy.clean(['recycle']), /POLICY_DENIED:recycle/) && !!document.querySelector('.catbox[data-id=recycle]') && document.querySelector('.catbox[data-id=recycle]').disabled;
      const cats = await window.tidy.categories();
      c.policyLock = cats.filter(x => x.locked).length === cats.length && cats.length === state.cats.length && await rejects(() => window.tidy.clean(['npm']), /POLICY_DENIED:cleaner-lock/);
      c.guardPolicy = await rejects(() => window.tidy.runPs('t', 'uninstall.ps1', ['-Kind','appx','-Id','x']), /POLICY_DENIED:uninstall/);
      const j = buildReportJson('manual');
      c.reportJson = j.schema === 1 && Array.isArray(j.steps) && !!j.sys && j.sys.os === state.sys.os;
      c.reportSendResult = await window.tidy.reportSend({ json: j, md: buildReport(), profile: 'manual' });
      c.stepsShared = typeof runSteps === 'function' && typeof runUnattended === 'function';
      c.askWrap = (state.unattended = true, ask('x') === true && (notify('y'), true) && (state.unattended = false, true));
    `);
    const sent = c.reportSendResult; delete c.reportSendResult;
    const auditLines = readText(path.join(TMP, 'pd', 'audit', MONTH + '.jsonl')).split('\n');
    c.audit = auditLines.some(l => l.includes('"event":"denied"') && l.includes('"action":"uninstall"'));
    c.reportSend = !!(sent && !sent.queued) && listDir(path.join(TMP, 'reports', HOST)).some(f => /-manual\.json$/.test(f)) && exists(path.join(TMP, 'reports', '_latest', HOST + '.json'));
    if (!c.reportSend) console.log('DIAG reportSend:', JSON.stringify(sent));
    // outbox: point the report dir below a regular file so every remote write fails
    fs.writeFileSync(path.join(TMP, 'notadir'), 'not a directory');
    await M.setPolicyForTest({ ...locked, reportDir: path.join(TMP, 'notadir', 'x') }); await reload();
    const ob = await page(`
      const r = await window.tidy.reportSend({ json: buildReportJson('manual'), md: buildReport(), profile: 'manual' });
      c.queued = r.queued === true;
      c.outboxCount = (await window.tidy.reportStatus()).outboxCount;
    `);
    c.outbox = ob.queued && listDir(path.join(TMP, 'pd', 'outbox')).length === 2 && ob.outboxCount === 2;
    if (!c.outbox) console.log('DIAG outbox:', JSON.stringify(ob), listDir(path.join(TMP, 'pd', 'outbox')));
    return c;
  });

  // ---- activate: real discovery against TMP/ud, the activation record, remove, and the Solo-build cap
  await group('activate', async () => {
    await M.setLicenseForTest(null); await M.setPolicyForTest(null); await reload();
    const licFile = path.join(TMP, 'ud', 'TidyWin.lic');
    const c = {};
    const a1 = await page(`c.r = await window.tidy.licenseActivate({ text: 'TIDYWIN1.bad.bad', scope: 'user' });`);
    c.activateRejects = a1.r && a1.r.ok === false && a1.r.status === 'format' && !exists(licFile);
    const a2 = await page(`c.r = await window.tidy.licenseActivate({ text: ${JSON.stringify(F.wrap(F.tokens.solo))}, scope: 'user' }); const s = await window.tidy.licenseState(); c.ed = s.edition; c.src = s.license && s.license.source;`);
    c.activateWrites = a2.r && a2.r.ok === true && exists(licFile) && a2.ed === 'enterprise' && a2.src === 'userdata';
    if (!c.activateWrites) console.log('DIAG activate:', JSON.stringify(a2));
    const act = readJson(path.join(TMP, 'pd', 'activation.json'));
    c.activation = !!(act && act.licenseId === F.payloads.solo.id);
    const a3 = await page(`c.r = await window.tidy.licenseRemove(); c.ed = (await window.tidy.licenseState()).edition;`);
    c.remove = a3.r && a3.r.ok === true && !exists(licFile) && a3.ed === 'enterprise';
    await M.setLicenseForTest(F.tokens.ent); await M.setBuildForTest('solo'); await reload();
    const a4 = await page(`const s = await window.tidy.licenseState(); c.ed = s.edition; c.build = s.build; c.warn = s.warnings.length > 0; c.features = s.features.length;`);
    c.soloBuild = a4.ed === 'solo' && a4.build === 'solo' && a4.warn === false && a4.features === 0;
    await M.setBuildForTest(null); await M.setLicenseForTest(null); await reload();
    return c;
  });

  // ---- unattended: real spawned children (Electron exe, no TIDYWIN_NO_WINDOW), exit codes + files
  await group('unattended', async () => {
    const ELECTRON = [path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe'), path.join(__dirname, 'node_modules', '.bin', 'electron.cmd')].find(exists) || process.execPath;
    const PD2 = path.join(TMP, 'pd2'), REP2 = path.join(TMP, 'rep2');
    const env = { ...process.env, TIDYWIN_TEST_PUBKEY: F.pubHex, TIDYWIN_DATA_DIR: PD2 };
    delete env.TIDYWIN_NO_WINDOW; delete env.ELECTRON_RUN_AS_NODE;
    const child = (name, args) => new Promise(resolve => {
      const log = path.join(TMP, `run-${name}.log`);
      // Each child gets its own Chromium profile so it never shares %APPDATA% (or the
      // single-instance lock) with a NodeMend that is installed and running on this PC.
      const full = [__dirname, '--unattended', ...args, '--log=' + log, '--user-data-dir=' + path.join(TMP, 'ud-' + name)];
      const shell = /\.cmd$/i.test(ELECTRON);
      const p = spawn(shell ? `"${ELECTRON}"` : ELECTRON, shell ? full.map(a => `"${a}"`) : full, { env, windowsHide: true, stdio: 'ignore', shell });
      const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve({ name, status: null, log, timedOut: true }); }, 180000);
      p.on('error', e => { clearTimeout(t); resolve({ name, status: null, log, error: e.message }); });
      p.on('exit', code => { clearTimeout(t); resolve({ name, status: code, log }); });
    });
    const runs = {};
    runs.ok = await child('ok', ['--profile=smoke', '--license=' + FX['ent.lic'], '--policy=' + FX['locked-unattended.json'], '--report-dir=' + REP2, '--timeout-min=5']);
    runs.nokey = await child('nokey', ['--profile=smoke', '--policy=' + FX['locked-unattended.json'], '--report-dir=' + REP2, '--timeout-min=5']);
    runs.subset = await child('subset', ['--profile=smoke', '--license=' + FX['ent-subset.lic'], '--policy=' + FX['locked-unattended.json'], '--report-dir=' + REP2, '--timeout-min=5']);
    runs.badargs = await child('badargs', ['--steps=bogus', '--license=' + FX['ent.lic'], '--policy=' + FX['locked-unattended.json'], '--report-dir=' + REP2, '--timeout-min=5']);
    runs.policy = await child('policy', ['--profile=smoke', '--license=' + FX['ent.lic'], '--policy=' + FX['no-unattended.json'], '--report-dir=' + REP2, '--timeout-min=5']);
    runs.policymissing = await child('policymissing', ['--profile=smoke', '--license=' + FX['ent.lic'], '--policy=' + path.join(path.dirname(FX['ent.lic']), 'missing.json'), '--report-dir=' + REP2, '--timeout-min=5']);
    const c = {};
    c.unExit = runs.ok.status === 0;
    c.unLog = readText(runs.ok.log).includes('RESULT: OK');
    const rep = listDir(path.join(REP2, HOST)).find(f => /-smoke\.json$/.test(f));
    const j = rep ? readJson(path.join(REP2, HOST, rep)) : null;
    c.unReport = !!(j && j.mode === 'unattended' && j.steps && j.steps[0] && j.steps[0].key === 'diag' && j.steps[0].state === 'done' && j.app && j.app.edition === 'enterprise')
      && readText(path.join(REP2, HOST, rep ? rep.replace(/\.json$/, '.md') : '')).includes('maintenance report') && exists(path.join(REP2, '_latest', HOST + '.json'));
    const audit = listDir(path.join(PD2, 'audit')).filter(f => /\.jsonl$/.test(f)).map(f => readText(path.join(PD2, 'audit', f))).join('\n');
    c.unAudit = audit.includes('"event":"run-start"') && audit.includes('"event":"run-end"');
    c.unNoKey = runs.nokey.status === 0 && readText(runs.nokey.log).includes('RESULT: OK');   // unattended mode needs no key
    c.unSubset = runs.subset.status === 0;                                                       // a restricted key no longer restricts
    c.unBadArgs = runs.badargs.status === 2;
    c.unPolicy = runs.policy.status === 4;
    c.unPolicyMissing = runs.policymissing.status === 4 && /policy file not found/.test(readText(runs.policymissing.log));
    for (const [k, v] of Object.entries(c)) if (!v) {
      const name = { unExit: 'ok', unLog: 'ok', unReport: 'ok', unAudit: 'ok', unNoKey: 'nokey', unSubset: 'subset', unBadArgs: 'badargs', unPolicy: 'policy', unPolicyMissing: 'policymissing' }[k];
      console.log(`DIAG ${k}: child ${name} exit=${JSON.stringify(runs[name])}\n--- ${runs[name].log} ---\n${readText(runs[name].log).slice(-4000)}\n--- end ---`);
    }
    return c;
  });

  const fails = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log('SMOKETEST', JSON.stringify(checks, null, 2));
  console.log(fails.length ? 'RESULT: FAIL ' + fails.join(',') : 'RESULT: PASS');
  app.exit(fails.length ? 1 : 0);
});

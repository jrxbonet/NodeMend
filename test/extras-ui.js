// Native Electron UI checks. No cleanup, browser edits, process pause or drive access.
process.env.TIDYWIN_NO_WINDOW = '1';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const root = path.resolve(__dirname, '..');
const out = process.env.TIDYWIN_QA_OUTPUT || path.join(root, '.tmp', 'extras-ui-' + process.platform);
fs.mkdirSync(out, { recursive: true });
process.env.TIDYWIN_DATA_DIR = path.join(out, 'data');
app.setPath('userData', path.join(out, 'user'));
delete process.env.TIDYWIN_LICENSE; delete process.env.TIDYWIN_POLICY;
require('../main');
const wait = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', (event, level, message) => { if (level >= 3 && !/LICENSE_REQUIRED/.test(message)) errors.push(message); });
  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  for (let i = 0; i < 90; i++) { if (await win.webContents.executeJavaScript('!!(state.sys && state.cats.length)')) break; await wait(1000); }
  const result = await win.webContents.executeJavaScript(`(async () => {
    const info = await window.tidy.info(), lic = await window.tidy.licenseState();
    const engines = await window.tidy.recoveryStatus();
    const checks = { nativePlatform: info.platform, systemLoaded: !!state.sys, categoriesLoaded: state.cats.length > 0, freeCleaningEnabled: !document.querySelector('#btn-clean').dataset.locked, bundledRecovery: engines.bundled.ok, smartOff: !(await window.tidy.smartStatus()).enabled };
    try { await window.tidy.recoveryRun({}); checks.recoveryGated = false; } catch (e) { checks.recoveryGated = /LICENSE_REQUIRED/.test(e.message); }
    checks.resumeWithoutLicense = (await window.tidy.performanceResumeAll()).ok;
    checks.windowsControlsHidden = info.platform === 'win32' || document.querySelector('.nav-btn[data-tab="updates"]').hidden;
    checks.freeLabel = document.querySelector('#lic-badge').textContent.includes('Free');
    return checks;
  })()`);
  for (const name of ['systemLoaded', 'categoriesLoaded', 'freeCleaningEnabled', 'bundledRecovery', 'smartOff', 'recoveryGated', 'resumeWithoutLicense', 'windowsControlsHidden', 'freeLabel']) assert.equal(result[name], true, name);
  for (const tab of ['recovery', 'privacy', 'performance', 'smart', 'vpn', 'license']) {
    await win.webContents.executeJavaScript(`showTab('${tab}')`); await wait(250);
    fs.writeFileSync(path.join(out, tab + '.png'), (await win.capturePage()).toPNG());
  }
  assert.deepEqual(errors, [], errors.join('\n'));
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, ...result, hostMutations: false }, null, 2));
  console.log(JSON.stringify({ ok: true, ...result, hostMutations: false })); app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });

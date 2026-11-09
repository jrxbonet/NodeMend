'use strict';
function createSmartCleaner({ allowedCategories, isAllowed, canRun, clean, onResult = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let timer = null, config = { enabled: false, minutes: 60, categories: [] }, busy = false, lastRun = null;
  const allowed = new Set(allowedCategories);
  function stop() { if (timer) clearIntervalFn(timer); timer = null; config.enabled = false; }
  async function tick() {
    if (!config.enabled || busy || !canRun()) return;
    if (!isAllowed()) { stop(); return; }
    busy = true;
    try { const result = await clean(config.categories.slice()); lastRun = new Date().toISOString(); onResult({ ok: true, lastRun, freed: result.totalFreed }); }
    catch { onResult({ ok: false, error: 'Automatic cleaning failed; review the app log.' }); }
    finally { busy = false; }
  }
  function configure(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['enabled', 'minutes', 'categories'].includes(k)) || typeof value.enabled !== 'boolean') throw new Error('INVALID_SMART_CONFIG');
    if (!value.enabled) { stop(); return status(); }
    if (!isAllowed()) throw new Error('LICENSE_REQUIRED');
    if (!Number.isInteger(value.minutes) || value.minutes < 15 || value.minutes > 1440 || !Array.isArray(value.categories) || !value.categories.length || value.categories.some(id => !allowed.has(id))) throw new Error('INVALID_SMART_CONFIG');
    stop(); config = { enabled: true, minutes: value.minutes, categories: [...new Set(value.categories)] };
    timer = setIntervalFn(tick, config.minutes * 60000); if (timer?.unref) timer.unref();
    return status();
  }
  function status() { return { ...config, categories: config.categories.slice(), busy, lastRun, runsWhileAppOpen: true, installedSystemTask: false }; }
  return { configure, status, stop, tick };
}
module.exports = { createSmartCleaner };

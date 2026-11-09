const assert = require('assert');
const { createSmartCleaner } = require('../lib/smart-clean');
(async () => {
  let allowed = true, running = false, calls = [], interval;
  const service = createSmartCleaner({ allowedCategories: ['cache'], isAllowed: () => allowed, canRun: () => !running, clean: async ids => { calls.push(ids); return { totalFreed: 42 }; }, setIntervalFn: fn => (interval = fn, { unref() {} }), clearIntervalFn: () => {} });
  assert.equal(service.status().enabled, false);
  assert.throws(() => service.configure({ enabled: true, minutes: 1, categories: ['cache'] }), /INVALID/);
  assert.throws(() => service.configure({ enabled: true, minutes: 15, categories: ['recycle'] }), /INVALID/);
  service.configure({ enabled: true, minutes: 15, categories: ['cache'] });
  assert.equal(calls.length, 0); // never cleans immediately on activation
  running = true; await interval(); assert.equal(calls.length, 0);
  running = false; await interval(); assert.deepEqual(calls, [['cache']]);
  allowed = false; await interval(); assert.equal(service.status().enabled, false); assert.equal(calls.length, 1);
  assert.throws(() => service.configure({ enabled: true, minutes: 15, categories: ['cache'] }), /LICENSE_REQUIRED/);
  service.configure({ enabled: false });
  console.log('RESULT: PASS (opt-in smart cleaning, intervals, protected categories, busy and expiry gates)');
})().catch(e => { console.error(e); process.exitCode = 1; });

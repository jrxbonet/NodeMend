const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { assertPlainDirectorySync } = require('../lib/platform');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidywin-link-boundary-'));
const valuable = path.join(root, 'valuable'), cache = path.join(root, 'cache');
fs.mkdirSync(valuable); fs.mkdirSync(cache); fs.mkdirSync(path.join(valuable, 'sub'));
fs.writeFileSync(path.join(valuable, 'sub', 'preserve.txt'), 'keep');
const junction = path.join(cache, 'linked');
try {
  fs.symlinkSync(valuable, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertPlainDirectorySync(path.join(junction, 'sub')), /SYMLINK_PATH/);
  assert.throws(() => assertPlainDirectorySync(junction), /SYMLINK_PATH/);
  assert.equal(assertPlainDirectorySync(valuable), valuable);
  assert.equal(fs.readFileSync(path.join(valuable, 'sub', 'preserve.txt'), 'utf8'), 'keep');
  console.log('RESULT: PASS (actual linked-ancestor rejection; valuable fixture unchanged)');
} finally {
  // Only remove our owned temporary fixture; unlink the junction before recursive cleanup.
  try { fs.unlinkSync(junction); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

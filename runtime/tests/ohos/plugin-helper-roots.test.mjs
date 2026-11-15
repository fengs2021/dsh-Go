import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHelperRoots } from '../../ohos/process/command-router.mjs';
import { profileDirectories } from '../../ohos/plugins/store.mjs';

// The helper reads its package code and writes its own state under the engine home;
// both must be reachable or billion-context cannot create its config.
test('plugin helper roots follow the installed profiles and the engine home', () => {
  const home = process.env.HOME;
  const profile = '/data/storage/el2/base/files/runtime/rootfs/root/.dsh/profiles/web';
  profileDirectories.add(profile);
  try {
    const roots = pluginHelperRoots();
    assert.equal(roots.includes(profile), true);
    if (home) assert.equal(roots.includes(home), true);
    else assert.equal(roots.length, 1);
  } finally {
    profileDirectories.delete(profile);
    assert.deepEqual(pluginHelperRoots().filter(value => value === profile), []);
  }
  assert.equal(pluginHelperRoots().every(value => typeof value === 'string' && value.startsWith('/')), true);
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scriptRoots } from '../../ohos/process/node-script.mjs';

// A plugin helper entry lives inside the installed plugin tree, not the workspace.
// Only these extra readable roots are added; the working directory is not affected.
test('script roots keep the session roots and add the plugin install trees', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ohos-script-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), temporary = join(root, 'temporary');
  const profile = join(root, 'profiles', 'web');
  await mkdir(workspace); await mkdir(temporary); await mkdir(join(profile, 'node_modules', 'billion-context'), { recursive: true });
  const entry = join(profile, 'node_modules', 'billion-context', 'proxy.mjs');
  await writeFile(entry, 'export {};\n');

  const roots = scriptRoots([workspace, temporary], [profile]);
  assert.deepEqual(roots, [realpathSync(workspace), realpathSync(temporary), realpathSync(profile)]);
  assert.equal(roots.some(held => entry.startsWith(held + '/')), true);
  assert.equal(roots.some(held => workspace === held), true);
  // The workspace never becomes an ancestor of the plugin tree.
  assert.equal(roots.includes('/'), false);
});

test('script roots ignore duplicates, missing paths, plain files and the filesystem root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ohos-script-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), file = join(root, 'file.txt');
  await mkdir(workspace); await writeFile(file, 'x');
  assert.deepEqual(scriptRoots([workspace], [workspace, file, join(root, 'absent'), '/']), [realpathSync(workspace)]);
  assert.deepEqual(scriptRoots([workspace]), [realpathSync(workspace)]);
});


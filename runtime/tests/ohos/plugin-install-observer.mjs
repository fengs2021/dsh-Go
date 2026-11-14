// Test-only Cordis plugin. It runs inside a real DSH profile on the simulated
// openharmony platform and asks the running plugin manager to do the two things
// its package-manager seam owns: name the registry, and run one package-manager
// command that is answered in process. No download, no network and no method
// replacement: the profile's own files are the fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'ohos-plugin-install-observer';
export const inject = ['pluginManager'];
export async function apply(ctx, config) {
  const require = createRequire(join(config.prefix, 'package.json'));
  const entry = require.resolve('@deepseek-ai/dsh-plugin-manager');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const sha256 = hash(readFileSync(entry));
  assert.equal(sha256, config.sha256);
  const { PluginManager } = await import(pathToFileURL(entry));
  const manager = ctx.pluginManager;
  assert(manager instanceof PluginManager);
  assert.equal(process.platform, 'openharmony');

  const violations = [];
  const check = (label, run) => {
    try { run(); }
    catch (error) { violations.push({ name: label, message: error.message }); }
  };
  const files = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];
  const snapshot = () => Object.fromEntries(files.map((file) => {
    const path = join(manager.profile.dir, file);
    return [file, existsSync(path) ? hash(readFileSync(path)) : null];
  }));
  const before = snapshot();
  const pending = manager.installs.size;
  const events = [];
  const disposers = ['changed', 'install-log', 'install-state'].map((type) =>
    ctx.on('plugin-manager/' + type, (value) => { events.push({ type, value }); }));

  let registry;
  let run;
  try {
    registry = await manager.registries();
    run = await manager.runPnpm(['list'], undefined, 'ohos-bridge-probe');
  } finally {
    for (const dispose of disposers) dispose();
  }

  check('registries answers through the in-process bridge', () => {
    assert.equal(typeof registry, 'object');
    assert.equal(registry.resolved === null || /^https?:\/\/\S+$/.test(registry.resolved), true, String(registry.resolved));
    assert.equal(Array.isArray(registry.fallbackRegistries), true);
  });
  check('list runs in process and reports the log the contract names', () => {
    assert.equal(run.exitCode, 0);
    assert.equal(run.timedOut, undefined);
    const root = join(manager.profile.dir, '.plugin-manager', 'logs');
    assert.equal(existsSync(root), true, root);
    const operations = readdirSync(root).filter((name) => name.startsWith('operation-'));
    assert.equal(operations.length > 0, true);
    const logs = operations.map((name) => join(root, name, 'pnpm.log')).filter((file) => existsSync(file));
    assert.equal(logs.length > 0, true);
    const text = logs.map((file) => readFileSync(file, 'utf8')).join('\n');
    assert.match(text, /> dsh plugin list/);
    assert.match(text, /^registry: https?:\/\//m);
    assert.equal(existsSync(run.logPath), true, run.logPath);
  });
  check('the streamed log reaches the caller', () => {
    const logs = events.filter((event) => event.type === 'plugin-manager/install-log');
    assert.equal(logs.length > 0, true);
    assert.equal(logs.every((event) => event.value.argv[0] === 'pnpm' && event.value.argv[1] === 'list'), true);
  });
  check('no changed event and nothing selected differently', () => {
    assert.deepEqual(events.filter((event) => event.type === 'plugin-manager/changed'), []);
    assert.equal(manager.installs.size, pending);
  });
  check('the profile keeps its own files', () => assert.deepEqual(snapshot(), before));
  check('the bridge leaves no pnpm lockfile', () => assert.equal(snapshot()['pnpm-lock.yaml'], before['pnpm-lock.yaml']));

  const record = {
    status: violations.length === 0 ? 'PASS' : 'FAIL',
    entry,
    sha256,
    scope: 'actual DSH service, real profile filesystem, in-process package manager; Linux sim, not a device/UI claim',
    platform: process.platform,
    bridge: { version: globalThis.__dshOhosPackageManager?.VERSION ?? null },
    registryResolved: registry?.resolved ?? null,
    run: { exitCode: run?.exitCode, logPath: run?.logPath },
    before,
    after: snapshot(),
    events,
    violations,
  };
  if (config.output !== undefined) writeFileSync(config.output, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('[OHOS-PLUGIN-BRIDGE-PROBE] ' + JSON.stringify(record));
}

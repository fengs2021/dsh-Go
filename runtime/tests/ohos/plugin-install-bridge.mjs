// The patched plugin manager answers the three profile package operations
// through globalThis.__dshOhosPackageManager on openharmony and keeps the pnpm
// path everywhere else. A fake object stands in for the bridge: the delegation
// itself is what is asserted, so no registry, network or profile is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
// The patched tree the refusal-era drivers used, and the degrade target when
// it is absent. DSH_GO_OHOS_BRIDGE_TREE='' proves the patch-diff fallback.
const preparedTree = process.env.DSH_GO_OHOS_BRIDGE_TREE ?? '/root/prepared5/dsh';
const mode = process.argv[4];
const prefix = resolve(process.argv[2] ?? preparedTree);
const output = process.argv[3];

function readTree(path) {
  const bytes = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (file.endsWith('.js')) bytes.push([file, readFileSync(file, 'utf8')]);
    }
  };
  walk(path);
  return bytes;
}

function located() {
  for (const candidate of preparedTree === '' ? [prefix] : [prefix, preparedTree]) {
    try {
      const require = createRequire(join(candidate, 'package.json'));
      const index = require.resolve('@deepseek-ai/dsh-plugin-manager');
      const operations = require.resolve('@deepseek-ai/dsh-plugin-manager/operations');
      if (index && operations) return { prefix: candidate, require, index, operations };
    } catch { /* try the next candidate */ }
  }
  return null;
}

const site = located();
const rows = [];
const notes = { platform: process.platform, prefix: site?.prefix ?? null, patchCheck: site === null ? 'patch diff fallback' : 'patched tree' };
async function check(name, run) {
  try { await run(); rows.push({ name, passed: true }); }
  catch (error) { rows.push({ name, passed: false, error: { name: error.name, message: error.message, code: error.code } }); }
}

const OLD = ['OHOS_PLUGIN_INSTALL_UNAVAILABLE', '随包插件', '连接电脑', 'ohos-plugin-install-refusal.diff'];
const pins = readFileSync(join(repository, 'runtime/patches/pins.json'), 'utf8');

await check('pins.json pins the bridge patch and no longer the refusal patch', async () => {
  assert.equal(pins.includes('zzzzzzzzzzzzz-ohos-plugin-install-bridge.diff'), true);
  assert.equal(pins.includes('zzzzzzzzzzzzz-ohos-plugin-install-refusal.diff'), false);
});

if (site === null) {
  // Fallback: no prepared tree to inspect. Judge the patch itself.
  const diff = readFileSync(join(repository, 'runtime/patches/zzzzzzzzzzzzz-ohos-plugin-install-bridge.diff'), 'utf8');
  await check('patch diff delegates all three operations to the bridge', async () => {
    assert.equal(diff.includes('zzzzzzzzzzzzz-ohos-plugin-install-bridge.diff'), false);
    for (const call of ['ohos.runProfilePnpm(context, args, options)', 'ohos.readRegistry(dir, options)', 'ohos.viewProfilePackage(dir, spec, options)']) assert.equal(diff.includes(call), true, call);
    assert.equal(diff.includes('globalThis.__dshOhosPackageManager'), true);
  });
  await check('patch diff keeps no refusal message', async () => {
    for (const text of OLD) assert.equal(diff.includes(text), false, text);
  });
} else {
  const indexTree = readTree(dirname(site.index));
  const operationsTree = readTree(dirname(site.operations));
  const delegated = [
    'return ohos.runProfilePnpm(context, args, options)',
    'return ohos.readRegistry(dir, options)',
    'return ohos.viewProfilePackage(dir, spec, options)',
  ];
  for (const [label, tree] of [['lib/index.js', indexTree], ['lib/types/operations.js', operationsTree]]) {
    const text = tree.map(([, body]) => body).join('\n');
    await check(label + ' defines the openharmony bridge helper and delegates three entries', async () => {
      assert.equal(text.includes('globalThis.__dshOhosPackageManager'), true);
      assert.equal(text.includes('process.platform === "openharmony"') || text.includes("process.platform === 'openharmony'"), true);
      for (const line of delegated) assert.equal(text.includes(line), true, line);
    });
    await check(label + ' keeps none of the refusal text', async () => {
      for (const old of OLD) assert.equal(text.includes(old), false, old);
    });
  }
  await check('the whole installed lib drops the refusal message', async () => {
    for (const [file, body] of [...indexTree, ...operationsTree]) for (const old of OLD) assert.equal(body.includes(old), false, file + ': ' + old);
  });
}

if (mode === 'ohos' && site !== null) {
  assert.equal(process.platform, 'openharmony');
  const require = site.require;
  const load = (name) => import(pathToFileURL(require.resolve(name)));
  const { PluginManager } = await load('@deepseek-ai/dsh-plugin-manager');
  const operations = await load('@deepseek-ai/dsh-plugin-manager/operations');
  const calls = [];
  const logPath = '/fixture/profile/.plugin-manager/logs/operation-fixture/pnpm.log';
  globalThis.__dshOhosPackageManager = {
    runProfilePnpm: async (...args) => {
      calls.push(['runProfilePnpm', ...args]);
      return { exitCode: 0, output: 'Added 1 package(s).\n', truncated: false, logPath };
    },
    readRegistry: async (...args) => {
      calls.push(['readRegistry', ...args]);
      return 'https://registry.fixture.test/';
    },
    viewProfilePackage: async (...args) => {
      calls.push(['viewProfilePackage', ...args]);
      return { exitCode: 0, stdout: '{"name":"is-odd","version":"3.0.1"}', stderr: '', timedOut: false };
    },
  };
  const profile = { dir: '/fixture/profile', name: 'dsh', installAnchor: '/fixture/profile/package.json' };
  function manager(overrides = {}) {
    const created = Object.create(PluginManager.prototype);
    Object.assign(created, {
      profile,
      configuredRegistries: { registry: null, fallbackRegistries: ['https://registry.npmjs.org'] },
      installedFrom: new Map(),
      pnpmCommand: 'pnpm',
      inspectTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      outputBytes: 100000,
      packageOperations: new Set(),
      abort: new AbortController(),
      ownerContext: { emit: () => {}, get: () => undefined },
      listBundles: async () => [],
    }, overrides);
    return created;
  }

  await check('runProfilePnpm is delegated whole', async () => {
    const context = { dir: '/fixture/profile', home: '/fixture/home', profile: 'dsh' };
    const args = ['add', 'is-odd@3.0.1', '--save-exact'];
    const options = { execution: 'service', timeoutMs: 1000 };
    const result = await operations.runProfilePnpm(context, args, options);
    assert.deepEqual(calls.at(-1), ['runProfilePnpm', context, args, options]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.logPath, logPath);
  });
  await check('readProfileRegistry is delegated whole', async () => {
    const options = { command: 'pnpm', timeoutMs: 500 };
    const result = await operations.readProfileRegistry('/fixture/profile', options);
    assert.deepEqual(calls.at(-1), ['readRegistry', '/fixture/profile', options]);
    assert.equal(result, 'https://registry.fixture.test/');
  });
  await check('viewProfilePackage is delegated whole', async () => {
    const options = { fields: ['name', 'version'], registry: 'https://registry.fixture.test/' };
    const result = await operations.viewProfilePackage('/fixture/profile', 'is-odd@3.0.1', options);
    assert.deepEqual(calls.at(-1), ['viewProfilePackage', '/fixture/profile', 'is-odd@3.0.1', options]);
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).version, '3.0.1');
  });
  await check('PluginManager.registries reads the bridge registry', async () => {
    const result = await manager().registries();
    assert.equal(calls.at(-1)[0], 'readRegistry');
    assert.equal(calls.at(-1)[1], profile.dir);
    assert.equal(result.resolved, 'https://registry.fixture.test/');
    assert.deepEqual(result.fallbackRegistries, ['https://registry.npmjs.org']);
  });
  await check('PluginManager install path runs through runProfilePnpm', async () => {
    const events = [];
    const instance = manager({ ownerContext: { emit: (...args) => events.push(args), get: () => undefined } });
    const result = await instance.runPnpm(['add', 'is-odd@3.0.1', '--save-exact'], undefined, 'request-fixture');
    const [name, context, args, options] = calls.at(-1);
    assert.equal(name, 'runProfilePnpm');
    assert.deepEqual(args, ['add', 'is-odd@3.0.1', '--save-exact']);
    assert.equal(context.dir, profile.dir);
    assert.equal(context.profile, 'dsh');
    assert.equal(options.execution, 'service');
    assert.equal(typeof options.onOutput, 'function');
    // The finishing chunk is emitted once the bridge answers; the caller's own
    // onOutput is the same stream the bridge writes through.
    options.onOutput('Added 1 package(s).\n', 'stdout');
    assert.deepEqual(events.map(([type, value]) => [type, value.stream, value.text]), [
      ['plugin-manager/install-log', 'stdout', ''],
      ['plugin-manager/install-log', 'stdout', 'Added 1 package(s).\n'],
    ]);
    const [finish] = events;
    assert.equal(finish[1].exitCode, 0);
    assert.equal(finish[1].requestId, 'request-fixture');
    assert.deepEqual(finish[1].argv, ['pnpm', 'add', 'is-odd@3.0.1', '--save-exact']);
    assert.equal(finish[1].cwd, profile.dir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.logPath, logPath);
  });
  await check('the shipped bridge module answers the same three names', async () => {
    const bridge = await import(pathToFileURL(join(repository, 'runtime/ohos/plugins/package-manager.mjs')).href);
    assert.equal(typeof bridge.runProfilePnpm, 'function');
    assert.equal(typeof bridge.readRegistry, 'function');
    assert.equal(typeof bridge.viewProfilePackage, 'function');
    assert.match(bridge.VERSION, /^\d+\.\d+\.\d+-ohos$/);
    for (const name of ['runProfilePnpm', 'readRegistry', 'viewProfilePackage']) assert.equal(typeof bridge.default[name], 'function', name);
  });
} else if (mode === 'native' && site !== null) {
  assert.equal(process.platform, 'linux');
  const require = site.require;
  const load = (name) => import(pathToFileURL(require.resolve(name)));
  const { PluginManager } = await load('@deepseek-ai/dsh-plugin-manager');
  const operations = await load('@deepseek-ai/dsh-plugin-manager/operations');
  const calls = [];
  globalThis.__dshOhosPackageManager = {
    runProfilePnpm: async (...args) => { calls.push(['runProfilePnpm', ...args]); return { exitCode: 0, output: '', truncated: false, logPath: '/never' }; },
    readRegistry: async (...args) => { calls.push(['readRegistry', ...args]); return 'https://registry.fixture.test/'; },
    viewProfilePackage: async (...args) => { calls.push(['viewProfilePackage', ...args]); return { exitCode: 0, stdout: '{}', stderr: '', timedOut: false }; },
  };
  const accessed = new Error('the real pnpm path was entered');
  const blocked = new Proxy({}, { get() { throw accessed; }, set() { throw accessed; } });
  function manager(overrides = {}) {
    const created = Object.create(PluginManager.prototype);
    Object.assign(created, {
      configuredRegistries: { registry: null, fallbackRegistries: ['https://registry.npmjs.org'] },
      installedFrom: new Map(),
      pnpmCommand: 'pnpm',
      inspectTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      outputBytes: 100000,
      packageOperations: new Set(),
      abort: new AbortController(),
      ownerContext: { emit: () => {}, get: () => undefined },
      listBundles: async () => [],
    }, overrides);
    return created;
  }

  await check('runProfilePnpm keeps the pnpm path', async () => {
    await assert.rejects(operations.runProfilePnpm(blocked, ['add', 'fixture@1'], {}), (error) => error === accessed);
  });
  await check('readProfileRegistry keeps the pnpm path', async () => {
    await assert.rejects(operations.readProfileRegistry(repository, blocked), (error) => error === accessed);
    // A command that cannot exist: the real execa path reports no registry,
    // where the injected bridge would have answered with its own URL.
    const answered = await operations.readProfileRegistry(repository, { command: '/nonexistent/pnpm-bridge-probe', timeoutMs: 1000 });
    assert.equal(answered, null);
  });
  await check('viewProfilePackage keeps the pnpm path', async () => {
    await assert.rejects(operations.viewProfilePackage(repository, 'fixture@1', blocked), (error) => error === accessed);
    const viewed = await operations.viewProfilePackage(repository, 'fixture@1', { command: '/nonexistent/pnpm-bridge-probe', fields: ['version'], timeoutMs: 1000 });
    assert.equal(viewed.exitCode, null);
    assert.equal(viewed.cause?.code, 'ENOENT');
    assert.equal(viewed.stdout, '');
  });
  await check('PluginManager.registries reads the real profile on linux', async () => {
    const instance = manager();
    Object.defineProperty(instance, 'profile', { get() { throw accessed; } });
    await assert.rejects(instance.registries(), (error) => error === accessed);
  });
  await check('PluginManager install path reads the real profile on linux', async () => {
    const instance = manager();
    Object.defineProperty(instance, 'profile', { get() { throw accessed; } });
    await assert.rejects(instance.runPnpm(['add', 'fixture@1'], undefined, undefined), (error) => error === accessed);
  });
  await check('the injected bridge object was never called', async () => assert.deepEqual(calls, []));
}

if (mode === undefined) {
  // Standalone: the same script drives both platform semantics as children.
  const run = (args, env) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const preload = join(repository, 'runtime/ohos/sim/preload.mjs');
  const ohos = run(['--jitless', '--import', preload, fileURLToPath(import.meta.url), prefix, join('/tmp', 'bridge-ohos.json'), 'ohos'],
    { DSH_GO_OHOS_SIM_PLATFORM: 'openharmony', DSH_GO_OHOS_SIM_ADDONS: '[]' });
  const native = run([fileURLToPath(import.meta.url), prefix, join('/tmp', 'bridge-native.json'), 'native'], {});
  const report = [['ohos', ohos], ['native', native]].map(([name, child]) => {
    const last = (child.stdout ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';
    return { mode: name, status: child.status, summary: last, stderr: (child.stderr ?? '').trim().split('\n').slice(-6) };
  });
  for (const row of report) console.log(row.mode + ': ' + row.summary + (row.status === 0 ? '' : ' (exit ' + row.status + ')'));
  for (const child of [ohos, native]) if ((child.stdout ?? '').includes('FAIL')) console.log(child.stdout);
  for (const child of [ohos, native]) if (child.status !== 0 && child.stderr) console.log(child.stderr);
  const ok = report.every((row) => row.status === 0);
  if (output !== undefined) await writeFile(output, JSON.stringify({ scope: notes, report }, null, 2) + '\n');
  console.log(ok ? 'PASS plugin-install-bridge' : 'FAIL plugin-install-bridge');
  process.exitCode = ok ? 0 : 1;
} else {
  if (site === null) console.log('PATCH-ONLY: no patched tree under ' + prefix + ', delegation rows were not run');
  if (output !== undefined) await writeFile(output, JSON.stringify({ scope: 'delegation asserted with a fake bridge object, not an OS or device claim', mode, prefix: site?.prefix ?? null, patchCheck: notes.patchCheck, rows }, null, 2) + '\n');
  console.log(JSON.stringify({ mode, passed: rows.filter((row) => row.passed).length, total: rows.length }));
  if (rows.some((row) => !row.passed)) {
    for (const row of rows.filter((item) => !item.passed)) console.log('FAIL ' + row.name + ': ' + JSON.stringify(row.error));
    process.exitCode = 1;
  } else console.log('PASS ' + mode + ' ' + rows.length + '/' + rows.length);
}

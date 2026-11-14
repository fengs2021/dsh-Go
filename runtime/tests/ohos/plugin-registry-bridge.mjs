// Registry-facing profile operations of the patched plugin manager: on
// openharmony they answer through globalThis.__dshOhosPackageManager, and on
// linux they still build the same pnpm command lines. The fake bridge answers
// every lookup, so no registry, network or profile is read here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
const prepared = '/root/prepared5/dsh';
const mode = process.argv[4];
const prefix = resolve(process.argv[2] ?? prepared);
const output = process.argv[3];

function located() {
  for (const candidate of [prefix, prepared]) {
    try {
      const require = createRequire(join(candidate, 'package.json'));
      return { require, index: require.resolve('@deepseek-ai/dsh-plugin-manager'), operations: require.resolve('@deepseek-ai/dsh-plugin-manager/operations') };
    } catch { /* try the next candidate */ }
  }
  return null;
}

const site = located();
const rows = [];
async function check(name, run) {
  try { await run(); rows.push({ name, passed: true }); }
  catch (error) { rows.push({ name, passed: false, error: { name: error.name, message: error.message, code: error.code } }); }
}
function bridge(calls) {
  return {
    runProfilePnpm: async (...args) => { calls.push(['runProfilePnpm', ...args]); return { exitCode: 0, output: '', truncated: false, logPath: '/never' }; },
    readRegistry: async (...args) => { calls.push(['readRegistry', ...args]); return 'https://registry.fixture.test/'; },
    viewProfilePackage: async (...args) => {
      calls.push(['viewProfilePackage', ...args]);
      const spec = String(args[1]);
      const [name, version] = spec.split('@');
      return { exitCode: 0, stdout: JSON.stringify({ name, version }), stderr: '', timedOut: false };
    },
  };
}

if (site === null) {
  console.log('SKIP: no prepared dsh tree to import (' + prefix + ')');
  process.exitCode = 1;
} else if (mode === 'ohos') {
  assert.equal(process.platform, 'openharmony');
  const load = (name) => import(pathToFileURL(site.require.resolve(name)));
  const { PluginManager } = await load('@deepseek-ai/dsh-plugin-manager');
  const operations = await load('@deepseek-ai/dsh-plugin-manager/operations');
  const { TYPERT } = await load('@deepseek-ai/dsh-plugin-manager/typert');
  const calls = [];
  globalThis.__dshOhosPackageManager = bridge(calls);
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
      versionListLimit: 20,
      versionLookupConcurrency: 4,
      packageOperations: new Set(),
      abort: new AbortController(),
      ownerContext: { emit: () => {}, get: () => undefined },
      listBundles: async () => [],
    }, overrides);
    return created;
  }

  await check('readProfileRegistry is delegated whole', async () => {
    const options = { command: 'pnpm', timeoutMs: 500 };
    const result = await operations.readProfileRegistry('/fixture/profile', options);
    assert.deepEqual(calls.at(-1), ['readRegistry', '/fixture/profile', options]);
    assert.equal(result, 'https://registry.fixture.test/');
  });
  await check('viewProfilePackage is delegated whole', async () => {
    const options = { fields: ['name', 'version'], registry: 'https://registry.fixture.test/', timeoutMs: 500 };
    const result = await operations.viewProfilePackage('/fixture/profile', 'is-odd@3.0.1', options);
    assert.deepEqual(calls.at(-1), ['viewProfilePackage', '/fixture/profile', 'is-odd@3.0.1', options]);
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).version, '3.0.1');
  });
  await check('registries resolves through the bridge and copies its fallbacks', async () => {
    const instance = manager();
    const result = await instance.registries();
    assert.equal(calls.at(-1)[0], 'readRegistry');
    assert.equal(calls.at(-1)[1], profile.dir);
    assert.equal(result.resolved, 'https://registry.fixture.test/');
    assert.deepEqual(result.fallbackRegistries, ['https://registry.npmjs.org']);
    assert.notEqual(result.fallbackRegistries, instance.configuredRegistries.fallbackRegistries);
    const descriptor = TYPERT.invocations.find((item) => item.method === 'registries');
    assert.deepEqual(descriptor.result.create().parse(JSON.parse(JSON.stringify(result))), result);
  });
  await check('askRegistries reads each plan entry through the bridge', async () => {
    const instance = manager();
    const answer = await instance.askRegistries('is-odd', ['version'], ['https://registry.fixture.test/'], { kind: 'registry', spec: 'is-odd', name: 'is-odd' });
    assert.deepEqual(calls.at(-1), ['viewProfilePackage', profile.dir, 'is-odd', {
      command: 'pnpm', fields: ['version'], timeoutMs: 1000, registry: 'https://registry.fixture.test/',
    }]);
    assert.equal(answer.status, 'answered');
    assert.equal(answer.registry, 'https://registry.fixture.test/');
    // A bare name has no version to echo: the fake answers what the spec carried.
    assert.deepEqual(answer.answer, { name: 'is-odd' });
    assert.deepEqual(answer.attempts, [{ registry: 'https://registry.fixture.test/' }]);
  });
  await check('updateBundle checks the registry through the bridge', async () => {
    const events = [];
    const instance = manager({
      ownerContext: { emit: (...args) => events.push(args), get: () => undefined },
      listBundles: async () => [{
        name: 'fixture-plugin', installed: true, availability: 'profile', official: false,
        source: 'fixture-plugin@1.0.0', version: '1.0.0', enabled: true,
      }],
    });
    const result = await instance.updateBundle('fixture-plugin', '1.1.0', { requestId: 'registry-fixture' });
    assert.equal(calls.at(-1)[0], 'viewProfilePackage');
    assert.equal(calls.at(-1)[2], 'fixture-plugin@1.1.0');
    assert.equal(result.step, 'check');
    assert.equal(result.from, '1.0.0');
    assert.equal(result.to, '1.1.0');
    assert.equal(result.result.application, 'failed');
    assert.equal(result.result.error.code, 'not-bundle');
    assert.equal(result.restore, undefined);
    assert.deepEqual(events, [['plugin-manager/update-state', { requestId: 'registry-fixture', step: 'checking' }]]);
  });
  await check('the shipped bridge reads the registry from .npmrc without pnpm', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ohos-bridge-registry-'));
    writeFileSync(join(directory, '.npmrc'), 'registry=https://registry.fixture.test\n');
    const emptyHome = mkdtempSync(join(tmpdir(), 'ohos-bridge-home-'));
    const home = process.env.HOME;
    process.env.HOME = emptyHome;
    try {
      const bridgeModule = await import(pathToFileURL(join(repository, 'runtime/ohos/plugins/package-manager.mjs')).href);
      assert.equal(await bridgeModule.readRegistry(directory), 'https://registry.fixture.test/');
      assert.equal(await bridgeModule.readRegistry(emptyHome), 'https://registry.npmjs.org/');
    } finally {
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    }
  });
  await check('no pnpm binary was reached: the bridge answered every call', async () => assert.equal(calls.length > 0, true));
} else if (mode === 'native') {
  assert.equal(process.platform, 'linux');
  const load = (name) => import(pathToFileURL(site.require.resolve(name)));
  const { PluginManager } = await load('@deepseek-ai/dsh-plugin-manager');
  const operations = await load('@deepseek-ai/dsh-plugin-manager/operations');
  const calls = [];
  globalThis.__dshOhosPackageManager = bridge(calls);
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

  await check('readProfileRegistry keeps the pnpm path', async () => {
    await assert.rejects(operations.readProfileRegistry(repository, blocked), (error) => error === accessed);
    assert.equal(await operations.readProfileRegistry(repository, { command: '/nonexistent/pnpm-bridge-probe', timeoutMs: 1000 }), null);
  });
  await check('viewProfilePackage keeps the pnpm path', async () => {
    await assert.rejects(operations.viewProfilePackage(repository, 'fixture@1', blocked), (error) => error === accessed);
    const viewed = await operations.viewProfilePackage(repository, 'fixture@1', { command: '/nonexistent/pnpm-bridge-probe', fields: ['version'], timeoutMs: 1000 });
    assert.equal(viewed.exitCode, null);
    assert.equal(viewed.cause?.code, 'ENOENT');
  });
  await check('registries reads the real profile on linux', async () => {
    const instance = manager();
    Object.defineProperty(instance, 'profile', { get() { throw accessed; } });
    await assert.rejects(instance.registries(), (error) => error === accessed);
  });
  await check('askRegistries reads the real profile on linux', async () => {
    const instance = manager();
    Object.defineProperty(instance, 'profile', { get() { throw accessed; } });
    await assert.rejects(instance.askRegistries('fixture', ['version'], ['https://registry.npmjs.org/'], { kind: 'registry' }), (error) => error === accessed);
  });
  await check('the injected bridge object was never called', async () => assert.deepEqual(calls, []));
}

if (mode === undefined) {
  const run = (args, env) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const preload = join(repository, 'runtime/ohos/sim/preload.mjs');
  const children = {
    ohos: run(['--jitless', '--import', preload, fileURLToPath(import.meta.url), prefix, join(tmpdir(), 'bridge-registry-ohos.json'), 'ohos'],
      { DSH_GO_OHOS_SIM_PLATFORM: 'openharmony', DSH_GO_OHOS_SIM_ADDONS: '[]' }),
    native: run([fileURLToPath(import.meta.url), prefix, join(tmpdir(), 'bridge-registry-native.json'), 'native'], {}),
  };
  let ok = true;
  for (const [name, child] of Object.entries(children)) {
    const summary = (child.stdout ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';
    console.log(name + ': ' + summary + (child.status === 0 ? '' : ' (exit ' + child.status + ')'));
    if (child.status !== 0) {
      ok = false;
      console.log(((child.stdout ?? '') + (child.stderr ?? '')).trim());
    }
  }
  if (output !== undefined) await writeFile(output, JSON.stringify({ scope: 'delegation asserted with a fake bridge object, not an OS or device claim', report: Object.keys(children) }, null, 2) + '\n');
  console.log(ok ? 'PASS plugin-registry-bridge' : 'FAIL plugin-registry-bridge');
  process.exitCode = ok ? 0 : 1;
} else {
  if (output !== undefined) await writeFile(output, JSON.stringify({ scope: 'registry delegation asserted with a fake bridge object; Linux, not device', mode, rows }, null, 2) + '\n');
  console.log(JSON.stringify({ mode, passed: rows.filter((row) => row.passed).length, total: rows.length }));
  if (rows.some((row) => !row.passed)) {
    for (const row of rows.filter((item) => !item.passed)) console.log('FAIL ' + row.name + ': ' + JSON.stringify(row.error));
    process.exitCode = 1;
  } else console.log('PASS ' + mode + ' ' + rows.length + '/' + rows.length);
}

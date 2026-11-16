import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COT_CONTROLLER,
  COT_TRANSLATOR,
  cotConfig,
  cotTranslationActive,
  cotTranslationState,
  pickProvider,
  pickTargetLanguage,
  startCotTranslation,
} from '../../ohos/phone/cot-translation.mjs';

const simulationSymbol = Symbol.for('dsh.go.ohos.sim');
const mountedSymbol = Symbol.for('dsh.go.ohos.cotTranslation');

class FakeTranslator { static inject = []; }
class FakeController { static inject = ['translator', 'typert', 'sessionController']; }

// 每个用例都从干净状态开始：模拟标记与已挂载标记都要清掉。
function sandbox(platform = 'openharmony') {
  const calls = [];
  const lines = [];
  globalThis[simulationSymbol] = true;
  return {
    calls,
    lines,
    platform,
    log: (line) => lines.push(line),
    ctx: { plugin(plugin, config) { calls.push({ plugin, config }); return Promise.resolve(plugin); } },
    done() {
      delete globalThis[mountedSymbol];
      delete globalThis[simulationSymbol];
    },
  };
}

const loadOf = (modules) => async (name) => {
  if (!Object.hasOwn(modules, name)) throw new Error('Cannot find module ' + name);
  return modules[name];
};

const happyModules = () => ({
  [COT_TRANSLATOR]: { default: FakeTranslator },
  [COT_CONTROLLER]: { default: FakeController },
});

test('mounts the official translator then the controller with the bing default', async () => {
  const box = sandbox();
  try {
    const result = await startCotTranslation(box.ctx, { log: box.log, load: loadOf(happyModules()), env: {} });
    assert.deepEqual(result, { provider: 'bing', targetLanguage: 'auto', mounted: ['translator', 'cot-translation'] });
    assert.equal(box.calls.length, 2);
    assert.equal(box.calls[0].plugin, FakeTranslator);
    assert.deepEqual(box.calls[0].config, { provider: 'bing' });
    assert.equal(box.calls[1].plugin, FakeController);
    assert.deepEqual(box.calls[1].config, { provider: 'bing', targetLanguage: 'auto' });
    assert.equal(cotTranslationActive(), true);
    assert.deepEqual(cotTranslationState(), result);
    // fiber 落地是异步的，挂载日志先出现，应用结果随后。
    assert.deepEqual(box.lines.slice(0, 2), ['mount translator {"provider":"bing"}', 'mount cot-translation {"provider":"bing","targetLanguage":"auto"}']);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(box.lines.slice(2), ['applied translator', 'applied cot-translation']);
  } finally { box.done(); }
});

test('honours the provider and language from options, then from the environment', async () => {
  const box = sandbox();
  try {
    const fromOptions = await startCotTranslation(box.ctx, {
      log: box.log, load: loadOf(happyModules()), env: { DSH_GO_COT_PROVIDER: 'google', DSH_GO_COT_TARGET: 'ja' },
      provider: 'deepseek-official', targetLanguage: 'zh-Hant',
    });
    assert.equal(fromOptions.provider, 'deepseek-official');
    assert.equal(fromOptions.targetLanguage, 'zh-Hant');
    assert.deepEqual(box.calls[1].config, { provider: 'deepseek-official', targetLanguage: 'zh-Hant' });
  } finally { box.done(); }
  const second = sandbox();
  try {
    const fromEnv = await startCotTranslation(second.ctx, {
      log: second.log, load: loadOf(happyModules()), env: { DSH_GO_COT_PROVIDER: 'google', DSH_GO_COT_TARGET: 'ja' },
    });
    assert.equal(fromEnv.provider, 'google');
    assert.equal(fromEnv.targetLanguage, 'ja');
  } finally { second.done(); }
});

test('an unknown provider falls back to bing instead of failing the mount', () => {
  assert.equal(pickProvider('nope'), 'bing');
  assert.equal(pickProvider('  '), 'bing');
  assert.equal(pickProvider(undefined), 'bing');
  assert.equal(pickProvider('google'), 'google');
  assert.equal(pickTargetLanguage(''), 'auto');
  assert.equal(pickTargetLanguage(undefined), 'auto');
  assert.equal(pickTargetLanguage('zh-Hant'), 'zh-Hant');
  assert.deepEqual(cotConfig({}, {}), { provider: 'bing', targetLanguage: 'auto' });
  assert.deepEqual(cotConfig({ provider: 'bogus' }, { DSH_GO_COT_PROVIDER: 'google' }), { provider: 'bing', targetLanguage: 'auto' });
});

test('the second start in one engine keeps the first instance', async () => {
  const box = sandbox();
  try {
    await startCotTranslation(box.ctx, { log: box.log, load: loadOf(happyModules()), env: {} });
    const again = await startCotTranslation(box.ctx, { log: box.log, load: loadOf(happyModules()), env: {} });
    assert.equal(again, undefined);
    assert.equal(box.calls.length, 2);
    assert.deepEqual(box.lines.slice(-1), ['already mounted in this engine, keeping the first instance']);
  } finally { box.done(); }
});

test('a missing plugin package is logged and leaves nothing mounted', async () => {
  const box = sandbox();
  try {
    const result = await startCotTranslation(box.ctx, { log: box.log, load: loadOf({}), env: {} });
    assert.equal(result, undefined);
    assert.equal(box.calls.length, 0);
    assert.equal(cotTranslationActive(), false);
    assert.match(box.lines[0], /^load failed: Cannot find module @deepseek-ai\/dsh-experimental-translator$/);
  } finally { box.done(); }
});

test('a package without a default export is refused', async () => {
  const box = sandbox();
  try {
    const modules = { [COT_TRANSLATOR]: { default: FakeTranslator }, [COT_CONTROLLER]: {} };
    const result = await startCotTranslation(box.ctx, { log: box.log, load: loadOf(modules), env: {} });
    assert.equal(result, undefined);
    assert.equal(box.calls.length, 0);
    assert.deepEqual(box.lines, ['unexpected exports translator=function controller=undefined']);
  } finally { box.done(); }
});

test('a context without ctx.plugin is refused', async () => {
  const box = sandbox();
  try {
    const result = await startCotTranslation({}, { log: box.log, load: loadOf(happyModules()), env: {} });
    assert.equal(result, undefined);
    assert.deepEqual(box.lines, ['engine has no ctx.plugin, cannot mount child plugins']);
  } finally { box.done(); }
});

test('other platforms mount nothing unless the simulation flag is set', async () => {
  const box = sandbox('linux');
  delete globalThis[simulationSymbol];
  try {
    const result = await startCotTranslation(box.ctx, { platform: 'linux', log: box.log, load: loadOf(happyModules()), env: {} });
    assert.equal(result, undefined);
    assert.equal(box.calls.length, 0);
    assert.deepEqual(box.lines, []);
    delete globalThis[simulationSymbol];
    // 模拟标记打开后，仿真环境里也能挂上，测试与本地调试都用这条路。
    globalThis[simulationSymbol] = true;
    const simulated = await startCotTranslation(box.ctx, { platform: 'linux', log: box.log, load: loadOf(happyModules()), env: {} });
    assert.equal(simulated.provider, 'bing');
    assert.equal(box.calls.length, 2);
  } finally { box.done(); }
});

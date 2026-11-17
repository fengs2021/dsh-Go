import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNodes, registerUiTools, phoneUiCatalog, classifyFailure, readNativeSnapshot, runScript, resolveShotDir, sessionWorkspace, projectUiResult } from '../../ohos/phone/ui-tools.mjs';
import { resolveKeyPath, fingerprintOf, loadOrCreateKey, frame, FrameReader, HdcLink } from '../../ohos/phone/hdc-link.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 一棵有代表性的 uitest 树：可点按钮、输入框、零宽节点、无文字容器。
const tree = (children) => ({ attributes: { type: 'root', bounds: '[0,0][1260,2720]' }, children });
const node = (attrs, children) => ({ attributes: attrs, children });

test('collectNodes 读出可点/可输入节点并给出中心坐标', () => {
  const { nodes, screen } = collectNodes(tree([
    node({ type: 'Button', text: '签到', clickable: 'true', bounds: '[100,200][300,260]' }),
    node({ type: 'TextInput', hint: '搜索', clickable: 'true', bounds: '[0,300][1260,380]' }),
  ]));
  assert.equal(screen.x2, 1260);
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0].label, '签到');
  assert.equal(nodes[0].clickable, true);
  assert.equal(nodes[0].bounds.cx, 200);
  assert.equal(nodes[0].bounds.cy, 230);
  assert.equal(nodes[1].editable, true);
  assert.equal(nodes[1].label, '搜索');
});

test('零宽/零高节点的 bounds 判成 null：文字还看得到，但不会被当成点击目标', () => {
  const { nodes } = collectNodes(tree([
    node({ type: 'Text', text: '空壳', clickable: 'true', bounds: '[10,10][10,40]' }),
    node({ type: 'Text', text: '反向', clickable: 'true', bounds: '[50,50][20,20]' }),
    node({ type: 'Text', text: '正常', clickable: 'true', bounds: '[0,0][100,50]' }),
  ]));
  assert.deepEqual(nodes.map((n) => n.label), ['空壳', '反向', '正常']);
  assert.equal(nodes[0].bounds, null);
  assert.equal(nodes[1].bounds, null);
  assert.deepEqual(nodes[2].bounds, { x1: 0, y1: 0, x2: 100, y2: 50, cx: 50, cy: 25 });
});

test('没有文字也不是可点的普通容器不进列表，但子节点照样遍历', () => {
  const { nodes } = collectNodes(tree([
    node({ type: 'Column', bounds: '[0,0][1260,1000]' }, [
      node({ type: 'Text', text: '深层按钮', clickable: 'true', bounds: '[10,10][110,60]' }),
    ]),
  ]));
  assert.deepEqual(nodes.map((n) => n.label), ['深层按钮']);
});

test('resolveKeyPath 的优先级：显式选项 > 环境变量 > 用户自备 > 随包', () => {
  assert.equal(resolveKeyPath({ keyPath: '/x/id_rsa' }).source, 'option');
  const home = mkdtempSync(join(tmpdir(), 'dsh-hdc-'));
  const previous = process.env.DSH_GO_PHONE_KEY, previousHome = process.env.DSH_GO_PHONE_HOME;
  try {
    process.env.DSH_GO_PHONE_KEY = '/env/id_rsa';
    assert.equal(resolveKeyPath().source, 'env');
    delete process.env.DSH_GO_PHONE_KEY;
    process.env.DSH_GO_PHONE_HOME = home;
    const source = resolveKeyPath().source;
    assert.ok(source === 'user' || source === 'shipped' || source === 'generated', source);
  } finally {
    if (previous === undefined) delete process.env.DSH_GO_PHONE_KEY; else process.env.DSH_GO_PHONE_KEY = previous;
    if (previousHome === undefined) delete process.env.DSH_GO_PHONE_HOME; else process.env.DSH_GO_PHONE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('密钥可生成、公钥指纹是 32 组冒号分隔的十六进制', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hdckey-'));
  try {
    const keyPath = join(dir, 'id_rsa');
    const key = loadOrCreateKey(keyPath);
    const print = fingerprintOf(key);
    assert.match(print, /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('帧格式与读帧器能往返：头部 11 字节、载荷原样取回', () => {
  const payload = Buffer.from('id\n', 'utf8');
  const wire = frame(3, 1001, payload);
  assert.equal(wire.subarray(0, 2).toString('ascii'), 'HW');
  const seen = [];
  const reader = new FrameReader((f) => seen.push(f));
  reader.push(wire);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].channelId, 3);
  assert.equal(seen[0].cmd, 1001);
  assert.equal(seen[0].payload.toString('utf8'), 'id\n');
});

test('读帧器能处理被切碎的网络分片', () => {
  const wire = frame(5, 10, Buffer.alloc(1024, 0x41));
  const seen = [];
  const reader = new FrameReader((f) => seen.push(f));
  for (let i = 0; i < wire.length; i += 7) reader.push(wire.subarray(i, i + 7));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.length, 1024);
});

// 用假 ctx 走一遍注册：确认四个工具都装上了、审批钩子也挂了、卸载时都摘掉。
const fakeCtx = () => {
  const registered = new Map();
  const hooks = [];
  const disposed = [];
  return {
    registered, hooks, disposed,
    ctx: {
      tools: { register(definition) {
        registered.set(definition.name, definition);
        return () => { disposed.push(definition.name); };
      } },
      on(event, handler) { hooks.push(event); return () => { disposed.push('hook:' + event); }; },
      get() { return undefined; },
    },
  };
};

test('注册：四个手机界面工具全部装上，卸载时全部摘掉', () => {
  const { ctx, registered, hooks, disposed } = fakeCtx();
  const dispose = registerUiTools(ctx);
  assert.deepEqual([...registered.keys()].sort(),
    ['mcp__phone__app', 'mcp__phone__hdc', 'mcp__phone__shell', 'mcp__phone__ui']);
  assert.deepEqual(Object.keys(registered.get('mcp__phone__ui').parameters.properties).includes('action'), true);
  assert.ok(registered.get('mcp__phone__ui').output.schema);
  assert.deepEqual(hooks, ['tools/pre-execute']);
  dispose();
  assert.equal(disposed.length, 5);
});

test('工具目录只暴露 name/description/parameters，不泄漏实现', () => {
  assert.equal(phoneUiCatalog.length, 4);
  for (const entry of phoneUiCatalog) assert.deepEqual(Object.keys(entry).sort(), ['description', 'name', 'parameters']);
});

test('失败分三态：帧已写出却没拿到回执 → outcome_unknown 且 dispatched=true', () => {
  const outcome = classifyFailure(Object.assign(new Error('命令执行超时 30000ms'), { hdcPhase: 'dispatched', executionNonce: 'n-1' }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'outcome_unknown');
  assert.equal(outcome.dispatched, true);
  assert.match(outcome.message, /不要直接重试/);
  assert.match(outcome.message, /n-1/);
});

test('失败分三态：连不上、帧没写出去 → failed 且 dispatched=false（可安全重试）', () => {
  const outcome = classifyFailure(Object.assign(new Error('没检测到无线调试端口'), { hdcPhase: 'not_dispatched' }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'failed');
  assert.equal(outcome.dispatched, false);
  assert.equal(classifyFailure(new Error('随便什么错')).dispatched, false);
  assert.equal(classifyFailure(undefined).code, 'failed');
});

test('readNativeSnapshot 只读快照并归一化，拿不到 binding 时返回 null 而不抛', () => {
  const snapshot = readNativeSnapshot(() => ({ getPhoneSnapshot: () => ({ available: true, foreground: false, engineId: 'eng-1', bridgeGeneration: 7, nowMs: 1, ownerHash: 'x' }) }));
  assert.deepEqual(snapshot, { available: true, foreground: false, engineId: 'eng-1', bridgeGeneration: 7 });
  assert.equal(readNativeSnapshot(() => { throw new Error('No such binding dsh_ohos_publication'); }), null);
  assert.equal(readNativeSnapshot(() => ({})), null);
  assert.equal(readNativeSnapshot(() => null), null);
  assert.equal(readNativeSnapshot(() => ({ getPhoneSnapshot: () => null })), null);
});

test('hdc 连不上时错误标成「未派发」：重试不会重复执行动作', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hdc-'));
  try {
    const link = new HdcLink({ port: 1, connectTimeoutMs: 1500, keyPath: join(dir, 'id_rsa') });
    await assert.rejects(() => link.exec('id'), (error) => error.hdcPhase === 'not_dispatched' && Boolean(error.executionNonce));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- script：一次调用把"进设置→点那一项→读回来"连起来 ----
const recorder = (behaviour = {}) => {
  const calls = [];
  const action = (name) => async (step) => {
    calls.push({ name, step });
    const custom = behaviour[name];
    if (custom) return custom(step, calls.length);
    return { ok: true, code: 'ok', message: name + ' ok', data: '' };
  };
  const actions = { dump: action('dump'), click: action('click'), input: action('input'), wait: action('wait'),
    boom: async () => { throw Object.assign(new Error('连接断了'), { hdcPhase: 'not_dispatched' }); } };
  return { calls, actions };
};

test('script 顺序执行多步并保留每步结果', async () => {
  const { calls, actions } = recorder();
  const outcome = await runScript([{ action: 'click', text: '设置' }, { action: 'wait', ms: 500 }, { action: 'dump', filter: 'Linux' }], actions);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.code, 'ok');
  assert.equal(outcome.dispatched, true, '点过屏幕就必须标成已派发');
  assert.deepEqual(calls.map((c) => c.name), ['click', 'wait', 'dump']);
  assert.match(outcome.data, /1\. click · ok/);
  assert.match(outcome.data, /3\. dump · ok/);
  assert.match(outcome.message, /3 步/);
});

test('script 只读动作不算已派发（失败后可安全重试）', async () => {
  const { actions } = recorder();
  const outcome = await runScript([{ action: 'dump' }, { action: 'wait', ms: 1 }], actions);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.dispatched, false);
});

test('script 遇第一个失败就停，前面的结果照原样回报', async () => {
  const { calls, actions } = recorder({ click: (step, n) => (n === 2
    ? { ok: false, code: 'failed', message: '没找到「不存在」', data: '', dispatched: false }
    : { ok: true, code: 'ok', message: 'ok', data: '' }) });
  const outcome = await runScript([{ action: 'dump' }, { action: 'click', text: '不存在' }, { action: 'dump' }], actions);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'failed');
  assert.equal(outcome.dispatched, false, '第一步是 dump，第二步点了但没生效 → 不应说已派发');
  assert.equal(calls.length, 2, '失败后不许继续跑后面的步骤');
  assert.match(outcome.message, /第 2 步 click 失败/);
  assert.match(outcome.data, /1\. dump/);
  assert.doesNotMatch(outcome.data, /3\./);
});

test('script 中途抛错按三态归类，且已生效的动作仍标 dispatched', async () => {
  const { actions } = recorder();
  const outcome = await runScript([{ action: 'click' }, { action: 'boom' }], actions);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'failed');
  assert.equal(outcome.dispatched, true, '第一步已经点下去了，不能让人直接重试');
  assert.match(outcome.message, /第 2 步 boom 出错/);
});

test('script 拒绝空/超长/嵌套/未知动作/非对象步骤', async () => {
  const { actions } = recorder();
  const cases = [
    [[], /steps 数组/],
    [Array.from({ length: 21 }, () => ({ action: 'dump' })), /最多 20 步/],
    [[{ action: 'script', steps: [] }], /不能嵌套/],
    [[{ action: 'format' }], /不支持：format/],
    [[null], /不是对象/],
  ];
  for (const [steps, pattern] of cases) {
    const outcome = await runScript(steps, actions);
    assert.equal(outcome.ok, false, JSON.stringify(steps));
    assert.equal(outcome.code, 'invalid_args');
    assert.match(outcome.message, pattern);
    assert.equal(outcome.dispatched, false);
  }
});

test('截图目录跟着会话工作区走，不再依赖引擎 cwd', () => {
  assert.equal(resolveShotDir('/data/storage/el2/base/files/runtime/rootfs/root/workspace/DSH-Go'),
    join('/data/storage/el2/base/files/runtime/rootfs/root/workspace/DSH-Go', 'phone-shots'));
  // 拿不到绝对工作区时退回进程 cwd（旧行为），不会抛错。
  assert.equal(resolveShotDir(undefined), join(process.cwd(), 'phone-shots'));
  assert.equal(resolveShotDir(''), join(process.cwd(), 'phone-shots'));
  assert.equal(resolveShotDir('relative/DSH-Go'), join(process.cwd(), 'phone-shots'));
});

test('sessionWorkspace 从工具执行上下文里取会话 cwd', () => {
  const wrapper = (cwd) => ({ agent: { session: { header: { cwd } } } });
  assert.equal(sessionWorkspace(wrapper('/data/x/DSH-Go')), '/data/x/DSH-Go');
  assert.equal(sessionWorkspace(wrapper('C:/Users/x')), undefined);
  assert.equal(sessionWorkspace(wrapper(undefined)), undefined);
  assert.equal(sessionWorkspace({}), undefined);
  assert.equal(sessionWorkspace(undefined), undefined);
  assert.equal(sessionWorkspace({ agent: { session: { header: {} } } }), undefined);
});

test('交回模型的结果用上游口径：status/effect/evidence/dispatched/code/message', () => {
  assert.deepEqual(projectUiResult('mcp__phone__ui', { action: 'dump' }, { ok: true, code: 'ok', message: 'ok', data: 'x' }),
    { status: 'succeeded', effect: 'screen_read', evidence: 'unknown', dispatched: false, code: 'ok', message: 'ok', data: 'x' });
  assert.equal(projectUiResult('mcp__phone__ui', { action: 'click' }, { ok: true, code: 'ok', message: 'ok' }).effect, 'ui_acted');
  assert.equal(projectUiResult('mcp__phone__ui', { action: 'script' },
    { ok: true, code: 'ok', message: 'm', dispatched: true }).effect, 'ui_acted', 'script 点过屏幕就不能说成只读');
  assert.equal(projectUiResult('mcp__phone__app', { action: 'launch' }, { ok: true, code: 'ok', message: 'm' }).effect, 'opened_ui');
  assert.equal(projectUiResult('mcp__phone__shell', { command: 'id' }, { ok: true, code: 'ok', message: 'm' }).effect, 'unknown');
  const unknown = projectUiResult('mcp__phone__ui', { action: 'click' }, { ok: false, code: 'outcome_unknown', message: 'm', dispatched: true });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.effect, 'unknown');
  assert.equal(unknown.dispatched, true);
  const failed = projectUiResult('mcp__phone__ui', { action: 'click' }, { ok: false, code: 'failed', message: 'm' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.effect, 'none');
});

test('输出 schema 与上游 phoneResultSchema 同源，只是 effect 多了界面自动化的值', () => {
  const { ctx, registered } = fakeCtx();
  const dispose = registerUiTools(ctx);
  const schema = registered.get('mcp__phone__ui').output.schema;
  assert.deepEqual(schema.required, ['status', 'effect', 'evidence', 'dispatched', 'code', 'message']);
  for (const value of ['succeeded', 'failed', 'unknown']) assert.ok(schema.properties.status.enum.includes(value));
  for (const value of ['none', 'opened_ui', 'screen_read', 'ui_acted']) assert.ok(schema.properties.effect.enum.includes(value), value);
  assert.equal(schema.properties.evidence.enum.includes('unknown'), true);
  assert.ok(schema.properties.data, 'data 仍然保留：dump 的完整控件列表比 message 长');
  dispose();
});

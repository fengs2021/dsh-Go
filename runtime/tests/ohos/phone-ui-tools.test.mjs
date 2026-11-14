import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNodes, registerUiTools, phoneUiCatalog } from '../../ohos/phone/ui-tools.mjs';
import { resolveKeyPath, fingerprintOf, loadOrCreateKey, frame, FrameReader } from '../../ohos/phone/hdc-link.mjs';
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

// hdc-status.mjs：把诊断结果写成「系统操作」页能读的状态文件，并轮询「重新检测」请求。
// 纯旁路：诊断失败只写状态，不抛给调用方。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hdc-status-'));
process.env.HOME = home;

const {
  stageOf,
  statusOf,
  readRequestedAt,
  requestPath,
  startHdcStatusWatch,
  statusPath,
  writeStatus,
  authorizedStatus,
} = await import('../../../runtime/ohos/phone/hdc-status.mjs');

const authorized = {
  auth: { ok: true, port: 45957, ms: 120 },
  wirelessDebugging: { ok: true, discoveredPorts: [45957], defaultPort: 37123 },
  key: { source: 'user', path: '/tmp/id_rsa', pemBytes: 625, fingerprint: 'ab:cd' },
  hints: ['一', '二', '三', '四'],
};

test('信道路径都在 dsh-app 下', () => {
  assert.equal(statusPath(), path.join(home, '.dsh', 'dsh-app', 'hdc-status.json'));
  assert.equal(requestPath(), path.join(home, '.dsh', 'dsh-app', 'hdc-probe.json'));
});

test('stageOf：通道通了是 authorized，端口没开是 no_port，其余是 unauthorized', () => {
  assert.equal(stageOf(authorized), 'authorized');
  assert.equal(stageOf({ auth: { ok: false }, wirelessDebugging: { ok: false } }), 'no_port');
  assert.equal(stageOf({ auth: { ok: false }, wirelessDebugging: { ok: true } }), 'unauthorized');
  assert.equal(stageOf(null), 'unauthorized');
});

test('statusOf：字段归一化，hints 最多三条且每条截断', () => {
  const status = statusOf(authorized, 'boot');
  assert.equal(status.v, 1);
  assert.equal(status.source, 'boot');
  assert.equal(status.stage, 'authorized');
  assert.equal(status.authorized, true);
  assert.equal(status.port, 45957);
  assert.deepEqual(status.ports, [45957]);
  assert.equal(status.defaultPort, 37123);
  assert.equal(status.pemBytes, 625);
  assert.equal(status.hints.length, 3);
  assert.equal(statusOf({ hints: ['x'.repeat(300)] }).hints[0].length, 200);
  assert.equal(statusOf({}).stage, 'unauthorized');
  assert.equal(statusOf({}).port, 0);
});

test('writeStatus 落在状态文件里，页面读得到', () => {
  writeStatus({ ...statusOf(authorized), source: 'manual' });
  const raw = JSON.parse(fs.readFileSync(statusPath(), 'utf8'));
  assert.equal(raw.source, 'manual');
  assert.equal(raw.stage, 'authorized');
  assert.equal(raw.authorized, true);
});

test('authorizedStatus 记成已授权，并保留附加字段', () => {
  const status = authorizedStatus({ source: 'probe-x' });
  assert.equal(status.stage, 'authorized');
  assert.equal(status.authorized, true);
  assert.equal(status.source, 'probe-x');
  assert.equal(JSON.parse(fs.readFileSync(statusPath(), 'utf8')).source, 'probe-x');
});

test('readRequestedAt：文件缺失或坏掉都当 0', () => {
  assert.equal(readRequestedAt(), 0);
  fs.mkdirSync(path.dirname(requestPath()), { recursive: true });
  fs.writeFileSync(requestPath(), '{坏');
  assert.equal(readRequestedAt(), 0);
  fs.writeFileSync(requestPath(), JSON.stringify({ at: 42 }));
  assert.equal(readRequestedAt(), 42);
});

test('startHdcStatusWatch：看到新请求就跑一次诊断，旧序号不重复跑', async () => {
  fs.writeFileSync(requestPath(), JSON.stringify({ at: 100 }));
  const seen = [];
  const stop = startHdcStatusWatch(null, {
    intervalMs: 10,
    probe: async (source) => { seen.push(source); },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(seen, []);
  fs.writeFileSync(requestPath(), JSON.stringify({ at: 101 }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(seen, ['request']);
  fs.writeFileSync(requestPath(), JSON.stringify({ at: 102 }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(seen, ['request', 'request']);
  stop();
  fs.writeFileSync(requestPath(), JSON.stringify({ at: 103 }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(seen.length, 2);
});

test('startHdcStatusWatch 装了 ctx 时随插件卸载停掉', () => {
  const effects = [];
  const ctx = { effect: (fn, label) => { effects.push([fn, label]); return () => {}; } };
  const stop = startHdcStatusWatch(ctx, { intervalMs: 1000, probe: async () => {} });
  assert.equal(effects.length, 1);
  assert.equal(effects[0][1], 'ohos hdc status watch shutdown');
  effects[0][0]();
  stop();
});

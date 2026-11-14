// 「系统操作」页的调试通道状态：状态判据、落盘格式与「重新检测」请求轮询，纯本地。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stageOf, statusOf, writeStatus, probeAndWrite, readRequestedAt, statusPath, requestPath, startHdcStatusWatch } from '../../ohos/phone/hdc-status.mjs';

const isolated = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hdc-status-'));
  const previous = process.env.HOME;
  process.env.HOME = dir;
  return { dir, restore: () => {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  } };
};

test('状态判据：授权成功、没端口、端口在但没授权，三种不能混', () => {
  assert.equal(stageOf({ auth: { ok: true }, wirelessDebugging: { ok: true } }), 'authorized');
  assert.equal(stageOf({ auth: { ok: false }, wirelessDebugging: { ok: false } }), 'no_port');
  assert.equal(stageOf({ auth: { ok: false, error: '鉴权超时' }, wirelessDebugging: { ok: true } }), 'unauthorized');
});

test('落盘：写进 dsh-app 下的固定文件，字段齐全且 hints 截断到 3 条', () => {
  const { dir, restore } = isolated();
  try {
    const status = statusOf({
      wirelessDebugging: { discoveredPorts: [45957, 45958, 45959, 45960, 45961], defaultPort: 45957, ok: true },
      auth: { ok: false, port: 0, ms: 812, error: '  鉴权超时  ' },
      key: { source: 'shipped', path: '/runtime/phone/hdc-key/id_rsa', pemBytes: 625, fingerprint: '83:f3' },
      hints: ['一', '二', '三', '四']
    }, 'boot');
    assert.equal(status.stage, 'unauthorized');
    assert.equal(status.authorized, false);
    assert.equal(status.ms, 812);
    assert.equal(status.error, '鉴权超时', '多行/多空格要压成一行');
    assert.deepEqual(status.ports, [45957, 45958, 45959, 45960], '端口只留前 4 个');
    assert.equal(status.hints.length, 3);
    assert.equal(status.keySource, 'shipped');
    assert.equal(status.pemBytes, 625);
    writeStatus(status);
    const file = path.join(dir, '.dsh', 'dsh-app', 'hdc-status.json');
    assert.equal(statusPath(), file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.stage, 'unauthorized');
    assert.equal(raw.v, 1);
    // 原子写：不留临时文件
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['hdc-status.json']);
  } finally { restore(); }
});

test('诊断抛错也要落一条 error 状态，页面不至于空白', async () => {
  const { dir, restore } = isolated();
  try {
    const status = await probeAndWrite('boot', { keyPath: '/nonexistent/dir/id_rsa' });
    assert.ok(['error', 'unauthorized', 'no_port'].includes(status.stage), '真实诊断结果之一：' + status.stage);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.dsh', 'dsh-app', 'hdc-status.json'), 'utf8'));
    assert.equal(typeof raw.updatedAt, 'number');
    assert.equal(raw.source, 'boot');
  } finally { restore(); }
});

test('重新检测：请求文件里的新序号才会触发一次诊断，旧序号不重复触发', async () => {
  const { dir, restore } = isolated();
  const calls = [];
  try {
    const request = requestPath();
    fs.mkdirSync(path.dirname(request), { recursive: true });
    fs.writeFileSync(request, JSON.stringify({ at: 1000 }));
    assert.equal(readRequestedAt(), 1000);
    const stop = startHdcStatusWatch(null, { intervalMs: 20, probe: async (source) => { calls.push(source); return null; } });
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual(calls, [], '启动时不该重复跑旧请求');
      fs.writeFileSync(request, JSON.stringify({ at: 2000 }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual(calls, ['request']);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual(calls, ['request'], '同一个序号只跑一次');
    } finally { stop(); }
    // 请求文件缺失或坏了都当作没有请求
    fs.writeFileSync(request, 'not json');
    assert.equal(readRequestedAt(), 0);
  } finally { restore(); }
});

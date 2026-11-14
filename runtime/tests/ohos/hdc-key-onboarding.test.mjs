// 网络调试密钥的来源优先级与自检输出：不依赖任何设备，纯本地判据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveKeyPath, userKeyPath, fingerprintOf, loadOrCreateKey, pubPemOf, diagnoseHdc } from '../../ohos/phone/hdc-link.mjs';

const isolated = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hdc-key-'));
  const previous = { home: process.env.DSH_GO_PHONE_HOME, key: process.env.DSH_GO_PHONE_KEY };
  process.env.DSH_GO_PHONE_HOME = dir;
  delete process.env.DSH_GO_PHONE_KEY;
  return { dir, restore: () => {
    if (previous.home === undefined) delete process.env.DSH_GO_PHONE_HOME; else process.env.DSH_GO_PHONE_HOME = previous.home;
    if (previous.key === undefined) delete process.env.DSH_GO_PHONE_KEY; else process.env.DSH_GO_PHONE_KEY = previous.key;
    fs.rmSync(dir, { recursive: true, force: true });
  } };
};

test('密钥优先级：显式选项 > 环境变量 > 用户自备 > 随包内置', () => {
  const { dir, restore } = isolated();
  try {
    assert.equal(resolveKeyPath({ keyPath: '/tmp/explicit-id_rsa' }).source, 'option');
    assert.equal(resolveKeyPath({ keyPath: '/tmp/explicit-id_rsa' }).path, '/tmp/explicit-id_rsa');
    process.env.DSH_GO_PHONE_KEY = '/tmp/env-id_rsa';
    assert.equal(resolveKeyPath().source, 'env');
    delete process.env.DSH_GO_PHONE_KEY;
    // 没有自备密钥时用随包内置的那把（只对打包者本人的手机有效）
    assert.equal(resolveKeyPath().source, 'shipped');
    // 自备密钥一存在就必须优先，否则用户放进去也永远不生效
    const userPath = userKeyPath();
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, fs.readFileSync(loadOrCreateKey(path.join(dir, 'gen', 'id_rsa')) && path.join(dir, 'gen', 'id_rsa')));
    assert.equal(resolveKeyPath().source, 'user');
    assert.equal(resolveKeyPath().path, userPath);
  } finally { restore(); }
});

test('默认生成的密钥是 3072 位、公钥 PEM 恰好 625 字节，指纹是 SHA-256', () => {
  const { dir, restore } = isolated();
  try {
    const key = loadOrCreateKey(path.join(dir, 'gen', 'id_rsa'));
    assert.equal(key.asymmetricKeyDetails.modulusLength, 3072);
    assert.equal(pubPemOf(key).length, 625);
    assert.match(fingerprintOf(key), /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/);
  } finally { restore(); }
});

test('自检报告带来源、指纹和可执行的中文步骤，且从不假装成功', async () => {
  const { restore } = isolated();
  try {
    const report = await diagnoseHdc({ port: 1, connectTimeoutMs: 300 });
    assert.equal(report.key.source, 'shipped');
    assert.match(report.key.fingerprint, /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/);
    assert.equal(report.key.pubkeyPemBytes, 625);
    assert.equal(report.auth.ok, false);
    assert.ok(report.auth.error.length > 0);
    assert.ok(report.hints.some(hint => hint.includes('无线调试')), '没端口时要指向开发者选项的无线调试');
    assert.ok(report.hints.some(hint => hint.includes('始终允许')), '鉴权失败时要说清弹窗怎么点');
    assert.ok(report.hints.some(hint => hint.includes('hdc-client')), '要告诉用户自备密钥放哪里');
  } finally { restore(); }
});

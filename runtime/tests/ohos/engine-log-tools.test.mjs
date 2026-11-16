import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineLogPaths, resolveEngineLog, tailLines, splitLines, matcherOf, grepLines, clipText, readEngineLog } from '../../ohos/phone/engine-log.mjs';

// 一台"手机"的目录形状：<filesDir> 下有 dsh-runtime/engine.log 和 linux-tools/，
// 引擎的 DSH_HOME 在 <filesDir>/runtime/rootfs/root/.dsh。
function fakeDevice() {
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ohos-log-'));
  fs.mkdirSync(path.join(filesDir, 'dsh-runtime'), { recursive: true });
  fs.mkdirSync(path.join(filesDir, 'linux-tools'), { recursive: true });
  const home = path.join(filesDir, 'runtime/rootfs/root/.dsh');
  fs.mkdirSync(home, { recursive: true });
  const env = { DSH_HOME: home, DSH_GO_OHOS_LINUX_DIRECTORY: path.join(filesDir, 'linux-tools') };
  return { filesDir, home, env, log: path.join(filesDir, 'dsh-runtime/engine.log') };
}

test('engineLogPaths 先看宿主给的 linux 目录兄弟，再从 DSH_HOME 往上找', () => {
  const { filesDir, env } = fakeDevice();
  const paths = engineLogPaths(env);
  assert.equal(paths[0], path.join(filesDir, 'dsh-runtime/engine.log'));
  assert.ok(paths.includes(path.join(filesDir, 'runtime/dsh-runtime/engine.log')), '往上找时会经过 runtime/ 这一层');
  assert.ok(paths.every((entry) => entry.startsWith('/')), '候选路径都是绝对路径');
  assert.equal(new Set(paths).size, paths.length, '候选路径去重');
  // 显式覆盖永远排第一
  assert.equal(engineLogPaths({ ...env, DSH_GO_ENGINE_LOG: '/tmp/x/engine.log' })[0], '/tmp/x/engine.log');
  // 没有任何线索时返回空表，不瞎猜
  assert.deepEqual(engineLogPaths({}), []);
});

test('resolveEngineLog 只认真正存在的文件，滚动文件也算找到', () => {
  const { filesDir, env, log } = fakeDevice();
  assert.equal(resolveEngineLog(env).found, false);
  assert.equal(resolveEngineLog(env).expected, log);
  fs.writeFileSync(log + '.1', 'rotated\n');
  const rotatedOnly = resolveEngineLog(env);
  assert.equal(rotatedOnly.found, true);
  assert.equal(rotatedOnly.file, log);
  assert.equal(rotatedOnly.rotated, log + '.1');
  fs.writeFileSync(log, 'live\n');
  assert.equal(resolveEngineLog(env).file, log);
});

test('tailLines 取末尾若干行，末尾换行不算一行', () => {
  assert.deepEqual(tailLines('a\nb\nc\n', 2), ['b', 'c']);
  assert.deepEqual(tailLines('a\nb\nc', 9), ['a', 'b', 'c']);
  assert.deepEqual(tailLines('only', 3), ['only']);
  assert.deepEqual(tailLines('', 3), []);
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
});

test('matcherOf 正则优先，写坏了退回字面量', () => {
  assert.equal(matcherOf('ERR_\\w+').kind, 'regex');
  assert.ok(matcherOf('ERR_\\w+').test('x ERR_OHOS_LINUX y'));
  assert.equal(matcherOf('([').kind, 'literal', '坏正则不能让整次调用失败');
  assert.ok(matcherOf('([').test('a (['), '坏正则按字面量匹配');
  assert.ok(matcherOf('attach').test('ATTACH thing'), '默认忽略大小写');
  assert.equal(matcherOf('attach', false).test('ATTACH'), false);
  assert.equal(matcherOf(''), null);
});

test('grepLines 带行号、限条数、超长行截断', () => {
  const content = ['a', '[linux] install start', 'b', '[linux] install failed', 'c'].join('\n');
  const grep = grepLines(content, 'linux');
  assert.equal(grep.total, 2);
  assert.deepEqual(grep.hits.map((hit) => hit.number), [2, 4]);
  assert.equal(grepLines(content, 'linux', { limit: 1 }).hits.length, 1);
  assert.equal(grepLines(content, 'linux', { limit: 1 }).total, 2, 'total 是全部命中数，不受 limit 影响');
  const long = grepLines('x'.repeat(5000), 'x');
  assert.equal(long.hits[0].line.length, 2000);
});

test('clipText 截尾不截头，并丢掉被切掉的那半行', () => {
  const short = clipText('abc');
  assert.deepEqual(short, { text: 'abc', truncated: false, droppedBytes: 0 });
  const long = clipText('a'.repeat(10) + '\n' + 'b'.repeat(50), 40);
  assert.equal(long.truncated, true);
  assert.ok(long.text.startsWith('b'), '保留最新的一段');
  assert.ok(long.text.length > 0 && long.text.length <= 40);
});

test('readEngineLog tail 读末尾行并报文件行数', async () => {
  const { env, log } = fakeDevice();
  fs.writeFileSync(log, ['1', '2', '[attach] persist failed', '[linux] install ok'].join('\n') + '\n');
  const out = await readEngineLog({ action: 'tail', lines: 2 }, { env });
  assert.equal(out.ok, true);
  assert.match(out.message, /末尾 2 行（文件共 4 行）/);
  assert.equal(out.data, '[attach] persist failed\n[linux] install ok');
});

test('readEngineLog grep 默认连滚动文件一起找，可以关掉', async () => {
  const { env, log } = fakeDevice();
  fs.writeFileSync(log, 'boot ok\n[attach] persist failed\n');
  fs.writeFileSync(log + '.1', 'old boot\n[linux] install failed ERR_OHOS_LINUX_RECOVERY_REQUIRED\n');
  const both = await readEngineLog({ action: 'grep', pattern: 'ERR_OHOS_LINUX' }, { env });
  assert.equal(both.ok, true);
  assert.match(both.message, /共 1 行/);
  assert.match(both.data, /engine\.log\.1/);
  assert.match(both.data, /ERR_OHOS_LINUX_RECOVERY_REQUIRED/);
  const live = await readEngineLog({ action: 'grep', pattern: 'ERR_OHOS_LINUX', includeRotated: false }, { env });
  assert.equal(live.data, '', '关掉滚动文件就找不到');
  assert.match(live.message, /没有匹配/);
  const none = await readEngineLog({ action: 'grep', pattern: 'nothing-here' }, { env });
  assert.equal(none.ok, true, '没命中不算失败');
  assert.equal(none.data, '');
});

test('readEngineLog 拒绝空 pattern 与未知 action', async () => {
  const { env } = fakeDevice();
  assert.equal((await readEngineLog({ action: 'grep' }, { env })).code, 'invalid_args');
  assert.equal((await readEngineLog({ action: 'purge' }, { env })).code, 'invalid_args');
});

test('readEngineLog 找不到日志时给出期望路径而不是空失败', async () => {
  const { env, log } = fakeDevice();
  const out = await readEngineLog({ action: 'tail' }, { env });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'log_not_found');
  assert.match(out.message, new RegExp(log.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')));
 });

test('readEngineLog path 列出每个候选路径与大小', async () => {
  const { env, log } = fakeDevice();
  fs.writeFileSync(log, 'x'.repeat(1234));
  const out = await readEngineLog({ action: 'path' }, { env });
  assert.equal(out.ok, true);
  assert.match(out.data, /1234 字节/);
  assert.match(out.data, /缺失/);
  assert.match(out.data, /engine\.log/);
});

test('readEngineLog save 把末尾行写进会话工作区', async () => {
  const { env, log } = fakeDevice();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-'));
  fs.writeFileSync(log, 'a\nb\nc\n');
  const out = await readEngineLog({ action: 'save', lines: 2 }, { env, workspace });
  assert.equal(out.ok, true);
  const saved = path.join(workspace, out.data);
  assert.equal(fs.readFileSync(saved, 'utf8'), 'b\nc\n');
  assert.match(out.data, /^engine-log-\d+\.log$/);
});

test('readEngineLog 读不了文件时报 log_unreadable 而不是崩', async () => {
  const { env, log } = fakeDevice();
  fs.writeFileSync(log, 'a\n');
  const out = await readEngineLog({ action: 'tail' }, { env, read: () => { const error = new Error('nope'); error.code = 'EACCES'; throw error; } });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'log_unreadable');
  assert.match(out.message, /EACCES/);
});

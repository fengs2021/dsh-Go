// progress-feed.mjs：把 agent 的实时思考/工具调用压成「一行弹幕」写进固定文件。
// 纯旁路监听：只读事件、只写文件，不改变 agent 行为；停表后文件要清干净。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-progress-feed-'));
process.env.HOME = home;

const { progressFeedPath, arktsStatePath, startProgressFeed } = await import(
  '../../../runtime/ohos/phone/progress-feed.mjs'
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 真事件总线的最小替身：只记录监听函数，测试里手动投喂帧。
const fakeCtx = () => {
  const listeners = new Map();
  const effects = [];
  return {
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    effect(fn, label) {
      effects.push({ fn, label });
      return () => {};
    },
    get() {
      return undefined;
    },
    fire(event, payload) {
      const handler = listeners.get(event);
      if (typeof handler === 'function') handler(payload);
    },
    listeners,
    effects,
  };
};

const readFeed = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const frame = (chunk) => ({ frame: { type: 'chunk', chunk } });
const startFrame = () => ({ frame: { type: 'start' } });

const withFeed = async (body) => {
  const dir = fs.mkdtempSync(path.join(home, 'run-'));
  const file = path.join(dir, 'progress.json');
  const ctx = fakeCtx();
  const stop = startProgressFeed(ctx, { file });
  try {
    await body({ ctx, file });
  } finally {
    stop();
  }
  return { ctx, file };
};

test('进度文件默认落在 <home>/.dsh/dsh-app/，可用 DSH_GO_PROGRESS_FILE 覆盖', () => {
  delete process.env.DSH_GO_PROGRESS_FILE;
  assert.equal(progressFeedPath(), path.join(home, '.dsh', 'dsh-app', 'progress.json'));
  process.env.DSH_GO_PROGRESS_FILE = '/tmp/x/progress.json';
  assert.equal(progressFeedPath(), '/tmp/x/progress.json');
  delete process.env.DSH_GO_PROGRESS_FILE;
  assert.equal(arktsStatePath('/a/b/progress.json'), path.join('/a/b', 'danmaku-arkts.json'));
});

test('空转时也落一份快照：v=1、stage=idle、line 为空、seq 递增', async () => {
  await withFeed(async ({ file }) => {
    assert.ok(fs.existsSync(file), '启动即写一次，ArkTS 侧不会读到旧文件');
    const first = readFeed(file);
    assert.equal(first.v, 1);
    assert.equal(first.stage, 'idle');
    assert.equal(first.line, '');
    assert.ok(first.seq >= 1);
    assert.equal(typeof first.updatedAt, 'number');
  });
});

test('中文思考才上屏：英文思考只留通用话术', async () => {
  await withFeed(async ({ ctx, file }) => {
    ctx.fire('agent/assistant-stream', startFrame());
    ctx.fire('agent/assistant-stream', frame({ type: 'block-start', blockType: 'reasoning' }));
    ctx.fire('agent/assistant-stream', frame({ type: 'reasoning-delta', text: 'The user wants me to check the layout tree first and then decide.' }));
    await sleep(520);
    const english = readFeed(file);
    assert.equal(english.stage, 'thinking');
    assert.equal(english.line, '💭 正在思考…');

    ctx.fire('agent/assistant-stream', frame({ type: 'reasoning-delta', text: '我先看一下当前的界面节点，再决定点哪个按钮。' }));
    await sleep(520);
    const chinese = readFeed(file);
    assert.equal(chinese.stage, 'thinking');
    assert.match(chinese.line, /^💭 /);
    assert.match(chinese.line, /界面节点/);
  });
});

test('工具调用变成中文动作词 + 参数提示', async () => {
  await withFeed(async ({ ctx, file }) => {
    ctx.fire('agent/assistant-stream', startFrame());
    ctx.fire('agent/assistant-stream', frame({ type: 'block-start', blockType: 'tool_use' }));
    ctx.fire('agent/assistant-stream', frame({ type: 'tool-call-delta', name: 'mcp__phone__ui', argumentsDelta: '{"action":"dump"}' }));
    await sleep(520);
    const snapshot = readFeed(file);
    assert.equal(snapshot.stage, 'tool');
    assert.equal(snapshot.tool, 'phone/ui');
    // 快照里只带原始工具名与已经拼好的那一行，参数提示只体现在 line 上。
    assert.equal(snapshot.line, '🛠 手机界面 · dump');
  });
});

test('一轮结束写完成话术，出错写告警话术', async () => {
  await withFeed(async ({ ctx, file }) => {
    ctx.fire('agent/assistant-stream', startFrame());
    ctx.fire('agent/assistant-stream', frame({ type: 'block-start', blockType: 'text' }));
    ctx.fire('agent/assistant-stream', frame({ type: 'text-delta', text: '界面已经打开了，接下来我点右上角那个按钮。' }));
    ctx.fire('agent/status', { status: 'idle' });
    await sleep(520);
    const done = readFeed(file);
    assert.equal(done.stage, 'done');
    assert.match(done.line, /本轮完成/);
    assert.equal(done.status, 'idle');

    ctx.fire('agent/error', { error: { message: '工具调用失败' } });
    await sleep(520);
    const failed = readFeed(file);
    assert.equal(failed.stage, 'error');
    assert.match(failed.line, /工具调用失败/);
  });
});

test('停表：解绑监听、清掉进度文件、留一条可读的停机效果', async () => {
  const { ctx, file } = await withFeed(async ({ ctx, file }) => {
    ctx.fire('agent/assistant-stream', startFrame());
    await sleep(120);
    assert.ok(fs.existsSync(file));
  });
  assert.equal(fs.existsSync(file), false, '停表后不能让 ArkTS 读到上一轮的残留进度');
  assert.equal(ctx.listeners.size, 0);
  const labels = ctx.effects.map((entry) => entry.label);
  assert.deepEqual(labels, ['ohos progress feed']);
  ctx.fire('agent/assistant-stream', startFrame());
  await sleep(120);
  assert.equal(fs.existsSync(file), false);
});

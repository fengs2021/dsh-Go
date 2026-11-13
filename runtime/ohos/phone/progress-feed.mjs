// 后台进度导出：把 agent 的实时思考/工具调用浓缩成「弹幕行」，原子写入固定文件，
// 供 ArkTS 侧（通知栏轮播 / 前台顶部浮层）轮询展示。纯旁路监听，不改变 agent 行为。
import fs from 'node:fs';
import path from 'node:path';

const FEED_VERSION = 1;
const SAMPLE_MS = 400;        // 采样节流
const WRITE_MS = 900;         // 写盘节流
const MIN_HOLD_MS = 2200;     // 一条弹幕最短停留，保证读得完
const IDLE_QUIET_MS = 25000;  // 超过这么久没有事件 → 心跳话术
const POOL_MAX = 8;
const LINE_UNITS = 76;        // 显示宽度上限（半角单位，全角计 2）

const clean = (text) => String(text === undefined || text === null ? '' : text)
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`[^`]*`/g, ' ')
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/\b[0-9a-f]{16,}\b/gi, ' ')
  .replace(/\[\d+\]/g, ' ')
  .replace(/[*#>|]+/g, ' ')
  .replace(/^\s*[-+]\s+/gm, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const width = (text) => {
  let units = 0;
  for (const ch of text) units += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  return units;
};

const clip = (text, units = LINE_UNITS) => {
  if (width(text) <= units) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const step = ch.codePointAt(0) > 0x2e7f ? 2 : 1;
    if (used + step > units - 1) break;
    out += ch;
    used += step;
  }
  return out + '…';
};

// 从一段连续文本里切出「已完成的句子」和「正在写的那一句」。
const sentences = (buffer) => {
  const text = clean(buffer);
  if (!text) return { done: [], live: '' };
  const parts = text.split(/(?<=[。！？；!?;…])/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { done: [], live: '' };
  const live = parts[parts.length - 1];
  const done = parts.slice(0, -1).filter((part) => width(part) >= 8);
  return { done, live: width(live) >= 10 ? live : '' };
};

// tool-call-delta 的参数是流式 JSON 片段，尽力捞一个像样的提示词。
const argumentHint = (text) => {
  const raw = clean(text);
  if (!raw) return '';
  const named = /\b(?:command|path|text|query|filter|action|key|app|title)\s*"?\s*:?\s*"?([^",}]{2,28})/.exec(raw);
  if (named) return named[1];
  return width(raw) > 6 ? raw.slice(0, 24) : '';
};

export function progressFeedPath() {
  const explicit = process.env.DSH_GO_PROGRESS_FILE;
  if (explicit) return explicit;
  const home = process.env.HOME || process.env.DSH_HOME || process.cwd();
  return path.join(home, '.dsh', 'dsh-app', 'progress.json');
}

export function startProgressFeed(ctx, options = {}) {
  const file = options.file || progressFeedPath();
  const now = () => Date.now();
  const state = { stage: 'idle', status: '', turn: 0, step: 0, steps: 0, reasoning: '', answer: '', tool: '', toolHint: '', error: '', startedAt: now(), lastEventAt: now(), lastSwitchAt: 0, pool: [], live: '', seq: 0 };
  const push = (line) => {
    const text = clip(line);
    if (!text) return;
    if (state.pool.includes(text)) return;
    state.pool.push(text);
    while (state.pool.length > POOL_MAX) state.pool.shift();
  };
  const sample = () => {
    const source = state.stage === 'answer' ? state.answer : state.reasoning;
    const result = sentences(source);
    for (const line of result.done.slice(-3)) push(line);
    state.live = result.live;
    if (state.tool) push('🛠 ' + state.tool + (state.toolHint ? ' · ' + state.toolHint : ''));
  };
  const line = () => {
    const quiet = now() - state.lastEventAt;
    if (state.stage === 'error') return clip('⚠\ufe0f ' + (state.error || '执行出错'));
    if (state.stage === 'done') return clip('\u2705 本轮完成 · ' + state.steps + ' 步');
    if (quiet > IDLE_QUIET_MS) return clip('\u23f3 仍在处理… 已 ' + Math.round(quiet / 1000) + ' 秒');
    if (state.stage === 'tool' && state.tool && now() - (state.toolAt || 0) < 6000) return clip('\ud83d\udee0 ' + state.tool + (state.toolHint ? ' · ' + state.toolHint : ''));
    if (state.pool.length > 0) return clip(state.pool[state.pool.length - 1]);
    if (state.live) return clip((state.stage === 'answer' ? '\u270d\ufe0f ' : '\ud83d\udcad ') + state.live);
    if (state.stage === 'answer') return '\u270d\ufe0f 正在组织回答…';
    if (state.stage === 'thinking') return '\ud83d\udcad 正在思考…';
    return '';
  };
  let timer = null;
  let lastWrite = 0;
  let lastLine = '';
  let dirty = true;
  const tick = () => {
    try {
      sample();
      const text = line();
      const urgent = state.stage === 'error' || state.stage === 'done';
      if (text && (urgent || (text !== lastLine && now() - state.lastSwitchAt >= MIN_HOLD_MS))) {
        state.lastSwitchAt = now();
        lastLine = text;
      }
      if (now() - lastWrite < WRITE_MS && !dirty) return;
      lastWrite = now();
      dirty = false;
      const payload = {
        v: FEED_VERSION, updatedAt: now(), stage: state.stage, line: lastLine || text,
        tool: state.tool, turn: state.turn, step: state.step, steps: state.steps,
        status: state.status, elapsedMs: now() - state.startedAt, quietMs: now() - state.lastEventAt,
        recent: state.pool.slice(-4), seq: ++state.seq
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(payload));
      fs.renameSync(temp, file);
    } catch { /* 进度导出永远不能影响 agent */ }
  };
  const reset = () => {
    state.reasoning = '';
    state.answer = '';
    state.tool = '';
    state.toolHint = '';
    state.toolAt = 0;
    state.error = '';
    state.pool = [];
    state.live = '';
    lastLine = '';
    state.lastSwitchAt = 0;
    state.steps = 0;
    state.startedAt = now();
  };
  const touch = () => { state.lastEventAt = now(); dirty = true; };

  const offStream = ctx.on('agent/assistant-stream', (payload) => {
    const frame = payload && payload.frame;
    if (!frame) return;
    if (frame.type === 'start') {
      reset();
      state.stage = 'thinking';
      state.step += 1;
      state.steps += 1;
      touch();
      return;
    }
    if (frame.type === 'end') { touch(); return; }
    const chunk = frame.chunk;
    if (!chunk) return;
    touch();
    switch (chunk.type) {
      case 'block-start':
        if (chunk.blockType === 'reasoning') state.stage = 'thinking';
        else if (chunk.blockType === 'text') state.stage = 'answer';
        else state.stage = 'tool';
        return;
      case 'reasoning-delta':
        state.stage = 'thinking';
        state.reasoning = (state.reasoning + chunk.text).slice(-4000);
        return;
      case 'text-delta':
        if (state.stage !== 'thinking') state.stage = 'answer';
        state.answer = (state.answer + chunk.text).slice(-4000);
        return;
      case 'tool-call-delta':
        state.stage = 'tool';
        state.toolAt = now();
        if (chunk.name) state.tool = String(chunk.name).replace(/^mcp__/, '').replace(/__/g, '/');
        if (chunk.argumentsDelta) state.toolHint = argumentHint((state.toolHint || '') + chunk.argumentsDelta);
        return;
      case 'finish':
        state.stage = state.answer ? 'answer' : 'thinking';
        return;
      default: return;
    }
  });
  const offStatus = ctx.on('agent/status', (payload) => {
    const status = payload && payload.status ? String(payload.status) : '';
    if (!status) return;
    state.status = status;
    if (status === 'idle') state.stage = 'done';
    else if (state.stage === 'done') state.stage = 'thinking';
    touch();
  });
  const offError = ctx.on('agent/error', (payload) => {
    const error = payload && payload.error ? payload.error : payload && payload.failure ? payload.failure : null;
    const message = (error && (error.message || error.code)) || '执行出错';
    state.stage = 'error';
    state.error = clip(String(message), 48);
    touch();
  });

  timer = setInterval(tick, SAMPLE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  tick();
  const stop = () => {
    clearInterval(timer);
    if (typeof offStream === 'function') offStream();
    if (typeof offStatus === 'function') offStatus();
    if (typeof offError === 'function') offError();
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => stop, 'ohos progress feed');
  return stop;
}

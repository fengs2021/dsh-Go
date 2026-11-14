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
const CJK = /[\u3400-\u9fff]/;
// 工具名换成一眼看懂的中文动作词；没登记的就用原名末段。
const TOOL_LABELS = {
  'phone/shell': '手机命令',
  'phone/ui': '手机界面',
  'phone/app': '打开应用',
  'plugin_manager': '插件安装',
  'plugin-manager': '插件安装',
  'bash': '执行命令',
  'read_image': '看截图',
  'web_search': '联网搜索',
  'web_fetch': '读取网页',
  'read': '读文件',
  'write': '写文件',
  'edit': '改文件',
  'grep': '搜代码',
  'glob': '找文件',
  'todo': '整理待办',
  'subagent': '分派子任务'
};
const HINT_FIELDS = ['command', 'path', 'text', 'query', 'filter', 'action', 'key', 'app', 'title', 'spec', 'package', 'target', 'url', 'name'];

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
  // 与其把半句话硬截断，不如退到最近的标点/空格收尾，读起来像一句完整的话。
  const boundary = Math.max(out.lastIndexOf('。'), out.lastIndexOf('，'), out.lastIndexOf('、'),
    out.lastIndexOf('；'), out.lastIndexOf('！'), out.lastIndexOf('？'), out.lastIndexOf(' '));
  if (boundary > 0 && boundary >= out.length * 0.5) return out.slice(0, boundary).replace(/[，、；\s]+$/, '') + '…';
  return out + '…';
};

// 中文字幕只放中文：整段英文思考（夹杂半句、术语、JSON 片段）不上屏，宁可显示通用话术。
const cjkCount = (text) => {
  let count = 0;
  for (const ch of text) if (CJK.test(ch)) count += 1;
  return count;
};
const readableLine = (text) => typeof text === 'string' && cjkCount(text) >= 6;

const labelOf = (tool) => {
  const name = String(tool || '');
  const direct = TOOL_LABELS[name];
  if (direct !== undefined) return direct;
  const parts = name.split('/');
  const last = parts[parts.length - 1] || name;
  return TOOL_LABELS[last] !== undefined ? TOOL_LABELS[last] : (width(last) > 14 ? clip(last, 14) : last);
};

// 从一段连续文本里切出「已完成的句子」和「正在写的那一句」。
// 一段文本里前面半截常是英文思考，后面才接中文；只保留从第一个汉字开始的部分。
const chineseOnly = (text) => {
  const start = text.search(CJK);
  if (start < 0) return '';
  const tail = text.slice(start);
  return cjkCount(tail) >= 6 ? tail : '';
};

const sentences = (buffer) => {
  const text = clean(buffer);
  if (!text) return { done: [], live: '' };
  const parts = text.split(/(?<=[。！？；!?;…])/).map((part) => chineseOnly(part.trim())).filter(Boolean);
  if (parts.length === 0) return { done: [], live: '' };
  const live = parts[parts.length - 1];
  const done = parts.slice(0, -1).filter((part) => width(part) >= 8);
  return { done, live: width(live) >= 10 ? live : '' };
};

// tool-call-delta 的参数是流式 JSON 片段，尽力捞一个像样的提示词。
const argumentHint = (accumulated) => {
  const raw = String(accumulated || '');
  if (!raw) return '';
  const tidy = (value) => {
    const text = clean(value).replace(/^[\s:：,、]+/, '');
    if (!text) return '';
    if (/["{}[\]<>=]/.test(text)) return '';
    return width(text) > 28 ? clip(text, 28) : text;
  };
  // 优先取已经闭合的字段值：\"command\": \"…\" 里那一段不会被截成半句。
  const fieldPattern = new RegExp('"(?:' + HINT_FIELDS.join('|') + ')"\\s*:\\s*"([^"\\\\]{2,80})"');
  const complete = fieldPattern.exec(raw);
  if (complete !== null) {
    const value = tidy(complete[1]);
    if (value) return value;
  }
  // 流还没走完时，只收完全跑出引号外的干净片段，绝不把 JSON 残片搬上屏。
  const tail = new RegExp('(?:' + HINT_FIELDS.join('|') + ')"\\s*:\\s*"([^"\\\\]{4,80})' + '$');
  const open = tail.exec(raw);
  if (open !== null) {
    const value = tidy(open[1]);
    if (value && !/[\\"]/.test(value)) return value;
  }
  return '';
};

export function progressFeedPath() {
  const explicit = process.env.DSH_GO_PROGRESS_FILE;
  if (explicit) return explicit;
  const home = process.env.HOME || process.env.DSH_HOME || process.cwd();
  return path.join(home, '.dsh', 'dsh-app', 'progress.json');
}

// ArkTS 侧的弹幕状态（tick 次数、后台标志、通知结果）写在同一目录，这里一并抄进日志，
// 这样用户只要截一张「设置→诊断」的引擎日志尾部，就能看出是哪一环断了。
export function arktsStatePath(feedFile) {
  return path.join(path.dirname(feedFile), 'danmaku-arkts.json');
}

function readArktsState(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(raw);
    return 'ticks=' + value.ticks + ' bg=' + (value.background ? 1 : 0) +
      ' attached=' + (value.attached ? 1 : 0) + ' notify=' + String(value.notify || '-').slice(0, 40) +
      ' err=' + String(value.error || '-').slice(0, 40);
  } catch {
    return 'absent';
  }
}

function lifecycleFacts(ctx) {
  try {
    const coordinator = typeof ctx.get === 'function' ? ctx.get('ohosLifecycle') : undefined;
    const status = coordinator && typeof coordinator.status === 'function' ? coordinator.status() : undefined;
    const native = status && status.nativeHost ? status.nativeHost : null;
    if (!native) return 'phase=? host=none paused=' + String(status && status.paused);
    return 'phase=' + native.phase + ' fg=' + native.foreground + ' avail=' + native.available +
      ' deadline=' + native.deadlineMs + ' paused=' + String(status.paused) +
      ' manual=' + String(status.manualPaused) + ' busy=' + String(status.busy);
  } catch (error) {
    return 'phase=? err=' + String((error && error.message) || error).slice(0, 40);
  }
}

export function startProgressFeed(ctx, options = {}) {
  const file = options.file || progressFeedPath();
  const now = () => Date.now();
  const state = { stage: 'idle', status: '', turn: 0, step: 0, steps: 0, reasoning: '', answer: '', tool: '', toolArgs: '', toolHint: '', error: '', startedAt: now(), lastEventAt: now(), lastSwitchAt: 0, pool: [], live: '', seq: 0 };
  const toolLine = () => '🛠 ' + labelOf(state.tool) + (state.toolHint ? ' · ' + state.toolHint : '');
  // 归一化后比较：同一句话的多种写法（标点、空白不同）算重复，不再反复上屏。
  const normal = (text) => text.replace(/[\s\p{P}]/gu, '');
  const similar = (left, right) => {
    const a = normal(left);
    const b = normal(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    return shorter.length >= 8 && longer.startsWith(shorter);
  };
  const push = (line) => {
    const text = clip(line);
    if (!text) return;
    const index = state.pool.findIndex((entry) => similar(entry, text));
    if (index >= 0) {
      // 同一句的两种说法只留信息更多的那个：工具提示词是流式到达的，晚到的更完整。
      if (normal(text).length > normal(state.pool[index]).length) state.pool[index] = text;
      return;
    }
    state.pool.push(text);
    while (state.pool.length > POOL_MAX) state.pool.shift();
  };
  const sample = () => {
    const source = state.stage === 'answer' ? state.answer : state.reasoning;
    const result = sentences(source);
    for (const line of result.done.slice(-3)) if (readableLine(line)) push(line);
    state.live = readableLine(result.live) ? result.live : '';
    if (state.tool) push(toolLine());
  };
  const activeStage = (stage) => stage === 'thinking' || stage === 'tool' || stage === 'answer';
  const line = () => {
    const quiet = now() - state.lastEventAt;
    if (state.stage === 'error') return clip('⚠\ufe0f ' + (state.error || '执行出错'));
    if (state.stage === 'done') return quiet > 8000 ? '' : clip('\u2705 本轮完成 · ' + state.steps + ' 步');
    const running = activeStage(state.stage);
    // 只有真正在跑时才抱怨“久没更新”；闲置时安静收场，别把上一轮的进度一直挂在那儿。
    if (!running && state.stage === 'idle') return '';
    if (running && quiet > IDLE_QUIET_MS) return clip('\u23f3 仍在处理… 已 ' + Math.round(quiet / 1000) + ' 秒');
    if (state.stage === 'tool' && state.tool && now() - (state.toolAt || 0) < 6000) return clip(toolLine());
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
        v: FEED_VERSION, updatedAt: now(), stage: state.stage, line: text || (activeStage(state.stage) ? lastLine : ''),
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
    state.toolArgs = '';
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
        else {
          state.stage = 'tool';
          state.toolArgs = '';
          state.toolHint = '';
        }
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
        if (chunk.name) {
          const name = String(chunk.name).replace(/^mcp__/, '').replace(/__/g, '/');
          if (name !== state.tool) state.toolArgs = '';
          state.tool = name;
        }
        if (chunk.argumentsDelta) {
          state.toolArgs = (state.toolArgs + String(chunk.argumentsDelta)).slice(-3000);
          state.toolHint = argumentHint(state.toolArgs);
        }
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

  const arktsFile = arktsStatePath(file);
  let beats = 0;
  const beat = () => {
    try {
      beats += 1;
      console.error('[danmaku] beat ' + beats + ' ' + lifecycleFacts(ctx) + ' stage=' + state.stage +
        ' wrote=' + state.seq + ' line="' + String(state.pool[state.pool.length - 1] || '').slice(0, 24) + '"');
      console.error('[danmaku] arkts ' + readArktsState(arktsFile));
      console.error('[danmaku] file ' + file + ' exists=' + fs.existsSync(file));
    } catch { /* 诊断日志本身不能影响运行 */ }
  };
  const heartbeat = setInterval(beat, 5000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  console.error('[danmaku] progress feed armed, file=' + file);
  timer = setInterval(tick, SAMPLE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  tick();
  const stop = () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    if (typeof offStream === 'function') offStream();
    if (typeof offStatus === 'function') offStatus();
    if (typeof offError === 'function') offError();
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => stop, 'ohos progress feed');
  return stop;
}

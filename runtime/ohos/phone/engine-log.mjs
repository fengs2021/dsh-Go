// 会话内自查引擎日志：ArkTS 宿主把引擎进程的 stdout/stderr 写进 <filesDir>/dsh-runtime/engine.log
// （1 MB 滚动到 engine.log.1）。这个文件就在 App 私有目录里，引擎进程自己读得到，
// 而会话里的 bash 读不到（虚拟 shell 只放行工作区与私有缓存），所以「读日志」只能做成工具。
// 比把日志复制进工作区更省空间，也更新鲜：每次调用读的都是当前文件。
import fs from 'node:fs';
import path from 'node:path';
import { sessionWorkspace } from './ui-tools.mjs';

const LOG_NAME = 'engine.log';
const ACTIONS = ['tail', 'grep', 'path', 'save'];
const MAX_BYTES = 96 * 1024; // 单次回给模型的正文上限：超了截掉最早的部分，不截最新的。
const MAX_LINE = 2000; // 单行上限：日志里偶尔有整段 JSON，别让它把一次调用吃掉。
const TAIL_DEFAULT = 200;
const TAIL_MAX = 2000;
const GREP_DEFAULT = 100;
const GREP_MAX = 500;

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
const result = (ok, code, message, data) => ({ ok, code, message, data: data ?? '' });
export const engineLogSchema = { type: 'object', additionalProperties: false,
  properties: { ok: { type: 'boolean' }, code: { type: 'string' }, message: { type: 'string' }, data: { type: 'string' } },
  required: ['ok', 'code', 'message', 'data'] };

// 三条线索，按可靠性排序：
//   1. 宿主显式给的完整路径（DSH_GO_ENGINE_LOG，目前宿主不设，留给以后）；
//   2. DSH_GO_OHOS_LINUX_DIRECTORY = <filesDir>/linux-tools 的兄弟目录（宿主每次都设，最稳）；
//   3. 从 DSH_HOME = <filesDir>/runtime/rootfs/root/.dsh 往上找（8 层之内必然经过 <filesDir>）。
export function engineLogPaths(env = process.env) {
  const candidates = [];
  const add = (file) => {
    if (typeof file === 'string' && file.startsWith('/') && !candidates.includes(file)) candidates.push(file);
  };
  add(env.DSH_GO_ENGINE_LOG);
  const linux = env.DSH_GO_OHOS_LINUX_DIRECTORY;
  if (typeof linux === 'string' && linux.startsWith('/')) add(path.join(path.dirname(linux), 'dsh-runtime', LOG_NAME));
  const home = env.DSH_HOME;
  if (typeof home === 'string' && home.startsWith('/')) {
    let level = home;
    for (let step = 0; step < 8 && level !== '/'; step += 1) {
      level = path.dirname(level);
      if (level === '/') break;
      add(path.join(level, 'dsh-runtime', LOG_NAME));
    }
  }
  return candidates;
}

// 找到实际存在的那个（live 文件不在但滚动文件还在，也算找到：刚滚动过）。
export function resolveEngineLog(env = process.env, exists = fs.existsSync) {
  const candidates = engineLogPaths(env);
  for (const file of candidates) {
    if (exists(file) || exists(file + '.1')) return { found: true, file, rotated: file + '.1', candidates };
  }
  return { found: false, file: undefined, rotated: undefined, candidates, expected: candidates[0] };
}

export function splitLines(content) {
  const lines = String(content ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function tailLines(content, count) {
  const lines = splitLines(content);
  return lines.slice(Math.max(0, lines.length - count));
}

// 用户给的是正则就用正则，正则写坏了就退回字面量包含：宁可少一分灵活，也不要因为一个手误整次调用失败。
export function matcherOf(pattern, ignoreCase = true) {
  const source = String(pattern ?? '');
  if (!source) return null;
  try {
    const expression = new RegExp(source, ignoreCase ? 'i' : '');
    return { kind: 'regex', test: (line) => expression.test(line) };
  } catch {
    const needle = ignoreCase ? source.toLowerCase() : source;
    return { kind: 'literal', test: (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle) };
  }
}

export function grepLines(content, pattern, { limit = GREP_DEFAULT, ignoreCase = true } = {}) {
  const matcher = matcherOf(pattern, ignoreCase);
  if (matcher === null) return { kind: null, total: 0, hits: [] };
  const hits = [];
  let total = 0;
  splitLines(content).forEach((line, index) => {
    if (!matcher.test(line)) return;
    total += 1;
    if (hits.length < limit) hits.push({ number: index + 1, line: line.slice(0, MAX_LINE) });
  });
  return { kind: matcher.kind, total, hits };
}

// 截尾不截头：日志里最新的才是现场；顺带丢掉被切掉的那半行。
export function clipText(content, maxBytes = MAX_BYTES) {
  const buffer = Buffer.from(String(content ?? ''), 'utf8');
  if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), truncated: false, droppedBytes: 0 };
  const tail = buffer.subarray(buffer.length - maxBytes);
  let clipped = tail.toString('utf8');
  const newline = clipped.indexOf('\n');
  if (newline >= 0) clipped = clipped.slice(newline + 1);
  return { text: clipped, truncated: true, droppedBytes: buffer.length - maxBytes };
}

const fileFacts = (file, exists) => {
  try {
    if (!exists(file)) return null;
    const bytes = fs.statSync(file).size;
    return { file, bytes };
  } catch { return null; }
};

export async function readEngineLog(args = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? fs.existsSync;
  const read = deps.read ?? ((file) => fs.readFileSync(file, 'utf8'));
  const action = String(args.action ?? 'tail');
  // 参数错误先判：不能因为本机恰好没有日志文件，就把"action 写错了"报成"找不到日志"。
  if (!ACTIONS.includes(action)) return result(false, 'invalid_args', 'action 只支持 ' + ACTIONS.join('/'), '');
  if (action === 'grep' && String(args.pattern ?? '').trim() === '') {
    return result(false, 'invalid_args', 'grep 需要 pattern（正则或字面量，例如 ERR_OHOS_LINUX 或 "attach\] persist"）', '');
  }
  const resolved = resolveEngineLog(env, exists);

  if (action === 'path') {
    const lines = ['engine.log 探测结果（按线索顺序）：'];
    for (const file of resolved.candidates) {
      const facts = fileFacts(file, exists);
      lines.push((facts ? '· ' + facts.bytes + ' 字节  ' : '· 缺失  ') + file);
    }
    if (resolved.candidates.length === 0) lines.push('· 没有任何路径线索：DSH_GO_OHOS_LINUX_DIRECTORY 与 DSH_HOME 都不在 App 私有目录下（不在鸿蒙宿主里运行？）');
    const rotated = resolved.rotated ? fileFacts(resolved.rotated, exists) : null;
    if (rotated) lines.push('· 滚动文件 ' + rotated.bytes + ' 字节  ' + resolved.rotated);
    return result(resolved.found, resolved.found ? 'ok' : 'log_not_found', resolved.found ? '找到引擎日志' : '没找到引擎日志', lines.join('\n'));
  }

  if (resolved.file === undefined) {
    return result(false, 'log_not_found',
      '找不到引擎日志。期望位置：' + (resolved.expected ?? '(无路径线索)') + '；可先用 action=path 看探测到的候选路径。', resolved.candidates.join('\n'));
  }

  if (action === 'grep') {
    const pattern = String(args.pattern ?? '').trim();
    if (!pattern) return result(false, 'invalid_args', 'grep 需要 pattern（正则或字面量，例如 ERR_OHOS_LINUX 或 "attach\\] persist"）', '');
    const limit = Math.min(GREP_MAX, Math.max(1, Number.isFinite(args.limit) ? Math.floor(args.limit) : GREP_DEFAULT));
    const ignoreCase = args.ignoreCase !== false;
    const files = [resolved.file];
    const rotatedToo = args.includeRotated !== false && exists(resolved.rotated);
    if (rotatedToo) files.push(resolved.rotated);
    const blocks = [];
    const tally = [];
    let total = 0;
    let kind = null;
    for (const file of files) {
      let content;
      try { content = read(file); }
      catch (error) { blocks.push('（读不了 ' + file + '：' + ((error && error.code) || (error && error.message) || error) + '）'); continue; }
      const remaining = limit - tally.reduce((sum, entry) => sum + entry.shown, 0);
      const grep = grepLines(content, pattern, { limit: Math.max(0, remaining), ignoreCase });
      kind = kind ?? grep.kind;
      total += grep.total;
      const name = path.basename(file);
      if (grep.total > 0) {
        tally.push({ name, total: grep.total, shown: grep.hits.length });
        blocks.push('## ' + name + '（命中 ' + grep.total + ' 行，显示 ' + grep.hits.length + ' 行）');
        for (const hit of grep.hits) blocks.push(hit.number + ': ' + hit.line);
      }
    }
    if (total === 0) {
      return result(true, 'ok', '没有匹配 ' + JSON.stringify(pattern) + '（' + (kind === 'literal' ? '按字面量' : '按正则') + '，文件 ' + files.map((file) => path.basename(file)).join(' + ') + '）', '');
    }
    const clipped = clipText(blocks.join('\n'));
    const brief = tally.map((entry) => entry.name + ' ' + entry.total).join(' / ');
    return result(true, 'ok',
      '匹配 ' + JSON.stringify(pattern) + ' 共 ' + total + ' 行（' + brief + '）' + (clipped.truncated ? '，正文已截断到最新的 ' + MAX_BYTES + ' 字节' : ''),
      clipped.text);
  }

  if (action === 'tail') {
    const count = Math.min(TAIL_MAX, Math.max(1, Number.isFinite(args.lines) ? Math.floor(args.lines) : TAIL_DEFAULT));
    let content;
    try { content = read(resolved.file); }
    catch (error) {
      return result(false, 'log_unreadable', '读不了 ' + resolved.file + '：' + ((error && error.code) || (error && error.message) || error), '');
    }
    const all = splitLines(content);
    const lines = tailLines(content, count);
    const clipped = clipText(lines.join('\n'));
    return result(true, 'ok',
      'engine.log 末尾 ' + lines.length + ' 行（文件共 ' + all.length + ' 行）' + (clipped.truncated ? '，正文已截断到最新的 ' + MAX_BYTES + ' 字节' : ''),
      clipped.text);
  }

  if (action === 'save') {
    const workspace = typeof deps.workspace === 'string' && deps.workspace.startsWith('/') ? deps.workspace : process.cwd();
    const count = Math.min(TAIL_MAX, Math.max(1, Number.isFinite(args.lines) ? Math.floor(args.lines) : 2000));
    let content;
    try { content = read(resolved.file); }
    catch (error) {
      return result(false, 'log_unreadable', '读不了 ' + resolved.file + '：' + ((error && error.code) || (error && error.message) || error), '');
    }
    const target = path.join(workspace, 'engine-log-' + Date.now() + '.log');
    try {
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(target, tailLines(content, count).join('\n') + '\n');
    } catch (error) {
      return result(false, 'save_failed', '日志拿到了，但写不进工作区 ' + workspace + '：' + ((error && error.code) || (error && error.message) || error), '');
    }
    const bytes = fs.statSync(target).size;
    return result(true, 'ok', '已把引擎日志末尾 ' + count + ' 行存到工作区（' + bytes + ' 字节）', path.relative(workspace, target));
  }

  return result(false, 'invalid_args', 'action 只支持 tail/grep/path/save', '');
}

export const engineLogTool = Object.freeze({
  name: 'mcp__engine__log',
  description: '读本机引擎自己的日志（engine.log）：tail 看末尾若干行，grep 按正则/字面量找关键字（默认连上一次启动的滚动文件一起找），path 显示探测到的日志路径，save 把末尾若干行存进工作区。' +
    '排查「工具报错但界面说不清」时用它：工具回执里的 [attach]/[linux]/[phone-hdc]/[ohos-vendor] 等前缀，以及 ERR_* 码都写在里面。只读，不改任何文件（action=save 只写工作区一份副本）。',
  parameters: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['tail', 'grep', 'path', 'save'], description: '动作：tail/grep/path/save' },
    lines: { type: 'number', description: 'tail/save 用：末尾多少行，默认 200（上限 2000）' },
    pattern: { type: 'string', description: 'grep 用：正则或字面量，例如 ERR_OHOS_LINUX 或 "\\[attach\\]"' },
    limit: { type: 'number', description: 'grep 用：最多显示多少行命中的行，默认 100（上限 500）' },
    ignoreCase: { type: 'boolean', description: 'grep 用：是否忽略大小写，默认 true' },
    includeRotated: { type: 'boolean', description: 'grep 用：是否连上一次启动的 engine.log.1 一起找，默认 true' } },
    required: ['action'] },
});

export function registerEngineLogTool(ctx) {
  return ctx.tools.register({
    name: engineLogTool.name, description: engineLogTool.description, parameters: engineLogTool.parameters,
    timeoutMs: 30000,
    output: { schema: engineLogSchema, render: (_args, value) => text(value) },
    async execute(args, exec) {
      try { return await readEngineLog(args || {}, { workspace: sessionWorkspace(exec) }); }
      catch (error) { return result(false, 'log_failed', String((error && error.message) || error), ''); }
    },
  });
}

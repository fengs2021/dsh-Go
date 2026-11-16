/**
 * Session health tools for the OpenHarmony host.
 *
 * A session log lives at <DSH_HOME>/sessions/<workspace>/<id>/session.v4.jsonl.zstd
 * and is a concatenation of independently compressed Zstandard frames, one per
 * durable checkpoint. Node's one-shot and streaming zstd decoders both stop after
 * the first frame, so this module walks the frame structure itself and decodes
 * every frame before parsing the JSONL.
 *
 * The file layout is not workspace-scoped: sessions whose cwd is not a registered
 * workspace still live under a hashed directory here, which is why this reader can
 * see sessions the remote bridge cannot.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sessionWorkspace } from './ui-tools.mjs';

const ZSTD_MAGIC = 0xfd2fb528;
const MAX_SESSIONS = 200;
const MAX_LOG_BYTES = 96 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const DEFAULT_SLOW_MS = 20000;

export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid Zstandard frame magic at byte ' + offset);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('reserved Zstandard frame-header bit at byte ' + (offset - 1));
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved Zstandard block type at byte ' + (offset - 3));
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

export function decodeSessionLog(buffer) {
  if (!buffer || buffer.length === 0) return '';
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return buffer.toString('utf8');
  const { frames } = scanZstdFrames(buffer);
  const parts = [];
  for (const frame of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'));
    } catch {
      // A frame that fails its checksum is dropped; the rest of the log still reads.
    }
  }
  return parts.join('');
}

export function sessionRoot(env = process.env) {
  if (typeof env.DSH_GO_SESSIONS_DIR === 'string' && env.DSH_GO_SESSIONS_DIR.startsWith('/')) return env.DSH_GO_SESSIONS_DIR;
  const home = typeof env.DSH_HOME === 'string' ? env.DSH_HOME : '';
  if (!home) return undefined;
  return path.join(home, 'sessions');
}

export function listSessionLogs(root, io = {}) {
  const readdir = io.readdir ?? fs.readdirSync;
  const statSync = io.statSync ?? fs.statSync;
  if (!root) return [];
  let workspaces = [];
  try {
    workspaces = readdir(root);
  } catch {
    return [];
  }
  const logs = [];
  for (const workspace of workspaces) {
    const directory = path.join(root, workspace);
    let entries = [];
    try {
      entries = readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(directory, entry);
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const file = path.join(dir, name);
        try {
          const info = statSync(file);
          if (!info.isFile()) continue;
          logs.push({ id: entry.startsWith('session-') ? entry : 'session-' + entry, file, bytes: info.size, mtimeMs: info.mtimeMs });
        } catch {
          // Missing variant: try the next name.
        }
      }
    }
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return logs.slice(0, MAX_SESSIONS);
}

export function parseSessionLog(text) {
  let header;
  const events = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (record && record.type === 'session' && header === undefined) {
      header = record;
      continue;
    }
    if (record && typeof record.type === 'string') events.push(record);
  }
  return { header, events };
}

export function isNotice(text) {
  if (typeof text !== 'string') return true;
  const flat = text.trim();
  if (flat === '') return true;
  return /^(The user changed|The approval policy changed|The sandbox mode|The permission preset|用户(把|已将|切换)|已把你)/i.test(flat);
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

export function clip(value, limit = 200) {
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + '…';
}

export function failureOf(event) {
  const data = event && event.data ? event.data : {};
  const candidates = [data.error, data.failure, data.cause, data.reason, data.message, data.code];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === 'string') return clip(candidate, 240);
    const code = candidate && typeof candidate.code === 'string' ? candidate.code : undefined;
    const message = candidate && typeof candidate.message === 'string' ? candidate.message : undefined;
    if (code || message) return clip([code, message].filter(Boolean).join(': '), 240);
    return clip(candidate, 240);
  }
  return undefined;
}

export function summarizeSession(header, events, meta = {}) {
  let firstUser;
  let firstAssistant;
  let updatedAt = header && typeof header.createdAt === 'number' ? header.createdAt : undefined;
  const turns = new Set();
  const steps = new Set();
  let attempts = 0;
  let failures = 0;
  let lastFailure;
  for (const event of events) {
    if (typeof event.time === 'number') updatedAt = Math.max(updatedAt ?? event.time, event.time);
    if (event.type === 'turn/start' && event.data && typeof event.data.turn === 'number') turns.add(event.data.turn);
    if (event.type === 'step/start' && event.data) steps.add((event.data.turn ?? 0) + '/' + (event.data.step ?? 0));
    if (event.type === 'assistant/attempt') attempts += 1;
    if (event.type === 'user/message' && firstUser === undefined) {
      const text = textOf(event.data && event.data.content);
      if (!isNotice(text)) firstUser = text;
    }
    if (event.type === 'assistant/message' && firstAssistant === undefined) firstAssistant = textOf(event.data && event.data.message && event.data.message.content);
    const retried = event.type === 'llm/retry' || event.type === 'assistant/failure' || event.type === 'turn/error';
    const failedTurn = event.type === 'turn/end' && event.data && event.data.reason && event.data.reason.kind && event.data.reason.kind !== 'completed';
    if (retried || failedTurn) {
      failures += 1;
      lastFailure = failureOf(event) ?? clip(event.data && event.data.reason, 200) ?? event.type;
    }
  }
  const title = firstUser ? clip(firstUser, 60) : firstAssistant ? clip(firstAssistant, 60) : '';
  return {
    id: header && header.id ? header.id : meta.id,
    cwd: header && typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: header && typeof header.createdAt === 'number' ? header.createdAt : undefined,
    updatedAt,
    title,
    turns: turns.size,
    steps: steps.size,
    attempts,
    failures,
    lastFailure,
    events: events.length,
    bytes: meta.bytes,
  };
}

export function turnTimings(events, options = {}) {
  const slowMs = typeof options.slowMs === 'number' && options.slowMs > 0 ? options.slowMs : DEFAULT_SLOW_MS;
  const turns = [];
  let current;
  for (const event of events) {
    const time = typeof event.time === 'number' ? event.time : undefined;
    if (event.type === 'turn/start') {
      current = { turn: event.data && event.data.turn, startedAt: time, steps: 0, attempts: [], failures: [], reason: undefined };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (event.type === 'turn/end') {
      current.endedAt = time;
      if (time !== undefined && current.startedAt !== undefined) current.durationMs = time - current.startedAt;
      const reason = event.data && event.data.reason;
      current.reason = reason && typeof reason === 'object' ? clip(reason.kind ?? reason, 80) : clip(reason, 80);
      current = undefined;
      continue;
    }
    if (event.type === 'step/start') current.steps += 1;
    if (event.type === 'assistant/attempt') current.attempts.push({ at: time });
    if (event.type === 'llm/retry' || event.type === 'assistant/failure' || event.type === 'turn/error') {
      const message = failureOf(event) ?? event.type;
      current.failures.push({ at: time, message });
      const open = current.attempts[current.attempts.length - 1];
      if (open && open.durationMs === undefined && time !== undefined && open.at !== undefined) {
        open.durationMs = time - open.at;
        open.failure = message;
      }
    }
  }
  const slowest = turns
    .map(turn => ({ turn: turn.turn, durationMs: turn.durationMs ?? 0 }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 3);
  return { turns, slowest, slow: turns.filter(turn => (turn.durationMs ?? 0) >= slowMs).length };
}

function result(ok, code, message, data) {
  const value = { ok, code };
  if (message) value.message = message;
  if (data !== undefined) value.data = data;
  return value;
}

export function renderSessionSummary(summary) {
  const stamp = typeof summary.updatedAt === 'number' ? new Date(summary.updatedAt).toISOString().slice(5, 19).replace('T', ' ') : '?';
  const title = summary.title || '(无标题)';
  return stamp + '  ' + summary.id + '  轮 ' + summary.turns + ' 尝试 ' + summary.attempts + ' 失败 ' + summary.failures + '  ' + title;
}

export function renderTurn(turn, slowMs = DEFAULT_SLOW_MS) {
  const seconds = turn.durationMs === undefined ? '未结束' : (turn.durationMs / 1000).toFixed(1) + 's';
  const attempts = turn.attempts.map(attempt => (attempt.durationMs === undefined ? '?' : (attempt.durationMs / 1000).toFixed(1)) + 's' + (attempt.failure ? '(' + clip(attempt.failure, 60) + ')' : '')).join(' → ');
  const slow = (turn.durationMs ?? 0) >= slowMs ? ' ⚠慢' : '';
  return '轮 ' + turn.turn + '  ' + seconds + slow + '  步 ' + turn.steps + '  尝试 ' + turn.attempts.length + (attempts ? '  [' + attempts + ']' : '') + (turn.reason ? '  ' + turn.reason : '');
}

export async function readSessions(args = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const read = deps.read ?? (file => fs.readFileSync(file));
  const action = typeof args.action === 'string' ? args.action : 'list';
  if (!['list', 'timing', 'events'].includes(action)) {
    return result(false, 'invalid_args', '未知动作 ' + action + '，可用 list / timing / events');
  }
  const root = sessionRoot(env);
  if (root === undefined) {
    return result(false, 'sessions_unavailable', '拿不到会话目录：环境里没有 DSH_HOME，也没有 DSH_GO_SESSIONS_DIR');
  }
  const logs = deps.logs ?? listSessionLogs(root, deps.io ?? {});
  if (logs.length === 0) return result(false, 'sessions_not_found', '在 ' + root + ' 下没有找到任何 session 日志');

  const wanted = typeof args.session === 'string' && args.session.trim() ? args.session.trim() : undefined;
  const loaded = [];
  const load = entry => {
    if (entry.bytes !== undefined && entry.bytes > MAX_LOG_BYTES) throw new Error('日志过大 ' + entry.bytes + ' 字节');
    const buffer = read(entry.file);
    const text = decodeSessionLog(buffer);
    return { ...entry, ...parseSessionLog(text) };
  };

  if (action === 'list') {
    for (const entry of logs) {
      try {
        const parsed = load(entry);
        loaded.push(summarizeSession(parsed.header, parsed.events, entry));
      } catch (error) {
        loaded.push({ id: entry.id, file: entry.file, bytes: entry.bytes, error: String(error && error.message ? error.message : error) });
      }
    }
    const lines = loaded.map(summary => (summary.error ? '?? ' + summary.id + '  读不出：' + summary.error : renderSessionSummary(summary)));
    return result(true, 'ok', '会话共 ' + loaded.length + ' 条（目录 ' + root + '）', { sessions: loaded, lines });
  }

  const target = wanted
    ? logs.find(entry => entry.id === wanted || entry.id.replace(/^session-/, '') === wanted.replace(/^session-/, ''))
    : logs[0];
  if (!target) return result(false, 'sessions_not_found', '没有找到会话 ' + wanted);
  const parsed = load(target);
  const summary = summarizeSession(parsed.header, parsed.events, target);

  if (action === 'events') {
    const count = typeof args.lines === 'number' && args.lines > 0 ? Math.min(args.lines, 500) : 60;
    const tail = parsed.events.slice(-count);
    const rows = tail.map(event => (typeof event.time === 'number' ? new Date(event.time).toISOString().slice(11, 23) : '?') + '  ' + event.type + '  ' + clip(event.data, 160));
    const text = rows.join('\n');
    return result(true, 'ok', '会话 ' + summary.id + ' 末尾 ' + tail.length + ' / ' + parsed.events.length + ' 条事件', {
      session: summary,
      events: tail,
      text: text.length > MAX_TEXT_BYTES ? text.slice(text.length - MAX_TEXT_BYTES) : text,
    });
  }

  const slowMs = typeof args.slowMs === 'number' && args.slowMs > 0 ? args.slowMs : DEFAULT_SLOW_MS;
  const timings = turnTimings(parsed.events, { slowMs });
  const lines = timings.turns.map(turn => renderTurn(turn, slowMs));
  const worst = timings.slowest[0];
  const headline = '会话 ' + summary.id + ' 轮 ' + timings.turns.length + '，慢轮（≥' + Math.round(slowMs / 1000) + 's）' + timings.slow + ' 个' + (worst && worst.durationMs ? '，最慢 轮' + worst.turn + ' ' + (worst.durationMs / 1000).toFixed(1) + 's' : '');
  return result(true, 'ok', headline, { session: summary, timings: { slowest: timings.slowest, slow: timings.slow, turns: timings.turns }, lines });
}

export const sessionsTool = Object.freeze({
  name: 'mcp__engine__sessions',
  description: '读取本机引擎的会话日志（含 App 里"未分组"的会话）：列会话、看每一轮/每次尝试的耗时与失败原因。参数 action=list|timing|events，session 可给 id（默认最新一条），timing 用 slowMs 判定慢轮，events 用 lines 取末尾事件数。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'timing', 'events'], description: 'list 列会话（默认），timing 看每轮耗时，events 看末尾事件' },
      session: { type: 'string', description: '会话 id，例如 session-618b6fc0-… 或 618b6fc0-…；省略则用最新一条' },
      slowMs: { type: 'number', description: 'timing 里判定"慢轮"的阈值毫秒，默认 20000' },
      lines: { type: 'number', description: 'events 动作返回的事件条数，默认 60，上限 500' },
    },
    additionalProperties: false,
  },
});

export function registerSessionsTool(ctx) {
  const schema = {
    parse(value) {
      return value;
    },
  };
  const text = value => [value.message, ...(Array.isArray(value.data && value.data.lines) ? value.data.lines : [])].filter(Boolean).join('\n');
  return ctx.tools.register({
    name: sessionsTool.name,
    description: sessionsTool.description,
    parameters: sessionsTool.parameters,
    timeoutMs: 30000,
    output: { schema, render: (_args, value) => text(value) },
    async execute(args, exec) {
      try {
        return await readSessions(args || {}, { workspace: sessionWorkspace(exec) });
      } catch (error) {
        return result(false, 'sessions_failed', String(error && error.message ? error.message : error));
      }
    },
  });
}

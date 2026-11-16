import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  scanZstdFrames,
  decodeSessionLog,
  sessionRoot,
  listSessionLogs,
  parseSessionLog,
  summarizeSession,
  turnTimings,
  readSessions,
  isNotice,
  clip,
} from '../../ohos/phone/sessions.mjs';

const header = { type: 'session', version: 4, id: 'session-a', createdAt: 1000, cwd: '/w' };
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

function compressFrames(chunks) {
  return Buffer.concat(chunks.map(chunk => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8'))));
}

function fakeSessions(root) {
  const dir = path.join(root, '--w--', 'session-a');
  fs.mkdirSync(dir, { recursive: true });
  const text = lines([
    header,
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1000, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1001, data: { content: [{ type: 'text', text: '看看这个对话为什么慢' }] } },
    { type: 'assistant/attempt', seq: 3, time: 1002, data: { attempt: 1 } },
    { type: 'llm/retry', seq: 4, time: 61002, data: { error: { code: 'TIMEOUT', message: 'origin did not respond' } } },
    { type: 'step/end', seq: 5, time: 61010, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 61020, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  const half = Math.floor(text.length / 2);
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, compressFrames([text.slice(0, half), text.slice(half)]));
  return file;
}

test('scanZstdFrames finds every frame of a concatenated log', () => {
  const buffer = compressFrames(['alpha', 'beta', 'gamma']);
  const { frames, tornStart } = scanZstdFrames(buffer);
  assert.equal(frames.length, 3);
  assert.equal(tornStart, undefined);
  assert.equal(frames[0].start, 0);
  assert.equal(frames[2].end, buffer.length);
});

test('scanZstdFrames reports a torn tail instead of throwing', () => {
  const buffer = compressFrames(['alpha', 'beta']);
  const cut = buffer.subarray(0, buffer.length - 5);
  const { frames, tornStart } = scanZstdFrames(cut);
  assert.equal(frames.length, 1);
  assert.equal(tornStart, frames[0].end);
});

test('decodeSessionLog reads every frame, and passes plaintext through', () => {
  const zstd = compressFrames(['{"a":1}\n', '{"b":2}\n']);
  assert.equal(decodeSessionLog(zstd), '{"a":1}\n{"b":2}\n');
  assert.equal(decodeSessionLog(Buffer.from('plain\n', 'utf8')), 'plain\n');
  assert.equal(decodeSessionLog(Buffer.alloc(0)), '');
});

test('sessionRoot follows DSH_HOME and prefers an explicit override', () => {
  assert.equal(sessionRoot({ DSH_HOME: '/data/files/.dsh' }), '/data/files/.dsh/sessions');
  assert.equal(sessionRoot({ DSH_HOME: '/x', DSH_GO_SESSIONS_DIR: '/y/sessions' }), '/y/sessions');
  assert.equal(sessionRoot({ DSH_GO_SESSIONS_DIR: 'relative' }), undefined);
  assert.equal(sessionRoot({}), undefined);
});

test('listSessionLogs walks workspace/session directories newest first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sessions-'));
  fakeSessions(root);
  const older = path.join(root, '--w--', 'plain');
  fs.mkdirSync(older, { recursive: true });
  const file = path.join(older, 'session.v4.jsonl');
  fs.writeFileSync(file, 'x');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(file, past, past);
  const logs = listSessionLogs(root);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].id, 'session-a');
  assert.ok(logs[0].file.endsWith('session.v4.jsonl.zstd'));
  assert.equal(logs[1].id, 'session-plain');
  assert.deepEqual(listSessionLogs('/definitely/missing'), []);
  assert.deepEqual(listSessionLogs(undefined), []);
});

test('parseSessionLog keeps the header apart and skips unreadable lines', () => {
  const { header: parsed, events } = parseSessionLog(lines([header, { type: 'turn/start', time: 5, data: {} }]) + 'not json\n');
  assert.equal(parsed.id, 'session-a');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'turn/start');
});

test('summarizeSession ignores system notices when naming a session', () => {
  const events = [
    { type: 'user/message', time: 10, data: { content: [{ type: 'text', text: 'The user changed the approval policy from "ask" to "never"' }] } },
    { type: 'user/message', time: 11, data: { content: [{ type: 'text', text: '真正的第一句' }] } },
    { type: 'assistant/attempt', time: 12, data: {} },
    { type: 'llm/retry', time: 13, data: { error: { code: 'SERVER', message: '524' } } },
  ];
  const summary = summarizeSession(header, events, { bytes: 10 });
  assert.equal(summary.title, '真正的第一句');
  assert.equal(summary.attempts, 1);
  assert.equal(summary.failures, 1);
  assert.equal(summary.lastFailure, 'SERVER: 524');
  assert.ok(isNotice('The approval policy changed from "ask" to "never"'));
  assert.equal(isNotice('正常内容'), false);
});

test('turnTimings reports per-turn duration, attempts and the slow ones', () => {
  const events = [
    { type: 'turn/start', time: 0, data: { turn: 1 } },
    { type: 'step/start', time: 0, data: { turn: 1, step: 1 } },
    { type: 'assistant/attempt', time: 100, data: {} },
    { type: 'llm/retry', time: 121100, data: { error: 'Error 524: A timeout occurred' } },
    { type: 'step/end', time: 121200, data: { turn: 1, step: 1 } },
    { type: 'turn/end', time: 121300, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', time: 200000, data: { turn: 2 } },
    { type: 'turn/end', time: 201000, data: { turn: 2, reason: { kind: 'completed' } } },
  ];
  const { turns, slow, slowest } = turnTimings(events, { slowMs: 20000 });
  assert.equal(turns.length, 2);
  assert.equal(turns[0].durationMs, 121300);
  assert.equal(turns[0].attempts.length, 1);
  assert.equal(turns[0].attempts[0].durationMs, 121000);
  assert.match(turns[0].attempts[0].failure, /524/);
  assert.equal(turns[0].reason, 'completed');
  assert.equal(turns[1].durationMs, 1000);
  assert.equal(slow, 1);
  assert.equal(slowest[0].turn, 1);
});

test('readSessions lists, times and pages through a real log', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
  fakeSessions(path.join(home, 'sessions'));
  const env = { DSH_HOME: home };
  const list = await readSessions({ action: 'list' }, { env });
  assert.equal(list.ok, true);
  assert.equal(list.data.sessions.length, 1);
  assert.match(list.data.lines[0], /看看这个对话为什么慢/);

  const timing = await readSessions({ action: 'timing', session: 'a' }, { env });
  assert.equal(timing.ok, true);
  assert.equal(timing.data.timings.turns.length, 1);
  assert.equal(timing.data.timings.turns[0].durationMs, 60020);
  assert.match(timing.message, /最慢 轮1/);

  const events = await readSessions({ action: 'events', lines: 3 }, { env });
  assert.equal(events.ok, true);
  assert.equal(events.data.events.length, 3);
  assert.equal(events.data.events[2].type, 'turn/end');
});

test('readSessions reports missing input as codes, not exceptions', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
  fakeSessions(path.join(home, 'sessions'));
  const env = { DSH_HOME: home };
  assert.equal((await readSessions({ action: 'nope' }, { env })).code, 'invalid_args');
  assert.equal((await readSessions({}, { env: {} })).code, 'sessions_unavailable');
  assert.equal((await readSessions({ action: 'timing', session: 'zzz' }, { env })).code, 'sessions_not_found');
  assert.equal((await readSessions({}, { env: { DSH_HOME: '/definitely/missing' } })).code, 'sessions_not_found');
});

test('clip flattens whitespace and bounds the length', () => {
  assert.equal(clip('  a\n b  '), 'a b');
  assert.equal(clip({ code: 'X' }), '{"code":"X"}');
  assert.ok(clip('y'.repeat(500), 20).length <= 20);
});

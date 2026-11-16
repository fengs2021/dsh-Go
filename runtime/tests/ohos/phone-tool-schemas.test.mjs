// 工具注册表只认 JSON Schema 的一个子集（type/oneOf/properties/required/
// additionalProperties/items/enum/const + 注解）。曾经把 output.schema 写成带
// parse() 的可执行 schema，ctx.tools.register 抛错 → 整个 ohos-phone 插件加载失败，
// 截图/点击/引擎日志一起消失。这里用**真的**注册表校验器把每组工具的 schema 过一遍。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { JsonSchemaError, assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { registerUiTools } from '../../ohos/phone/ui-tools.mjs';
import { engineLogSchema, readEngineLog, registerEngineLogTool } from '../../ohos/phone/engine-log.mjs';
import { readSessions, registerSessionsTool, sessionsSchema } from '../../ohos/phone/sessions.mjs';
import { phoneCatalog, phoneResultSchema } from '../../ohos/phone/catalog.mjs';

function capture(register) {
  const registered = [];
  const ctx = {
    tools: { register(definition) { registered.push(definition); return () => {}; } },
    on: () => () => {},
    get: () => undefined,
    effect: () => () => {},
  };
  const dispose = register(ctx);
  assert.equal(typeof dispose, 'function', 'registration must return a disposer');
  return registered;
}

function check(definition) {
  assert.equal(typeof definition.name, 'string');
  assert.equal(typeof definition.description, 'string');
  assert.equal(typeof definition.output.render, 'function');
  assertObjectJsonSchema(definition.parameters);
  assertObjectJsonSchema(definition.output.schema);
}

test('every phone and engine tool declares a conforming JSON Schema', () => {
  for (const definition of phoneCatalog) {
    assert.equal(typeof definition.parameters, 'object');
    assertObjectJsonSchema(definition.parameters);
  }
  assertObjectJsonSchema(phoneResultSchema);
  const ui = capture(registerUiTools);
  assert.deepEqual(ui.map(d => d.name).sort(), ['mcp__phone__app', 'mcp__phone__hdc', 'mcp__phone__shell', 'mcp__phone__ui']);
  for (const definition of ui) check(definition);
  const log = capture(registerEngineLogTool);
  assert.equal(log.length, 1);
  for (const definition of log) check(definition);
  const sessions = capture(registerSessionsTool);
  assert.equal(sessions.length, 1);
  for (const definition of sessions) check(definition);
  assert.deepEqual([...ui.map(d => d.name), ...log.map(d => d.name), ...sessions.map(d => d.name)].sort(),
    ['mcp__engine__log', 'mcp__engine__sessions', 'mcp__phone__app', 'mcp__phone__hdc', 'mcp__phone__shell', 'mcp__phone__ui']);
});

test('a Standard Schema object is what the registry refuses', () => {
  assert.throws(() => assertSupportedJsonSchema({ parse(value) { return value; } }), JsonSchemaError);
});

function lines(rows) {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}

test('session results satisfy their own output schema on success and on failure', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sessions-'));
  const dir = path.join(home, 'sessions', '--w--', 'session-a');
  fs.mkdirSync(dir, { recursive: true });
  const text = lines([
    { type: 'session', version: 4, id: 'session-a', createdAt: 1000, cwd: '/w' },
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1001, data: { content: [{ type: 'text', text: '慢' }] } },
    { type: 'turn/end', seq: 2, time: 2000, data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
  const env = { DSH_HOME: home };
  for (const args of [{ action: 'list' }, { action: 'timing' }, { action: 'events', lines: 2 }]) {
    const value = await readSessions(args, { env });
    assert.equal(value.ok, true);
    assert.deepEqual(validateJsonSchemaValue(sessionsSchema, value, 'value'), []);
  }
  const missing = await readSessions({ action: 'nope' }, { env });
  assert.equal(missing.ok, false);
  assert.deepEqual(validateJsonSchemaValue(sessionsSchema, missing, 'value'), [], 'failure results must still satisfy the schema');
});

test('engine log results satisfy their own output schema', async () => {
  const missing = await readEngineLog({ action: 'path' }, { env: {}, exists: () => false });
  assert.equal(missing.ok, false);
  assert.deepEqual(validateJsonSchemaValue(engineLogSchema, missing, 'value'), []);
  const bad = await readEngineLog({ action: 'nope' }, { env: {}, exists: () => false });
  assert.equal(bad.code, 'invalid_args');
  assert.deepEqual(validateJsonSchemaValue(engineLogSchema, bad, 'value'), []);
});

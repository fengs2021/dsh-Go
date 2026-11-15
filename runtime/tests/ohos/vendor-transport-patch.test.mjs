import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchBundledTransport } from '../../ohos/process/vendor-patch.mjs';

const anchor = 'agent=new import_undici.Agent({headersTimeout:timeoutMs,bodyTimeout:timeoutMs,...ca?{connect:{ca}}:{}})';

function bundle(body, root = mkdtempSync(join(tmpdir(), 'dsh-vendor-'))) {
  const dir = join(root, 'billion-context', 'dist');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'index.js');
  writeFileSync(path, body);
  return path;
}

test('a bundled transport prefers the published node:http dispatcher', () => {
  const path = bundle(`function directDispatcher(timeoutMs){let agent;if(!agent){${anchor}}return agent}`);
  const logs = [];
  assert.equal(patchBundledTransport(path, { log: message => logs.push(message) }), 'patched');
  const source = readFileSync(path, 'utf8');
  assert.ok(source.includes("globalThis[Symbol.for('dsh.go.ohos.net')]?.dispatcher??(new import_undici.Agent("));
  assert.ok(source.includes('/* dsh-ohos:transport */'));
  assert.ok(source.includes('return agent'), 'the rest of the bundle survives');
  assert.equal(logs.length, 1);
});

test('an already patched bundle is left untouched', () => {
  const path = bundle(`${anchor}/* dsh-ohos:transport */`);
  assert.equal(patchBundledTransport(path), 'cached');
  assert.ok(readFileSync(path, 'utf8').startsWith(anchor));
});

test('a bundle without the transport anchor is reported and not rewritten', () => {
  const body = 'agent=new import_undici.Agent({})';
  const path = bundle(body);
  const logs = [];
  assert.equal(patchBundledTransport(path, { log: message => logs.push(message) }), 'skipped');
  assert.equal(readFileSync(path, 'utf8'), body);
  assert.match(logs[0], /no transport anchor/);
});

test('unrelated scripts are ignored', () => {
  const path = bundle(anchor);
  const other = path.replace('billion-context', 'something-else');
  assert.equal(patchBundledTransport(other), undefined);
});

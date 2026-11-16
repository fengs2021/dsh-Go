import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SHIM_MARKER, builtinShimSource, createLazyTextDecoder, installBuiltinShims,
  installCompatShims, installEncodingShims, probeBuiltin,
} from '../../ohos/plugins/shims.mjs';

const shimsUrl = pathToFileURL(fileURLToPath(new URL('../../ohos/plugins/shims.mjs', import.meta.url))).href;
const silent = () => {};

const unavailable = () => Object.assign(new Error('ERR_INSPECTOR_NOT_AVAILABLE'), { code: 'ERR_INSPECTOR_NOT_AVAILABLE' });

// A runtime that lacks the inspector must be recognised before anything is hooked.
test('probeBuiltin reports missing builtins with the runtime code', () => {
  assert.deepEqual(probeBuiltin('node:fs'), { available: true });
  const probe = probeBuiltin('node:inspector', () => { throw unavailable(); });
  assert.deepEqual(probe, { available: false, code: 'ERR_INSPECTOR_NOT_AVAILABLE' });
  const odd = probeBuiltin('node:inspector', () => { throw 'not an error'; });
  assert.deepEqual(odd, { available: false, code: 'UNKNOWN' });
});

test('builtinShimSource carries a stub with probe APIs and guarded calls', () => {
  const source = builtinShimSource('node:inspector');
  assert.equal(typeof source, 'string');
  assert.match(source, /export const url = \(\) => undefined;/);
  assert.match(source, /ERR_DSHGO_BUILTIN_UNAVAILABLE/);
  assert.match(source, /export default \{/);
  assert.equal(builtinShimSource('node:fs'), undefined);
});

test('installBuiltinShims leaves a complete runtime alone', () => {
  let registered = 0;
  const result = installBuiltinShims({ probe: () => ({ available: true }), register: () => { registered += 1; }, log: silent });
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.skipped.map(entry => entry.reason), ['available', 'available']);
  assert.equal(result.hooked, false);
  assert.equal(registered, 0);
});

test('installBuiltinShims redirects ESM importers only', () => {
  let hook;
  const lines = [];
  const result = installBuiltinShims({
    probe: () => ({ available: false, code: 'ERR_INSPECTOR_NOT_AVAILABLE' }),
    register: (value) => { hook = value; },
    log: line => lines.push(line),
  });
  assert.equal(result.hooked, true);
  assert.equal(result.installed.length, 2);
  assert.equal(lines.some(line => line.includes('node:inspector is missing')), true);

  const next = () => ({ url: 'file:///real.js' });
  const imported = hook.resolve('node:inspector', { conditions: ['node', 'import'] }, next);
  assert.equal(imported.shortCircuit, true);
  assert.match(imported.url, /^data:text\/javascript;base64,/);
  const decoded = Buffer.from(imported.url.split(',')[1], 'base64').toString('utf8');
  assert.match(decoded, /export const url/);
  assert.match(lines.at(-1), /resolved to a compatibility stub/);

  // CJS keep the real resolution: a `node:` stub breaks the CJS loader.
  assert.deepEqual(hook.resolve('node:inspector', { conditions: ['node', 'require'] }, next), { url: 'file:///real.js' });
  assert.deepEqual(hook.resolve('node:inspector', {}, next), { url: 'file:///real.js' });
  assert.deepEqual(hook.resolve('node:fs', { conditions: ['import'] }, next), { url: 'file:///real.js' });
});

test('installBuiltinShims reports a loader without registerHooks instead of pretending', () => {
  const lines = [];
  const result = installBuiltinShims({
    probe: () => ({ available: false, code: 'ERR_INSPECTOR_NOT_AVAILABLE' }),
    register: null,
    log: line => lines.push(line),
  });
  assert.equal(result.hooked, false);
  assert.deepEqual(result.installed, []);
  assert.equal(lines.some(line => line.includes('registerHooks is unavailable')), true);
});

class Utf8OnlyDecoder {
  constructor(label = 'utf-8', options = undefined) {
    const key = String(label).toLowerCase();
    if (key === 'boom') throw new RangeError('boom');
    if (key !== 'utf-8') throw Object.assign(new Error(`ERR_ENCODING_NOT_SUPPORTED: ${key}`), { code: 'ERR_ENCODING_NOT_SUPPORTED' });
    this.encoding = 'utf-8';
    this.fatal = Boolean(options?.fatal);
    this.ignoreBOM = Boolean(options?.ignoreBOM);
  }
  decode(input = '') { return String(input); }
}

test('the lazy decoder keeps utf-8 native and fails only when a legacy label decodes', () => {
  const lines = [];
  const Shim = createLazyTextDecoder(Utf8OnlyDecoder, { log: line => lines.push(line) });
  const utf8 = new Shim('utf-8', { fatal: true });
  assert.equal(utf8.decode('hi'), 'hi');
  assert.equal(utf8.encoding, 'utf-8');
  assert.equal(utf8.fatal, true);

  const gbk = new Shim('GBK', { fatal: true, ignoreBOM: true });
  assert.equal(gbk.encoding, 'gbk');
  assert.equal(gbk.fatal, true);
  assert.equal(gbk.ignoreBOM, true);
  assert.throws(() => gbk.decode('x'), (error) => {
    assert.equal(error.code, 'ERR_ENCODING_NOT_SUPPORTED');
    assert.equal(error.encoding, 'gbk');
    return true;
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /TextDecoder\(gbk\) is emulated/);
  assert.equal(Object.prototype.toString.call(gbk), '[object TextDecoder]');

  assert.throws(() => new Shim('boom'), RangeError);
});

test('installEncodingShims only moves a runtime that cannot construct legacy labels', () => {
  const capable = { TextDecoder: class Capable { constructor() {} decode() { return ''; } } };
  assert.deepEqual(installEncodingShims({ scope: capable, log: silent, util: {} }), { installed: false, reason: 'legacy encodings available' });
  assert.equal(capable.TextDecoder.name, 'Capable');

  const scope = { TextDecoder: Utf8OnlyDecoder };
  const util = { TextDecoder: class Other { constructor() {} } };
  const first = installEncodingShims({ scope, log: silent, util });
  assert.equal(first.installed, true);
  assert.equal(first.utilPatched, true);
  assert.equal(scope.TextDecoder[SHIM_MARKER], true);
  assert.equal(util.TextDecoder, scope.TextDecoder);
  assert.deepEqual(installEncodingShims({ scope, log: silent, util }), { installed: false, reason: 'already installed' });
  assert.deepEqual(installEncodingShims({ scope: { TextDecoder: undefined }, log: silent }), { installed: false, reason: 'no TextDecoder' });
});

// A real loader round-trip: the plugin that used to die at import now loads and
// only the debugger feature is missing.
test('a plugin importing node:inspector loads through the stub', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-shim-'));
  try {
    const plugin = join(dir, 'plugin.mjs');
    writeFileSync(plugin, [
      "import inspector, { Session } from 'node:inspector';",
      'const report = { urlType: typeof inspector.url, urlValue: String(inspector.url()), hasSession: typeof Session };',
      'try {',
      "  new inspector.Session();",
      "  report.threw = false;",
      '} catch (error) {',
      '  report.threw = true;',
      '  report.code = error.code;',
      '}',
      'export default report;',
    ].join('\n'));
    const runner = join(dir, 'runner.mjs');
    writeFileSync(runner, [
      `import { installBuiltinShims } from '${shimsUrl}';`,
      "installBuiltinShims({ probe: () => ({ available: false, code: 'ERR_INSPECTOR_NOT_AVAILABLE' }), log: () => {} });",
      `const plugin = await import('${pathToFileURL(plugin).href}');`,
      'console.log(JSON.stringify(plugin.default));',
    ].join('\n'));
    const output = execFileSync(process.execPath, ['--no-warnings', runner], { encoding: 'utf8' });
    const report = JSON.parse(output.trim().split('\n').at(-1));
    assert.deepEqual(report, { urlType: 'function', urlValue: 'undefined', hasSession: 'function', threw: true, code: 'ERR_DSHGO_BUILTIN_UNAVAILABLE' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installCompatShims honours the opt-out and installs once', () => {
  const lines = [];
  const disabled = installCompatShims({ env: { DSH_GO_NO_OHOS_SHIMS: '1' }, log: line => lines.push(line) });
  assert.deepEqual(disabled, { installed: false, reason: 'disabled' });
  assert.equal(globalThis[SHIM_MARKER], undefined);
  assert.equal(lines.some(line => line.includes('DSH_GO_NO_OHOS_SHIMS=1')), true);

  const scope = { TextDecoder: Utf8OnlyDecoder };
  const first = installCompatShims({
    env: {},
    log: silent,
    scope,
    util: {},
    register: () => {},
    probe: () => ({ available: false, code: 'ERR_INSPECTOR_NOT_AVAILABLE' }),
  });
  assert.equal(first.installed, true);
  assert.equal(first.builtins.hooked, true);
  assert.equal(first.encoding.installed, true);
  assert.deepEqual(installCompatShims({ env: {}, log: silent }), { installed: false, reason: 'already installed' });
});

// Compatibility shims for the stripped Node build the phone ships.
//
// The OpenHarmony runtime is Node without the inspector and with small-icu (utf-8
// decoders only). A plugin that touches either at module scope dies while it is
// still being imported, so the host can only report "did not activate" and the
// plugin silently disappears from the UI. These shims keep the same capability
// limits but make the failure lazy, so the plugin loads and the missing feature
// fails on use instead of at import:
//
//   - node:inspector resolves to a stub that reports no debugger session;
//   - TextDecoder keeps its constructor total for legacy labels and raises
//     ERR_ENCODING_NOT_SUPPORTED when an emulated decoder actually decodes.
//
// Only ESM requests are redirected. Node's CJS loader refuses a non-builtin
// resolution for a `node:` specifier, and the guarded require pattern
// (`createRequire(...)('node:inspector')` inside try/catch) already copes.
//
// Set DSH_GO_NO_OHOS_SHIMS=1 to boot without any of this and compare behaviour.

import { createRequire, registerHooks } from 'node:module';

export const SHIM_MARKER = Symbol.for('dsh.go.ohos.shims');

const inspectorSource = [
  'const unavailable = api => {',
  '  const error = new Error("ERR_DSHGO_BUILTIN_UNAVAILABLE: node:inspector is not available in this runtime");',
  '  error.code = "ERR_DSHGO_BUILTIN_UNAVAILABLE";',
  '  error.builtin = "node:inspector";',
  '  error.api = api;',
  '  return error;',
  '};',
  'const noop = () => {};',
  'export const url = () => undefined;',
  'export const open = () => { throw unavailable("open"); };',
  'export const close = () => { throw unavailable("close"); };',
  'export const waitForDebugger = () => Promise.reject(unavailable("waitForDebugger"));',
  'export class Session { constructor() { throw unavailable("Session"); } }',
  'export const console = { log: noop, info: noop, warn: noop, error: noop, debug: noop, dir: noop, trace: noop,',
  '  time: noop, timeEnd: noop, timeLog: noop, timeStamp: noop, assert: noop, count: noop, countReset: noop,',
  '  group: noop, groupEnd: noop, groupCollapsed: noop, table: noop, profile: noop, profileEnd: noop,',
  '  markTimeline: noop, timeline: noop, timelineEnd: noop };',
  'export default { url, open, close, waitForDebugger, Session, console };',
].join('\n');

const inspectorPromisesSource = [
  'const unavailable = api => {',
  '  const error = new Error("ERR_DSHGO_BUILTIN_UNAVAILABLE: node:inspector/promises is not available in this runtime");',
  '  error.code = "ERR_DSHGO_BUILTIN_UNAVAILABLE";',
  '  error.builtin = "node:inspector/promises";',
  '  error.api = api;',
  '  return error;',
  '};',
  'export const url = () => undefined;',
  'export const open = () => Promise.reject(unavailable("open"));',
  'export const close = () => Promise.reject(unavailable("close"));',
  'export const waitForDebugger = () => Promise.reject(unavailable("waitForDebugger"));',
  'export class Session { constructor() { throw unavailable("Session"); } }',
  'export default { url, open, close, waitForDebugger, Session };',
].join('\n');

const stubs = new Map([
  ['node:inspector', { source: inspectorSource, note: 'reports no debugger session; Session/open/close raise ERR_DSHGO_BUILTIN_UNAVAILABLE' }],
  ['node:inspector/promises', { source: inspectorPromisesSource, note: 'reports no debugger session; Session/open/close raise ERR_DSHGO_BUILTIN_UNAVAILABLE' }],
]);

const message = error => (error && typeof error.message === 'string' ? error.message : String(error));

const defaultLog = line => {
  try { console.error(line); } catch { /* the host may already be tearing down */ }
};

/** The ESM source of the stub for `specifier`, or undefined when we carry no stub. */
export function builtinShimSource(specifier) {
  return stubs.get(specifier)?.source;
}

/** `{ available, code }` for one builtin, so the caller can log why it shimmed. */
export function probeBuiltin(specifier, require = createRequire(import.meta.url)) {
  try {
    require(specifier);
    return { available: true };
  } catch (error) {
    return { available: false, code: typeof error?.code === 'string' ? error.code : 'UNKNOWN' };
  }
}

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;

/**
 * Point every builtin this runtime lacks at its stub, for ESM importers only.
 * `register` and `probe` are injectable so the decision logic stays testable
 * without touching the real loader.
 */
export function installBuiltinShims({ probe = probeBuiltin, register = registerHooks, log = defaultLog, specs = [...stubs.keys()] } = {}) {
  const installed = [];
  const skipped = [];
  for (const specifier of specs) {
    if (!stubs.has(specifier)) {
      skipped.push({ specifier, reason: 'no stub' });
      continue;
    }
    const result = probe(specifier);
    if (result.available) skipped.push({ specifier, reason: 'available' });
    else installed.push({ specifier, code: result.code, note: stubs.get(specifier).note });
  }
  if (installed.length === 0) return { installed, skipped, hooked: false };
  if (typeof register !== 'function') {
    log('[ohos-shim] module.registerHooks is unavailable; plugin builtin shims stay off');
    return { installed: [], skipped, hooked: false };
  }
  const urls = new Map(installed.map(({ specifier }) => [specifier, dataUrl(stubs.get(specifier).source)]));
  register({
    resolve(specifier, context, nextResolve) {
      const url = urls.get(specifier);
      if (url === undefined) return nextResolve(specifier, context);
      // A `node:` specifier that resolves outside the builtin table breaks the
      // CJS loader ("Cannot read properties of undefined (reading 'exports')"),
      // and guarded requires already survive the real error.
      const conditions = context?.conditions;
      if (!Array.isArray(conditions) || conditions.includes('require')) return nextResolve(specifier, context);
      log(`[ohos-shim] ${specifier} resolved to a compatibility stub: ${stubs.get(specifier).note}`);
      return { url, shortCircuit: true };
    },
  });
  for (const entry of installed) log(`[ohos-shim] ${entry.specifier} is missing in this runtime (${entry.code}); ESM importers get a stub`);
  return { installed, skipped, hooked: true };
}

/**
 * A TextDecoder whose constructor stays total when this build lacks the label.
 * Supported labels delegate to the native decoder untouched, so utf-8 semantics
 * (fatal, ignoreBOM, streaming) are exactly the runtime's own.
 */
export function createLazyTextDecoder(Native, { log = defaultLog } = {}) {
  class TextDecoder {
    #native;
    #label;
    #options;
    #failure;

    constructor(label = 'utf-8', options = undefined) {
      this.#options = options;
      this.#label = String(label).toLowerCase();
      try {
        this.#native = new Native(label, options);
        this.#label = this.#native.encoding;
      } catch (error) {
        if (error?.code !== 'ERR_ENCODING_NOT_SUPPORTED') throw error;
        this.#failure = error;
        log(`[ohos-shim] TextDecoder(${this.#label}) is emulated: this runtime carries utf-8 decoders only, decode() will raise ERR_ENCODING_NOT_SUPPORTED`);
      }
    }

    get encoding() { return this.#label; }
    get fatal() { return this.#native === undefined ? Boolean(this.#options?.fatal) : this.#native.fatal; }
    get ignoreBOM() { return this.#native === undefined ? Boolean(this.#options?.ignoreBOM) : this.#native.ignoreBOM; }

    decode(input = undefined, options = undefined) {
      if (this.#native !== undefined) return this.#native.decode(input, options);
      const error = new Error(`ERR_ENCODING_NOT_SUPPORTED: ${this.#label} is not supported by this runtime (utf-8 only)`);
      error.code = 'ERR_ENCODING_NOT_SUPPORTED';
      error.encoding = this.#label;
      error.cause = this.#failure;
      throw error;
    }
  }
  Object.defineProperty(TextDecoder.prototype, Symbol.toStringTag, { value: 'TextDecoder', configurable: true });
  return TextDecoder;
}

/**
 * Install the lazy decoder when this build cannot construct legacy labels.
 * The global and `node:util` both move, because plugins reach for either one.
 */
export function installEncodingShims({ scope = globalThis, Native = scope?.TextDecoder, util, log = defaultLog } = {}) {
  if (typeof Native !== 'function') return { installed: false, reason: 'no TextDecoder' };
  if (Native[SHIM_MARKER] === true) return { installed: false, reason: 'already installed' };
  try {
    new Native('gbk');
    return { installed: false, reason: 'legacy encodings available' };
  } catch (error) {
    if (error?.code !== 'ERR_ENCODING_NOT_SUPPORTED') throw error;
  }
  const Shim = createLazyTextDecoder(Native, { log });
  Object.defineProperty(Shim, SHIM_MARKER, { value: true });
  scope.TextDecoder = Shim;
  let utilPatched = false;
  try {
    const module = util ?? createRequire(import.meta.url)('node:util');
    if (typeof module?.TextDecoder === 'function' && module.TextDecoder !== Shim) {
      Object.defineProperty(module, 'TextDecoder', { value: Shim, writable: true, configurable: true, enumerable: true });
      utilPatched = module.TextDecoder === Shim;
    }
  } catch (error) {
    log(`[ohos-shim] could not patch node:util TextDecoder: ${message(error)}`);
  }
  log('[ohos-shim] TextDecoder shim installed: legacy labels construct lazily and raise on decode, utf-8 unchanged');
  return { installed: true, utilPatched };
}

/** Both shims, once per process. Safe to call from every preload surface. */
export function installCompatShims({ log = defaultLog, env = process.env, ...options } = {}) {
  if (globalThis[SHIM_MARKER] === true) return { installed: false, reason: 'already installed' };
  if (env?.DSH_GO_NO_OHOS_SHIMS === '1') {
    log('[ohos-shim] DSH_GO_NO_OHOS_SHIMS=1 keeps the stripped runtime unpatched');
    return { installed: false, reason: 'disabled' };
  }
  Object.defineProperty(globalThis, SHIM_MARKER, { value: true, configurable: true });
  const builtins = installBuiltinShims({ log, ...options });
  const encoding = installEncodingShims({ log, ...options });
  return { installed: true, builtins, encoding };
}

import { createHttpDispatcher } from './dispatcher.mjs';

const nodeFetch = globalThis.fetch;

// Every Undici copy reads its default dispatcher from these thread globals, and the
// copies bundled into plugins ship llhttp as WebAssembly — which a --jitless V8 does
// not expose. Publishing our node:http transport keeps plugin transports off WASM.
// Only Undici's own default Agent is displaced; any other owner keeps control.
const undiciDispatcherSymbols = ['undici.globalDispatcher.1', 'undici.globalDispatcher.2'].map(key => Symbol.for(key));

function isUndiciDefaultAgent(current) {
  return typeof current === 'object' && current !== null
    && typeof current.dispatch === 'function' && current.constructor?.name === 'Agent';
}

const displaceable = current => current === undefined || isUndiciDefaultAgent(current);

function publishUndiciDispatcher(dispatcher) {
  // This hook runs before application code, so a non-default value already here
  // belongs to an explicit owner and must survive.
  if (!displaceable(globalThis[undiciDispatcherSymbols[0]])) return false;
  for (const symbol of undiciDispatcherSymbols) {
    if (!displaceable(globalThis[symbol])) continue;
    // Undici defines these as writable but non-configurable, so assignment is the
    // only legal replacement; only a missing slot may be defined from scratch.
    if (Object.hasOwn(globalThis, symbol)) globalThis[symbol] = dispatcher;
    else Object.defineProperty(globalThis, symbol, { value: dispatcher, writable: true, enumerable: false, configurable: true });
  }
  return true;
}

export function createFetch(dispatcher) {
  // Explicit dispatchers carry DNS pins and proxy policy; never discard them.
  return (input, init) => nodeFetch(input, { ...init, dispatcher: init?.dispatcher ?? dispatcher });
}

export function installFetch() {
  if (process.platform !== 'openharmony' && globalThis[Symbol.for('dsh.go.ohos.sim')] !== true) return;
  const key = Symbol.for('dsh.go.ohos.net');
  if (globalThis[key]) return globalThis[key];
  const network = {
    createDispatcher: createHttpDispatcher,
    dispatcher: createHttpDispatcher({ proxyEnv: process.env.NODE_USE_ENV_PROXY === '1' ? process.env : {} }),
    fetch: (input, init) => nodeFetch(input, { ...init, dispatcher: init?.dispatcher ?? network.dispatcher }),
  };
  globalThis[key] = network;
  globalThis.fetch = network.fetch;
  network.publishesUndiciDispatcher = publishUndiciDispatcher(network.dispatcher);
  if (!network.publishesUndiciDispatcher) console.error('[ohos-net] undici keeps its existing dispatcher owner');
  return network;
}

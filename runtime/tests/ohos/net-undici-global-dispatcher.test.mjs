import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const fetchModule = fileURLToPath(new URL('../../ohos/net/fetch.mjs', import.meta.url));

// installFetch mutates thread globals, so each case gets a clean process. The module
// is imported dynamically: importing it reads globalThis.fetch, which materialises
// Undici's own global dispatcher symbols before a case could seed one.
async function run(body) {
  const script = `const load = () => import(${JSON.stringify(fetchModule)});\n${body}`;
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_USE_ENV_PROXY', 'DSH_GO_OHOS_SIM', 'DSH_GO_OHOS_SIM_PLATFORM']) delete env[key];
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], { env, timeout: 15000 });
  return JSON.parse(stdout.trim());
}

const helpers = `const sym = (name) => globalThis[Symbol.for(name)];
const report = (first) => ({ installed: Boolean(first),
  fetchReplaced: first ? globalThis.fetch === first.fetch : false,
  legacyOwns: sym('undici.globalDispatcher.1') === (first && first.dispatcher),
  currentOwns: sym('undici.globalDispatcher.2') === (first && first.dispatcher),
  dispatchable: typeof (first && first.dispatcher.dispatch) === 'function',
  published: first ? first.publishesUndiciDispatcher : null });
const seed = (value) => {
  for (const name of ['undici.globalDispatcher.1', 'undici.globalDispatcher.2']) {
    if (Object.hasOwn(globalThis, Symbol.for(name))) globalThis[Symbol.for(name)] = value;
    else Object.defineProperty(globalThis, Symbol.for(name), { value, writable: true, enumerable: false, configurable: true });
  }
};`;

test('a simulated OHOS host publishes the node:http dispatcher to every Undici copy', async () => {
  const outcome = await run(`globalThis[Symbol.for('dsh.go.ohos.sim')] = true;\n${helpers}
const { installFetch } = await load();
const first = installFetch();
console.log(JSON.stringify(report(first)));`);
  assert.deepEqual(outcome, { installed: true, fetchReplaced: true, legacyOwns: true, currentOwns: true, dispatchable: true, published: true });
});

test("Undici's own default Agent is displaced", async () => {
  const outcome = await run(`globalThis[Symbol.for('dsh.go.ohos.sim')] = true;\n${helpers}
class Agent { dispatch() {} }
const own = new Agent();
seed(own);
const { installFetch } = await load();
const first = installFetch();
console.log(JSON.stringify({ ...report(first), displaced: sym('undici.globalDispatcher.1') !== own }));`);
  assert.equal(outcome.published, true);
  assert.equal(outcome.displaced, true);
  assert.equal(outcome.legacyOwns, true);
  assert.equal(outcome.currentOwns, true);
});

test('an explicit dispatcher owner is never replaced', async () => {
  const outcome = await run(`globalThis[Symbol.for('dsh.go.ohos.sim')] = true;\n${helpers}
const foreign = { dispatch() {}, tag: 'foreign' };
seed(foreign);
const { installFetch } = await load();
const first = installFetch();
console.log(JSON.stringify({ ...report(first), untouched: sym('undici.globalDispatcher.1') === foreign
  && sym('undici.globalDispatcher.2') === foreign }));`);
  assert.equal(outcome.untouched, true);
  assert.equal(outcome.published, false);
  assert.equal(outcome.fetchReplaced, true);
});

test('repeat installation keeps the same network object and dispatcher', async () => {
  const outcome = await run(`globalThis[Symbol.for('dsh.go.ohos.sim')] = true;
const { installFetch } = await load();
const a = installFetch();
const b = installFetch();
console.log(JSON.stringify({ same: a === b, dispatcherSame: a.dispatcher === b.dispatcher,
  fetchSame: globalThis.fetch === a.fetch, legacyOwns: globalThis[Symbol.for('undici.globalDispatcher.1')] === a.dispatcher }));`);
  assert.deepEqual(outcome, { same: true, dispatcherSame: true, fetchSame: true, legacyOwns: true });
});

test('a non-OHOS host without the simulation marker is left alone', async () => {
  const outcome = await run(`const { installFetch } = await load();
const before = globalThis.fetch;
const network = installFetch();
console.log(JSON.stringify({ network: network === undefined, fetchSame: globalThis.fetch === before }));`);
  assert.deepEqual(outcome, { network: true, fetchSame: true });
});

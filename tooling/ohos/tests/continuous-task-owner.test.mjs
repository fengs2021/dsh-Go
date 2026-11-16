import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadHostModules, timers, tickRetry, permission, task } from './lifecycle-host-fixture.mjs';

// Production ContinuousTaskOwner bodies run unchanged against stubbed OS modules.
const modules = await loadHostModules(process.env.DSH_LIFECYCLE_ETS_SOURCE);
const { ContinuousTaskOwner } = modules;
after(() => modules.close());
afterEach(() => timers.clear());

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const context = { applicationInfo: { accessTokenId: 42, name: 'io.github.fixture' }, abilityInfo: { name: 'EntryAbility' } };

function reset(overrides = {}) {
  Object.assign(permission, { grants: 0, modes: 0, status: 0, supported: true, dataSupported: true,
    accessCapability: true, backgroundCapability: true, reminderCapability: true, error: null,
    requestedModes: null, requestedSubmodes: null, systemStatus: null, ...overrides });
  Object.assign(task, { startCalls: [], startResults: [], updates: 0, updateFails: false, stops: [],
    listeners: [], logs: [], nextId: 400 });
  timers.clear();
}
function setup() {
  const calls = [];
  const host = { calls, continuous: [], lifecycleUpdate(kind, owner, first, second) {
    calls.push({ kind, owner, first, second });
    if (kind === 'continuous') host.continuous.push(second);
    return 1;
  } };
  const counts = { woke: 0, fell: 0 };
  const owner = new ContinuousTaskOwner(context, host, 7, () => { counts.woke++; }, () => { counts.fell++; });
  return { owner, host, counts };
}

test('a phone without the ACL holds a data-transfer task and refreshes its progress', async () => {
  reset({ systemStatus: -1 });
  const { owner, host, counts } = setup();
  assert.equal(owner.eligible(), true, 'a data-transfer task only needs the public permission');
  assert.equal(owner.request(), true);
  await flush();
  assert.deepEqual(task.startCalls, [1], 'task keeping needs an ACL this phone does not grant');
  assert.deepEqual(host.continuous, [1], 'the native lease follows OS acceptance only');
  assert.equal(counts.woke, 1);
  assert.deepEqual(task.logs.at(-1), { level: 'info', format: 'continuous task %{public}d holds mode %{public}d', rest: [400, 1] });
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 240000, 'refresh well inside the ten-minute cancel window');
  assert.equal(tickRetry(), 240000);
  await flush();
  assert.equal(task.updates, 1);
  assert.equal(timers.size, 1, 'the refresh re-arms itself');
  assert.equal(counts.fell, 0);
});

test('a refused mode falls through to the next candidate', async () => {
  reset();
  task.startResults = ['refuse'];
  const { owner, host } = setup();
  assert.equal(owner.request(), true);
  await flush();
  assert.deepEqual(task.startCalls, [9, 1], 'task keeping first, data transfer second');
  assert.deepEqual(host.continuous, [1]);
  assert.deepEqual(task.logs[0], { level: 'warn', format: 'continuous mode %{public}d refused: %{public}s',
    rest: [9, 'mode refused by the system'] });
  assert.equal(owner.error(), null, 'a refused first candidate is not an error if a later one held');
});

test('refusing every mode falls back to the short task instead of failing the turn', async () => {
  reset({ systemStatus: -1 });
  task.startResults = ['refuse'];
  const { owner, counts } = setup();
  assert.equal(owner.request(), true);
  await flush();
  assert.equal(counts.fell, 1);
  assert.equal(owner.active(), false);
  assert.equal(timers.size, 0);
  assert.deepEqual(task.listeners, [], 'no OS listener outlives a refused task');
});

test('a task without an ownership id is reported, never claimed or stopped', async () => {
  reset({ systemStatus: -1 });
  task.startResults = ['no-id'];
  const { owner, counts } = setup();
  assert.equal(owner.request(), true);
  await flush();
  assert.equal(owner.error(), 'ohos_continuous_missing_id');
  assert.equal(owner.cleanupPending(), true);
  assert.deepEqual(task.stops, [], 'a context-wide stop could cancel a replacement owner');
  assert.equal(counts.fell, 1);
});

test('a failing progress refresh drops the lease rather than running on borrowed time', async () => {
  reset({ systemStatus: -1 });
  const { owner, host, counts } = setup();
  owner.request();
  await flush();
  task.updateFails = true;
  tickRetry();
  await flush();
  assert.equal(owner.error(), 'ohos_continuous_progress_failed');
  assert.deepEqual(task.stops, [400]);
  assert.deepEqual(host.continuous, [1, 0]);
  assert.equal(counts.fell, 1);
  assert.equal(owner.active(), false);
  assert.equal(timers.size, 0);
});

test('stopping clears the refresh timer, the native lease and the OS listener', async () => {
  reset({ systemStatus: -1 });
  const { owner, host } = setup();
  owner.request();
  await flush();
  owner.stop();
  await flush();
  assert.equal(timers.size, 0);
  assert.deepEqual(task.stops, [400]);
  assert.deepEqual(host.continuous, [1, 0]);
  assert.deepEqual(task.listeners, []);
  assert.equal(owner.active(), false);
});

test('a denied public permission asks the system for nothing', async () => {
  reset({ status: -1 });
  const { owner } = setup();
  assert.equal(owner.eligible(), false);
  assert.equal(owner.request(), false);
  await flush();
  assert.deepEqual(task.startCalls, []);
  assert.equal(timers.size, 0);
});

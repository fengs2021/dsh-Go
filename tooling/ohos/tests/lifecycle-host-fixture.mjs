import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Only unavailable platform/timer boundaries are adapted. Production method
// bodies run unchanged; this is not an ArkTS or an OHOS device execution.
export const timers = new Map();
let nextTimer = 1;
export function testSetTimeout(callback, delay) {
  const id = nextTimer++; timers.set(id, { callback, delay }); return id;
}
export function testClearTimeout(id) { timers.delete(id); }
export function tickRetry() {
  const [id, timer] = timers.entries().next().value ?? [];
  if (id === undefined) throw new Error('No scheduled retry');
  timers.delete(id); timer.callback(); return timer.delay;
}
export const permission = { grants: 0, modes: 0, status: 0, supported: true, dataSupported: true,
  accessCapability: true, backgroundCapability: true, reminderCapability: true, error: null, requestedModes: null,
  requestedSubmodes: null, systemStatus: null };
export const abilityAccessCtrl = {
  GrantStatus: { PERMISSION_GRANTED: 0, PERMISSION_DENIED: -1 },
  createAtManager() { return { checkAccessTokenSync(id, name) {
    permission.grants++; permission.last = { id, name };
    if (permission.error) throw permission.error;
    return name === 'ohos.permission.KEEP_BACKGROUND_RUNNING_SYSTEM' && permission.systemStatus !== null ? permission.systemStatus : permission.status;
  } }; },
};
// Owner-side state: one record of what the OS was asked to do.
export const task = { startCalls: [], startResults: [], updates: 0, updateFails: false, stops: [],
  listeners: [], logs: [], nextId: 400 };
export const wantAgent = {
  OperationType: { START_ABILITY: 1 },
  WantAgentFlags: { CONSTANT_FLAG: 1 },
  async getWantAgent(config) { return { config }; },
};
export const hilog = {
  info(domain, tag, format, ...rest) { task.logs.push({ level: 'info', format, rest }); },
  warn(domain, tag, format, ...rest) { task.logs.push({ level: 'warn', format, rest }); },
};
export const backgroundTaskManager = {
  BackgroundTaskMode: { MODE_DATA_TRANSFER: 1, MODE_TASK_KEEPING: 9 },
  BackgroundTaskSubmode: { SUBMODE_NORMAL_NOTIFICATION: 2, SUBMODE_LIVE_VIEW_NOTIFICATION: 3 },
  on(event, callback) { task.listeners.push(event); },
  off(event, callback) { task.listeners = task.listeners.filter(name => name !== event); },
  async startBackgroundRunning(context, request) {
    task.startCalls.push(request.backgroundTaskModes[0]);
    const plan = task.startResults.length > 0 ? task.startResults.shift() : 'start';
    if (plan === 'refuse') throw Object.assign(new Error('mode refused by the system'), { code: 9800005 });
    return { continuousTaskId: plan === 'no-id' ? undefined : task.nextId++ };
  },
  async updateBackgroundRunning(context, request) {
    task.updates++;
    if (task.updateFails) throw new Error('progress rejected');
    return { continuousTaskId: request.continuousTaskId };
  },
  async stopBackgroundRunning(context, id) { task.stops.push(id); },
  ContinuousTaskRequest: class {
    isModeSupported() {
      permission.modes++; permission.requestedModes = this.backgroundTaskModes;
      permission.requestedSubmodes = this.backgroundTaskSubmodes ?? null;
      // A device may support the unattended mode and still refuse the fallback.
      const modes = this.backgroundTaskModes ?? [];
      return modes.length === 1 && modes[0] === 1 ? permission.supported && permission.dataSupported : permission.supported;
    }
  },
};
export const canIUse = name => name === 'SystemCapability.Security.AccessToken' ? permission.accessCapability
  : name === 'SystemCapability.Notification.ReminderAgent' ? permission.reminderCapability : permission.backgroundCapability;

export async function loadHostModules(sourceOverride) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const source = sourceOverride ?? path.join(repo, 'app/ohos/entry/src/main/ets/runtime');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lifecycle-host-'));
  const fixture = import.meta.url;
  const model = (await fs.readFile(path.join(source, 'RuntimeLifecycle.ets'), 'utf8')).replace(/import type[^\n]+libdsh_host.so[^\n]+\n/, '');
  await fs.writeFile(path.join(directory, 'RuntimeLifecycle.mts'),
    `import { testSetTimeout as setTimeout, testClearTimeout as clearTimeout } from '${fixture}';\n` + model);
  const permissionSource = (await fs.readFile(path.join(source, 'BackgroundCompute.ets'), 'utf8'))
    .replace("import abilityAccessCtrl from '@ohos.abilityAccessCtrl';", '')
    .replace("import backgroundTaskManager from '@ohos.resourceschedule.backgroundTaskManager';", '');
  await fs.writeFile(path.join(directory, 'BackgroundCompute.mts'),
    `import { abilityAccessCtrl, backgroundTaskManager, canIUse } from '${fixture}';\n` + permissionSource);
  // The OS task owner only needs the platform modules stubbed away above.
  const ownerSource = (await fs.readFile(path.join(source, 'ContinuousTaskOwner.ets'), 'utf8'))
    .replace(/^import common from '@ohos\.app\.ability\.common';\n/m, '')
    .replace(/^import wantAgent from '@ohos\.app\.ability\.wantAgent';\n/m, '')
    .replace(/^import backgroundTaskManager from '@ohos\.resourceschedule\.backgroundTaskManager';\n/m, '')
    .replace(/^import hilog from '@ohos\.hilog';\n/m, '')
    .replace(/^import \{ NativeHostModule \} from '\.\/NativeHost';\n/m, '')
    .replace("from './BackgroundCompute';", "from './BackgroundCompute.mts';");
  if (ownerSource.includes("from '@ohos.") || ownerSource.includes("from './NativeHost'"))
    throw new Error('The owner fixture did not detach every platform import');
  await fs.writeFile(path.join(directory, 'ContinuousTaskOwner.mts'),
    `import { testSetTimeout as setTimeout, testClearTimeout as clearTimeout, backgroundTaskManager, wantAgent, hilog } from '${fixture}';\n` + ownerSource);
  const modules = { ...await import(pathToFileURL(path.join(directory, 'RuntimeLifecycle.mts'))),
    ...await import(pathToFileURL(path.join(directory, 'BackgroundCompute.mts'))),
    ...await import(pathToFileURL(path.join(directory, 'ContinuousTaskOwner.mts'))) };
  return { ...modules, directory, async close() { await fs.rm(directory, { recursive: true, force: true }); } };
}

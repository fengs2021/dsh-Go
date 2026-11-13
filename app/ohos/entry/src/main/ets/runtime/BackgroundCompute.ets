// Eligibility only; ContinuousTaskOwner separately waits for OS task acceptance.
import abilityAccessCtrl from '@ohos.abilityAccessCtrl';
import type { Permissions } from '@ohos.abilityAccessCtrl';
import backgroundTaskManager from '@ohos.resourceschedule.backgroundTaskManager';

function grantedPermission(accessTokenId: number, permission: Permissions): boolean {
  try {
    return abilityAccessCtrl.createAtManager().checkAccessTokenSync(accessTokenId, permission) ===
      abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED;
  } catch (_) {
    return false;
  }
}

function supportedMode(mode: backgroundTaskManager.BackgroundTaskMode): boolean {
  try {
    const request = new backgroundTaskManager.ContinuousTaskRequest();
    request.backgroundTaskModes = [mode];
    return request.isModeSupported();
  } catch (_) {
    return false;
  }
}

// MODE_TASK_KEEPING is the natural fit for a local engine, but a phone only accepts it
// with the ACL permission ohos.permission.KEEP_BACKGROUND_RUNNING_SYSTEM, which a debug
// build cannot hold. module.json declares backgroundModes:["dataTransfer"] instead, so
// any application may hold a MODE_DATA_TRANSFER lease; the OS drops such a lease after
// ten idle minutes, which is why ContinuousTaskOwner refreshes it while it runs.
export function continuousTaskModes(accessTokenId: number): backgroundTaskManager.BackgroundTaskMode[] {
  if (!canIUse('SystemCapability.ResourceSchedule.BackgroundTaskManager.ContinuousTask')) return [];
  if (!grantedPermission(accessTokenId, 'ohos.permission.KEEP_BACKGROUND_RUNNING')) return [];
  const modes: backgroundTaskManager.BackgroundTaskMode[] = [];
  if (grantedPermission(accessTokenId, 'ohos.permission.KEEP_BACKGROUND_RUNNING_SYSTEM') &&
      supportedMode(backgroundTaskManager.BackgroundTaskMode.MODE_TASK_KEEPING)) {
    modes.push(backgroundTaskManager.BackgroundTaskMode.MODE_TASK_KEEPING);
  }
  if (supportedMode(backgroundTaskManager.BackgroundTaskMode.MODE_DATA_TRANSFER)) {
    modes.push(backgroundTaskManager.BackgroundTaskMode.MODE_DATA_TRANSFER);
  }
  return modes;
}

export function backgroundComputePermission(accessTokenId: number): string {
  if (!canIUse('SystemCapability.Security.AccessToken')) return 'unknown';
  try {
    const grant = abilityAccessCtrl.createAtManager().checkAccessTokenSync(
      accessTokenId, 'ohos.permission.KEEP_BACKGROUND_RUNNING');
    if (grant === abilityAccessCtrl.GrantStatus.PERMISSION_DENIED) return 'denied';
    if (grant !== abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED ||
        !canIUse('SystemCapability.ResourceSchedule.BackgroundTaskManager.ContinuousTask')) return 'unknown';
    return continuousTaskModes(accessTokenId).length > 0 ? 'granted' : 'denied';
  } catch (_) {
    // 9800005 combines mode/ACL/configuration failures; it is not a user denial.
    return 'unknown';
  }
}

// Whether this build may schedule system reminders at all. Plain builds don't ask for
// the permission (hap-distribution.py). The service can still say no at publish time.
export function agentReminderAccess(accessTokenId: number): string {
  if (!canIUse('SystemCapability.Notification.ReminderAgent')) return 'unsupported';
  try {
    const grant = abilityAccessCtrl.createAtManager().checkAccessTokenSync(
      accessTokenId, 'ohos.permission.PUBLISH_AGENT_REMINDER');
    return grant === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED ? 'granted' : 'denied';
  } catch (_) {
    return 'denied';
  }
}

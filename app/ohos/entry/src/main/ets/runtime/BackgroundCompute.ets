// Eligibility only; ContinuousTaskOwner separately waits for OS task acceptance.
import abilityAccessCtrl from '@ohos.abilityAccessCtrl';
import backgroundTaskManager from '@ohos.resourceschedule.backgroundTaskManager';

// checkAccessTokenSync takes the literal Permissions union, so every name is spelled
// out at its call site. KEEP_BACKGROUND_RUNNING_SYSTEM is restricted: only a signing
// profile that carries the ACL grants it, so the query itself may fail on a build that
// does not declare it.
const CONTINUOUS_CAPABILITY: string = 'SystemCapability.ResourceSchedule.BackgroundTaskManager.ContinuousTask';

function modeSupported(mode: backgroundTaskManager.BackgroundTaskMode,
  submodes: backgroundTaskManager.BackgroundTaskSubmode[]): boolean {
  const request = new backgroundTaskManager.ContinuousTaskRequest();
  request.backgroundTaskModes = [mode];
  if (submodes.length > 0) request.backgroundTaskSubmodes = submodes;
  return request.isModeSupported();
}

function systemAclGranted(accessTokenId: number): boolean {
  try {
    return abilityAccessCtrl.createAtManager().checkAccessTokenSync(
      accessTokenId, 'ohos.permission.KEEP_BACKGROUND_RUNNING_SYSTEM') ===
      abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED;
  } catch (_) {
    // A missing restricted declaration fails the query; that is a denial of this
    // mode alone, never an unobservable device.
    return false;
  }
}

// Ordered modes this build may request for one long local turn. Task keeping is the
// unattended mode, but on a phone it needs the restricted ACL; a data-transfer task
// only needs the public permission, and ContinuousTaskOwner keeps its live-view
// progress fresh so the system does not cancel it.
export function continuousTaskModes(accessTokenId: number): backgroundTaskManager.BackgroundTaskMode[] {
  const modes: backgroundTaskManager.BackgroundTaskMode[] = [];
  if (systemAclGranted(accessTokenId) &&
      modeSupported(backgroundTaskManager.BackgroundTaskMode.MODE_TASK_KEEPING, [])) {
    modes.push(backgroundTaskManager.BackgroundTaskMode.MODE_TASK_KEEPING);
  }
  if (modeSupported(backgroundTaskManager.BackgroundTaskMode.MODE_DATA_TRANSFER,
    [backgroundTaskManager.BackgroundTaskSubmode.SUBMODE_LIVE_VIEW_NOTIFICATION])) {
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
        !canIUse(CONTINUOUS_CAPABILITY)) return 'unknown';
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

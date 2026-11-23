// 实验用：整夜保持运行 + TASK_KEEPING 资格试探。
//
// 这里只做「测量」，不改默认行为：
//  - start()/stop() 申请 DATA_TRANSFER 长时任务，每 4 分钟 updateBackgroundRunning 一次；
//  - 三个回调（cancel/suspend/active）把原因打到 hilog.warn，供真机判据；
//  - probeTaskKeeping() 单独试一次 MODE_TASK_KEEPING，只记录错误码，不接管默认路径。
import backgroundTaskManager from '@ohos.resourceschedule.backgroundTaskManager';
import wantAgent from '@ohos.app.ability.wantAgent';
import common from '@ohos.app.ability.common';
import fs from '@ohos.file.fs';
import hilog from '@ohos.hilog';

const DOMAIN: number = 0x3F10;
const TAG: string = 'DshKeepAwake';
const REFRESH_MS: number = 4 * 60 * 1000;
// 传进来的是 common.Context（应用上下文），没有 abilityInfo；mainElement 固定为 EntryAbility。
const ABILITY_NAME: string = 'EntryAbility';
const LOG_NAME: string = '/keepawake.log';
const LOG_LIMIT: number = 64 * 1024;

export class KeepAwake {
  private static context: common.UIAbilityContext | null = null;
  private static request: backgroundTaskManager.ContinuousTaskRequest | null = null;
  private static taskId: number | null = null;
  private static timer: number = -1;
  private static listening: boolean = false;

  /// 事件同时落盘：hilog 缓冲区几十分钟就转掉，锁屏实验只能在解锁后读文件。
  private static note(line: string): void {
    const context = KeepAwake.context;
    if (context === null) return;
    try {
      const path: string = context.filesDir + LOG_NAME;
      let kept: string = '';
      try {
        const size: number = fs.statSync(path).size;
        if (size > 0 && size < LOG_LIMIT) kept = fs.readTextSync(path);
      } catch (_) {
        kept = '';
      }
      const text: string = new Date().toISOString() + ' ' + line + '\n' + kept;
      const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, text.slice(0, LOG_LIMIT));
      fs.closeSync(file);
    } catch (_) {
      // 记录失败不影响任务本身。
    }
  }

  /// 只接受 UIAbilityContext：长时任务 API 对 Context 类型做校验，
  /// 传应用上下文会报 401「The context cannot be null and its type must be Context」。
  static configure(context: common.UIAbilityContext): void {
    KeepAwake.context = context;
  }

  /// 申请整夜保持。返回状态码：'granted:<id>' / 'denied:<message>'。
  static async start(): Promise<string> {
    const context = KeepAwake.context;
    if (context === null) return 'denied:no-context';
    KeepAwake.listen();
    try {
      const agent = await wantAgent.getWantAgent({
        wants: [{ bundleName: context.applicationInfo.name, abilityName: ABILITY_NAME }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 2001,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      });
      const request = new backgroundTaskManager.ContinuousTaskRequest();
      request.backgroundTaskModes = [backgroundTaskManager.BackgroundTaskMode.MODE_DATA_TRANSFER];
      request.backgroundTaskSubmodes = [backgroundTaskManager.BackgroundTaskSubmode.SUBMODE_LIVE_VIEW_NOTIFICATION];
      request.wantAgent = agent;
      const started = await backgroundTaskManager.startBackgroundRunning(context, request);
      KeepAwake.request = request;
      KeepAwake.taskId = started.continuousTaskId ?? null;
      if (KeepAwake.taskId !== null) request.continuousTaskId = KeepAwake.taskId;
      hilog.warn(DOMAIN, TAG, 'hold start ok id=%{public}s', String(KeepAwake.taskId));
      KeepAwake.note('hold start id=' + String(KeepAwake.taskId));
      KeepAwake.arm();
      return 'granted:' + String(KeepAwake.taskId);
    } catch (error) {
      const err = error as Error;
      hilog.warn(DOMAIN, TAG, 'hold start failed: %{public}s', err.message);
      return 'denied:' + err.message;
    }
  }

  static async stop(): Promise<string> {
    KeepAwake.disarm();
    const context = KeepAwake.context;
    const id = KeepAwake.taskId;
    KeepAwake.taskId = null;
    KeepAwake.request = null;
    if (context === null || id === null) return 'stopped';
    try {
      await backgroundTaskManager.stopBackgroundRunning(context, id);
      hilog.warn(DOMAIN, TAG, 'hold stop ok id=%{public}d', id);
      KeepAwake.note('hold stop id=' + String(id));
      return 'stopped';
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'hold stop failed: %{public}s', (error as Error).message);
      return 'stop-failed:' + (error as Error).message;
    }
  }

  static state(): string {
    return KeepAwake.taskId === null ? 'idle' : 'holding:' + String(KeepAwake.taskId);
  }

  /// 单独试探 TASK_KEEPING：只记录错误码，不改变默认路径。
  static async probeTaskKeeping(): Promise<string> {
    const context = KeepAwake.context;
    if (context === null) return 'no-context';
    try {
      const agent = await wantAgent.getWantAgent({
        wants: [{ bundleName: context.applicationInfo.name, abilityName: ABILITY_NAME }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 2002,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      });
      const request = new backgroundTaskManager.ContinuousTaskRequest();
      request.backgroundTaskModes = [backgroundTaskManager.BackgroundTaskMode.MODE_TASK_KEEPING];
      request.wantAgent = agent;
      const started = await backgroundTaskManager.startBackgroundRunning(context, request);
      const id = started.continuousTaskId ?? null;
      hilog.warn(DOMAIN, TAG, 'taskkeeping probe accepted id=%{public}s', String(id));
      if (id !== null) {
        try { await backgroundTaskManager.stopBackgroundRunning(context, id); } catch (_) {}
      }
      return 'accepted:' + String(id);
    } catch (error) {
      const err = error as Error;
      const code: number | undefined = (error as CodedError).code;
      hilog.warn(DOMAIN, TAG, 'taskkeeping probe refused code=%{public}s msg=%{public}s',
        String(code), err.message);
      return 'refused:' + (code === undefined ? err.message : String(code));
    }
  }

  private static listen(): void {
    if (KeepAwake.listening) return;
    KeepAwake.listening = true;
    try {
      backgroundTaskManager.on('continuousTaskCancel', (info: backgroundTaskManager.ContinuousTaskCancelInfo) => {
        const detail: number | undefined = (info as ContinuousTaskCancelInfoEx).detailedReason;
        hilog.warn(DOMAIN, TAG, 'cancel id=%{public}d reason=%{public}d detail=%{public}s',
          info.id, info.reason, String(detail));
        KeepAwake.note('cancel id=' + String(info.id) + ' reason=' + String(info.reason) + ' detail=' + String(detail));
        KeepAwake.taskId = null;
        KeepAwake.disarm();
      });
      backgroundTaskManager.on('continuousTaskSuspend', (info: backgroundTaskManager.ContinuousTaskSuspendInfo) => {
        hilog.warn(DOMAIN, TAG, 'suspend id=%{public}d state=%{public}s reason=%{public}d',
          info.continuousTaskId, String(info.suspendState), info.suspendReason);
        KeepAwake.note('suspend id=' + String(info.continuousTaskId) + ' reason=' + String(info.suspendReason));
      });
      backgroundTaskManager.on('continuousTaskActive', (info: backgroundTaskManager.ContinuousTaskActiveInfo) => {
        hilog.warn(DOMAIN, TAG, 'active id=%{public}d', info.id);
        KeepAwake.note('active id=' + String(info.id));
      });
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'listener failed: %{public}s', (error as Error).message);
    }
  }

  private static arm(): void {
    KeepAwake.disarm();
    KeepAwake.timer = setInterval((): void => {
      const context = KeepAwake.context;
      const request = KeepAwake.request;
      if (context === null || request === null || KeepAwake.taskId === null) return;
      backgroundTaskManager.updateBackgroundRunning(context, request).then((): void => {
        hilog.warn(DOMAIN, TAG, 'progress refreshed id=%{public}s', String(KeepAwake.taskId));
        KeepAwake.note('progress refreshed id=' + String(KeepAwake.taskId));
      }).catch((error: Error): void => {
        hilog.warn(DOMAIN, TAG, 'progress refresh failed: %{public}s', error.message);
        KeepAwake.note('progress refresh failed: ' + error.message);
      });
    }, REFRESH_MS);
  }

  private static disarm(): void {
    if (KeepAwake.timer >= 0) {
      clearInterval(KeepAwake.timer);
      KeepAwake.timer = -1;
    }
  }
}


interface ContinuousTaskCancelInfoEx {
  detailedReason?: number;
}

interface CodedError {
  code?: number;
  message: string;
}

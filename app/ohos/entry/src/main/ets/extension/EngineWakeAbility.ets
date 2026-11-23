// 系统延迟任务（WorkScheduler）扩展：设备锁屏/应用被冻结时，由系统在满足条件时拉起。
//
// 它只做三件事，且全部可观测：写一条唤醒记录、尝试拉起主 Ability、结束本次 work。
// 真正的引擎启动仍由 EntryAbility 负责；这里不复制启动流程，也不假装能跑定时任务。
import workScheduler from '@ohos.resourceschedule.workScheduler';
import fs from '@ohos.file.fs';
import http from '@ohos.net.http';
import notificationManager from '@ohos.notificationManager';
import hilog from '@ohos.hilog';
import WorkSchedulerExtensionAbility from '@ohos.WorkSchedulerExtensionAbility';

const DOMAIN: number = 0x3F10;
const MARKER: string = '/wake-log.txt';
const LIMIT: number = 64 * 1024;

export default class EngineWakeAbility extends WorkSchedulerExtensionAbility {
  onWorkStart(work: workScheduler.WorkInfo): void {
    const filesDir: string = this.context.filesDir;
    const stamp: string = new Date().toISOString();
    try {
      const path: string = filesDir + MARKER;
      let kept: string = '';
      try {
        const size: number = fs.statSync(path).size;
        if (size > 0 && size < LIMIT) kept = fs.readTextSync(path);
      } catch (_) {
        kept = '';
      }
      const next: string = (stamp + ' wake workId=' + work.workId + '\n' + kept).slice(0, LIMIT);
      const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, next);
      fs.closeSync(file);
    } catch (_) {
      // 记录失败不影响唤醒本身。
    }
    hilog.warn(DOMAIN, 'DshWake', 'workScheduler woke the app at %{public}s', stamp);
    // 扩展上下文没有 startAbility，也不能调用 backgroundTaskManager，2 分钟就会被回收：
    // 所以这里只探活。引擎在 → 静默返回；引擎不在 → 发一条诚实的通知。
    this.probeEngine().catch((error: Error): void => {
      hilog.warn(DOMAIN, 'DshWake', 'probe failed: %{public}s', error.message);
    });
  }

  private async probeEngine(): Promise<void> {
    const request = http.createHttp();
    try {
      const response = await request.request('http://127.0.0.1:3080/__dsh_bridge__/auth-status',
        { method: http.RequestMethod.GET, connectTimeout: 3000, readTimeout: 3000 });
      if (response.responseCode === 200) {
        hilog.warn(DOMAIN, 'DshWake', 'engine is up on loopback; nothing to report');
        return;
      }
      hilog.warn(DOMAIN, 'DshWake', 'engine answered %{public}d', response.responseCode);
    } catch (_) {
      hilog.warn(DOMAIN, 'DshWake', 'engine is not reachable on loopback');
    } finally {
      request.destroy();
    }
    try {
      await notificationManager.publish({
        id: 4101,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: 'DSH 后台提醒',
            text: '本机引擎当前没有运行，睡前那段时间的定时任务可能没有执行。',
            additionalText: '打开 DSH 可继续'
          }
        }
      });
      hilog.warn(DOMAIN, 'DshWake', 'notification published');
    } catch (error) {
      hilog.warn(DOMAIN, 'DshWake', 'notification rejected: %{public}s', (error as Error).message);
    }
  }

  onWorkStop(work: workScheduler.WorkInfo): void {
    try {
      workScheduler.stopWork(work, true);
    } catch (_) {
      // workId 已结束或不存在。
    }
  }
}

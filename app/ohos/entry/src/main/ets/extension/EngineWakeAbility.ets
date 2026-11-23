// 系统延迟任务（WorkScheduler）扩展：设备锁屏/应用被冻结时，由系统在满足条件时拉起。
//
// 它只做三件事，且全部可观测：写一条唤醒记录、尝试拉起主 Ability、结束本次 work。
// 真正的引擎启动仍由 EntryAbility 负责；这里不复制启动流程，也不假装能跑定时任务。
import workScheduler from '@ohos.resourceschedule.workScheduler';
import fs from '@ohos.file.fs';
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
    // 扩展上下文没有 startAbility：这里只记录唤醒事实，不假装能把主 Ability 拉起。
    // 真正的引擎启动路径仍在 EntryAbility；下一步是在扩展里直接跑引擎（待验证）。

  }

  onWorkStop(work: workScheduler.WorkInfo): void {
    try {
      workScheduler.stopWork(work, true);
    } catch (_) {
      // workId 已结束或不存在。
    }
  }
}

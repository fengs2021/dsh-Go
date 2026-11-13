// 后台进度弹幕：把引擎导出的进度快照变成「看得见的一行」。
// 前台 → 应用内顶部浮层（AppStorage 供 Index.ets 订阅，零权限）；
// 后台 → 通知栏同一条通知滚动更新（不需要悬浮窗权限，调试签名包也能用）。
// 同时把自身状态写进 danmaku-arkts.json，引擎侧的诊断心跳会把它抄进 engine.log，
// 用户截一张「设置→诊断」就能看出是哪一环断了。
import notificationManager from '@ohos.notificationManager';
import wantAgent, { WantAgent } from '@ohos.app.ability.wantAgent';
import Want from '@ohos.app.ability.Want';
import common from '@ohos.app.ability.common';
import fs from '@ohos.file.fs';
import hilog from '@ohos.hilog';
import { DanmakuFeed, DanmakuSnapshot } from './DanmakuFeed';
import { RuntimePaths } from './RuntimePaths';

const DOMAIN: number = 0x3F00;
const TAG: string = 'DshDanmaku';
const NOTIFY_ID: number = 0x44530001;
const NOTIFY_LABEL: string = 'dsh-danmaku';
const TICK_MS: number = 1000;
const PUBLISH_MIN_MS: number = 2600;
const DONE_LINGER_MS: number = 8000;
const WAIT_GRACE_MS: number = 8000;    // 启动后多久没进度就开始提示
const STALE_MS: number = 20000;        // 进度文件多久没更新算卡住

function stageIcon(stage: string): string {
  if (stage === 'tool') return '🛠';
  if (stage === 'answer') return '✍️';
  if (stage === 'done') return '✅';
  if (stage === 'error') return '⚠️';
  if (stage === 'waiting') return '⌛';
  if (stage === 'thinking') return '💭';
  return '·';
}

export function danmakuTitle(stage: string, steps: number): string {
  if (stage === 'tool') return 'DSH Go · 正在操作手机';
  if (stage === 'answer') return 'DSH Go · 正在回答';
  if (stage === 'done') return 'DSH Go · 本轮完成';
  if (stage === 'error') return 'DSH Go · 执行出错';
  if (stage === 'waiting') return 'DSH Go · 等待进度';
  return steps > 0 ? 'DSH Go · 思考中（第 ' + steps + ' 步）' : 'DSH Go · 思考中';
}

export class DanmakuService {
  private static instance: DanmakuService | null = null;
  private feed: DanmakuFeed | null = null;
  private statePath: string = '';
  private context: common.UIAbilityContext | null = null;
  private timer: number = -1;
  private background: boolean = false;
  private line: string = '';
  private stage: string = 'waiting';
  private steps: number = 0;
  private ticks: number = 0;
  private attachedAt: number = 0;
  private lastFeedAt: number = 0;
  private finishedAt: number = 0;
  private lastPublishAt: number = 0;
  private lastPublished: string = '';
  private notifyState: string = 'idle';
  private errorText: string = '';
  private agent: WantAgent | null = null;
  private permissionAsked: boolean = false;

  static shared(): DanmakuService {
    if (DanmakuService.instance === null) DanmakuService.instance = new DanmakuService();
    return DanmakuService.instance;
  }

  attach(context: common.UIAbilityContext): void {
    this.context = context;
    this.feed = new DanmakuFeed(context.filesDir);
    this.statePath = new RuntimePaths(context.filesDir).dshHome + '/dsh-app/danmaku-arkts.json';
    this.attachedAt = Date.now();
    if (this.timer < 0) this.timer = setInterval(() => this.tick(), TICK_MS);
    hilog.info(DOMAIN, TAG, '进度弹幕已启动，读取 %{public}s', this.feed.path());
    this.tick();
  }

  onForeground(): void {
    this.background = false;
    this.cancelNotification();
    this.tick();
  }

  onBackground(): void {
    this.background = true;
    this.lastPublished = '';
    this.tick();
  }

  detach(): void {
    if (this.timer >= 0) { clearInterval(this.timer); this.timer = -1; }
    this.cancelNotification();
  }

  private localStatus(): string {
    if (this.lastFeedAt === 0) {
      const waited = Date.now() - this.attachedAt;
      return waited < WAIT_GRACE_MS ? '' : '⌛ 等待引擎进度…（弹幕已就绪）';
    }
    const age = Date.now() - this.lastFeedAt;
    return age > STALE_MS ? '⌛ 进度 ' + Math.round(age / 1000) + ' 秒没更新' : '';
  }

  private tick(): void {
    this.ticks += 1;
    const snapshot: DanmakuSnapshot | null = this.feed === null ? null : this.feed.read();
    if (snapshot !== null && snapshot.line !== undefined) {
      this.lastFeedAt = Date.now();
      this.line = snapshot.line;
      this.stage = snapshot.stage === undefined ? 'thinking' : snapshot.stage;
      this.steps = snapshot.steps === undefined ? 0 : snapshot.steps;
    } else {
      const fallback = this.localStatus();
      if (fallback.length > 0) {
        this.line = fallback;
        this.stage = 'waiting';
      } else if (this.line.length === 0) {
        this.stage = 'waiting';
      }
    }
    this.publishState();
    this.writeState();
    if (this.background) this.publishNotification();
  }

  private publishState(): void {
    AppStorage.setOrCreate<string>('dshDanmakuLine', this.line);
    AppStorage.setOrCreate<string>('dshDanmakuStage', this.stage);
    AppStorage.setOrCreate<string>('dshDanmakuIcon', stageIcon(this.stage));
    AppStorage.setOrCreate<number>('dshDanmakuSteps', this.steps);
    AppStorage.setOrCreate<number>('dshDanmakuAt', this.lastFeedAt);
  }

  // 给引擎侧诊断心跳读：一眼看出 ArkTS 这半边的死活。
  private writeState(): void {
    if (this.statePath.length === 0) return;
    try {
      const payload: string = JSON.stringify({
        ticks: this.ticks, background: this.background, attached: true,
        line: this.line, stage: this.stage, notify: this.notifyState,
        error: this.errorText, feedAt: this.lastFeedAt, updatedAt: Date.now()
      });
      const file = fs.openSync(this.statePath, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.WRITE_ONLY);
      try { fs.writeSync(file.fd, payload); } finally { fs.closeSync(file); }
    } catch (error) {
      this.errorText = 'state_write';
    }
  }

  private async ensureAgent(): Promise<WantAgent> {
    if (this.agent !== null) return this.agent;
    const context = this.context;
    if (context === null) throw new Error('没有上下文');
    const wants: Want[] = [{ bundleName: context.applicationInfo.name, abilityName: 'EntryAbility' }];
    const info: wantAgent.WantAgentInfo = {
      wants: wants,
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: 0,
      actionFlags: [wantAgent.WantAgentFlags.CONSTANT_FLAG]
    };
    this.agent = await wantAgent.getWantAgent(info);
    return this.agent;
  }

  private async ensurePermission(): Promise<boolean> {
    if (this.permissionAsked) return true;
    this.permissionAsked = true;
    try {
      const enabled: boolean = await notificationManager.isNotificationEnabled();
      if (!enabled && this.context !== null) await notificationManager.requestEnableNotification(this.context);
      return true;
    } catch (error) {
      this.errorText = 'notify_permission';
      return false;
    }
  }

  private async publishNotification(): Promise<void> {
    if (this.line.length === 0) return;
    const signature: string = this.stage + '|' + this.line;
    const now: number = Date.now();
    if (signature === this.lastPublished) return;
    if (now - this.lastPublishAt < PUBLISH_MIN_MS) return;
    this.lastPublishAt = now;
    this.lastPublished = signature;
    try {
      if (!(await this.ensurePermission())) return;
      const agent: WantAgent = await this.ensureAgent();
      const request: notificationManager.NotificationRequest = {
        id: NOTIFY_ID,
        label: NOTIFY_LABEL,
        notificationSlotType: notificationManager.SlotType.SERVICE_INFORMATION,
        tapDismissed: true,
        isAlertOnce: true,
        wantAgent: agent,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: { title: danmakuTitle(this.stage, this.steps), text: this.line }
        }
      };
      await notificationManager.publish(request);
      this.notifyState = 'ok';
      if (this.stage === 'done') this.finishedAt = now;
      if (this.finishedAt > 0 && now - this.finishedAt > DONE_LINGER_MS) {
        this.finishedAt = 0;
        await this.cancelNotification();
      }
    } catch (error) {
      this.notifyState = 'fail';
      this.errorText = 'notify_publish';
      hilog.warn(DOMAIN, TAG, '进度通知更新失败');
    }
  }

  private async cancelNotification(): Promise<void> {
    this.lastPublished = '';
    try {
      await notificationManager.cancel(NOTIFY_ID, NOTIFY_LABEL);
      this.notifyState = 'cancelled';
    } catch (error) {
      hilog.debug(DOMAIN, TAG, '撤销进度通知失败');
    }
  }
}

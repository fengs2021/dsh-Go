// 后台进度弹幕：把引擎导出的进度快照变成「看得见的一行」。
// 前台 → 应用内顶部浮层（AppStorage 供 Index.ets 订阅，零权限）；
// 后台 → 通知栏同一条通知滚动更新（不需要悬浮窗权限，调试签名包也能用）。
import notificationManager from '@ohos.notificationManager';
import wantAgent, { WantAgent } from '@ohos.app.ability.wantAgent';
import Want from '@ohos.app.ability.Want';
import common from '@ohos.app.ability.common';
import hilog from '@ohos.hilog';
import { DanmakuFeed, DanmakuSnapshot } from './DanmakuFeed';

const DOMAIN: number = 0x3F00;
const TAG: string = 'DshDanmaku';
// 独立 id/label：不与 Flutter 侧 dsh-chat:live 进度通知抢同一条。
const NOTIFY_ID: number = 0x44530001;
const NOTIFY_LABEL: string = 'dsh-danmaku';
const TICK_MS: number = 1000;
const PUBLISH_MIN_MS: number = 2600;   // 同一条通知的更新节流，避免系统限流
const DONE_LINGER_MS: number = 8000;   // 回合结束后浮层/通知再留一会儿

function stageIcon(stage: string): string {
  if (stage === 'tool') return '🛠';
  if (stage === 'answer') return '✍️';
  if (stage === 'done') return '✅';
  if (stage === 'error') return '⚠️';
  if (stage === 'thinking') return '💭';
  return '·';
}

export function danmakuTitle(stage: string, steps: number): string {
  if (stage === 'tool') return 'DSH Go · 正在操作手机';
  if (stage === 'answer') return 'DSH Go · 正在回答';
  if (stage === 'done') return 'DSH Go · 本轮完成';
  if (stage === 'error') return 'DSH Go · 执行出错';
  return steps > 0 ? 'DSH Go · 思考中（第 ' + steps + ' 步）' : 'DSH Go · 思考中';
}

export class DanmakuService {
  private static instance: DanmakuService | null = null;
  private feed: DanmakuFeed | null = null;
  private context: common.UIAbilityContext | null = null;
  private timer: number = -1;
  private background: boolean = false;
  private line: string = '';
  private stage: string = '';
  private steps: number = 0;
  private finishedAt: number = 0;
  private lastPublishAt: number = 0;
  private lastPublished: string = '';
  private agent: WantAgent | null = null;
  private permissionAsked: boolean = false;
  private ticks: number = 0;

  static shared(): DanmakuService {
    if (DanmakuService.instance === null) DanmakuService.instance = new DanmakuService();
    return DanmakuService.instance;
  }

  // 由 EntryAbility.onCreate 调用：拿到 filesDir 与 UIAbility 上下文后开始轮询。
  attach(context: common.UIAbilityContext): void {
    this.context = context;
    this.feed = new DanmakuFeed(context.filesDir);
    if (this.timer < 0) this.timer = setInterval(() => this.tick(), TICK_MS);
    hilog.info(DOMAIN, TAG, '进度弹幕已启动，读取 %{public}s', this.feed.path());
  }

  onForeground(): void {
    this.background = false;
    this.cancelNotification();
  }

  onBackground(): void {
    this.background = true;
  }

  detach(): void {
    if (this.timer >= 0) { clearInterval(this.timer); this.timer = -1; }
    this.cancelNotification();
  }

  private tick(): void {
    if (this.feed === null) return;
    const snapshot: DanmakuSnapshot | null = this.feed.read();
    this.ticks += 1;
    if (this.ticks % 60 === 0) {
      hilog.info(DOMAIN, TAG, '心跳 tick=%{public}d 后台=%{public}s 行=%{public}s',
        this.ticks, this.background ? 'yes' : 'no', this.line);
    }
    if (snapshot === null) {
      if (this.line !== '') this.publishState('', 'idle', 0, 0);
      return;
    }
    const line: string = snapshot.line === undefined ? '' : snapshot.line;
    const stage: string = snapshot.stage === undefined ? 'idle' : snapshot.stage;
    const steps: number = snapshot.steps === undefined ? 0 : snapshot.steps;
    const updatedAt: number = snapshot.updatedAt === undefined ? 0 : snapshot.updatedAt;
    this.publishState(line, stage, steps, updatedAt);
    if (stage === 'done' && this.background) this.publishNotification(updatedAt);
  }

  // 前台浮层：把最新一行丢进 AppStorage，供 Index.ets 的 @StorageLink 订阅。
  private publishState(line: string, stage: string, steps: number, updatedAt: number): void {
    this.line = line;
    this.stage = stage;
    this.steps = steps;
    AppStorage.setOrCreate<string>('dshDanmakuLine', line);
    AppStorage.setOrCreate<string>('dshDanmakuStage', stage);
    AppStorage.setOrCreate<string>('dshDanmakuIcon', stageIcon(stage));
    AppStorage.setOrCreate<number>('dshDanmakuSteps', steps);
    AppStorage.setOrCreate<number>('dshDanmakuAt', updatedAt);
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

  private async ensurePermission(): Promise<void> {
    if (this.permissionAsked) return;
    this.permissionAsked = true;
    try {
      const enabled: boolean = await notificationManager.isNotificationEnabled();
      if (!enabled && this.context !== null) await notificationManager.requestEnableNotification(this.context);
    } catch (error) {
      hilog.warn(DOMAIN, TAG, '通知权限检查失败');
    }
  }

  private async publishNotification(updatedAt: number): Promise<void> {
    if (this.line === '') return;
    const signature: string = this.stage + '|' + this.line;
    const now: number = Date.now();
    if (signature === this.lastPublished) return;
    if (now - this.lastPublishAt < PUBLISH_MIN_MS) return;
    this.lastPublishAt = now;
    this.lastPublished = signature;
    try {
      await this.ensurePermission();
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
          normal: {
            title: danmakuTitle(this.stage, this.steps),
            text: this.line,
            additionalText: updatedAt > 0 ? '' : ''
          }
        }
      };
      await notificationManager.publish(request);
      if (this.stage === 'done') this.finishedAt = now;
      if (this.finishedAt > 0 && now - this.finishedAt > DONE_LINGER_MS) this.cancelNotification();
    } catch (error) {
      hilog.warn(DOMAIN, TAG, '进度通知更新失败');
    }
  }

  private async cancelNotification(): Promise<void> {
    this.lastPublished = '';
    try {
      await notificationManager.cancel(NOTIFY_ID, NOTIFY_LABEL);
    } catch (error) {
      hilog.debug(DOMAIN, TAG, '撤销进度通知失败');
    }
  }
}

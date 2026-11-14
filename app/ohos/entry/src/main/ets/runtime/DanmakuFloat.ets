// 真浮窗：API 26 的 floatView（SystemCapability.Window.SessionManager）。
// 后台时把一条「横向条」贴到系统窗口层，别的 App 在前台也能看见弹幕。
// 能力/权限拿不到时全程静默降级，只把原因写进诊断字符串，通知横幅那条路照旧工作。
import { floatView } from '@kit.ArkUI';
import common from '@ohos.app.ability.common';
import { BusinessError } from '@ohos.base';
import hilog from '@ohos.hilog';

const DOMAIN: number = 0x3F00;
const TAG: string = 'DshDanmakuFloat';
const PAGE: string = 'pages/DanmakuFloat';

function errCode(error: Object): string {
  const code: number | undefined = (error as BusinessError).code;
  return code === undefined || code === null ? 'err' : String(code);
}

export class DanmakuFloat {
  private context: common.UIAbilityContext | null = null;
  private controller: floatView.FloatViewController | null = null;
  private storage: LocalStorage = new LocalStorage();
  private status: string = 'init';
  private creating: boolean = false;
  private started: boolean = false;
  private want: boolean = false;

  attach(context: common.UIAbilityContext): void {
    if (this.context === null) this.context = context;
    try {
      this.status = floatView.isFloatViewEnabled() ? 'enabled' : 'disabled';
    } catch (error) {
      this.status = 'probe_' + errCode(error);
    }
    hilog.info(DOMAIN, TAG, '浮窗能力探测：%{public}s', this.status);
  }

  state(): string {
    return this.status;
  }

  // 每秒被 DanmakuService 调一次：顺手刷新内容，并按「有没有弹幕 + 是否在后台」决定浮窗去留。
  sync(line: string, icon: string, background: boolean): void {
    try {
      this.storage.setOrCreate<string>('line', line);
      this.storage.setOrCreate<string>('icon', icon);
    } catch (error) {
      this.status = 'storage_' + errCode(error);
    }
    const want: boolean = background && line.length > 0;
    if (want === this.want) return;
    this.want = want;
    if (want) {
      this.show();
    } else {
      this.hide();
    }
  }

  private show(): void {
    if (this.controller !== null) {
      this.startNow();
      return;
    }
    if (this.creating) return;
    const context: common.UIAbilityContext | null = this.context;
    if (context === null) return;
    this.creating = true;
    const config: floatView.FloatViewConfiguration = {
      context: context,
      templateType: floatView.FloatViewTemplateType.HORIZONTAL_BAR,
      isConfirmOnClose: false
    };
    floatView.create(config).then((controller: floatView.FloatViewController) => {
      this.controller = controller;
      this.creating = false;
      this.status = 'created';
      controller.setUIContext(PAGE, this.storage).then(() => {
        this.startNow();
      }).catch((error: BusinessError) => {
        this.status = 'uictx_' + errCode(error);
      });
    }).catch((error: BusinessError) => {
      this.creating = false;
      this.status = 'create_' + errCode(error);
      hilog.warn(DOMAIN, TAG, '浮窗创建失败，回落到通知横幅');
    });
  }

  private startNow(): void {
    const controller: floatView.FloatViewController | null = this.controller;
    if (controller === null || this.started) return;
    controller.start().then(() => {
      this.started = true;
      this.status = 'started';
    }).catch((error: BusinessError) => {
      this.status = 'start_' + errCode(error);
    });
  }

  private hide(): void {
    const controller: floatView.FloatViewController | null = this.controller;
    if (controller === null || !this.started) return;
    controller.stop().then(() => {
      this.started = false;
      this.status = 'stopped';
    }).catch((error: BusinessError) => {
      this.status = 'stop_' + errCode(error);
    });
  }
}

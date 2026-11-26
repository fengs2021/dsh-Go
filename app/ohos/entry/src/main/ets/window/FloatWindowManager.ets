/*
 * 系统级悬浮小窗：WindowType.TYPE_FLOAT，压在别的应用之上，供「人不在 App 里时也能看到智能体
 * 在干什么」用。内容是 pages/FloatPanel（独立页面实例，只能读 PipState）。
 *
 * 两条硬约束，都是真机上踩出来的：
 * 1. TYPE_FLOAT 要 ohos.permission.SYSTEM_FLOAT_WINDOW，它是 system_basic 级权限，三方应用
 *    在 module.json5 里声明也拿不到。dshgo 没有本地 shell 桥，所以这里不做偷偷授权，建窗
 *    失败就把该执行的 hdc 命令按真实 tokenId 打进日志，由 PC 侧 hdc 授一次即可；
 * 2. 建窗/位移失败一律降级为「没有悬浮窗」，不弹窗教育用户，也不影响主界面。
 */
import common from '@ohos.app.ability.common';
import window from '@ohos.window';
import display from '@ohos.display';
import hilog from '@ohos.hilog';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import { PipState, defaultPipTheme } from './PipState';

const DOMAIN: number = 0x3F10;
const TAG: string = 'DshPip';
const WINDOW_NAME: string = 'dsh_pip_float';
const FLOAT_PAGE: string = 'pages/FloatPanel';

export class FloatWindowManager {
  private static instance: FloatWindowManager = new FloatWindowManager();

  private context: common.UIAbilityContext | undefined = undefined;
  private floatWindow: window.Window | undefined = undefined;
  private showing: boolean = false;
  private compact: boolean = false;
  // 用户开关：App 退到后台时是否自动升起悬浮窗。默认关，由 Dart 侧 setAuto 打开。
  private auto: boolean = false;

  private currentX: number = 40;
  private currentY: number = 180;
  private currentWidth: number = 900;
  private currentHeight: number = 700;

  static getInstance(): FloatWindowManager {
    return FloatWindowManager.instance;
  }

  init(context: common.UIAbilityContext): void {
    this.context = context;
    this.applyColorMode(context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
  }

  /// 浮窗和主界面不在同一个渲染树，拿不到 Material 主题，只能按系统明暗选 DSH 的
  /// 深/浅两套色板（palette.dart 的值）。Dart 侧要用自定义强调色可再调 setTheme 覆盖。
  applyColorMode(dark: boolean): void {
    PipState.getInstance().setTheme(defaultPipTheme(dark));
  }

  isShowing(): boolean {
    return this.showing && this.floatWindow !== undefined;
  }

  async show(compact: boolean): Promise<boolean> {
    const context: common.UIAbilityContext | undefined = this.context;
    if (context === undefined) {
      hilog.warn(DOMAIN, TAG, 'show ignored: manager not initialised');
      return false;
    }
    if (this.isShowing()) {
      if (this.compact !== compact) {
        await this.setCompact(compact);
      }
      return true;
    }

    try {
      this.applyColorMode(context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
      const config: window.Configuration = {
        name: WINDOW_NAME,
        windowType: window.WindowType.TYPE_FLOAT,
        ctx: context
      };
      this.floatWindow = await window.createWindow(config);
      await this.floatWindow.loadContent(FLOAT_PAGE);
      await this.floatWindow.setWindowBackgroundColor('#00000000');
      this.compact = compact;
      PipState.getInstance().setCompact(compact);
      this.measure();
      await this.floatWindow.resize(this.currentWidth, this.currentHeight);
      await this.floatWindow.moveWindowTo(this.currentX, this.currentY);
      await this.floatWindow.showWindow();
      this.showing = true;
      // 系统悬浮窗已经能看了，应用内那层浮层就收起来，避免两个窗叠在一起。
      PipState.getInstance().hide();
      hilog.info(DOMAIN, TAG, 'float window shown at (%{public}d, %{public}d)', this.currentX, this.currentY);
      return true;
    } catch (error) {
      const message: string = (error as Error).message;
      hilog.warn(DOMAIN, TAG, 'TYPE_FLOAT rejected: %{public}s', message);
      hilog.warn(DOMAIN, TAG,
        'if this build really needs the system float window, grant it once from a PC: hdc shell atm perm -g -i %{public}d -p ohos.permission.SYSTEM_FLOAT_WINDOW',
        context.applicationInfo.accessTokenId);
      this.floatWindow = undefined;
      this.showing = false;
      return false;
    }
  }

  async hide(): Promise<void> {
    const target: window.Window | undefined = this.floatWindow;
    this.floatWindow = undefined;
    this.showing = false;
    if (target === undefined) {
      return;
    }
    try {
      await target.destroyWindow();
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'destroy failed: %{public}s', (error as Error).message);
    }
  }

  async setCompact(compact: boolean): Promise<void> {
    this.compact = compact;
    PipState.getInstance().setCompact(compact);
    const target: window.Window | undefined = this.floatWindow;
    if (target === undefined) {
      return;
    }
    this.measure();
    try {
      await target.resize(this.currentWidth, this.currentHeight);
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'resize failed: %{public}s', (error as Error).message);
    }
  }

  async moveBy(dx: number, dy: number): Promise<void> {
    const target: window.Window | undefined = this.floatWindow;
    if (target === undefined) {
      return;
    }
    const info: display.Display = display.getDefaultDisplaySync();
    const maxX: number = Math.max(0, info.width - this.currentWidth);
    const maxY: number = Math.max(0, info.height - this.currentHeight);
    this.currentX = Math.max(0, Math.min(this.currentX + dx, maxX));
    this.currentY = Math.max(0, Math.min(this.currentY + dy, maxY));
    try {
      await target.moveWindowTo(Math.round(this.currentX), Math.round(this.currentY));
    } catch (error) {
      // 连续拖动时中间帧被系统合并掉很正常，不需要报。
      hilog.debug(DOMAIN, TAG, 'move skipped: %{public}s', (error as Error).message);
    }
  }

  /// 把主界面拉回前台并收起悬浮窗。TYPE_FLOAT 窗口可见时本进程算「有可见窗口」，
  /// 自拉起通常能成；被系统拦下时只记日志，不假装成功。
  async bringToFront(): Promise<void> {
    const context: common.UIAbilityContext | undefined = this.context;
    if (context !== undefined) {
      try {
        await context.startAbility({
          bundleName: context.abilityInfo.bundleName,
          moduleName: context.abilityInfo.moduleName,
          abilityName: context.abilityInfo.name
        });
      } catch (error) {
        hilog.warn(DOMAIN, TAG, 'bringToFront failed: %{public}s', (error as Error).message);
      }
    }
    await this.hide();
  }

  setAuto(enabled: boolean): void {
    this.auto = enabled;
  }

  /// App 退到后台：用户开了自动悬浮才升起来，且只给胶囊态，别挡人。
  async onBackground(): Promise<void> {
    if (!this.auto) {
      return;
    }
    await this.show(true);
  }

  async onForeground(): Promise<void> {
    if (this.isShowing()) {
      await this.hide();
    }
  }

  destroy(): void {
    const target: window.Window | undefined = this.floatWindow;
    this.floatWindow = undefined;
    this.showing = false;
    if (target === undefined) {
      return;
    }
    try {
      target.destroyWindow();
    } catch (error) {
      // 进程正在退出，窗口跟着走。
    }
  }

  private measure(): void {
    const info: display.Display = display.getDefaultDisplaySync();
    const density: number = info.densityPixels || 3;
    if (this.compact) {
      this.currentWidth = Math.floor(232 * density);
      this.currentHeight = Math.floor(68 * density);
    } else {
      this.currentWidth = Math.min(Math.floor(info.width * 0.94), Math.floor(340 * density));
      this.currentHeight = Math.floor(248 * density);
    }
    this.currentX = Math.max(20, Math.floor((info.width - this.currentWidth) / 2));
    this.currentY = Math.floor(90 * density);
  }
}

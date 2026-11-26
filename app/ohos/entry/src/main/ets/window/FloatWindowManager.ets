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
import promptAction from '@ohos.promptAction';
import wantAgent from '@ohos.app.ability.wantAgent';
import Want from '@ohos.app.ability.Want';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import { PipState, defaultPipTheme } from './PipState';

const DOMAIN: number = 0x3F10;
const TAG: string = 'DshPip';
const WINDOW_NAME: string = 'dsh_pip_float';
const FLOAT_PAGE: string = 'pages/FloatPanel';

export class FloatWindowManager {
  private static instance: FloatWindowManager = new FloatWindowManager();

  private static lastMoveWarn: number = 0;
  private static lastMoveLog: number = 0;

  // 系统接手拖动后，TouchType.Up 可能不再回传给应用（真机实测：拖完点击全哑）。
  // 用一个标记 + 下一次 Down 时兜底 stopMoving()，把卡住的 moving 状态解掉。
  private moving: boolean = false;
  private lastTouchX: number = 0;
  private lastTouchY: number = 0;
  private static lastError: string = '';

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
      // TYPE_FLOAT 建出来的窗口默认不可聚焦；不给焦点时点击能到，但连续 move 事件常常收不到，
      // 拖动因此完全没反应。这两条都失败不影响建窗，只是手势可能失灵。
      try {
        await this.floatWindow.setWindowFocusable(true);
      } catch (error) {
        hilog.warn(DOMAIN, TAG, 'setWindowFocusable rejected: %{public}s', (error as Error).message);
      }
      try {
        await this.floatWindow.setWindowTouchable(true);
      } catch (error) {
        hilog.warn(DOMAIN, TAG, 'setWindowTouchable rejected: %{public}s', (error as Error).message);
      }
      this.compact = compact;
      PipState.getInstance().setCompact(compact);
      this.measure();
      await this.floatWindow.resize(this.currentWidth, this.currentHeight);
      await this.clampToScreen();
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
    this.moving = false;
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
    setTimeout((): void => {
      this.forceClamp('compact');
    }, 120);
  }

  /// 真机实测结论（v94，2026-11-26）：
  /// - ArkUI 的 PanGesture 在 TYPE_FLOAT 窗口里**不触发**（onTouch 的 Move 事件正常）；
  /// - SDK 推荐的 startMoving() 能把窗口拖走，但系统进入 moving 后不再回传 TouchType.Up，
  ///   窗口卡在 moving 状态、之后所有点击失灵（⤢ / 回到应用 都点不动）。
  /// 所以拖动改成「onTouch 记起点 + Move 里自己算坐标 + moveWindowTo」，绕开系统 moving 状态。
  /// 记下手指相对窗口左上角的偏移（px）。用 screenX/screenY 而不是组件内 x/y：
  /// 窗口跟着手指移动后，组件内坐标会漂，屏幕坐标不会。
  /// 只记上一帧的手指位置。onTouch 给的是**窗口内**的 vp 坐标，窗口一移动它就跟着变；
  /// 用「按起点算绝对位置」会形成反馈回路（窗口动 → 坐标变 → 位置回退），表现就是框体一直抖。
  /// 改成逐帧增量：窗口永远只按手指这一帧的位移走，坐标漂移被自然消掉。
  beginDragAt(xVp: number, yVp: number): void {
    this.lastTouchX = xVp;
    this.lastTouchY = yVp;
  }

  /// 手指跟到哪窗口就到哪（px）。
  async dragToScreen(xVp: number, yVp: number): Promise<void> {
    const target: window.Window | undefined = this.floatWindow;
    if (target === undefined) {
      return;
    }
    const info: display.Display = display.getDefaultDisplaySync();
    const density: number = info.densityPixels || 3;
    const dxPx: number = (xVp - this.lastTouchX) * density;
    const dyPx: number = (yVp - this.lastTouchY) * density;
    this.lastTouchX = xVp;
    this.lastTouchY = yVp;
    if (Math.abs(dxPx) < 0.5 && Math.abs(dyPx) < 0.5) {
      return;
    }
    const maxX: number = Math.max(0, info.width - this.currentWidth);
    const maxY: number = Math.max(0, info.height - this.currentHeight);
    const nextX: number = Math.max(0, Math.min(this.currentX + dxPx, maxX));
    const nextY: number = Math.max(0, Math.min(this.currentY + dyPx, maxY));
    if (Math.round(nextX) === Math.round(this.currentX) && Math.round(nextY) === Math.round(this.currentY)) {
      return;
    }
    this.currentX = nextX;
    this.currentY = nextY;
    try {
      await target.moveWindowTo(Math.round(nextX), Math.round(nextY));
    } catch (error) {
      const now: number = Date.now();
      if (now - FloatWindowManager.lastMoveWarn > 2000) {
        FloatWindowManager.lastMoveWarn = now;
        hilog.warn(DOMAIN, TAG, 'dragTo rejected: %{public}s', (error as Error).message);
      }
    }
  }

  async startMoving(): Promise<void> {
    const target: window.Window | undefined = this.floatWindow;
    if (target === undefined || this.moving) {
      return;
    }
    this.moving = true;
    try {
      await target.startMoving();
    } catch (error) {
      const now: number = Date.now();
      if (now - FloatWindowManager.lastMoveWarn > 2000) {
        FloatWindowManager.lastMoveWarn = now;
        hilog.warn(DOMAIN, TAG, 'startMoving rejected: %{public}s', (error as Error).message);
      }
    }
  }

  async stopMoving(): Promise<void> {
    const target: window.Window | undefined = this.floatWindow;
    this.moving = false;
    if (target === undefined) {
      return;
    }
    try {
      await target.stopMoving();
    } catch (error) {
      // 手指抬起后系统自己会停，这里失败不算事。
    }
  }

  async moveBy(dx: number, dy: number): Promise<void> {
    const target: window.Window | undefined = this.floatWindow;
    if (target === undefined) {
      return;
    }
    const stamp: number = Date.now();
    if (stamp - FloatWindowManager.lastMoveLog > 500) {
      FloatWindowManager.lastMoveLog = stamp;
      hilog.warn(DOMAIN, TAG, 'moveBy dx=%{public}d dy=%{public}d from (%{public}d,%{public}d)',
        dx, dy, Math.round(this.currentX), Math.round(this.currentY));
    }
    const info: display.Display = display.getDefaultDisplaySync();
    const maxX: number = Math.max(0, info.width - this.currentWidth);
    const maxY: number = Math.max(0, info.height - this.currentHeight);
    this.currentX = Math.max(0, Math.min(this.currentX + dx, maxX));
    this.currentY = Math.max(0, Math.min(this.currentY + dy, maxY));
    try {
      await target.moveWindowTo(Math.round(this.currentX), Math.round(this.currentY));
    } catch (error) {
      // debug 级在本机被系统过滤，只有 warn 查得到；这里限流避免拖动时刷屏。
      const now: number = Date.now();
      if (now - FloatWindowManager.lastMoveWarn > 2000) {
        FloatWindowManager.lastMoveWarn = now;
        hilog.warn(DOMAIN, TAG, 'moveWindowTo rejected: %{public}s (x=%{public}d y=%{public}d)',
          (error as Error).message, Math.round(this.currentX), Math.round(this.currentY));
      }
    }
  }

  /// 把主界面拉回前台。应用在后台时直接 startAbility 会被系统以
  /// 「does not have permission to call the interface」拒掉（真机实测，需要
  /// START_ABILITIES_FROM_BACKGROUND，三方拿不到），所以按代价从低到高试三条路：
  /// wantAgent 触发（系统代发）→ openLink 走自己的 dshgo:// 协议 → startAbility。
  async bringToFront(): Promise<void> {
    const context: common.UIAbilityContext | undefined = this.context;
    if (context === undefined) {
      return;
    }
    const info = context.abilityInfo;
    const want: Want = {
      bundleName: info.bundleName,
      moduleName: info.moduleName,
      abilityName: info.name
    };
    if (await this.frontViaWantAgent(want)) {
      await this.hide();
      return;
    }
    try {
      await context.openLink('dshgo://pip/open');
      hilog.warn(DOMAIN, TAG, 'bringToFront via openLink');
      await this.hide();
      return;
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'openLink rejected: %{public}s', (error as Error).message);
    }
    try {
      await context.startAbility(want);
      hilog.warn(DOMAIN, TAG, 'bringToFront via startAbility');
      await this.hide();
      return;
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'startAbility rejected: %{public}s', (error as Error).message);
    }
    promptAction.showToast({ message: $r('app.string.dsh_pip_front_blocked'), duration: 3000 });
  }

  private async frontViaWantAgent(want: Want): Promise<boolean> {
    try {
      const agent = await wantAgent.getWantAgent({
        wants: [want],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 1001,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      });
      // TriggerInfo 只有 code / want / permission / extraInfo；只给 code 会报
      // 「Parameter error. Too few parameters」，要带上 want。
      const trigger: wantAgent.TriggerInfo = { code: 1001, want: want };
      await wantAgent.trigger(agent, trigger);
      hilog.warn(DOMAIN, TAG, 'bringToFront via wantAgent');
      return true;
    } catch (error) {
      FloatWindowManager.lastError = (error as Error).message;
      hilog.warn(DOMAIN, TAG, 'wantAgent rejected: %{public}s', FloatWindowManager.lastError);
      return false;
    }
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

  /// 内容变了（新的一句状态）就重算高度：展开态按行数收，别留一大片空白。
  async applyContentSize(): Promise<void> {
    const target: window.Window | undefined = this.floatWindow;
    if (target === undefined || this.compact) {
      return;
    }
    const before: number = this.currentHeight;
    this.measure();
    if (this.currentHeight === before) {
      return;
    }
    try {
      await target.resize(this.currentWidth, this.currentHeight);
    } catch (error) {
      hilog.debug(DOMAIN, TAG, 'content resize skipped: %{public}s', (error as Error).message);
    }
    setTimeout((): void => {
      this.forceClamp('content');
    }, 120);
  }

  /// 无条件把窗口夹回屏内（不看状态是否已相等），并留下数字日志。
  /// 用于 resize 之后：系统可能把窗口保持在原左上角，导致右侧越界。
  private async forceClamp(tag: string): Promise<void> {
    const target: window.Window | undefined = this.floatWindow;
    const info: display.Display = display.getDefaultDisplaySync();
    const maxX: number = Math.max(0, info.width - this.currentWidth);
    const maxY: number = Math.max(0, info.height - this.currentHeight);
    const nx: number = Math.max(0, Math.min(this.currentX, maxX));
    const ny: number = Math.max(0, Math.min(this.currentY, maxY));
    hilog.warn(DOMAIN, TAG, 'forceClamp[%{public}s] disp=%{public}dx%{public}d size=%{public}dx%{public}d -> (%{public}d,%{public}d)',
      tag, info.width, info.height, this.currentWidth, this.currentHeight, Math.round(nx), Math.round(ny));
    this.currentX = nx;
    this.currentY = ny;
    if (target === undefined) {
      return;
    }
    try {
      await target.moveWindowTo(Math.round(nx), Math.round(ny));
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'forceClamp move rejected: %{public}s', (error as Error).message);
    }
  }

  /// 尺寸变了就重新夹一次位置，并把窗口挪过去；否则越界的旧坐标会在下次拖动时把窗口拽回去。
  private async clampToScreen(): Promise<void> {
    const target: window.Window | undefined = this.floatWindow;
    const info: display.Display = display.getDefaultDisplaySync();
    // 以窗口真实尺寸为准：resize 之后 currentWidth/Height 与系统实际值可能不同步，
    // 用旧值算边界会漏掉「展开后右边被挤出屏幕」这种情况。
    let width: number = this.currentWidth;
    let height: number = this.currentHeight;
    if (target !== undefined) {
      const props: window.WindowProperties = target.getWindowProperties();
      // resize 之后系统报告值可能还停在旧尺寸，取较大者才不会漏判越界。
      width = Math.max(width, props.windowRect.width);
      height = Math.max(height, props.windowRect.height);
    }
    const maxX: number = Math.max(0, info.width - width);
    const maxY: number = Math.max(0, info.height - height);
    const nextX: number = Math.max(0, Math.min(this.currentX, maxX));
    const nextY: number = Math.max(0, Math.min(this.currentY, maxY));
    if (nextX === this.currentX && nextY === this.currentY) {
      return;
    }
    this.currentX = nextX;
    this.currentY = nextY;
    if (target === undefined) {
      return;
    }
    try {
      await target.moveWindowTo(Math.round(nextX), Math.round(nextY));
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'clamp move rejected: %{public}s', (error as Error).message);
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
      // 34(标题) + 6 + 18*行数 + 30(按钮) + 18(内边距)，行数按实际字数估，钳在 1~6 行。
      const state: PipState = PipState.getInstance();
      const text: string = state.detail.length > 0 ? state.detail : state.status;
      const lines: number = Math.max(1, Math.min(6, Math.ceil(text.length / 22)));
      this.currentHeight = Math.floor((34 + 6 + 18 * lines + 30 + 18) * density);
    }
    this.currentX = Math.max(20, Math.floor((info.width - this.currentWidth) / 2));
    this.currentY = Math.floor(90 * density);
  }
}

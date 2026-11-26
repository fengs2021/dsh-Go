/*
 * 画中画悬浮小窗的共享状态。
 *
 * 两个宿主读同一份状态：应用内浮层 FloatingPip（和 Flutter 页面同处一个窗口）与系统悬浮窗
 * 页面 FloatPanel（TYPE_FLOAT 窗口里的独立页面实例，拿不到 Dart 的 Provider）。所以这里
 * 不放业务逻辑，只有「谁改谁 notify」的单例，跨窗口靠 AppStorage 与 Dart 的 dsh/pip 通道。
 *
 * 色值默认抄自 app/lib/ui/theme/palette.dart 与 semantic_colors.dart，Dart 侧
 * PipWindow.applyTheme 会按当前 ThemeData 覆盖，换配色/换主题包时不用改这里。
 */
export enum PipMode {
  HIDDEN = 'hidden',
  MINI = 'mini',
  EXPANDED = 'expanded'
}

/// RUNNING 是「智能体在跑」，ATTENTION 是「需要你介入」（要授权、要验证码、出错等人看）。
export enum PipGlow {
  NORMAL = 'normal',
  RUNNING = 'running',
  ATTENTION = 'attention'
}

export interface PipTheme {
  dark: boolean;
  surface: string;
  surfaceLow: string;
  onSurface: string;
  onSurfaceMuted: string;
  rule: string;
  accent: string;
  success: string;
  warning: string;
}

/// 给 #RRGGBB 套一层透明度（#AARRGGBB），浮窗要半透明底。
export function withAlpha(color: string, alphaHex: string): string {
  if (color.length === 7 && color.startsWith('#')) {
    return '#' + alphaHex + color.substring(1);
  }
  return color;
}

export function defaultPipTheme(dark: boolean): PipTheme {
  if (dark) {
    return {
      dark: true,
      surface: '#1C1F28',
      surfaceLow: '#232730',
      onSurface: '#E6E9F0',
      onSurfaceMuted: '#B6BBC5',
      rule: '#343841',
      accent: '#97B1F0',
      success: '#8BCCA6',
      warning: '#E6BD7C'
    };
  }
  return {
    dark: false,
    surface: '#F0F4FD',
    surfaceLow: '#FBFCFF',
    onSurface: '#1E232E',
    onSurfaceMuted: '#4F5562',
    rule: '#DCE0E8',
    accent: '#4B67B4',
    success: '#337250',
    warning: '#936123'
  };
}

export class PipState {
  private static instance: PipState = new PipState();

  mode: PipMode = PipMode.HIDDEN;
  glow: PipGlow = PipGlow.NORMAL;
  title: string = '';
  status: string = '';
  /// 最新一句回复/叙述，展开态正文用它。
  detail: string = '';
  /// 正在跑的工具名（图标见 toolGlyph），空串表示没有工具在跑。
  tool: string = '';
  toolsDone: number = 0;
  /// 系统悬浮窗的胶囊态；应用内浮层不用它（浮层自己就是 MINI/EXPANDED 两档）。
  compact: boolean = false;
  theme: PipTheme = defaultPipTheme(false);

  private listeners: Array<() => void> = [];

  static getInstance(): PipState {
    return PipState.instance;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return (): void => {
      this.listeners = this.listeners.filter((item: () => void): boolean => item !== listener);
    };
  }

  private notify(): void {
    for (let index = 0; index < this.listeners.length; index++) {
      const listener: () => void = this.listeners[index];
      try {
        listener();
      } catch (error) {
        // 订阅者自己抛错不该带动其他订阅者；谁坏了谁在日志里查。
      }
    }
  }

  showMini(): void {
    this.mode = PipMode.MINI;
    this.notify();
  }

  showExpanded(): void {
    this.mode = PipMode.EXPANDED;
    this.notify();
  }

  hide(): void {
    this.mode = PipMode.HIDDEN;
    this.notify();
  }

  toggle(): void {
    if (this.mode === PipMode.HIDDEN) {
      this.mode = PipMode.MINI;
    } else if (this.mode === PipMode.MINI) {
      this.mode = PipMode.EXPANDED;
    } else {
      this.mode = PipMode.MINI;
    }
    this.notify();
  }

  setGlow(glow: PipGlow): void {
    if (this.glow === glow) {
      return;
    }
    this.glow = glow;
    this.notify();
  }

  setContent(title: string, status: string): void {
    if (this.title === title && this.status === status) {
      return;
    }
    this.title = title;
    this.status = status;
    this.notify();
  }

  setDetail(detail: string, tool: string, toolsDone: number): void {
    if (this.detail === detail && this.tool === tool && this.toolsDone === toolsDone) {
      return;
    }
    this.detail = detail;
    this.tool = tool;
    this.toolsDone = toolsDone;
    this.notify();
  }

  setCompact(compact: boolean): void {
    if (this.compact === compact) {
      return;
    }
    this.compact = compact;
    this.notify();
  }

  setTheme(theme: PipTheme): void {
    this.theme = theme;
    this.notify();
  }

  isVisible(): boolean {
    return this.mode !== PipMode.HIDDEN;
  }
}

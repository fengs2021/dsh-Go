/*
 * 系统悬浮窗里加载的页面。它是独立窗口里的独立页面实例，读不到 Dart 的 Provider，
 * 内容全靠 PipState（Dart 侧经 dsh/pip 通道写入）。
 *
 * 胶囊态只有一行：状态点 + 一句现状 + 展开 + 回 App。展开态给正文和关闭。
 * 拖动的不是页面里的东西，是窗口本身（FloatWindowManager.moveBy 换算成窗口坐标）。
 */
import { PipGlow, PipMode, PipState, PipTheme, defaultPipTheme, withAlpha } from '../window/PipState';
import { FloatWindowManager } from '../window/FloatWindowManager';

@Entry
@Component
struct FloatPanel {
  @State private mode: PipMode = PipMode.MINI;
  @State private glow: PipGlow = PipGlow.NORMAL;
  @State private title: string = '';
  @State private status: string = '';
  @State private detail: string = '';
  @State private tool: string = '';
  @State private toolsDone: number = 0;
  @State private theme: PipTheme = defaultPipTheme(false);
  @State private compact: boolean = false;
  @State private dotAlpha: number = 1;

  private state: PipState = PipState.getInstance();
  private dropSubscription: (() => void) | undefined = undefined;
  private dotTimer: number = -1;

  aboutToAppear(): void {
    this.sync();
    this.dropSubscription = this.state.subscribe((): void => this.sync());
  }

  aboutToDisappear(): void {
    if (this.dropSubscription !== undefined) {
      this.dropSubscription();
      this.dropSubscription = undefined;
    }
    if (this.dotTimer !== -1) {
      clearInterval(this.dotTimer);
      this.dotTimer = -1;
    }
  }

  private sync(): void {
    this.mode = this.state.mode;
    this.glow = this.state.glow;
    this.title = this.state.title;
    this.status = this.state.status;
    this.detail = this.state.detail;
    this.tool = this.state.tool;
    this.toolsDone = this.state.toolsDone;
    this.theme = this.state.theme;
    this.compact = this.state.compact;
    if (!this.compact) {
      FloatWindowManager.getInstance().applyContentSize();
    }
    if (this.glow === PipGlow.ATTENTION) {
      if (this.dotTimer === -1) {
        let fading: boolean = true;
        this.dotTimer = setInterval((): void => {
          this.getUIContext().animateTo({ duration: 600, curve: Curve.EaseInOut }, (): void => {
            this.dotAlpha = fading ? 0.35 : 1;
          });
          fading = !fading;
        }, 650);
      }
    } else if (this.dotTimer !== -1) {
      clearInterval(this.dotTimer);
      this.dotTimer = -1;
      this.dotAlpha = 1;
    }
  }

  private dotColor(): string {
    if (this.glow === PipGlow.RUNNING) {
      return this.theme.success;
    }
    if (this.glow === PipGlow.ATTENTION) {
      return this.theme.warning;
    }
    return this.theme.accent;
  }

  @Builder
  pillBar() {
    Row({ space: 6 }) {
      Text('⋮')
        .fontSize(12)
        .fontColor(this.theme.onSurfaceMuted)
        .fontWeight(FontWeight.Bold)
      Circle({ width: 8, height: 8 })
        .fill(this.dotColor())
        .opacity(this.dotAlpha)
      Text(this.summary())
        .fontSize(11)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.theme.onSurface)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      Button({ type: ButtonType.Circle }) {
        Text('⤢')
          .fontSize(11)
          .fontColor(this.theme.onSurfaceMuted)
      }
      .width(24)
      .height(24)
      .backgroundColor(this.theme.surfaceLow)
      .onClick((): void => {
        this.state.showExpanded();
        FloatWindowManager.getInstance().setCompact(false);
      })
      Button({ type: ButtonType.Circle }) {
        Text('×')
          .fontSize(12)
          .fontColor(this.theme.onSurfaceMuted)
      }
      .width(24)
      .height(24)
      .backgroundColor(this.theme.surfaceLow)
      .onClick((): void => {
        FloatWindowManager.getInstance().hide();
      })
    }
    .width('100%')
    .height('100%')
    .padding({ left: 10, right: 8 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  expandedPanel() {
    Column() {
      Row({ space: 6 }) {
        Circle({ width: 8, height: 8 })
          .fill(this.dotColor())
          .opacity(this.dotAlpha)
        Text(this.title.length > 0 ? this.title : $r('app.string.dsh_pip_idle'))
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.theme.onSurface)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        if (this.tool.length > 0) {
          Row({ space: 3 }) {
            Text(this.toolIcon())
              .fontSize(13)
            if (this.toolsDone > 0) {
              Text(String(this.toolsDone))
                .fontSize(10)
                .fontColor(this.theme.onSurfaceMuted)
            }
          }
          .padding({ left: 6, right: 6 })
          .height(20)
          .borderRadius(10)
          .backgroundColor(withAlpha(this.theme.accent, '26'))
          .alignItems(VerticalAlign.Center)
        }
        Button({ type: ButtonType.Circle }) {
          Text('—')
            .fontSize(12)
            .fontColor(this.theme.onSurfaceMuted)
            .fontWeight(FontWeight.Bold)
        }
        .width(24)
        .height(24)
        .backgroundColor(this.theme.surfaceLow)
        .onClick((): void => {
          this.state.showMini();
          FloatWindowManager.getInstance().setCompact(true);
        })
        Button({ type: ButtonType.Circle }) {
          Text('×')
            .fontSize(13)
            .fontColor(this.theme.onSurfaceMuted)
            .fontWeight(FontWeight.Bold)
        }
        .width(24)
        .height(24)
        .backgroundColor(this.theme.surfaceLow)
        .onClick((): void => {
          FloatWindowManager.getInstance().hide();
        })
      }
      .width('100%')
      .height(34)
      .padding({ left: 12, right: 8 })
      .alignItems(VerticalAlign.Center)

      Column() {
        Text(this.bodyText())
          .fontSize(12)
          .fontColor(this.theme.onSurface)
          .lineHeight(18)
          .maxLines(8)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Blank()
        Button($r('app.string.dsh_pip_back'))
          .fontSize(12)
          .fontColor(this.theme.onSurface)
          .backgroundColor(this.theme.surfaceLow)
          .borderRadius(9)
          .height(30)
          .width('100%')
          .onClick((): void => {
            FloatWindowManager.getInstance().bringToFront();
          })
      }
      .width('100%')
      .layoutWeight(1)
      .padding({ left: 12, right: 12, top: 6, bottom: 10 })
      .alignItems(HorizontalAlign.Start)
      // 正文区也能拖：之前只有 34vp 的标题栏接手势，按中间那片空白当然拖不动。
    }
    .width('100%')
    .height('100%')
  }

  /// 正文优先显示最新一句回复；没有就退回状态摘要。
  private bodyText(): ResourceStr {
    if (this.detail.length > 0) {
      return this.detail;
    }
    if (this.status.length > 0) {
      return this.status;
    }
    return $r('app.string.dsh_pip_waiting');
  }

  /// 工具名 → 图标。够用就行，认不出的统一齿轮。
  private toolIcon(): string {
    const name: string = this.tool;
    if (name.indexOf('bash') >= 0 || name.indexOf('run_code') >= 0) {
      return '⌘';
    }
    if (name.indexOf('read') >= 0) {
      return '◱';
    }
    if (name.indexOf('write') >= 0 || name.indexOf('edit') >= 0) {
      return '✎';
    }
    if (name.indexOf('fetch') >= 0 || name.indexOf('web') >= 0) {
      return '🌐';
    }
    if (name.indexOf('ui') >= 0) {
      return '👆';
    }
    return '⚙';
  }

  private summary(): string {
    if (this.status.length > 0) {
      return this.status;
    }
    return this.title;
  }

  build() {
    Column() {
      if (this.compact) {
        this.pillBar()
      } else {
        this.expandedPanel()
      }
    }
    .width('100%')
    .height('100%')
    // 半透明：85% 面色，能看见底下的内容又不糊掉字。
    .backgroundColor(withAlpha(this.theme.surface, 'D9'))
    // 悬浮窗的拖动交给系统：ArkUI 的 PanGesture 在 TYPE_FLOAT 窗口里收不到连续
    // move 事件，而 startMoving() 必须在这个窗口的 onTouch(Down) 里调。
    .onTouch((event: TouchEvent): void => {
      const manager: FloatWindowManager = FloatWindowManager.getInstance();
      const touch: TouchObject | undefined = event.touches.length > 0 ? event.touches[0] : undefined;
      if (touch === undefined) {
        return;
      }
      if (event.type === TouchType.Down) {
        manager.beginDragAt(touch.screenX, touch.screenY);
      } else if (event.type === TouchType.Move) {
        manager.dragToScreen(touch.screenX, touch.screenY);
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        // 窗口跟着手指移动时，Move 事件可能中途被系统断掉；抬手坐标才是最终位置。
        manager.dragToScreen(touch.screenX, touch.screenY);
      }
    })
    .borderRadius(this.compact ? 18 : 16)
    .border({
      width: this.glow === PipGlow.NORMAL ? 1 : 2,
      color: this.glow === PipGlow.RUNNING ? this.theme.success
        : (this.glow === PipGlow.ATTENTION ? this.theme.warning : this.theme.rule)
    })
  }
}

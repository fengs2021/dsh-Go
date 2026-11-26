/*
 * 应用内画中画浮层：贴着 Flutter 页面漂的一层 ArkUI。
 *
 * 它不是一个窗口，只是挂在 Index 根 Stack 里的普通组件，靠 position 定位。所以它只在 App
 * 前台时可见（要盖住别的应用走 FloatWindowManager 的 TYPE_FLOAT 系统悬浮窗）。
 * 交互照搬成熟做法：等比跟手拖动、松手就近吸附左右边、三档状态机、状态点呼吸。
 *
 * 「收起」不销毁组件而是移到屏外并关掉命中测试：Flutter 页面在它下面，组件树一抖就可能
 * 触发 Flutter view 重建，代价远高于挪一个位置。
 */
import display from '@ohos.display';
import { PipGlow, PipMode, PipState, PipTheme, defaultPipTheme } from './PipState';

const MINI_WIDTH: number = 232;
const MINI_HEIGHT: number = 68;
const EXPANDED_WIDTH: number = 340;
const EXPANDED_HEIGHT: number = 248;
const EDGE: number = 12;
const TOP_SAFE: number = 64;
const BOTTOM_SAFE: number = 76;

@Component
export struct FloatingPip {
  @State private mode: PipMode = PipMode.HIDDEN;
  @State private glow: PipGlow = PipGlow.NORMAL;
  @State private title: string = '';
  @State private status: string = '';
  @State private theme: PipTheme = defaultPipTheme(false);
  @State private posX: number = 0;
  @State private posY: number = 0;
  @State private dotAlpha: number = 1;

  private state: PipState = PipState.getInstance();
  private startX: number = 0;
  private startY: number = 0;
  private screenWidth: number = 380;
  private screenHeight: number = 800;
  private dotTimer: number = -1;
  private dropSubscription: (() => void) | undefined = undefined;

  aboutToAppear(): void {
    this.measureScreen();
    this.sync();
    this.dropSubscription = this.state.subscribe((): void => this.sync());
    this.snapToEdge(this.screenWidth - this.pipWidth() - EDGE,
      this.screenHeight - this.pipHeight() - BOTTOM_SAFE - 24);
  }

  aboutToDisappear(): void {
    if (this.dropSubscription !== undefined) {
      this.dropSubscription();
      this.dropSubscription = undefined;
    }
    this.stopBreathing();
  }

  private measureScreen(): void {
    const info: display.Display = display.getDefaultDisplaySync();
    const density: number = info.densityPixels || 3;
    this.screenWidth = Math.floor(info.width / density);
    this.screenHeight = Math.floor(info.height / density);
  }

  private pipWidth(): number {
    if (this.mode === PipMode.EXPANDED) {
      return Math.min(EXPANDED_WIDTH, this.screenWidth - EDGE * 2);
    }
    return Math.min(MINI_WIDTH, this.screenWidth - EDGE * 2);
  }

  private pipHeight(): number {
    return this.mode === PipMode.EXPANDED ? EXPANDED_HEIGHT : MINI_HEIGHT;
  }

  private sync(): void {
    this.mode = this.state.mode;
    this.glow = this.state.glow;
    this.title = this.state.title;
    this.status = this.state.status;
    this.theme = this.state.theme;
    if (this.glow === PipGlow.ATTENTION) {
      this.startBreathing();
    } else {
      this.stopBreathing();
      this.dotAlpha = 1;
    }
  }

  private startBreathing(): void {
    if (this.dotTimer !== -1) {
      return;
    }
    let fading: boolean = true;
    this.dotTimer = setInterval((): void => {
      this.getUIContext().animateTo({ duration: 600, curve: Curve.EaseInOut }, (): void => {
        this.dotAlpha = fading ? 0.35 : 1;
      });
      fading = !fading;
    }, 650);
  }

  private stopBreathing(): void {
    if (this.dotTimer === -1) {
      return;
    }
    clearInterval(this.dotTimer);
    this.dotTimer = -1;
  }

  private snapToEdge(targetX: number, targetY: number): void {
    const width: number = this.pipWidth();
    const height: number = this.pipHeight();
    const minX: number = EDGE;
    const maxX: number = Math.max(minX, this.screenWidth - width - EDGE);
    const minY: number = TOP_SAFE;
    const maxY: number = Math.max(minY, this.screenHeight - height - BOTTOM_SAFE);
    let finalX: number = maxX;
    if (this.mode === PipMode.EXPANDED) {
      // 展开态贴着边会显得被裁掉，改成水平居中。
      finalX = Math.max(minX, Math.min(maxX, Math.floor((this.screenWidth - width) / 2)));
    } else {
      finalX = targetX + width / 2 < this.screenWidth / 2 ? minX : maxX;
    }
    const finalY: number = Math.max(minY, Math.min(maxY, targetY));
    this.getUIContext().animateTo({ duration: 320, curve: Curve.FastOutSlowIn }, (): void => {
      this.posX = finalX;
      this.posY = finalY;
    });
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

  private pipBorderColor(): string {
    if (this.glow === PipGlow.RUNNING) {
      return this.theme.success;
    }
    if (this.glow === PipGlow.ATTENTION) {
      return this.theme.warning;
    }
    return this.theme.rule;
  }

  private visible(): boolean {
    return this.mode !== PipMode.HIDDEN;
  }

  @Builder
  header() {
    Row({ space: 6 }) {
      Text('⋮⋮')
        .fontSize(11)
        .fontColor(this.theme.onSurfaceMuted)
        .fontWeight(FontWeight.Bold)
      Circle({ width: 7, height: 7 })
        .fill(this.dotColor())
        .opacity(this.dotAlpha)
      Text(this.title.length > 0 ? this.title : $r('app.string.dsh_pip_idle'))
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.theme.onSurface)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      Button({ type: ButtonType.Circle }) {
        Text(this.mode === PipMode.EXPANDED ? '—' : '⤢')
          .fontSize(12)
          .fontColor(this.theme.onSurfaceMuted)
          .fontWeight(FontWeight.Bold)
      }
      .width(24)
      .height(24)
      .backgroundColor(this.theme.surfaceLow)
      .onClick((): void => {
        if (this.mode === PipMode.EXPANDED) {
          this.state.showMini();
        } else {
          this.state.showExpanded();
        }
        this.snapToEdge(this.posX, this.posY);
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
        this.state.hide();
      })
    }
    .width('100%')
    .height(34)
    .padding({ left: 10, right: 8 })
    .alignItems(VerticalAlign.Center)
    .priorityGesture(
      PanGesture({ fingers: 1, direction: PanDirection.All })
        .onActionStart((): void => {
          this.startX = this.posX;
          this.startY = this.posY;
        })
        .onActionUpdate((event: GestureEvent): void => {
          const width: number = this.pipWidth();
          const height: number = this.pipHeight();
          const maxX: number = Math.max(0, this.screenWidth - width);
          const maxY: number = Math.max(TOP_SAFE, this.screenHeight - height - 40);
          this.posX = Math.max(0, Math.min(maxX, this.startX + event.offsetX));
          this.posY = Math.max(TOP_SAFE, Math.min(maxY, this.startY + event.offsetY));
        })
        .onActionEnd((): void => {
          this.snapToEdge(this.posX, this.posY);
        })
        .onActionCancel((): void => {
          this.snapToEdge(this.posX, this.posY);
        })
    )
  }

  build() {
    Column() {
      this.header()
      if (this.mode === PipMode.EXPANDED) {
        Column() {
          Text(this.status.length > 0 ? this.status : $r('app.string.dsh_pip_waiting'))
            .fontSize(12)
            .fontColor(this.theme.onSurfaceMuted)
            .lineHeight(18)
            .maxLines(9)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
        .width('100%')
        .layoutWeight(1)
        .padding({ left: 12, right: 12, top: 8, bottom: 10 })
        .alignItems(HorizontalAlign.Start)
      } else {
        Row() {
          Text(this.status.length > 0 ? this.status : $r('app.string.dsh_pip_waiting'))
            .fontSize(11)
            .fontColor(this.theme.onSurfaceMuted)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          Text('⤢')
            .fontSize(11)
            .fontColor(this.theme.onSurfaceMuted)
            .margin({ left: 6 })
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 2, bottom: 10 })
        .alignItems(VerticalAlign.Center)
        .onClick((): void => {
          this.state.showExpanded();
          this.snapToEdge(this.posX, this.posY);
        })
      }
    }
    .width(this.pipWidth())
    .height(this.pipHeight())
    .backgroundColor(this.theme.surface)
    .borderRadius(14)
    .border({ width: this.glow === PipGlow.NORMAL ? 1 : 2, color: this.pipBorderColor() })
    .shadow({ radius: 12, color: '#1F000000', offsetX: 0, offsetY: 4 })
    .clip(true)
    .position({
      x: this.visible() ? this.posX : -4000,
      y: this.visible() ? this.posY : -4000
    })
    .opacity(this.visible() ? 1 : 0.001)
    .hitTestBehavior(this.visible() ? HitTestMode.Default : HitTestMode.None)
  }
}

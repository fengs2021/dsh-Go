
import common from '@ohos.app.ability.common';
import { FlutterPage } from '@ohos/flutter_ohos'

let storage = LocalStorage.getShared()
const EVENT_BACK_PRESS = 'EVENT_BACK_PRESS'
const DANMAKU_LINGER_MS: number = 9000
const DANMAKU_MUTE_MS: number = 30000

@Entry(storage)
@Component
struct Index {
  private context = getContext(this) as common.UIAbilityContext
  @LocalStorageLink('viewId') viewId: string = "";
  // 后台进度弹幕：由 DanmakuService 写入 AppStorage，这里只负责“贴一条在顶部”。
  @StorageLink('dshDanmakuLine') @Watch('onDanmakuLine') danmakuLine: string = '';
  @StorageLink('dshDanmakuIcon') danmakuIcon: string = '';
  @State shown: boolean = false;
  private hiddenUntil: number = 0;
  private lastLine: string = '';
  private hideTimer: number = -1;

  onDanmakuLine(): void {
    if (this.danmakuLine.length === 0) {
      this.shown = false;
      return;
    }
    if (this.danmakuLine === this.lastLine) return;
    this.lastLine = this.danmakuLine;
    if (Date.now() < this.hiddenUntil) return;
    this.shown = true;
    if (this.hideTimer >= 0) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => { this.shown = false; }, DANMAKU_LINGER_MS);
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      Column() {
        FlutterPage({ viewId: this.viewId })
      }
      .width('100%')
      .height('100%')

      if (this.shown) {
        Row() {
          Text(this.danmakuIcon)
            .fontSize(14)
            .margin({ right: 6 });
          Text(this.danmakuLine)
            .fontSize(13)
            .fontColor('#FFFFFF')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1);
        }
        .width('92%')
        .margin({ top: 44 })
        .padding({ left: 14, right: 14, top: 8, bottom: 8 })
        .backgroundColor('#CC1C1C1E')
        .borderRadius(18)
        .onClick(() => {
          this.hiddenUntil = Date.now() + DANMAKU_MUTE_MS;
          this.shown = false;
        })
      }
    }
    .width('100%')
    .height('100%')
  }

  onBackPress(): boolean {
    this.context.eventHub.emit(EVENT_BACK_PRESS)
    return true
  }
}

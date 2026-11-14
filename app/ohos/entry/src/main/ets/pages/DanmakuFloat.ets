// 浮窗里的内容：一条横向条，只显示当前这行弹幕。
// 内容通过 setUIContext(path, storage) 传入的 LocalStorage 实时更新，不碰 AppStorage。
@Entry
@Component
struct DanmakuFloatPage {
  @LocalStorageLink('line') line: string = '';
  @LocalStorageLink('icon') icon: string = '';

  build() {
    Row() {
      Text(this.icon)
        .fontSize(14)
        .margin({ right: 6 })
      Text(this.line)
        .fontSize(13)
        .fontColor('#FFFFFF')
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 14, right: 14, top: 6, bottom: 6 })
    .borderRadius(18)
    .backgroundColor('#E61C1C1E')
  }
}

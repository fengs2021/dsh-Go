
import common from '@ohos.app.ability.common';
import { FlutterPage } from '@ohos/flutter_ohos'
import { FloatingPip } from '../window/FloatingPip'

let storage = LocalStorage.getShared()
const EVENT_BACK_PRESS = 'EVENT_BACK_PRESS'

@Entry(storage)
@Component
struct Index {
  private context = getContext(this) as common.UIAbilityContext
  @LocalStorageLink('viewId') viewId: string = "";

  build() {
    Stack() {
      Column() {
        FlutterPage({ viewId: this.viewId })
      }
      .width('100%')
      .height('100%')

      // 应用内画中画浮层：平时 position 在屏外，Dart 侧经 dsh/pip 的 show 才出现。
      FloatingPip()
    }
    .width('100%')
    .height('100%')
  }

  onBackPress(): boolean {
    this.context.eventHub.emit(EVENT_BACK_PRESS)
    return true
  }
}

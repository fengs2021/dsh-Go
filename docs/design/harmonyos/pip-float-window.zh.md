# 画中画悬浮小窗（两套机制）

> 落地对象：`port71/app/ohos`（ArkTS 宿主）+ `port71/app/lib/pip/`（Dart 入口）。
> 参考实现：`shuwei-ai/swai`（HarmonyOS NEXT 原生应用，源码拆解见工作区 `docs/swai-pip-floatwindow.zh.md`）。
> 本文只写这套实现怎么用、边界在哪；踩坑结论都标了出处。

## 1. 两套机制，各管一段

| | 应用内浮层 | 系统悬浮窗 |
| --- | --- | --- |
| 文件 | `window/FloatingPip.ets` | `window/FloatWindowManager.ets` + `pages/FloatPanel.ets` |
| 形态 | 挂在 `pages/Index` 根 Stack 上的 ArkUI 组件 | `window.WindowType.TYPE_FLOAT` 独立窗口 |
| 可见范围 | 只在 App 前台 | 压在任何应用之上（微信、桌面、设置） |
| 前置条件 | 无 | `ohos.permission.SYSTEM_FLOAT_WINDOW`（system_basic，见 §4） |
| 状态源 | `window/PipState.ets` 单例 | 同一个单例（另一个页面实例） |

两套共用一份状态：`PipState` 的 `mode / glow / title / status / theme`。改的人 `notify()`，两个宿主自己订阅刷新。跨窗口没有别的通道可用——`FloatPanel` 是独立页面实例，拿不到 Dart 的 Provider。

## 2. 应用内浮层

`Index.ets` 现在是：

```ts
Stack() {
  Column() { FlutterPage({ viewId: this.viewId }) }.width('100%').height('100%')
  FloatingPip()
}
```

要点：

- **收起不销毁**：`position` 挪到 `(-4000, -4000)` + `opacity 0.001` + `hitTestBehavior None`（`FloatingPip.ets` 的 `build()` 尾部）。组件树里一旦用 `if` 条件渲染，下面那层 Flutter 页面可能跟着重建，代价远大于挪位置。
- **拖动是绝对定位**：`PanGesture` 起点 + `event.offsetX/offsetY` 直接算坐标，不做累加（避免长距离拖动漂移）；松手 `snapToEdge()` 就近吸附左右边，展开态改水平居中。
- **安全区**：顶 `TOP_SAFE=64`、底 `BOTTOM_SAFE=76`（vp），不压状态栏和输入条。
- **状态点**：`PipGlow.RUNNING` 绿、`ATTENTION` 琥珀并做 650ms/600ms 的呼吸（`animateTo` 改 alpha 0.35↔1），`NORMAL` 用强调色。

## 3. 系统悬浮窗

```ts
const config: window.Configuration = {
  name: 'dsh_pip_float',
  windowType: window.WindowType.TYPE_FLOAT,
  ctx: context
};
this.floatWindow = await window.createWindow(config);
await this.floatWindow.loadContent('pages/FloatPanel');
await this.floatWindow.setWindowBackgroundColor('#00000000');
await this.floatWindow.resize(w, h);
await this.floatWindow.moveWindowTo(x, y);
await this.floatWindow.showWindow();
```

- 尺寸单位是 **px**，所以全部按 `display.getDefaultDisplaySync().densityPixels` 从 vp 换算（胶囊 232×68vp、展开 340×248vp）；
- 拖动拖的是**窗口**：`FloatPanel` 的 `PanGesture` 把每帧增量交给 `FloatWindowManager.moveBy(dx, dy)`，内部夹到屏幕内再 `moveWindowTo`；
- 回到应用用 `context.startAbility({bundleName, moduleName, abilityName})` 自拉起，失败只记日志；
- 建窗失败一律降级（`catch` 里清引用 + 记日志），不弹窗、不影响主界面。

## 4. 权限：TYPE_FLOAT 不是声明就能拿到的

`ohos.permission.SYSTEM_FLOAT_WINDOW` 是 system_basic 级权限，三方应用在 `module.json5` 里声明也批不下来（Swai 的做法是在运行时用 shell 桥跑 `atm perm -g` 直接授）。

dshgo **没有**本地 shell 桥，所以这里不做偷偷授权：建窗失败时把命令按真实 tokenId 打进日志，由 PC 侧 `hdc` 授一次即可（同一台设备只需一次）：

```bash
# accessTokenId 从日志里拿（DshPip 那条 warn）
tools/hdc-oh/hdc.exe -t <ip>:<port> shell "atm perm -g -i <accessTokenId> -p ohos.permission.SYSTEM_FLOAT_WINDOW"
```

没授之前：应用内浮层照常工作，系统悬浮窗这条路静默不可用。

### 4.1 真机实测：这条路在现有签名材料下走不通（2026-11-26）

拿 v94（commit `c9a415e42`，`appProvisionType: debug`）在 `192.168.2.102` 上试过三步：

| 步骤 | 结果 |
| --- | --- |
| 只声明 `SYSTEM_FLOAT_WINDOW`（`c9a415e42`） | `atm perm -g -i 537628011 -p ohos.permission.SYSTEM_FLOAT_WINDOW` → `Error: Permission ... is not requested by the application` |
| 再补 `reason` + `usedScene.abilities=[EntryAbility]`（未提交的对照实验） | 同一条命令同样被拒 |
| 事后核对 | `bm dump` 的 `reqPermissions` **确实包含** `ohos.permission.SYSTEM_FLOAT_WINDOW`，`reqPermissionStates` 全 0；`atm perm -h` 写着「only debug hap tokens can be modified」，而本包 `appProvisionType=debug` |

结论：`atm` 的「not requested」不是字面意思——它看的是 token 上**可授予的 ACL 集合**，而
`SYSTEM_FLOAT_WINDOW` 是 system_basic 权限，必须出现在签名 profile 的 `acls` 里才会被登记。
现有签名材料没有这条 ACL，所以**声明写上也没用，三方签名下这条永远授不下来**。
要么拿到带该 ACL 的 profile（AGC 特批/系统签名），要么放弃系统悬浮窗这条路。
Swai 的做法（运行时 `atm` 自授）在这台设备和这份签名上同样不成立——它的
`ensurePermissionSilently()` 把错误吞掉了，看起来「实现了」而已。

## 5. Dart 入口与通道协议

`app/lib/pip/pip_window.dart`，通道名 `dsh/pip`：

| 方法 | 参数 | 作用 |
| --- | --- | --- |
| `show` | `compact: bool` | 显示应用内浮层（胶囊/展开） |
| `hide` / `toggle` | — | 收起 / 切换 |
| `setContent` | `title, status, glow` | 换文案与状态点颜色 |
| `setTheme` | `dark, surface, surfaceLow, onSurface, onSurfaceMuted, rule, accent` | 覆盖色板（缺省用 palette.dart 的值） |
| `float` | `show: bool, compact: bool` | 建/收系统悬浮窗 |
| `floatAuto` | `enabled: bool` | 允许退到后台时自动升悬浮窗 |
| `bringToFront` | — | 回主界面并收窗 |

其它平台没有这个插件，`PipWindow` 吞掉 `MissingPluginException` / `PlatformException` 返回 `false`，调用方不用按平台分支。

**真实调用点**：`app/lib/state/live_activity_state.dart` 的 ohos 分支。实时活动本来就要推 `dsh/notify`，这里顺手把同一份 `LivePush` 翻译成浮窗内容（`_feedPip`）：`running` 升起胶囊、`waiting` / `failed` 切琥珀并收起、结束清空。它显示的就是「当前这一轮在干什么」，和状态栏、锁屏的实时活动永远一致。

## 6. 颜色从哪来

浮窗和主界面不在同一个渲染树里，拿不到 Material 主题，所以：

- 默认值直接抄 `app/lib/ui/theme/palette.dart` 与 `semantic_colors.dart`（浅：面 `#F0F4FD` / 字 `#1E232E` / 线 `#DCE0E8`；深：面 `#1C1F28` / 字 `#E6E9F0` / 线 `#343841`；强调 `#4B67B4` / `#97B1F0`；success `#337250` / `#8BCCA6`；warning `#936123` / `#E6BD7C`），没有自造颜色；
- 明暗跟随系统：`init()` 和每次 `show()` 前读 `context.config.colorMode`；
- 用户自定义强调色要联动，调 `PipWindow.applyTheme(...)` 从 Dart 下发即可（通道与解析都已就位）。

## 7. 验证到了哪一步

| 项 | 结果 |
| --- | --- |
| `tooling/ohos/check-arkts.sh --sdk /root/sdk --hms-stubs` | 通过（0 error，产出 unsigned HAP） |
| `flutter analyze` | `No issues found!` |
| 真机 | **未验证**：TYPE_FLOAT 需先按 §4 授权一次；应用内浮层的手感（拖动/吸附/与输入条重叠）只有真机能看 |

## 8. 已知边界

- `FloatPanel` 与 `Index` 是**两个页面实例**，业务状态只能走 `PipState` 或 AppStorage，不能指望 `@State` 传过去；
- 系统悬浮窗的白名单可能随系统升级收紧（本来就是 system_basic 权限），所以应用内浮层必须是能独立工作的那套；
- `moveWindowTo` 连续拖动时中间帧会被系统合并，`moveBy` 里把这类异常记 debug 后忽略，不算失败；
- 展开态高度写死 248vp，不按内容自适应——实时活动本来就只有一两行。

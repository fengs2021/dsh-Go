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

### 4.1 真机实测：atm 授不下来，但**建窗照样成功**（2026-11-26）

先给结论：`atm perm -g` 在这台设备上拒绝了，`TYPE_FLOAT` 窗口却**能正常创建并压在桌面上**
（胶囊态「正在干活」，见 `_shots`）。所以「权限没授 → 悬浮窗不可用」这个推论是错的，
下面是被证伪的过程，留着免得下次有人重走。

拿 v94（commit `c9a415e42`，`appProvisionType: debug`）在 `192.168.2.102` 上试过三步：

| 步骤 | 结果 |
| --- | --- |
| 只声明 `SYSTEM_FLOAT_WINDOW`（`c9a415e42`） | `atm perm -g -i 537628011 -p ohos.permission.SYSTEM_FLOAT_WINDOW` → `Error: Permission ... is not requested by the application` |
| 再补 `reason` + `usedScene.abilities=[EntryAbility]`（未提交的对照实验） | 同一条命令同样被拒 |
| 事后核对 | `bm dump` 的 `reqPermissions` **确实包含** `ohos.permission.SYSTEM_FLOAT_WINDOW`，`reqPermissionStates` 全 0；`atm perm -h` 写着「only debug hap tokens can be modified」，而本包 `appProvisionType=debug` |

当时据此下的结论是「没有 ACL 就永远授不下来，这条走不通」——**被真机推翻**：
同一天在桌面上抓到了浮窗（胶囊态压在桌面图标之上），说明 `window.createWindow({windowType:
TYPE_FLOAT})` 不依赖这个权限是否授予，至少 API 26 + 本签名材料下不依赖。

能对上的事实：`atm` 的「not requested」看的是 token 上**可授予的 ACL 集合**（system_basic
权限要出现在签名 profile 的 `acls` 里才会被登记），所以这条**授权命令**注定失败；
但**建窗 API 本身没有强制这个校验**。两件事被混成一件，是我上一篇判断的错处。

现在的实现照原样：声明保留（声明无害，且在更严的系统上可能就是必要条件），
`ensurePermissionSilently` 这类运行时自授权限的写法**不要加**——Swai 那套在这台设备上
既无必要也不生效，它的 `ensurePermissionSilently()` 只是把错误吞了。

## 4.2 悬浮窗里「拖不动 / 点不动」到底是哪几步（2026-11-26 真机逐项排除）

按发生顺序记录，四个坑互相掩盖，只看现象会误判：

| # | 现象 | 真因 | 处理 |
| --- | --- | --- | --- |
| 1 | 拖整张卡没反应 | `PanGesture` 只挂在 34vp 的标题栏上，正文区没接手势 | 正文区也挂 `.parallelGesture()`（不抢按钮点击） |
| 2 | 挂了手势仍然不动 | **`PanGesture` 在 `TYPE_FLOAT` 窗口里不触发**（同窗口的 `onClick`、`onTouch` 都正常） | 改用 `onTouch` |
| 3 | 用 SDK 的 `startMoving()` 能拖走，但拖完 ⤢ / 回到应用全哑 | 系统进入 moving 后**不再回传 `TouchType.Up`**，窗口卡在 moving 状态吞掉后续所有输入 | 放弃 `startMoving()`，自己算坐标 + `moveWindowTo` |
| 4 | 自己算坐标后跟手比例只有 ~0.23 | **`TouchObject.screenX/screenY 是 vp**，窗口坐标是 px，混着用等于把手指数缩了 1/density | `screen * densityPixels - grab` |

最终实现（`window/FloatWindowManager.ets` 的 `beginDragAt` / `dragToScreen`）：`Down` 记「手指屏幕坐标 × density − 窗口当前坐标」的抓取偏移，`Move` 和 `Up/Cancel` 都按偏移反算窗口左上角再 `moveWindowTo`（抬手里程碑很关键：窗口跟着手指移动时 Move 事件会被系统中途断掉，抬手坐标才是最终位置）。

另一个独立的坑：**尺寸变化后必须重新夹取位置**。展开态窗口更宽，旧 `currentX` 可能已经越界，下一次拖动时 `clamp` 会把窗口朝反方向拽回去（实测：右拖 300px，窗口反而左移 214px）。现在 `resize` 之后统一 `clampToScreen()`。

### 4.3 「回到应用」：三方应用在后台拉不起自己

真机日志（`hilog -x | grep A03F10`）三连：

```
DshPip: wantAgent rejected: Parameter error. Too few parameters.
DshPip: openLink rejected: The application does not have permission to call the interface.
DshPip: startAbility rejected: The application does not have permission to call the interface.
```

- `startAbility` / `openLink`（`dshgo://`）都被拒：应用在后台时启动 Ability 需要
  `START_ABILITIES_FROM_BACKGROUND`（system_basic），三方拿不到，本 SDK 也没有
  `FLAG_START_WITHOUT_USER_ACTION` 之类的绕过位；
- `wantAgent.trigger` 这个 SDK 的 `TriggerInfo` 只有 `code / want / permission / extraInfo`，
  传 `{ code, want }` 仍报「Too few parameters」，暂时没跑通；
- 现状：三条都失败时 toast「系统不允许后台启动，请从桌面图标打开」，不静默。

要做成「一键回前台」，只剩通知这条正路：发一条带 wantAgent 的通知，用户点通知由系统拉起（属于用户操作，不受后台限制）。

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
| 真机 v94（`ccchimneyyy.dsh.go` 1.3.0） | **两套都跑起来了**：应用内浮层在聊天页右下角（绿点=在跑），系统悬浮窗在桌面之上（胶囊态「正在干活」）。触发链是"有对话在跑 → Dart 推实时活动 → 浮窗升胶囊 → 退到后台时 `onBackground` 自动升系统悬浮窗"，无需手动操作 |

## 8. 已知边界

- `FloatPanel` 与 `Index` 是**两个页面实例**，业务状态只能走 `PipState` 或 AppStorage，不能指望 `@State` 传过去；
- 系统悬浮窗的白名单可能随系统升级收紧（本来就是 system_basic 权限），所以应用内浮层必须是能独立工作的那套；
- `moveWindowTo` 连续拖动时中间帧会被系统合并，`moveBy` 里把这类异常记 debug 后忽略，不算失败；
- 展开态高度写死 248vp，不按内容自适应——实时活动本来就只有一两行。

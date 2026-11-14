# 界面操作的授权状态：引擎写文件、原生读、页面显示

手机上有两条互不相干的链路：

| 链路 | 谁在跑 | 管什么 |
| --- | --- | --- |
| 系统操作 | ArkTS 宿主（`app/ohos/entry/src/main/ets/phone/`），走 native host | 打开应用/系统页面、发通知、写剪贴板、交还给人 |
| 界面操作 | 本机引擎（Node 运行时）经 HDC 通道 `runtime/ohos/phone/hdc-link.mjs` | 读界面、点按、输入、滑动、按键、截图、启停应用、跑命令 |

界面操作的授权是「手机是否信任本机的调试公钥」，只有跑在引擎里的那条链路知道。引擎不能反过来调用 App 的 ArkTS（没有那种通道），因此状态这样传递：

```
引擎自检/被请求 ──写──> $HOME/.dsh/dsh-app/hdc-status.json ──读──> HdcChannelStatus.ets ──> Dart 页面
页面点「重新检测」 ──写──> $HOME/.dsh/dsh-app/hdc-probe.json ──每 2s 轮询──> 引擎自检
```

## 运行时段（`runtime/ohos/phone/hdc-status.mjs`）

- `statusOf(report, source)`：把 hdc-link 的自检结果压成一个扁平对象：`v`、`updatedAt`、`source`（boot / request）、`stage`（authorized / unauthorized / no_port / error）、`authorized`、`port`、`ports`（最多 4 个）、`defaultPort`、`ms`、`error`、`keySource`（shipped / user）、`keyPath`、`pemBytes`、`fingerprint`、`hints`（最多 3 条）。
- `writeStatus()`：先写临时文件再 rename，失败不影响调用方——状态写不进去不该让工具报错。
- `probeAndWrite(source)`：抓异常，失败也落一个 `stage=error` 的文件，页面才不会一直转圈。
- `readRequestedAt()`：读 `{at}`；坏文件返回 0，不当成新请求。
- `startHdcStatusWatch(ctx, {intervalMs = 2000})`：每两秒看一次请求文件，只有 `at` 变新才重新自检；`ctx.effect` 收尾时清掉定时器。

启动探针（`runtime/ohos/phone/index.mjs`）通过时写 `authorizedStatus()`，失败时先打印 `[phone-hdc] 下一步：…` 再 `probeAndWrite('boot')`。

状态文件里没有手机号、没有密钥内容，只有公钥 PEM 的字节数和指纹，可以给页面直接显示。

## 原生段（`app/ohos/entry/src/main/ets/phone/HdcChannelStatus.ets`）

`HdcChannelStatus` 以 `filesDir` 构造，路径同 `RuntimePaths.dshHome + '/dsh-app/...'`。`read()` 返回 `Map<string, Object|null>`（键名与状态文件一致，读不到返回空 Map，页面对「没读到」和「没授权」给的是两种文案）；`request()` 写 `{at: Date.now()}`。

`runtime/RuntimePlugin.ets` 在 `handle()` 里新增两个方法：`hdcStatus` → `read()`，`hdcProbe` → `request()`（都在 `phoneAttach` 之前返回，不依赖手机工具会话）。

## 应用段

- `app/lib/runtime/runtime_bridge.dart`：`hdcChannelStatus()`（`invokeMapMethod('hdcStatus')`，安卓上 `MissingPluginException` → null）、`requestHdcProbe()`。
- `app/lib/state/system_actions_state.dart`：`HdcStage` + `HdcChannelState`（`loaded` / `stage` / `checkedAt` / `port` / `hints` / `checking`，`fromMap` 认 `present` 与 `stage`）；控制器 `refreshHdc()` 在 `_load`、回到前台、以及 `probeHdc()` 的轮询里调用。`probeHdc()` 发请求后最多等 12 × 1.5s，一旦 `checkedAt` 变新就停。
- `app/lib/ui/phone/system_actions_page.dart`：在「能做的」和「做不到的」之间加一张卡片「界面操作（调试通道）」，标题只说现在的状态（已授权 / 还没授权 / 没找到调试端口 / 检测失败 / 还没检测），说明优先用引擎给的 `hints`，右侧是上次检测时间（24 小时制），点一下重新检测。未授权时下面跟一条「第一次要授权」的四步说明。「做不到的」里原来那条「看屏幕、点按其他应用 / 系统不允许」已经删掉——现在它是能做到、只是要先授权。

## 测试

`runtime/tests/ohos/hdc-status.test.mjs`（4 个）：`stageOf` 三种结果、落盘字段与原子写后不留临时文件、自检抛错仍落 `error`、请求序号去重与坏文件返回 0。

`app/test/phone/system_actions_page_test.dart` 新增一组「界面操作 says whether the debug channel is authorized」：已授权（有检测时间、无四步）、未授权（引擎的下一步优先于默认文案 + 四步）、没有状态（说没检测过，不谎称能用）、检测失败（指向日志 + 保留四步）。

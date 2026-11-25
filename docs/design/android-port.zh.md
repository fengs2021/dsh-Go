# Android 版本（android/port）要带哪些能力

分支：`android/port`（从 `origin/main` @ `d73c679c3` 拉出，worktree 在 `../androidport`）。

## 0. 先说结论

上游 main 本来就是 **Android 优先**的 Flutter 应用：安卓宿主已经具备
`PrivilegedChannel`（Shizuku / ADB 两条通道）、`CompanionAlwaysOnService` 前台服务、
`SYSTEM_ALERT_WINDOW` 声明与一整套 `pet/OverlayViews` 悬浮层。
所以「安卓版本」不是从零移植，而是 **把鸿蒙侧这几个月的能力，按 Android 的形态补回去**，
核心只有两件：**① 插入/排队联动修复**，**② 内置 hdc 通道（Android 直接操作鸿蒙手机）**。

## 1. 现状盘点（main 上已有什么）

| 能力 | main 现状 | 证据 |
| --- | --- | --- |
| 前台服务常驻 | ✅ `companion/CompanionAlwaysOnService.kt` | 已有 `FOREGROUND_SERVICE*` 权限声明 |
| 悬浮层 | ✅ `pet/OverlayViews.kt`、`PetOverlay`、`AskBar` | `AndroidManifest.xml` 已声明 `SYSTEM_ALERT_WINDOW` |
| 特权命令通道 | ✅ `PrivilegedChannel` 接口 + `ShizukuChannel` + `AdbChannel` | `phone/background/PrivilegedChannel.kt` |
| 后台策略 | ✅ `BackgroundControl` / `BackgroundPolicy` / `AdbStarter` | 同上目录 |
| 插入/排队联动 | ❌ 与鸿蒙侧同一个 bug | `app/lib/state/chat_state.dart:1352` 仍写死 `running ? steer : now` |

## 2. 要放进去的功能（按优先级）

### P0-1 插入/排队跟随 DSH 设置（直接移植）

鸿蒙侧已修（commit `390f9a3f8`）：新增 `effectiveSendMode()` 纯函数 + `busyEnterProvider`
（读引擎 `settings/describe` 的 `conversation.busyEnter`，默认 `queue`），发送路径只同步读缓存、
不发 RPC。Android 分支只要把这套搬过来（同一份 Dart 代码，无需改宿主），并把
`chat_state` 里那条写死的 `steer` 换掉。

### P0-2 内置 hdc 通道：Android 直接操作鸿蒙手机

**目标**：Android 手机上的 DSH 能像现在的 PC 一样，对一台鸿蒙手机执行
`aa start` / `uitest uiInput` / `power-shell` / `bm dump` 等命令。

**为什么可行**：hdc 的 TCP 端不校验公钥——我们这几天用 PC 的 `hdc.exe tconn <ip>:45957`
直接就能连上并执行 shell，全程没有配对弹窗。Android 端只需实现一个 hdc 客户端。

**落点**：新增 `HdcChannel : PrivilegedChannel`，与 `ShizukuChannel` / `AdbChannel` 并列，
复用现有 `Bundle` 协议（`Proto.OP` 等），这样上层 `phone` 工具、自动化、计划任务全都不用改。

实现要点（按我们实测的 hdc 3.2 行为）：

1. 连接：`Socket(host, port)`，默认端口 `45957`（鸿蒙「无线调试」页显示，可扫描 `/24` 发现）；
2. 握手：发 `CNXN` 包（`"OHOS HDC"` + 版本串 `Ver: 3.2.0c` + 16 位十六进制 hash），收 `AUTH`/`CNXN`；
   本地回环或非 enterprise 校验时不需要公钥；
3. 通道：`OPEN` 建立 shell 通道 → `WRTE` 写命令行 → `OKAY`/`CLSE` 收输出；
4. 加一层薄封装：`exec(cmd) -> {exit, stdout, stderr}`，再映射到 `Proto` 的请求/响应 Bundle；
5. 安全：沿用 `BackgroundPolicy` 的命令白名单（禁止 `bm uninstall`、`rm -rf` 等），
   并把「目标设备」做成显式配置（IP + 端口），不与本机混用。

**里程碑 M1**：`HdcChannel` 能跑通 `exec("echo ok")` 与 `exec("aa start -a EntryAbility -b <bundle>")`。

### P1-1 系统悬浮窗（这才是你要的「悬浮窗」）

Android 有 `SYSTEM_ALERT_WINDOW`，已有 `OverlayViews`/`PetOverlay` 可复用：
把鸿蒙侧的应用内胶囊升级成**真正的系统悬浮窗**——跨 App 常驻，显示当前会话是否在跑、
最近一行输出、以及一个「停止」按钮；点击跳回会话。

落点：`app/lib/ui/shell/floating_pill.dart` 的 UI 状态机可复用，宿主换成 Android overlay；
`floatingPillProvider` 的开关留在设置 → 通用。

**里程碑 M2**：前台/后台都能看到胶囊，点开有停止按钮，权限未授予时引导去系统设置。

### P1-2 计划任务（夜间/每日自动化）

鸿蒙侧现在是 PC 脚本（`scripts/phone-night*.sh`、`phone-daily-apps.sh`）+ systemd。
Android 版应内置为「计划任务」：

- 触发：`AlarmManager.setExactAndAllowWhileIdle` + 前台服务兜底；
- 动作：通过 `HdcChannel` 对目标鸿蒙手机执行「唤醒 → 解锁 → 拉起 App → 截图 → 熄屏」；
- 与现有的 `BackgroundControl` 复用准入与白名单；
- 任务内容放 JSON（步骤列表），不写死在代码里，便于改「打开小黑盒/中国移动签到/起点读书福利」。

**里程碑 M3**：一项「每天 03:00 对鸿蒙手机跑签到」的计划任务可从 UI 创建并执行。

### P2 技能与文档

`night-run`（夜间唤醒跑任务）、`zhuoyitong`（卓易通容器里开安卓 App）这两个内置技能可直接随包；
鸿蒙专属章节（WorkScheduler/长时任务/ACL）保留为「目标机说明」，因为 Android 端操作的是**鸿蒙手机**，
这些约束仍然是对方设备的约束，值得写进技能里。

### 不移植

- 鸿蒙 `WorkScheduler` / `continuousTask` / `KEEP_BACKGROUND_RUNNING_SYSTEM`：Android 有自己的前台服务；
- `SYSTEM_FLOAT_WINDOW` ACL 申请：已证伪（官方仅 PC/2in1 + 视频通话/投屏场景）；
- 鸿蒙 `EntryAbility` / ArkTS 宿主相关代码。

## 3. 风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| hdcd 端口/协议随版本变化 | 我们只在 hdc 3.2.0c + HarmonyOS 6 上验证过 | 版本串与端口做成配置；失败时回退到「提示用户在目标机开无线调试」 |
| 目标机 IP 漂移 | 鸿蒙侧开了「随机 MAC」，静态租约失效 | 复用 `scripts/phone-night.sh` 的 `/24` 扫描发现逻辑 |
| 悬浮窗被系统回收 | 国产 ROM 会杀 overlay | 前台服务 + `OverlayViews` 已有重挂机制 |
| 命令误伤 | overlay/hdc 都是高权限 | 沿用 `BackgroundPolicy` 白名单，默认只放行 `aa/uitest/power-shell/bm dump` |

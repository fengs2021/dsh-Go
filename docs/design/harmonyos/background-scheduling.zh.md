# 鸿蒙后台定时：WorkScheduler 能不能救「锁屏后不跑」

日期：2026-11-23。状态：**实验进行中**，只记录已核实的事实与已排除的选项，不写“已完成”。

## 问题

手机锁屏静置一段时间后，DSH（本机引擎）被系统冻结：定时的回合不会按时执行，解锁后才补跑。

## 已核实的事实

| 结论 | 证据 |
|---|---|
| `allowAppRunWhenDeviceFirstLocked` **第三方应用改不了** | 写进 `AppScope/app.json5` 后 hvigor 报 `00303038 Schema validate failed`；`/root/sdk/toolchains/modulecheck/app.json` 与 `module.json` 里都没有这个字段。它只出现在 `bm dump` 的 `applicationInfo` 里（系统默认值 false） |
| 长时任务需要「有任务在跑」才成立 | 现有实现是 `backgroundModes: ["dataTransfer"]` + `ContinuousTaskOwner`（240 s live view 续命），没有任务时没人持锁，锁屏后照常冻结 |
| WorkScheduler 扩展可以声明并被系统接受 | `module.json5` 增加 `EngineWakeAbility`（`type: "workScheduler"`）后 `check-arkts` 通过、`bm dump` 第 560 行能看到该扩展 |
| Work 注册是幂等的，重复注册会报 `9700005` | 第一次注册后再次 `startWork` 返回 `BussinessError 9700005: The work has been already added`；改为「先 `stopWork` 再 `startWork`」后日志出现 `wake work registered` |
| 我们的 INFO 级 hilog 被系统过滤 | 同一条日志用 `hilog.info` 时 `hilog -x` 查不到，改成 `hilog.warn` 立刻可见（`13:28:14 W .../DshWake: entry onCreate entered`） |
| 熄屏状态下 `aa start` 不会走 `onForeground` | 只在 `onForeground` 注册时日志一直缺失；挪到 `onCreate` + `onForeground` 都有后才稳定出现 |
| WorkScheduler 扩展上下文**没有** `startAbility` | ArkTS 编译报 `Property 'startAbility' does not exist on type 'WorkSchedulerExtensionContext'`，所以「唤醒后把主 Ability 拉到前台」这条走不通 |

## 当前实验

- 注册参数（最终版）：`workId 1001`、`isRepeat: true`、`repeatCycleTime: 20 min`、`isPersisted: true`、`networkType: NETWORK_TYPE_ANY`，**不带充电/电量条件**（第一版带了 `CHARGING_PLUGGED_ANY` + `batteryLevel 20`，怀疑把 work 挂住了）。
- 注册时刻 13:28:14，13:28:33 熄屏，观察窗口 13:28 → 14:15。
- 判据：`hilog -x | grep DshWake` 里出现 `workScheduler woke the app at ...`（扩展 `onWorkStart` 里的 warn 日志）。

## 若 WorkScheduler 不触发，剩下三条

1. **Agent Reminder 精确闹钟**：准点通知 + 一键进入；只提醒，不执行代码。
2. **整夜持长时任务**：睡前前台启动一次 dataTransfer 长任务，靠 live view 续命；不保证低电量/内存压力下存活。
3. **外部触发**：PC 侧 cron 或 Cloudflare Cron 打手机 bridge 接口，用网络请求把应用唤到可执行窗口；需要在手机上暴露一个鉴权入口。

## 若 WorkScheduler 触发，下一步

扩展里**不能** `startAbility`，所以要让定时的回合真正执行，只有两条：

- 在扩展进程里直接构造 `RuntimeController(this.context)` 起引擎（ctor 接受 `common.Context`，已确认签名；未知：扩展进程能否加载 `libdsh_host`、两次引擎会不会抢同一个 `dshHome` 锁）；
- 或者扩展只负责「写唤醒记录 + 发一条提醒」，把执行留给用户点进来或下一次前台。

## 复现命令

```bash
H=tools/hdc-oh/hdc.exe
$H shell "power-shell suspend"                     # 熄屏 = 锁屏
$H shell "hilog -x | grep -i DshWake | tail -5"     # 看唤醒/注册日志
$H shell "bm dump -n ccchimneyyy.dsh.go | grep -A3 EngineWakeAbility"  # 扩展是否在包里
```

脚本：`scripts/patch-*`（与本问题无关）；本问题没有脚本，结论以本文为准。

## 官方约束（2026-11-23 查证）

来源：`openharmony/docs` 的 `task-management/work-scheduler.md` 与 `continuous-task.md`。

1. **WorkScheduler 有频率上限**，按应用活跃分组：活跃 2 小时 / 经常使用 4 小时 / 常用 24 小时 / 极少使用 48 小时 / 受限或从未使用 **禁止**。→ 我们注册的 20 分钟重复周期根本不可能生效，这解释了 13:28→14:16 没有触发。
2. **单次回调最多 2 分钟**，超时系统终止扩展进程（特权应用可延长，第三方不行）。
3. 扩展**单独进程**，且**禁止**在扩展里调用 `backgroundTaskManager` / audio / media 等接口 —— 也就是说扩展里不能申请长时任务，也不能用我们的引擎启动路径（`RuntimeController` 会申请长时任务）。
4. `WorkSchedulerExtensionContext` 没有 `startAbility`（SDK 类型里没有，实测编译报错）。
5. 长时任务**只能由 UIAbility 申请**；`dataTransfer` 要求进度更新（首次不得超过 10 分钟，之后也要持续更新），否则长时任务被取消。

## 同类项目的做法

| 项目 | 做法 | 对我们的意义 |
|---|---|---|
| [forwardz666/Syncthing-for-HarmonyOS](https://github.com/forwardz666/Syncthing-for-HarmonyOS)（★17） | **真正保活靠长时任务 + 通知**；WorkScheduler 只做「兜底探活」：30 分钟一次，ping 本地 REST，核心不在了就发一条信息通知。扩展里明确不碰 `backgroundTaskManager` | 与我们结论一致：WorkScheduler 不能承载执行，只能做提醒/探活 |
| [Explore-In-HMOS/how-to-build-background-task-scheduler](https://github.com/Explore-In-HMOS/how-to-build-background-task-scheduler) | 手表上的周期天气同步，用 `WorkSchedulerExtensionAbility` + 周期 work | 可参考工程结构，但手表与手机的频率策略不同 |
| [Explore-In-HMOS/how-to-use-background-tasks-kit](https://github.com/Explore-In-HMOS/how-to-use-background-tasks-kit) | 延迟任务按系统条件拉取天气 | 同上，属「时效性要求不高」的场景 |

## 修订后的方案

- **能扛过夜的**：睡前在前台点一次「今晚保持运行」→ UIAbility 申请 `dataTransfer` 长时任务 → 每 4 分钟更新一次 live view 进度（现有 `ContinuousTaskOwner` 已实现）→ 通知栏常驻。用户删通知 = 系统停止长时任务，这个必须如实告诉用户。
- **WorkScheduler 只用于兜底**：2 小时一次（不是 20 分钟），扩展里只做三件事：写唤醒记录、ping 本机引擎、引擎不在时发一条「今晚的定时任务可能没跑」通知。
- **不要**在扩展里起引擎：2 分钟超时 + 禁止 `backgroundTaskManager` + 单独进程，三点都会让引擎启动失败或被杀。

## 第二轮调研（2026-11-23 下午）：机制全图与源码级证据

### 1. 延迟任务（WorkScheduler）的真实频率

源码：`resourceschedule_work_scheduler/services/native/src/work_status.cpp`

| 状态 | 最小间隔 | 出处 |
|---|---|---|
| 系统应用 | 5 分钟 | `SYS_APP_MIN_REPEAT_TIME = 5 * 60 * 1000` |
| 第三方 · 充电中 | 一律 **2 小时** | `GROUP_INTERVAL_MAP` 全表映射到 `TWO_HOUR` |
| 第三方 · 未充电 · 活跃(10) | **2 小时** | `bundle_active_group_map.h:25` |
| 第三方 · 经常使用(20) | 4 小时 | 同上 `2 * TWO_HOUR` |
| 第三方 · 常用(30) | **24 小时** | 同上 |
| 第三方 · 极少使用(40) | **48 小时** | 同上 |
| 第三方 · 受限(50) / 从未使用(60) | 禁止 | 同上（50 无表项） |

另有硬下限 `SET_INTERVAL_LOWER = 2h`（`work_scheduler_service.cpp:122`）。
→ 结论：**任何「几十分钟级」的定时唤醒对第三方都不存在**；最好情况也是 2 小时一次。

### 2. 长时任务的封堵面（API 26）

`@ohos.resourceschedule.backgroundTaskManager.d.ts` + `docs/spec/continuous_task.md`：

| 模式 | 第三方可用性 | 系统性取消/暂停原因 |
|---|---|---|
| `DATA_TRANSFER`(1) | 可用（需 `KEEP_BACKGROUND_RUNNING`） | `LOW_SPEED(4)`、`NOT_UPDATE(12)`（首次进度更新 >10 分钟） |
| `AUDIO_PLAYBACK`(2) | 可用 | 未接 AVSession(5)、未在播放(6)、静音/无有效音频 |
| `AUDIO_RECORDING`(3) | 可用 | 未录音(7) |
| `LOCATION`(4) | 可用 | 未使用定位(8)、位置未移动(15) |
| `BLUETOOTH_INTERACTION`(5) | 可用 | 未使用蓝牙(9)、无蓝牙数据(14) |
| `MULTI_DEVICE_CONNECTION`(6) | 可用 | 未使用多设备(10) |
| `MODE_VOIP`(8) | 可用 | 无音频/录音流(13) |
| `TASK_KEEPING`(9) | **手机/平板需受限 ACL `KEEP_BACKGROUND_RUNNING_SYSTEM`** | — |
| `MODE_SPECIAL_SCENARIO_PROCESSING`(13) | **API24+ 需受限 ACL `KEEP_BACKGROUND_RUNNING_SPECIAL_SCENARIO`** | `USER_UNAUTHORIZED(14/19)` |
| `MODE_NEARLINK`(14) | 可用（需星闪业务） | 未使用/无数据 |

→ 结论：**「纯计算 / 纯轮询」没有合法档位**。手机上的第三方要么用 `DATA_TRANSFER`（会被低速/不更新检测），
要么拿受限 ACL 走 `TASK_KEEPING`（个人开发者不可得，上游 dsh-Go 的设计文档也写明「面向调试签名或指定设备安装」）。

### 3. 代理提醒（reminderAgentManager）

- 到点行为 = 通知中心弹提醒；`maxScreenWantAgent`（到点自动拉起 ability）文档标注**预留接口，暂不支持**。
- 侧载/未授权时 `publishReminder` 返回 1700002，提醒上限按 0 处理（dsh-Remote 实测记录）。
- 只能「提醒人」，不能替你跑回合。

### 4. 实况窗（LiveViewKit）

- 可作为长时任务进度通知（`SUBMODE_LIVE_VIEW_NOTIFICATION`），但 **LiveViewKit 是 AGC 权益管控能力**，
  未开通时 `startLiveView` 抛错；且**本地创建要求应用在前台**（dsh-Remote `LiveViewService` 的注释与实现）。
- 对我们：`updateBackgroundRunning` 的进度刷新不依赖 LiveViewKit 的创建接口，刷新本身可用；
  但「用实况窗表达任务进度」这条路需要权益。

### 5. 同类项目实测结论

| 项目 | 结论 |
|---|---|
| [NekoBox4Harmony](https://github.com/xiaoli8571/NekoBox4Harmony)（★86，逆向 FlClash） | 明确写「**DATA_TRANSFER 当会话保活不成立**：10 分钟不更新会被取消，低速也会被取消」，只允许真实传输期短时持有；VPN 会话靠 `VpnExtensionAbility`（系统托管进程）+ 常驻通知 + 被杀自愈；`TASK_KEEPING` 因 ACL 不可得而放弃 |
| [dsh-Remote](https://github.com/Blank-not-black/dsh-Remote)（★90，同把 DSH 搬到鸿蒙） | 用 `dataTransfer` + 5 分钟 `updateBackgroundRunning` + `continuousTaskCancel/Suspend/Active` 回调做诊断；**没有过夜存活记录**；提醒在 1700002 时降级为进程内定时器，并明说「冻结期间无提醒」 |
| [Syncthing-for-HarmonyOS](https://github.com/forwardz666/Syncthing-for-HarmonyOS)（★17） | 长时任务扛真实同步；WorkScheduler 30 分钟只做保底探活；扩展里禁止 `backgroundTaskManager` |
| [swai](https://github.com/shuwei-ai/swai)（★11，原生鸿蒙 + DSH 客户端，源码在 `<ws>/build/swai-ref` 核过） | **没有长时任务**：只声明 `KEEP_BACKGROUND_RUNNING`，无 `backgroundModes`、无 `startBackgroundRunning`、无 wantAgent 常驻通知、无 `TASK_KEEPING` 试探。保活只有两招：① `appService` 扩展 `ShellBridgeService`（`exported:true`，别的应用 bind 才活，**未声明独立 process，与 UI 同进程**，进程该冻还是冻）；② `requestSuspendDelay` 包住单次 agent 长跑、`finally` 取消（`agent/AgentSession.ets:214-247`）。真正做的是**感知层**：浮窗 + 状态点告诉用户「还在跑」，不解决进程被冻结 |
| FlClash（闭源，NekoBox 逆向） | `TASK_KEEPING` + 双 Ability + VPN 扩展进程 + `hiAppEvent` 被杀自愈；手机端 ACL 由 AGC 特批 |

### 6. 尚未闭合的三件事（必须真机测，不能推理）

1. **`DATA_TRANSFER` 在这台 API 26 手机上，锁屏过夜会不会被 `LOW_SPEED` 取消**——开源仓只有枚举止，
   检测器不在开源代码里；`dsh-Remote` 的注释也承认不知道，且没有过夜记录。判据：`continuousTaskCancel` 的
   `reason` / `detailedCancelReason`（API26）具体值。
2. **`TASK_KEEPING` 在本机 debug 签名下是否真被拒**：SDK 合同说手机需 ACL；我们的签名材料不含
   `KEEP_BACKGROUND_RUNNING_SYSTEM`。需要实测 `startBackgroundRunning(MODE_TASK_KEEPING)` 的错误码
   （201 权限 / 9800005 校验）。若意外可用，问题一次性解决。
3. **应用活跃分组**：`work_status.cpp` 里第三方分组来自 DeviceUsageStats（活跃/经常/常用/极少），
   我们的 DSH 大概率是「常用」→ WorkScheduler 24 小时才一次；需要用 `hidumper -s DeviceUsageStatsService`
   或 `dumpsys` 类命令确认本应用分组。

### 7. 建议的下一步（先测量，再定型）

1. 在 `ContinuousTaskOwner` 里补日志：`continuousTaskCancel` 的 `reason` 与 `detailedCancelReason`（API26 才有）、
   `continuousTaskSuspend` 的 `suspendReason`，用 `hilog.warn`（INFO 在本机被过滤）。
2. 加一个只在前台可点的「今晚保持运行」开关：申请 `DATA_TRANSFER` 长时任务 + 4 分钟 `updateBackgroundRunning`，
   同时在申请前后各打一条日志；不给它任何「一定能过夜」的承诺。
3. 另做一次 `TASK_KEEPING` 试探（不改默认路径）：单独一个调试按钮，记录 `startBackgroundRunning` 的错误码。
4. 两个实验跑完再决定：若 `DATA_TRANSFER` 过夜存活 → 用它；若被 `LOW_SPEED` 取消 → 转「外部触发」
   （PC/云端 cron 打手机鉴权接口）或「提醒 + 用户点开」。

## 8. 测量工具用法（v83 起）

入口：**设置 → 后台保护**（鸿蒙机型才出现，页面底部「实验：整夜保持运行」）。

| 控件 | 行为 | 日志 |
|---|---|---|
| 「保持运行（实验）」行（点一下切换） | 申请 `MODE_DATA_TRANSFER` + `SUBMODE_LIVE_VIEW_NOTIFICATION`，每 4 分钟 `updateBackgroundRunning`；再点一下释放 | `DshKeepAwake hold start ok id=…` / `progress refreshed id=…` |
| 「测试 TASK_KEEPING 资格」行 | 单独试 `MODE_TASK_KEEPING`，成功会立刻停掉，失败只记错误码 | `taskkeeping probe accepted id=…` / `refused code=…` |

被系统取消/暂停时（这是判据）：

```bash
hdc shell "hilog -x | grep -i DshKeepAwake | tail -20"
# cancel id=… reason=<数字> detail=<数字>
# suspend id=… state=true reason=<数字>
```

数字含义见 `ContinuousTaskCancelReason` / `ContinuousTaskSuspendReason`：
`4 = DATA_TRANSFER_LOW_SPEED`、`12 = DATA_TRANSFER_NOT_UPDATE`、`1/2/3 = 用户取消/系统取消/用户删通知`。

过夜判据：

1. 早上第一条 `cancel` 的 `reason` 是 4 → 低速被判定，`DATA_TRANSFER` 这条路不通；
2. 是 12 → 进度刷新没生效（我们每 4 分钟刷，按理不该出现）；
3. 没有任何 cancel、`suspend` 也很少 → 长时任务扛住了，方案成立；
4. `probeTaskKeeping` 返回 `accepted` → 说明本机 debug 签名意外带了 ACL，优先用 TASK_KEEPING。

## 9. 真机结果（2026-11-23 晚，v84 测量版）

### 9.1 已经确定的

| 项 | 结果 | 证据 |
|---|---|---|
| WorkScheduler 扩展会被拉起 | **会** | 兜底日志 `files/wake-log.txt`：`2026-11-23T05:31:04Z wake workId=1001`、`09:31:06Z wake workId=1002`（北京时间 13:31 / 17:31，正是 2 小时/一次性探针） |
| 扩展里能不能起引擎 | 不能走常规路 | 扩展上下文没有 `startAbility`、禁止 `backgroundTaskManager`、单次 2 分钟 |
| `MODE_TASK_KEEPING` 是否可用 | **不可用** | 按钮返回 `refused:9800005`（Continuous Task verification failed）＝本机没有 `KEEP_BACKGROUND_RUNNING_SYSTEM` ACL |
| `DATA_TRANSFER` 能否申请 | **能** | 按钮返回 `granted:358`，通知栏出现常驻通知 |
| 锁屏后 JS 定时器还跑不跑 | **不跑** | 21:09:11 锁屏、21:14:30 解锁，`files/keepawake.log` 只有 `hold start id=358`，**没有** 4 分钟一次的 `progress refreshed` |

### 9.2 关键结论

`DATA_TRANSFER` 长时任务能让系统保留进程/通知，但**不能让 Dart/ArkTS 的 JS 定时器在锁屏期间继续执行**。
而 `DATA_TRANSFER` 的续命恰恰依赖「10 分钟内更新一次进度」——两者互相矛盾。

所以「靠长时任务 + 定时刷新进度，把手机当 7×24 小服务器」这条路，在**没有 `KEEP_BACKGROUND_RUNNING_SYSTEM` ACL** 的第三方应用上不成立。

### 9.3 剩下的可行方向

1. **WorkScheduler 扩展里跑一次「短促的引擎」**：扩展每次被拉起有 2 分钟，若能在扩展进程里启动 Node 引擎、把到期的定时回合触发后立刻退出，就能利用系统每 2 小时的唤醒。风险：扩展进程能否加载 `libdsh_host`/`libnode`、以及与前台进程抢同一个 `dshHome` 锁，未验证。
2. **外部触发**：PC/云端 cron 打手机上的鉴权入口（需要 App 暴露一个局域网/隧道可访问的小接口，或用系统推送唤醒）。
3. **提醒 + 人工**：代理提醒准点弹通知（已验证可用），点开由人决定是否跑。
4. **前台常亮**：睡前把 App 放前台+充电+屏幕常亮，最简单但耗电、且不能锁屏。

### 9.4 已修复的附带问题

- `backgroundProtection()` 原先因为 TASK_KEEPING 探测返回 null 就把整条资格判成 `unknown`（页面显示「保护暂不可用」）；现在 data-transfer 可用即报 `granted`。
- 长时任务 API 需要 **UIAbilityContext**，之前传应用上下文报 `401 The context cannot be null and its type must be Context`；已改为 `RuntimeController.ability.context`。

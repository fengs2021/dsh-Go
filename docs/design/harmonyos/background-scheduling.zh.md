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

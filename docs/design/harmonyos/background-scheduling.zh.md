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

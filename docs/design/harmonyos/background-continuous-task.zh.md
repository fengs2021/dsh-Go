# 后台长任务被冻结：恢复长时任务（continuous task）

2026-11-19。真机现象：App 切到后台跑长任务，约 3 分钟后“像睡着了”，回来发现任务停在中间。

## 1. 根因（代码证据，改动前）

| 事实 | 位置 |
| --- | --- |
| 长时任务代码只请求 `MODE_TASK_KEEPING` | `app/ohos/entry/src/main/ets/runtime/ContinuousTaskOwner.ets`（原 `start()`） |
| 资格判定要求 `ohos.permission.KEEP_BACKGROUND_RUNNING_SYSTEM` | `BackgroundCompute.ets`（原 `backgroundComputePermission()`） |
| 该权限是 system_grant 的 ACL，普通应用/调试签名拿不到 → `eligible()` 恒假 → `startBackgroundRunning` 从未被调用 | 同上 + `ContinuousTaskOwner.request()` 的早退分支 |
| 清单里没有 `backgroundModes`，也没有 `ohos.permission.KEEP_BACKGROUND_RUNNING` | `app/ohos/entry/src/main/module.json5`（改动前） |
| 唯一生效的机制是短时任务，系统给的时间 ≤ 180 s | `TransientTaskOwner.ets`：`requestSuspendDelay` + `duration > 180000` 判非法 |

结论：不是“偶发休眠”，而是**没有任何长时任务资格**。短时任务到期后进程被系统冻结（SIGSTOP 语义），Node 引擎与 Linux 微虚拟机一起停。

## 2. 修法

1. `module.json5`：`EntryAbility` 增加 `"backgroundModes": ["dataTransfer"]`；`requestPermissions` 增加 `ohos.permission.KEEP_BACKGROUND_RUNNING`（normal 级，安装即授）。
2. `BackgroundCompute.ets`：新增 `continuousTaskModes()`（按可用性返回有序模式表）、`modeSupported()`、`systemAclGranted()`；`backgroundComputePermission()` 改为「可用模式表非空即 granted」。
3. `ContinuousTaskOwner.ets`：按模式表逐个尝试，被拒就试下一个；`MODE_DATA_TRANSFER` 必须带 `SUBMODE_LIVE_VIEW_NOTIFICATION`；每 240 s `updateBackgroundRunning` 刷新进度（系统 10 分钟不刷新会取消）；`hilog` tag `DshBackground` 记录成功/被拒/进度失败。

## 3. 为什么是 dataTransfer

- `MODE_TASK_KEEPING` 是“无人值守”模式，但需要受限 ACL，第三方拿不到 → 保留为首选（拿到 ACL 时自动用），实际会落到下一个。
- `MODE_DATA_TRANSFER` 只需要公开权限，代价是必须有存活感：常驻通知 + 定期刷新进度。App 的长任务（构建、拷贝、Linux 里的命令）本身与“数据传输”语义接近，属于合理用法。

## 4. 验证状态

- 本机：`FULLHAP70_RC=0`、`audit-hap: OK`；包内 `module.json` 已含 `backgroundModes` 与权限；`ets/modules.abc` 可检出 `DshBackground`、`updateBackgroundRunning`、`continuous task %{public}d holds mode`。
- **真机未验证**（设备离线）：系统是否接受 `dataTransfer`、通知是否常驻、后台是否真的不再被冻结，都待装机确认。若被拒，`$DSH_HOME` 侧无痕迹，需看 `hilog -T DshBackground`。

## 5. 未覆盖

- 用户切到别的 App 后仍可能因内存压力被回收（长时任务不保证永不死）。
- 任务断点续跑（进程被杀后继续）不在本次范围。
- `app.json5` 的 `allowAppRunWhenDeviceFirstLocked` 未改（只影响开机首次解锁前）。

## 6. 后续基线更新时怎么合

补丁：`<WS>/patches/ohos-background-continuous-task.patch`（`git am` 即可）。

冲突面很小，只有三处：
- `module.json5`：abilities 里一行 `backgroundModes`、requestPermissions 里一条权限；
- `BackgroundCompute.ets`：新增三个函数 + 改 `backgroundComputePermission()` 尾段；
- `ContinuousTaskOwner.ets`：`start()` 的模式循环 + `armProgress()`/`disarmProgress()` + 字段。

若新基线已自带 `backgroundModes` 或公开权限版长时任务，则整个补丁可丢弃。

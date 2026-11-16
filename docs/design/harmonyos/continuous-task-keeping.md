# 长期后台回合：先 TASK_KEEPING，再 DATA_TRANSFER

本实现面向调试签名或指定设备安装。用户要求「切到后台也不许停」（2026-11-16），所以取两种长时任务模式，按可用性排序申请，而不是只有一种：

1. `MODE_TASK_KEEPING`（9）：真正为「后台继续计算」设计的模式，但**非 PC/2-in-1 设备必须有受限权限 `ohos.permission.KEEP_BACKGROUND_RUNNING_SYSTEM` 的 ACL**（SDK API 26 注释原文，API 21 起）。调试签名通常不下发这条 ACL，所以手机上通常拿不到。
2. `MODE_DATA_TRANSFER`（1）：只要公开权限 `ohos.permission.KEEP_BACKGROUND_RUNNING`。系统要求两条附加约束：进度超 10 分钟不更新会被取消；通知必须是 live view 类型。本实现用 `SUBMODE_LIVE_VIEW_NOTIFICATION`（3）+ 每 240 s 一次 `updateBackgroundRunning` 满足它们。

两种都不可用、模式不支持或系统拒绝开始时，仍然自动使用现有短时任务，不向回合报告权限错误。**不使用静音音频**（那是另一种越界手段，且需要 AVSession 配合）。

## 构建配置（这条以前是漏的）

`app/ohos/entry/src/main/module.json5` 必须声明：

- `requestPermissions` 含 `ohos.permission.KEEP_BACKGROUND_RUNNING`；
- `EntryAbility.backgroundModes` 含 `dataTransfer`（对应 TASK_KEEPING 时是 `taskKeeping`）。

**坑**：`tooling/ohos/check-arkts.sh` 的 `DISTRIBUTION` 默认为空，只有显式传 `--distribution debug|device|store` 才会执行 `tooling/ohos/hap-distribution.py permissions` 那段覆盖逻辑。v64 及以前的 HAP 里 `requestPermissions` 只有 INTERNET/GET_NETWORK_INFO/VIBRATE/MICROPHONE、`backgroundModes` 为空 —— 即长时任务在手机上**从来不可能成功**，不只是 ACL 问题。v65 起仓库 module.json5 自己声明这两项（v65 打包产物已核验：五项权限 + `['dataTransfer']`）。

`hap-distribution.py` 的非 store 覆盖仍会在带 `--distribution` 的构建里追加 `KEEP_BACKGROUND_RUNNING` 与三个受限权限（`KEEP_BACKGROUND_RUNNING_SYSTEM` / `READ_PASTEBOARD` / `PUBLISH_AGENT_REMINDER`）。普通签名没有对应 ACL，声明受限权限反而会让安装校验失败，所以仓库里的 module.json5 只声明公开那条，受限权限的查询在 `systemAclGranted()` 里单独 try/catch，未声明时只判该模式不可用（`12100001`），不把整台设备判成 unknown。

## 系统合同

公开 SDK API 26 的 `@ohos.resourceschedule.backgroundTaskManager.d.ts`：

- `MODE_TASK_KEEPING = 9`：非 PC/2-in-1 设备需 `ohos.permission.KEEP_BACKGROUND_RUNNING_SYSTEM` ACL（API 21 起；API 20 及以前只给 PC/2-in-1）。
- `MODE_DATA_TRANSFER = 1`：普通应用持 `KEEP_BACKGROUND_RUNNING` 即可申请；申请成功时系统自动发 `ContinuousTaskNotification`；进度超 10 分钟不更新任务被取消；通知须为 live view。`updateBackgroundRunning(context, request)`（`request.continuousTaskId` 必填）用于刷新。
- `ContinuousTaskRequest` 字段：`backgroundTaskModes`、`backgroundTaskSubmodes`（normal=2 / live view=3，「主类型必须与子类型匹配」）、`wantAgent`、`combinedTaskNotification?`、`continuousTaskId?`、`isModeSupported()`。
- 开始成功由系统显示长时任务通知；wantAgent 指向当前 UIAbility；停止用带任务 id 的 `stopBackgroundRunning`。

参考：

- https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/task-management/continuous-task.md
- https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/ide-signing-auto
- 固定 SDK 声明 SHA256：846b061552680ebf976ecd69b3fbe716768e9c64760676f166c717ab6455b708。

SDK 合同支持上述实现；具体手机系统版本、签名 ACL 下发、通知显示与点击、长时间熄屏运行仍待真机验证。Linux 夹具不能证明这些行为。

## 模式候选与申请

`BackgroundCompute.continuousTaskModes(accessTokenId)` 返回有序候选：先 `MODE_TASK_KEEPING`（ACL 已授予 **且** `isModeSupported()`），再 `MODE_DATA_TRANSFER`（带 live view 子类型且 `isModeSupported()`）。`backgroundComputePermission()` 的口径：公开权限 DENIED → `denied`；公开权限非 GRANTED 或没有 ContinuousTask 能力 → `unknown`；否则候选非空即 `granted`，空即 `denied`；其余异常（9800005）一律 `unknown`。`longTaskEligible` 与设置页文案都挂在它上面，Dart 侧不需要改。

`ContinuousTaskOwner.start()` 按候选顺序逐个建请求（dataTransfer 带 live view 子类型），`startBackgroundRunning` 抛错就 `continue` 试下一个，全部被拒才抛给 `TransientTaskOwner` 落回短时任务。成功时记录 `task/mode/outstanding` 与 `hilog` 一行 `continuous task <id> holds mode <mode>`，dataTransfer 额外起 240 s 一次的进度刷新；刷新失败置 `ohos_continuous_progress_failed` 并按「系统已收回」处理（撤销原生准入、落回短时任务），不带着随时会被系统掐断的租约继续跑。

## 准入与撤销

后台观察仍要求当前原生 owner/revision 的新鲜 busy ACK。权限检查只是申请条件，异步 OS start 成功且 owner/generation 仍当前才写原生 Continuous 状态。它使用新增 phase=7，保持原生快照布局不变；不借用短时任务 deadline，也不声称永不被系统暂停。Node 从原生只读桥读取此状态，HTTP 数据不能授予长期后台权限；手动暂停仍优先。

回到前台、回合 idle、手动暂停、owner 退役先关闭原生准入，再按本任务 id 停止 OS 任务并清掉进度定时器。系统 Cancel 立即撤销，Suspend 立即撤销并停止该任务；随后可走原短时 fallback，不信任随后 Active 事件。旧请求晚成功只清理其返回的 id，不能激活新 owner。停止失败最多三次，保留诊断，不无限重试。

SDK 将 continuousTaskId 声明为可选。若成功结果缺 id，不能安全按 id 回收；context 范围停止会误伤新任务，因此本实现关闭准入、保留 `ohos_continuous_missing_id` 与 cleanupPending，且在途请求计入退役 owner 的保留条件。此时不声称系统任务已经回收。正常 SDK 返回 id 与此异常分支均需真机核验。

## 验证范围

作者测试（`tooling/ohos/tests/continuous-task-owner.test.mjs` 7 例 + `lifecycle-host.test.mjs` / `transient-task.test.mjs`，合计 51 pass）覆盖：无 ACL 手机拿 dataTransfer 并 240 s 续期、被拒模式顺延、全拒回落短时任务、无权限/开始拒绝回退、未获 OS 接受不能准入、前后台及 owner 竞态、缺 id 晚回不误停新任务、Cancel/Suspend、进度刷新失败丢租约、手动暂停和停止失败。C++ 状态测试与真实双 DSO 的 Linux 单 Node 链路验证 phase=7 可驱动工具执行和 journal 提交，并在撤销后关闭准入。ArkTS 编译与设备验证的结论分别记录，不将桌面 N-API/hilog 适配器称作公开 SDK 或手机运行。

**未验证**：真机上 DATA_TRANSFER 是否被系统接受、live view 通知的显示形态、240 s 刷新能否撑过整轮、熄屏是否仍被冻结。装 v65 后应看 hilog tag `DshBackground` 的 `holds mode 1` 与后台计时连续性。

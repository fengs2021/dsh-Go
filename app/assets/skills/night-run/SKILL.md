---
# dsh-go:managed — 这行在，App 启动时会把这个技能更新到最新；想自己改就删掉它。
name: night-run
description: 让鸿蒙手机在夜间（或任意指定时刻）保持唤醒、把 DSH 拉到前台跑任务、跑完恢复灭屏时间的一套可执行方案。包含系统限制的实测结论（TASK_KEEPING 需受限 ACL 拿不到、DATA_TRANSFER 锁屏后 JS 定时器不跑、WorkScheduler 最小 2 小时且扩展不能起引擎）、PC 侧 hdc 定时脚本的完整命令、手机侧自助做法、以及失败时的排错口径。用户说「定时跑」「凌晨跑任务」「锁屏后还在跑」「常亮/别灭屏」「半夜三点执行」时加载它。Overnight wake-and-run recipe for HarmonyOS: keep the phone awake with power-shell timeout, launch DSH Go on schedule, restore afterwards, plus the system limits that rule out other approaches.
whenToUse: 用户要在锁屏/夜间/指定时刻让手机上的 DSH 自动跑任务，或问「能不能锁屏后继续跑」「怎么设置常亮」「能不能定时唤醒」时。
---

# 夜间唤醒跑任务（鸿蒙）

## 0. 一句话

**手机锁屏后，外部就连不上了**（不是 WiFi 慢，是新的 hdc 连接被掐断，实测锁屏 75 秒后全网段扫描零候选）。
所以正确做法只有一条：**睡前先让屏幕保持常亮（不锁屏），到点再从外部拉起任务，跑完还原灭屏时间**。

顺序不能反：**先常亮，再等时间**；「先锁屏、到点再唤醒」是走不通的。

## 1. 先认清系统限制（都实测过，别重复试）

| 做法 | 结论 | 证据 |
| --- | --- | --- |
| `MODE_TASK_KEEPING` 长时任务 | **不可用**：手机端第三方需要受限 ACL `KEEP_BACKGROUND_RUNNING_SYSTEM`，个人开发者拿不到 | `startBackgroundRunning` 返回 `9800005 Continuous Task verification failed` |
| `MODE_DATA_TRANSFER` 长时任务 | 能申请（`granted:<id>`，通知栏出现常驻通知），但**锁屏后 ArkTS/Dart 的定时器不跑**，进度无法续命；系统按 `DATA_TRANSFER_NOT_UPDATE` 在 10 分钟后取消 | `files/keepawake.log` 只有 `hold start`，没有任何 `progress refreshed` |
| WorkScheduler 延迟任务 | 会被系统拉起，但**最小间隔 2 小时**（活跃应用）、单次回调最多 2 分钟、扩展里禁止 `backgroundTaskManager`、扩展上下文没有 `startAbility` | `files/wake-log.txt` 有真实唤醒记录；OpenHarmony `work_status.cpp` 的 `GROUP_INTERVAL_MAP` |
| `allowAppRunWhenDeviceFirstLocked` | 第三方改不了（写进 app.json5 会 schema 校验失败），且它只管「开机后首次解锁前」 | hvigor `00303038 Schema validate failed` |
| 代理提醒 `reminderAgentManager` | 准点弹通知可用；`maxScreenWantAgent`（到点自动拉起）是预留接口、不支持 | API 文档 |

**结论**：不要用「长时任务 + 定时刷新」过夜；那条路在无 ACL 的机器上物理不成立。

## 2. 推荐方案：PC 侧 hdc 定时

前提：手机与 PC 在同一网络、开无线调试（`hdc tconn <ip>:<port>`），**或直接插 USB**（最稳，熄屏后 WiFi 会省电断开）。

时间线（示例：03:00 跑任务）：

| 时刻 | 动作 | 命令 |
| --- | --- | --- |
| 23:30（睡前） | **常亮待命**：亮屏 + 解锁 + 灭屏时间改 12 小时 + 拉起 App | `power-shell timeout -o 43200000` |
| 02:50 | 再拉起一次并截图为证 | `aa start -a EntryAbility -b ccchimneyyy.dsh.go` |
| 03:20 | 还原 + 熄屏 | `power-shell timeout -r` → `power-shell suspend` |
| 07:30 | **兜底还原**（万一 03:20 没跑成，别亮一整天） | 同 03:20 |

现成脚本（PC 上）：`scripts/phone-night.sh`

```sh
bash scripts/phone-night.sh prepare  # 睡前：亮屏 + 解锁 + 改灭屏时间 + 拉起（进入常亮待命）
bash scripts/phone-night.sh run      # 到点：再拉起一次 → 保持 HOLD_AFTER_MS → 还原并熄屏
bash scripts/phone-night.sh restore  # 只还原 + 熄屏（兜底）
bash scripts/phone-night.sh probe    # 只探测可达性并截图，不改设置
bash scripts/phone-night.sh shot     # 截屏到 _shots/
```

脚本的硬约束（改脚本时别破坏）：

- **每条命令都校验回显**：`WakeupDevice is called` / `No Error` / `start ability successfully` / `Override screen off time to …`；
  拿不到就 `FAIL` 并退出，不再“假装成功”。
- **IP 自动发现**：手机开着「随机 MAC」时 IP 会漂（静态租约失效），脚本对 `/24` 扫调试端口
  （1.5s 超时、24 并发），并缓存上次成功的地址到 `/root/.phone-night.last`。

可调参数（环境变量）：`TARGET=ip:port`、`HOLD_MS`（常亮时长，默认 3600000）、`RUN_AT_MS`（唤醒后等多久拉起，默认 600000）、`HOLD_AFTER_MS`（拉起后保持，默认 1200000）、`CONNECT_TRIES/CONNECT_WAIT`（夜里重连）。

定时：`phone-night.timer`（`OnCalendar=*-*-* 02:50:00`，`Persistent=true`）→ `phone-night.service` 跑 `run`。

## 3. 手机侧自助（没有 PC 时）

用本机工具（`mcp__phone__shell` / `mcp__phone__hdc`）做同一件事，但**只能在自己的 App 处于前台时生效**：

```sh
power-shell timeout -o 3600000   # 灭屏改 1 小时（回显 Override screen off time to 3600000）
power-shell wakeup               # 亮屏（回显 WakeupDevice is called）
power-shell timeout -r           # 还原（回显 Restore screen off time）
```

- 屏幕保持亮着 → 系统不会自动锁屏 → DSH 保持前台 → JS 定时器照常跑。
- **锁屏一旦发生，本 App 无法自我解锁**：`uitest` 注入会被系统拦掉，必须人工解锁。
- 建议同时：App 里把「后台运行 → 连续任务保护」打开（回合期间有效），并给手机充电。

## 4. 执行前检查（失败都在这里，不在方案）

1. `hdc list targets` 能看到 `ip:port`；夜里熄屏后 WiFi 常睡，`tconn` 失败就重试，仍失败说明只能走 USB。
2. `power-shell timeout -o` 必须回显 `Override screen off time to <ms>`；没有回显就是 hdc 没真正执行。
3. `aa start -a EntryAbility -b ccchimneyyy.dsh.go` 回显 `start ability successfully`；
   锁屏状态下会报 `10106102 设备已锁屏，无法自动拉起`，这时必须先 `power-shell wakeup` + 解锁。
4. 无锁屏密码时上滑即可解锁；**有密码时脚本解不开**，只能人工。

## 5. 跑完必须收尾

```sh
power-shell timeout -r   # 还原系统灭屏时间，否则整夜常亮耗电
power-shell suspend      # 熄屏
```

漏掉这两步的典型症状：第二天发现屏幕亮了一夜、电量掉光。

## 6. 排错速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `hdc list targets` → `[Empty]` | **锁屏掐断新连接**（实测 75 秒即断）/ 端口变了 | 睡前必须先 `prepare` 保持常亮；或插 USB；端口变了要重新看手机「无线调试」页 |
| 到点 App 没跑 | 手机已被锁屏（常亮没生效） | 检查 23:30 的 `prepare` 是否成功；`power-shell timeout -o` 的回显要能拿到 |
| `aa start` → `10106102` | 设备锁屏 | 先 `power-shell wakeup` 再上滑解锁 |
| `power-shell timeout` 无回显 | hdc 通道没通（同第一条） | 同上 |
| 任务没跑但 App 在前台 | 会话/引擎没连上（本机引擎「未运行」） | 先在 App 里确认「本机引擎 · 运行中」，再谈定时 |
| 亮了一夜 | 忘了 `timeout -r` | 补跑 restore |

## 7. 不要做的事（已验证不成立）

- 用 `DATA_TRANSFER` 长时任务 + 定时刷新进度「整夜保活」。
- 期待 `TASK_KEEPING` 在无 ACL 的签名下可用。
- 在 WorkScheduler 扩展里启动引擎或拉起 UIAbility（2 分钟上限 + 禁止 backgroundTaskManager + 无 startAbility）。
- 试图通过 `app.json5` 打开 `allowAppRunWhenDeviceFirstLocked`（第三方 schema 不认）。

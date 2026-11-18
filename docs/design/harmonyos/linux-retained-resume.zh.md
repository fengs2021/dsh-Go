# Linux 环境：App 更新后不必重装（保留实例按崩溃恢复继续用）

2026-11-18。设备上每次 App 更新后打开 Linux 都会报
`ERR_OHOS_LINUX_RECOVERY_REQUIRED`，页面提示「原来的 Linux 数据没法继续用了（常见于 App 更新之后）……点『重新安装 Linux』」，
也就是每更新一次就得丢掉整台 Linux（含已装的工具链）。本改动让保留实例在「没有确认关闭」时按崩溃恢复继续用原盘。

## 1. 为什么每次更新后必然报错

`hdc install` / 应用更新会强杀进程，引擎来不及走 Linux 的受控关闭，也就写不下 `state: 'clean'` 的
checkpoint。记录停在 `booting`（刚启动）或 `active`（运行中）。旧实现在 `decode()` 里对任何 `state !== 'clean'`
一律抛 `ERR_OHOS_LINUX_RECOVERY_REQUIRED`（「没有确认的干净关闭，禁止自动覆盖」），于是更新一次就要重装一次。

## 2. 改动后的判定表（`runtime/ohos/linux/instance.mjs` 的 `decode()`）

| 记录里的 state | 旧行为 | 新行为 | 依据 |
| --- | --- | --- | --- |
| `clean` | 校验 close 身份后复用 | 不变 | close 身份（`guestClose`/`native`）必须与本代 epoch 吻合 |
| `booting` / `active` | 抛 `ERR_OHOS_LINUX_RECOVERY_REQUIRED` | **按崩溃恢复继续用原盘** | 能走到 decode 说明已经拿到私有目录的真实 flock，不存在活着的 owner；随后 resume 分支会重新校验 target 的身份与大小、bios/kernel/tools 的 sha256，guest 自己的 ext4 journal 负责回放中断的写 |
| `preparing` | 抛 `ERR_OHOS_LINUX_RECOVERY_REQUIRED` | **仍然抛** | 首次安装可能连 target.ext4 都没落全，不能假设盘是完整的；这条路径继续由「重新安装 Linux」处理 |

另外两类仍然拒绝、且不在此改动范围：

- `ERR_OHOS_LINUX_ASSET_GENERATION`：App 换了 Linux 镜像代次，旧盘与新的内核/工具链不是一套。
- `ERR_OHOS_LINUX_INSTANCE_CORRUPT`：记录自相矛盾（本代 epoch 已经确认关闭，state 却写着 booting/active），
  或 target/目录/锁的 inode 身份被替换。旧 epoch 遗留的 close 数据属于没落盘的写残留，直接忽略。

## 3. 可观测性

恢复时 owner 会往引擎日志（设备上 `files/dsh-runtime/engine.log`）写一行：

```
[linux] resuming a retained instance whose close was never confirmed (process killed by an App update, a crash or a power loss)
```

## 4. 证据（本机）

`runtime/tests/ohos/linux-instance.test.mjs`：27 例 / 25 pass，2 个失败是「真 flock 必需」的老失败
（`sync observation followed by controlled native join failure cannot grant clean`、
`discard is refused while a live owner holds the real flock`），本机用 `/root/lock-stub.mjs` 桩掉原生锁时基线同样失败。
本机跑法：`node --import /root/lock-stub.mjs --test runtime/tests/ohos/linux-instance.test.mjs`
（需要把 `/root/prep66/dsh/node_modules` 临时软链成仓库根的 `node_modules`，跑完删掉）。

新增/改写的用例：

- `dirty consume directory sync failure …`：结尾第三条 owner 由「拒绝」改为「resume 成功、`created 1`、不下载」。
- `an instance the App killed while running resumes from its own disk`：state=active、close 为 null 时 resume，epoch 换新、target inode 不变。
- `a retained record that claims a confirmed close of its own epoch is still refused`：自相矛盾记录仍抛 `INSTANCE_CORRUPT`。
- 拒绝清单里去掉 `dirty`（改为正向用例）；「重新安装 Linux」用例把 `dirty` 换成 `preparing`。

`runtime/tests/ohos/linux-instance-process.test.mjs` 的两条跨进程用例（受控未确认关闭、SIGKILL）同步改为期待 resume
（`created 1` / `downloads 0` / target 字节不变），child actor 增加 `resume` 模式并在消息里带上 `downloads`/`created`。
这两条需要 CI 的 OHOS 原生绑定，本机无法运行（基线同样 15 例全失败），**未在真机/CI 上验证**。

## 5. 未验证

- 真机：装包含本改动的包后，在 Linux 运行中直接 `hdc install` 覆盖安装，再次打开设置页应能继续用原来的 Linux，且 engine.log 出现上面那行。
- 断电/崩溃场景与「更新时正好在首次安装」的 `preparing` 场景未实测。

## 6. 后续基线更新时怎么合

只有一处语义改动：`runtime/ohos/linux/instance.mjs` 的 `decode()`。上游基线若仍是「state !== 'clean' 就拒绝」，
把 `preparing` 之外的 dirty 分支替换成本文件实现（assetIdentity → target 形状 → clean 分支 → preparing 分支 → dirty 恢复分支），
并保留 `UNCONFIRMED` 这个 Symbol 与 `openLinuxInstance()` 返回的 `unconfirmedClose`。测试侧对应改动同 §4。

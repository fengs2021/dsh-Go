# 迁到上游 1.0.16 底座（claude/harmonyos-ohos）：移植总账

底座：`origin/claude/harmonyos-ohos` = `1948e7b7`（2026-11-13，含 upstream main 到 1.0.16）。
旧底：`origin/ohos/v8` = `4a4555bf`（2026-11-06，已停更），我们的 v16–v39 共 28 个提交建在它上面。
工作分支：`port/v40`（worktree `/root/port40`）。

## 为什么不 merge

`git merge-tree HEAD origin/claude/harmonyos-ohos` → **464 个文件冲突**（Dart 181 / runtime 其它 130 / Android 50 / 其余 ohos 与文档）。
两条线在 2026-11-01（`ca3c4202`）之后各自重写了鸿蒙层，tree 合不出一棵能编译的树。所以选「按能力在新底座上重做」，不是「合并」。

## 能力清单与去向

| 我们已有的能力（版本） | 新底座现状 | 去向 |
| --- | --- | --- |
| hdc 调试通道驱动界面：读控件树 / 点按 / 输入 / 滑动 / 按键 / 截图（v20 `a47845c7`） | 没有。上游 phone 工具只做系统公开能力（open/intent/notify/clipboard/handoff），文档明写「不支持后台屏或屏幕快照」 | **移植（本阶段已完成）** |
| 调试通道自检工具 `mcp__phone__hdc`、密钥来源优先级（v37） | 没有 | **移植（随上一条一起完成）** |
| 「系统操作」页显示授权状态（v39：hdc-status.mjs + HdcChannelStatus.ets + Dart 卡片） | 没有 | 阶段 2（要改 ArkTS `RuntimePlugin.ets` 与 Dart 页面） |
| 后台进度弹幕（通知栏滚动 + 前台浮层，v22–v25） | 没有（全树 `danmaku` 0 命中） | 阶段 3（ArkTS 侧改动最大） |
| 插件安装桥 / 按桥实时上报（v28–v30） | 上游已有自己的 `runtime/ohos/plugins/*`（installer/store/registry/graph）+ `plugin-install-refusal` | **不移植**，改用上游实现，只在行为差异处补丁 |
| WebAssembly 缺失时的纯 JS 垫片（v26–v27） | 上游 net/lifecycle 层已按无 wasm 重做（`runtime/ohos/net/fetch.mjs` 等） | **不移植**，先验证上游 fetch 链路，缺什么再补 |

## 阶段 1（本次）做了什么

| 文件 | 改动 |
| --- | --- |
| `runtime/ohos/phone/hdc-link.mjs`（新，278 行） | 原样搬入。零依赖纯 Node：直连手机 hdcd（无线调试端口自动从 `/proc/net/tcp` 里按 shell uid 2000 找），SessionHandShake 公钥签名鉴权，之后以 shell 身份跑命令 |
| `runtime/ohos/phone/ui-tools.mjs`（新，约 330 行） | 搬入并**新增审批钩子**：`mcp__phone__shell/ui/app` 默认按会话审批策略征求一次同意，只有 `never` 或 auto 预设才不打扰（与上游 `tools.mjs` 的 `askBeforeRunning` 同一口径） |
| `runtime/ohos/phone/index.mjs` | 接线 `registerUiTools(ctx)`；注册失败时先撤已注册的工具再关队列；`ctx.effect` 卸载时一并摘掉 |
| `runtime/ohos/package/compose-runtime.py` | 把 `phone/hdc-key/id_rsa` 加进 payload（上游脚本没有这一段），随包密钥才能进 HAP |
| `.gitignore` | `runtime/ohos/phone/hdc-key/`（私钥不入库，本地构建时放进去即可随包） |
| `runtime/tests/ohos/phone-ui-tools.test.mjs`（新） | 9 例：控件树解析（可点/可输入/中心坐标）、零宽节点 bounds 判 null 不当点击目标、深容器递归、密钥来源优先级、密钥生成与指纹格式、帧往返、分片读帧、四工具注册与卸载、目录不泄漏实现 |

## 验证证据

- `node --check` 三个文件 → 全部通过（hdc-link / ui-tools / index）。
- `node --test runtime/tests/ohos/phone-ui-tools.test.mjs` → **pass 9 / fail 0**。
- 上游既有 phone 测试（7 个文件）在本机 **基线就是 7/7 fail**（缺 `node_modules`：`Cannot find package '@deepseek-ai/cordis'`，`git stash` 后复测同样 7 fail / 0 pass），移植后仍是这 7 个环境性失败，**无新增失败**。

## 已知限制（未验证项）

- 真机行为未验证：`hdc-link` 的握手/鉴权/uitest 调用需要打 HAP 上真机才能验；本阶段只证明「能装进引擎、注册得进去、纯函数正确」。
- 上游 phone 工具的审批口径里还有 native permit（`claimPhonePermit`）这一层；我们的 hdc 工具**刻意不套**（理由见下节），只走 `tools/pre-execute` 的会话审批。
- `hdc-status.mjs`（v39 的状态文件与轮询）没进阶段 1，所以现在页面上还没有「授权状态」卡片。

## 阶段 1 补丁（2026-11-15）：三态结果 + 只读快照，不套 native permit

**为什么不套 native permit。** 上游那层许可落在原生宿主（`libdsh_host.so`，binding `dsh_ohos_publication`）里，一条许可绑 `(engineId, bridgeGeneration, requestId, executionNonce)` 并带 BOOTTIME 截止，实际提供三件事：前台门禁、换代作废、派发状态记账。前两条对 hdc 是**负收益**——hdc 通道的价值恰恰是不依赖 App 在前台（后台弹幕、长任务期间仍要驱动界面）；而 `phone_contract.h` / ArkTS 侧 `PhoneToolCatalog` 是**按结构化参数做白名单**的，hdc 的参数是自由 shell 命令，要过白名单就得改原生契约并重编 `libdsh_host.so`，等于把「底座能持续跟上游走」这条方案 A 的前提废掉。

**只把真正值钱的第三条搬过来。** 第三态（「已发出但结果未知」）在 Node 侧就能实现，且必须实现：现在点按/输入超时一律报 `ok:false`，模型会重试，而重试一次就是真的多按一下。

| 文件 | 改动 |
| --- | --- |
| `runtime/ohos/phone/hdc-link.mjs` | 新增 `hdcError(message, phase, extra)`；`execBuffer` 每次执行生成 `executionNonce`（`crypto.randomUUID()`），并按**帧是否已写出**给错误标 `hdcPhase`：连接/鉴权失败 = `not_dispatched`；超时、输出溢出、写出后断连 = `dispatched` |
| `runtime/ohos/phone/ui-tools.mjs` | 结果对象加 `dispatched` 字段；`classifyFailure(error)` 把 `dispatched` 映射成 `code:'outcome_unknown'` + 「不要直接重试，先用 dump/shot 确认现场」+ 执行 nonce；`readNativeSnapshot()` **只读** `getPhoneSnapshot()`（不 claim、不阻塞），把「本机当时 DSH 是否在前台 / 引擎第几代 / phone 回调是否可用」写进未知结果与 `mcp__phone__hdc` 自检输出 |
| `runtime/tests/ohos/phone-ui-tools.test.mjs` | 从 9 例增到 **13 例**：三态两分支、快照归一化与三种拿不到 binding 的情形、真连不上端口时错误必须标 `not_dispatched` 且带 nonce |

**证据（2026-11-15）**：`node --check` 两文件通过；`node --test runtime/tests/ohos/phone-ui-tools.test.mjs` → **tests 13 / pass 13 / fail 0**。真机仍未验证。

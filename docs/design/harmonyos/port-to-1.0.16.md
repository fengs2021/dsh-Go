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
- 上游 phone 工具的审批口径里还有 native permit（`claimPhonePermit`）这一层；我们的 hdc 工具**不经过** native permit，只走 `tools/pre-execute` 的会话审批。要不要给 hdc 工具也套上 native permit，阶段 2 再定。
- `hdc-status.mjs`（v39 的状态文件与轮询）没进阶段 1，所以现在页面上还没有「授权状态」卡片。

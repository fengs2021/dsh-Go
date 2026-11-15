# 迁到上游 1.0.16 底座（claude/harmonyos-ohos）：移植总账

底座：`origin/claude/harmonyos-ohos` = `1948e7b7`（2026-11-13，含 upstream main 到 1.0.16）。
旧底：`origin/ohos/v8` = `4a4555bf`（2026-11-06，已停更），我们的 v16–v39 共 28 个提交建在它上面。
工作分支：`port/v40`（worktree `/mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/port40`）。

## 为什么不 merge

`git merge-tree HEAD origin/claude/harmonyos-ohos` → **464 个文件冲突**（Dart 181 / runtime 其它 130 / Android 50 / 其余 ohos 与文档）。
两条线在 2026-11-01（`ca3c4202`）之后各自重写了鸿蒙层，tree 合不出一棵能编译的树。所以选「按能力在新底座上重做」，不是「合并」。

## 能力清单与去向

| 我们已有的能力（版本） | 新底座现状 | 去向 |
| --- | --- | --- |
| hdc 调试通道驱动界面：读控件树 / 点按 / 输入 / 滑动 / 按键 / 截图（v20 `a47845c7`） | 没有。上游 phone 工具只做系统公开能力（open/intent/notify/clipboard/handoff），文档明写「不支持后台屏或屏幕快照」 | **移植（本阶段已完成）** |
| 调试通道自检工具 `mcp__phone__hdc`、密钥来源优先级（v37） | 没有 | **移植（随上一条一起完成）** |
| 「系统操作」页显示授权状态（v39：hdc-status.mjs + HdcChannelStatus.ets + Dart 卡片） | 没有 | **移植（阶段 2，已完成）** |
| 后台进度弹幕（通知栏滚动 + 前台浮层，v22–v25） | 没有（全树 `danmaku` 0 命中） | **移植（阶段 3，已完成）** |
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

## 阶段 2：把「调试通道授权状态」搬到「系统操作」页

底座早就有一张「系统操作」页骨架（`app/lib/state/system_actions_state.dart`、`app/lib/ui/phone/system_actions_page.dart`、`system_actions_host.dart`），但全树 `hdc|Hdc|调试` **0 命中**——卡片整块是我们 v39 新增的增量。

| 文件 | 改动 |
| --- | --- |
| `runtime/ohos/phone/hdc-status.mjs`（新） | 原样搬入：诊断结果归一化后写 `<home>/.dsh/dsh-app/hdc-status.json`（临时文件 + rename 原子替换），导出 `stageOf/statusOf/writeStatus/authorizedStatus/probeAndWrite/startHdcStatusWatch`；`startHdcStatusWatch` 轮询页面写下的 `hdc-probe.json` 请求序号，`timer.unref()` + `ctx.effect` 收尾 |
| `app/ohos/entry/src/main/ets/phone/HdcChannelStatus.ets`（新） | 原样搬入：读同一个状态文件返回 `Map<string, Object|null>`，并写「重新检测」请求 |
| `app/ohos/entry/src/main/ets/runtime/RuntimePlugin.ets` | 新增 `hdcStatus` / `hdcProbe` 两个方法：前者返回状态 Map（通道未挂上时返回空 Map），后者写请求文件（已解除连接时抛 `ohos_detached`） |
| `app/lib/runtime/runtime_bridge.dart` | 新增 `hdcChannelStatus()` / `requestHdcProbe()`，`MissingPluginException` 一律吞成 null（老包不炸） |
| `app/lib/state/system_actions_state.dart` | 新增 `HdcStage` 枚举与 `HdcChannelState`（loaded/stage/checkedAt/port/hints/checking），`onShow` 与 `build` 时刷新；`probeHdc()` 发请求后轮询 12×1500ms 等 `checkedAt` 变化，期间按钮置灰 |
| `app/lib/ui/phone/system_actions_page.dart` | 新增「调试通道」卡片：已授权 `verified` / 未授权 `warning` / 未检测 `link`，右侧显示检测时间，未授权时追加四步操作清单；原来的「做不到的」卡片只在未授权时保留「读不到屏幕内容」那一条（授权后不再说假话） |
| `app/lib/l10n/parts/system_actions_{zh,en}.arb` + 生成物 | 新增 15 个键（标题 / 四种状态与提示 / 检测中 / 未检测 / 四步清单） |
| `runtime/ohos/phone/index.mjs` | 启动自检：`id` 成功 → 写「已授权」；失败 → 跑 `diagnoseHdc()` 把下一步打进 engine.log 并落盘「未授权」；之后可选的界面树 / 跨 App 自检；最后 `startHdcStatusWatch(ctx)` 常驻轮询 |
| `runtime/tests/ohos/phone-hdc-status.test.mjs`（新） | 8 例：路径落在 `dsh-app/` 下、`stageOf` 三分支、`statusOf` 归一化（hints≤3、每条截断 200、ports≤4）、落盘可读、`authorizedStatus` 保留附加字段、请求序号缺失 / 损坏按 0、只在序号变化时触发且停机后不再触发、效果标签 |

**证据（2026-11-15）**：`node --check` index/hdc-status 通过；`node --test runtime/tests/ohos/phone-hdc-status.test.mjs` → **tests 8 / pass 8 / fail 0**；`python3 tool/l10n_merge.py --no-gen` → `74 parts, 7703 keys`。**本机没有 flutter/dart/ohos SDK，Dart 与 ArkTS 未编译、未跑测试、未上真机**；`lib/l10n/gen/*` 是照 `gen-l10n` 既有格式手工同步的（15 键 × zh/en × 抽象类与实现）。

## 阶段 3：后台进度弹幕（通知栏 + 前台浮层 + 真浮窗）

底座全树 `grep -rli danmaku app runtime` = 0，整套要从 v39 搬。**这项能力没有一行 Dart**：数据源在 Node，展示全在 ArkTS。

| 文件 | 改动 |
| --- | --- |
| `runtime/ohos/phone/progress-feed.mjs`（新，362 行） | 原样搬入：旁路监听 `agent/assistant-stream`（start/chunk/end 三态与 `block-start / reasoning-delta / text-delta / tool-call-delta / finish` 五种 chunk）、`agent/status`、`agent/error`，把思考与工具调用压成一行（工具名换中文动作词、流式参数捞出提示词、只留中文句子、宽度截断退到标点），原子写 `<home>/.dsh/dsh-app/progress.json`；5 秒心跳把 ArkTS 侧状态与生命周期事实抄进 engine.log（`[danmaku] beat/arkts/file`）；停机删文件 |
| `app/ohos/entry/src/main/ets/runtime/DanmakuFeed.ets`（新） | 只读 `progress.json`，缺失 / 损坏安静返回 null |
| `app/ohos/entry/src/main/ets/runtime/DanmakuService.ets`（新，295 行） | 单例；`attachSafe` 包住一切异常并写 `danmaku-error.txt`；必须用 `getApplicationContext().filesDir`（引擎 HOME 是应用级沙箱，不是模块沙箱）；每秒 tick：读快照 → 写 AppStorage（`dshDanmakuLine/Stage/Icon/Steps/At`）→ 后台时发通知（同一条通知原地更新，`PUBLISH_MIN_MS=2600` 节流、完成后 8 秒撤）→ 同步浮窗；`probeCaps()` 把画中画能力与通知通道级别写进 `danmaku-arkts.json` 供引擎侧诊断抄走 |
| `app/ohos/entry/src/main/ets/runtime/DanmakuFloat.ets` + `pages/DanmakuFloat.ets`（新） | API 26 的 `floatView` 横向条：后台且有条目时贴出，前台 / 收工撤掉；能力或权限拿不到就全程静默降级（通知横幅那条路照旧） |
| `app/ohos/entry/src/main/ets/pages/Index.ets` | 顶部加一条弹幕浮层（`@StorageLink('dshDanmakuLine')`，9 秒后自动收、点一下静音 30 秒）；`aboutToAppear` 写 `danmaku-ui.txt` 探针 |
| `app/ohos/entry/src/main/ets/entryability/EntryAbility.ets` | `onCreate` 尽早 `attachSafe`、`onWindowStageCreate` 再挂一次（幂等），`onForeground / onBackground / onDestroy` 转发，`onCreate` 写 `danmaku-oncreate.txt` 探针（底座独有的 `AuthorizedWorkspacesPlugin` 一行未动） |
| `resources/base/profile/main_pages.json` | 注册 `pages/DanmakuFloat` 路由 |
| `runtime/ohos/phone/index.mjs` | `try { startProgressFeed(ctx) }`，模块自己挂 `ctx.effect` 负责停表清文件 |
| `runtime/tests/ohos/entry-ability-fixture.mjs` | 登记新增的三个入口导入（`../runtime/DanmakuService`、`@ohos.file.fs`、`@ohos.hilog`），否则「EntryAbility 导入集合完整」那两条会红 |
| `runtime/tests/ohos/phone-progress-feed.test.mjs`（新） | 6 例：默认路径与 `DSH_GO_PROGRESS_FILE` 覆盖、空转快照、英文思考只留通用话术而中文思考上屏、工具调用变「🛠 手机界面 · dump」、完成 / 出错话术、停表后解绑监听并删除进度文件 |

**为什么能原样搬**：底座 pins 的就是 dsh `0.2.2-rc.1`（`runtime/patches/pins.json`、`runtime/locks/dsh-0.2.2-rc.1`）；`agent/assistant-stream` 的 `{agent, frame}`、`start/chunk/end` 三态、五种 chunk、`agent/status` 载荷与 v39 的假设逐字一致（`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:401`、`@deepseek-ai/dsh-llm/lib/types/types.d.ts:459-484`）。

**证据（2026-11-15）**：`node --check` index/progress-feed 通过；`node --test runtime/tests/ohos/phone-progress-feed.test.mjs` → **tests 6 / pass 6 / fail 0**；`node --test runtime/tests/ohos/entry-ability-*.test.mjs` → **7 / 7 pass**；同集合（composition + phone + tooling runtime）复跑 **49 tests / 37 pass / 12 fail**，12 个失败与 `git stash` 后的基线**逐一同名**（缺 `node_modules`、缺 fixture 环境变量），**无新增失败**。ArkTS 未编译、未上真机。

**真机验收要点（未验）**：① 后台 30 秒以上是否仍每秒 tick（底座自己的 `ContinuousTaskOwner` 持 `MODE_TASK_KEEPING`，不需要 module.json5 的 `backgroundModes`）；② 通知通道 `SERVICE_INFORMATION` 在调试签名包上能否 publish；③ `floatView` 在无悬浮窗权限的调试包上应静默降级、通知横幅照旧；④ 前台浮层是否压在 Flutter 页面上（`Stack` 顶层）。

## 提交与推送记录

| 提交 | 内容 |
| --- | --- |
| `aa5f8cfb` | 阶段 1：hdc 调试通道的界面自动化（hdc-link / ui-tools / 打包带密钥 / 9 例测试） |
| `30ef128c` | 阶段 1 补丁：手机工具失败分三态（`not_dispatched` / `dispatched`）+ 只读快照，不套 native permit（13 例测试） |
| `ce13c895` | 阶段 2 + 阶段 3：授权状态卡片、后台进度弹幕（26 文件 +1941/−11） |

**推送（2026-11-15）**：`git push fork port/v40:port/v40` → `fengs2021/dsh-Go` 的 `refs/heads/port/v40` = `ce13c895`。
底座提交 `1948e7b7` 尚未进 fork（fork 的 `claude/harmonyos-ohos` 停在 `f47b11dd` = 2026-11-10），所以这条分支挂在 fork 上是一个**新分支**，没有改动任何上游分支。旧线 v16–v39 仍在 `fengs2021/dsh-Go` 的 `ohos/v8` = `e0162393`。

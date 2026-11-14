# 更新日志（HarmonyOS 分支 ohos/v8）

本文件记录 HarmonyOS NEXT 版 DSH Go 的**每一次改动**：改了什么、为什么改、改在哪些文件、怎么验证的、还有什么限制。
规则：任何一次提交都必须在本文件顶部新增一个条目（版本号、文件清单、验证证据、已知限制），不允许只有 commit message 没有日志。

- 上游：`https://github.com/ccch1mneyyy/dsh-Go`（分支 `ohos/v8`）
- 发布：`https://github.com/fengs2021/dshgo-ohos`（`ohos/v8` → `main`）
- 版本号规则：`app/pubspec.yaml` 的 `version: 1.0.<versionCode>+<versionCode>`，HAP 的 `versionCode` 与之一致。
- HAP 产物命名：`dsh-ohos-v<N>-unsigned.hap` / `dsh-ohos-v<N>-signed.hap`。

---

## v38 · 手机操作手册改口径 + 首次使用授权引导（2026-11-14，1.0.28+28）

**问题**：用户手册 `docs/guide/harmony/{zh,en}/04-phone-control.md` 写的是「鸿蒙版没有手机操控……不看屏幕，也不点按其他应用，系统不允许」，
而 ohos/v8 早已实现界面操作（`mcp__phone__ui` 的 dump/click/input/swipe/key/shot + `mcp__phone__app` 启停应用）。
说明书与实际能力相反；同时没有任何地方告诉新用户「第一次要让手机信任调试密钥」——这一步不做，界面操作永远只报鉴权超时。

**改动**：

| 文件 | 改动 |
| --- | --- |
| `docs/guide/harmony/zh/04-phone-control.md` | 重写：手机操作分两条路（系统操作 = 应用内开关走系统公开接口；界面操作 = 本机引擎调试通道）。新增「界面操作：第一次要授权」四步（开发者选项 → 无线调试保持开启 → 在对话里让 AI 检查手机调试通道 → 系统弹窗选「始终允许」；没弹窗就撤销授权重试）、「界面操作能做什么／做不到」「界面操作的安全」。系统操作原章节保留，仅把「看屏幕、点按其他应用做不到」改为指向界面操作 |
| `docs/guide/harmony/en/04-phone-control.md` | 同内容的英文版（Phone control / system actions + screen control） |
| `docs/guide/harmony/README.md` | 索引第 04 行中英文改成「手机操作 / Phone control」并概括新内容 |
| `docs/guide/harmony/SKILL.md` | 第 8 条改写：用户问「怎么让 AI 操作别的应用」时先讲两条路与首次授权四步，不再照旧说「鸿蒙版没有手机操控」 |
| `docs/guide/harmony/{zh,en}/11-faq.md` | 新增「界面操作用不了 / Screen control doesn't work」：按自检结果分三种（无调试端口 / 鉴权超时 / 换手机或撤销后）给动作 |
| `runtime/ohos/phone/index.mjs` | 启动探针失败时改调 `diagnoseHdc()`，把 hints 逐条写进 `engine.log`（`[phone-hdc] 下一步：…`），本机引擎页的实时日志即可看到该做哪一步 |
| `app/pubspec.yaml` + 四份 README 版本行 | 1.0.27+27 → 1.0.28+28（`tooling/ohos/bump-version.sh`，同时重生成 `app/assets/skills/dsh-go-guide/`） |

**验证**：
- `python3 app/tool/guide_sync.py --check` → `guide: 26 files checked`，退出 0（UI 路径 nav 注解、**粗体**必须是本语言 ARB 标签、zh 不用「会话／实验」、链接可达等规则全过）。
- 手册资产重建：`app/assets/skills/dsh-go-guide/harmony-zh-04-phone-control.md` 含 9 处「界面操作」，`manifest.json` 映射未变。
- runtime 重新组合：`compose-runtime.py` → `COMPOSE_RC=0`，`runtimeVersion ohos-26e09fc7c48fd074145d5c5e`，payload 12378 文件 / 45 815 193 B。
- 构建：见下条（本文件同版本追加）。

**已知限制**：
- 系统「是否允许调试」弹窗只能用户手点，App 不能代点；因此「无需授权」不可能，只能把步骤写清并让工具/日志在失败时直接说出下一步。
- 用户设置页是 Flutter（本机无 flutter SDK，改动进不了 HAP），所以没有新增 App 内的引导开关或引导页；引导出口只有三处：手册（随 App 安装的 dsh-go-guide 技能）、手机工具返回文案、本机引擎页实时日志。
- 界面操作要求屏幕亮着、且只在本机引擎的对话里生效；远程主机模式下两条路都不可用。

---

## v37 · 调试密钥引导（2026-11-14，1.0.27+27）

**问题**：手机工具（`mcp__phone__shell` / `mcp__phone__ui` / `mcp__phone__app`）靠 App 进程内的 HDC 客户端鉴权，
而 `hdc-link.mjs` 的密钥优先级是「随包内置优先」。结果两个问题同时存在：
1. 别人装同一个 HAP，手机并不认识内置那把密钥，所有手机工具只会报「鉴权超时」，且文案没有告诉用户去点弹窗。
2. 用户把自己的 `id_rsa` 放进数据目录也永远不生效——内置密钥一直抢在前面。

**改动**：

| 文件 | 改动 |
| --- | --- |
| `runtime/ohos/phone/hdc-link.mjs` | 新增 `resolveKeyPath()` 明确优先级：显式选项 > `DSH_GO_PHONE_KEY` > 用户自备 `$DSH_HOME/hdc-client/id_rsa` > 随包内置 > 自动生成；新增 `userKeyPath()` / `shippedKeyPath` 导出、`fingerprintOf()`（SHA-256 公钥指纹）、`diagnoseHdc()`（端口/密钥来源/指纹/PEM 字节数/鉴权结果 + 中文修复步骤）；三类失败文案改成带手机侧入口的引导（无线调试在哪、弹窗点「始终允许」、撤销授权重试） |
| `runtime/ohos/phone/ui-tools.mjs` | 新增只读工具 `mcp__phone__hdc`：把 `diagnoseHdc()` 给模型，用于回答「手机操作为什么用不了」「换人用时要做什么」 |
| `docs/design/harmonyos/hdc-key-onboarding.md` | 新增：密钥来源与优先级、625 字节公钥约束、别人装同一个包为什么必须授权一次、自备密钥流程、自检工具、已知限制 |
| `docs/design/harmonyos/README.md` | 索引新增「手机工具」一行 |
| `runtime/tests/ohos/hdc-key-onboarding.test.mjs` | 新增 3 条本地判据：优先级顺序、3072 位/625 字节/指纹格式、自检报告必须给出可执行步骤且不假装成功 |

**验证**：
- `node --test runtime/tests/ohos/hdc-key-onboarding.test.mjs` → `# pass 3 / # fail 0`。
- 本地仿真实测：内置密钥公钥 PEM = 625 字节，指纹 `83:f3:36:e2:…:8d`；把自备密钥放进 `$DSH_HOME/hdc-client/` 后 `source` 变为 `user`。
- 无无线调试环境下的自检输出：`没检测到无线调试端口：请打开手机的 设置 › 系统 › 开发者选项 › 无线调试 并保持开启…`，并附「始终允许」「撤销授权」「自备密钥放哪里」三条建议。

**已知限制**：
- 系统弹窗只能用户自己点，App 不能代点，因此「零操作」不可能，只能把步骤说清。
- 撤销授权后内置密钥也要重新授权（没有静默恢复）。
- known_hosts 在设备侧，shell uid 写不了，只能靠用户授权或使用已受信任的密钥。
- 用户手册 `docs/guide/harmony/zh/04-phone-control.md` 仍写「不看屏幕、不点按其他应用」，与 ohos/v8 已实现的 `mcp__phone__ui` 口径不一致，属待产品确认项，本版未改手册正文。

---

## CI 转绿（2026-11-14，纯 CI/文档改动，不产生新 HAP）

**问题**：推到 `fengs2021/dshgo-ohos` 后 GitHub Actions 的 `CI` 全红，失败作业两个：
1. `Generated files, tooling, SDK, web` → 步骤「Generated files are in sync」，日志 `guide: README.md: want one line \`> dsh-go 1.0.25\` (app/pubspec.yaml), found ['1.0.11']`。
2. `Runtime and bridge` → 步骤「Install a throwaway patched DSH」，日志 `rtbuild.py patch-dsh: error: the following arguments are required: --target`，退出码 2。

**根因**：
1. 我们每轮发版只改 `app/pubspec.yaml` 的版本，没有同步用户手册的版本行；`app/tool/guide_sync.py` 要求 `docs/guide/README.md`、`docs/guide/harmony/README.md` 及生成的 `app/assets/skills/dsh-go-guide/{README,harmony-README}.md` 里各有一行 `> dsh-go <pubspec 版本>`（`guide_sync.py:46 VERSION_LINE`、`:231` 报错点）。这四行停在 `1.0.11`。
2. ohos/v8 把 `rtbuild.py patch-dsh` 的 `--target` 改成了必填（`rtbuild.py:1566`），但 `.github/workflows/ci.yml:204` 还是上游的旧调用，没传 `--target`，于是 CI 在打补丁那步直接 argparse 退出。

**改动**：

| 文件 | 改动 |
| --- | --- |
| `docs/guide/README.md`、`docs/guide/harmony/README.md`、`app/assets/skills/dsh-go-guide/README.md`、`app/assets/skills/dsh-go-guide/harmony-README.md` | 版本行 `> dsh-go 1.0.11` → `> dsh-go 1.0.26`（与 `app/pubspec.yaml` 的 `version: 1.0.26+26` 对齐） |
| `tooling/ohos/bump-version.sh`（新增） | 一条命令同时改 `app/pubspec.yaml` 与四个手册版本行，并跑 `guide_sync.py` 自查，避免下次发版再拉红 CI |
| `.github/workflows/ci.yml:204` | `patch-dsh … --dsh-version "$version"` → 追加 `--target android`（该 CI 作业本来就是 Android 目标的垃圾前缀验证） |

**验证**：
- `python3 app/tool/guide_sync.py` → `guide: 26 files checked and built`，退出码 0（改前报两条 version 行错误）。
- 本地按 CI 步骤复现 android 目标打补丁：`npm ci --ignore-scripts`（596 packages, 13 s）→ `python3 -I runtime/lib/rtbuild.py patch-dsh --prefix /root/andtest --dsh-version 0.2.2-rc.1 --target android` → 全链 30+ 个 diff 全部 `patched`，退出码 0。
- 本地 `node --test runtime/tests/*.test.mjs` 的 8 个 not ok 都是本机环境缺件（`examples/` 被 sparse checkout 排除导致 `ERR_MODULE_NOT_FOUND`、缺 `dsh_ohos_publication` linked binding），非代码问题；以 CI 结果为准。

**已知限制**：版本号每涨一次都要同步这四行手册版本；下一轮发版前先跑 `python3 app/tool/guide_sync.py` 自查。

---

## v36 — versionCode 26 / 1.0.26：会话「未知工具结果」冷启动自愈

**问题**：手机会话反复报 `本轮运行失败 Previous tool results require reconciliation before another step — call mcp__phone__session with action=release (or start a new session)`，重启 App、甚至 v34 加了 `mcp__phone__session` 放行工具之后仍然不自愈。

**根因**（三层叠在一起）：
1. v34 的放行工具有**鸡生蛋死锁**——`coordinator.gate()/admit()` 在任何工具开始之前就检查「本会话是否有未解决的未知结果」，于是连 `mcp__phone__session` 自己都被拦下，提示里那句「去调它」永远执行不到。
2. `reconcileCold()` 每次冷启动都把 `dispatch-without-outcome` 一类行重新判成 `blocking = true` 并写回 journal，所以重启不解决问题。
3. 派发那条调用的引擎进程已经死了（升级 HAP 时我 `aa force-stop` 抓日志），结果永远不会再到，阻塞状态因此永久成立。

**改动**（`runtime/ohos/lifecycle/coordinator.mjs`，31 578 B）：

| 位置 | 改动 |
| --- | --- |
| 顶部常量 | 新增 `RELEASE_TOOLS = new Set(['phone_session', 'mcp__phone__session', 'session'])` 与 `isReleaseTool(name)` |
| 字段/构造 | 新增 `#autoAbandon`，构造参数 `autoAbandon = process.env.DSH_OHOS_LIFECYCLE_AUTO_RELEASE !== '0'` |
| `admit(sessionId, signal, tool)` / `gate(sessionId, signal, tool)` | 新增第三参 `tool`；命中放行工具时跳过 `ERR_OHOS_LIFECYCLE_RESULT_UNKNOWN` 抛错 |
| `prepared(meta)` | 传 `meta.block.name` |
| `run(meta, dispatch)` | `gate()` / `admit()` 传 `row.identity.name` |
| `reconcileCold()`：`dispatch-without-outcome`、`returned-awaiting-ordered-finalization` | 自动结算为 `basis = auto-abandon-unknown-without-replay`、`blocking = false` |
| `reconcileCold()`：`missing-ordered-recovery-slot` | 自动结算为 `basis = auto-abandon-missing-recovery-slot` |
| `reconcileCold()`：`existing-unknown-placeholder` | 自动结算为 `basis = auto-abandon-existing-unknown` |
| `reconcileCold()`：已放弃行 | 由「只认 `explicit-abandon-unknown-without-replay`」改为正则 `/abandon-unknown-without-replay$/` 且 `blocking === false`，二次启动不翻案 |

**仍然阻塞（不能静默放过）**：`session-identity-mismatch`、journal 损坏/乱序（`ERR_OHOS_LIFECYCLE_SEQUENCE`）。
**开关**：`DSH_OHOS_LIFECYCLE_AUTO_RELEASE=0` 回到 v35 行为。
**文档**：`docs/design/harmonyos/session-release-and-bili-host.md` 新增第 4 节「v36：未知结果的自愈」。

**验证**：`node --check` 通过；`runtime/tests/ohos/lifecycle-engine.test.mjs:42` 的两参 `gate(sessionId)` 调用仍兼容（缺 `tool` ⇒ 不放行）；compose 结果 `{"runtimeVersion":"ohos-3031512c72e84cca6aaf6ed7","payloadFiles":12378,"archiveRoundTrip":true}`，已解包确认 `coordinator.mjs` 含 `RELEASE_TOOLS` 与 `auto-abandon`；构建 `versionCode 26 / versionName 1.0.26`、`# errors 0`、`check-arkts: OK`、`audit-hap: OK`、`FULLHAP_RC=0`。
**产物**：`dsh-ohos-v36-unsigned.hap` 108 705 657 B md5 `60a1382f215aa329354c6d8c1e7be1bc`；`dsh-ohos-v36-signed.hap` 108 780 320 B md5 `9bdab0b77a73d5e50311fade19592304`。
**未验证**：真机行为（装机时设备离线，待联网后确认被锁会话能直接续跑）。

## v35 — versionCode 25 / 1.0.25：WebAssembly/llhttp 纯 JS 垫片（修手机 fetch 全废 → 模型请求 502）

**问题**：手机本机引擎里插件侧 `fetch` 全部失败，模型请求 502；`--jitless` 下 `WebAssembly` 不可用，而打包的 undici 用 llhttp 的 WASM 解析器。

**改动**：新增纯 JS 的 llhttp/WASM 垫片路径，保证 `fetch` 在无 WASM 环境可用。设计记录见 `docs/design/harmonyos/session-release-and-bili-host.md` 第 3 节。
**产物**：`dsh-ohos-v35-unsigned.hap` 108 704 778 B md5 `3b4118d1c50739d05730c9f519678ce1`；`dsh-ohos-v35-signed.hap` 108 776 223 B md5 `800b33efcff5c82ed8e044b4d54156b1`。
**未验证**：真机 `[wasm-shim]` 日志与会话不再 502（装机时设备掉线）。

## v34 — versionCode 24 / 1.0.24：会话放行工具 + bili 代理进程内托管

**问题一**：被强制结束的会话会永久卡在「工具结果未知」，用户无从下手。
**改动一**：新增 `runtime/ohos/phone/session-tools.mjs`，工具 `mcp__phone__session`（`action = list | release`）：`list` 列出被锁会话，`release` 逐个调用 `ctx.ohosLifecycle.acknowledgeUnknown(sessionId)`；协调器缺失时降级为 `unsupported`。

**问题二**：billion-context（bili）插件在手机上必然 `ERR_OHOS_NO_SPAWN`——它要 spawn 一个代理子进程。
**改动二**：新增 `runtime/ohos/process/bili-host.mjs`：扫描 `$DSH_HOME/profiles/*/node_modules/billion-context/dist/index.js` → 取空闲端口 → **先**写 `process.env.BILLION_CONTEXT_PROXY`（让插件走 attach 模式而不是 spawn）→ 用 `new Worker(script, { argv: ['start','--host','127.0.0.1','--port',…,'--no-auto-update'] })` 在进程内起代理 → 后台轮询 `/__bili/health`。`DSH_GO_BILI_HOST=0` 可关。
**文档**：`docs/design/harmonyos/session-release-and-bili-host.md`。
**验证**：PC 上 `/root/session-tools-test.mjs` 输出 `SESSION_TOOLS_TEST_OK`；`/root/bili-host-test.mjs` 环境变量 46 ms 就位、代理 541 ms 就绪、`/__bili/health` 200、RSS 142 MB；5/45/90 秒三次健康检查全部 200。
**产物**：`dsh-ohos-v34-signed.hap` 108 768 030 B md5 `21461f3959772bc34848a505933db9de`。

## v33 — versionCode 23 / 1.0.23：插件市场安装能力改为按桥实时上报

**问题**：App 的插件详情页底部整条灰色禁用按钮写死「这个引擎不能安装市场插件」，用户要求去掉并从市场装插件。文案来自我们自己的 Dart（`app/lib/l10n/app_zh.arb:5083 marketInstallRefused`），开关来自 `app/lib/state/runtime_capabilities_state.dart:22-24` —— 而真正在骗 App 的是引擎：`runtime/ohos/capabilities/snapshot.mjs` 把 `plugins.marketInstall` 硬编码成 `unsupported`（v25 以前的历史遗留）。

**改动**：`runtime/ohos/capabilities/snapshot.mjs` 新增 `marketInstallCapability()`：看 `globalThis.__dshOhosPackageManager` 是否注册、`runProfilePnpm / viewProfilePackage / readRegistry / parseArguments / profileDirectory` 五个 seam 是否齐全 —— 都有 ⇒ `supported`，半桥 ⇒ `unknown`，无桥 ⇒ `unsupported`。能力端点是纯只读，不读盘、不装包、不 spawn。
**测试/文档**：`runtime/tests/ohos/publication-capabilities-http.mjs` 按入包内容推导期望值；`docs/design/harmonyos/capabilities-v1.md:47,87,139`。
**产物**：`dsh-ohos-v33-unsigned.hap` md5 `487dd5294a5ae9176333c77d93a95651`；signed md5 `8c3cdeed69c9492068e59ec3ec44b1aa`。
**未验证**：装机后设备锁屏（`Error Code:10106102 The device screen is locked`），灰条是否变成可用「安装」按钮待人工解锁后确认。

## v32 — versionCode 22 / 1.0.22：`node:inspector` 垫片，让 dsh-market 能加载

**问题**：`dshmarket` 安装必失败（`ERR_INSPECTOR_NOT_AVAILABLE`），引擎启动也报 `dsh-market: failed to import`。根因是手机版 libnode 用 `--without-inspector` 编译（`runtime/ohos/node/build-node.py:240`），模块壳子在、agent 不在，`dshmarket/package/lib/restart.js:17` 顶层 `import inspector from 'node:inspector'` 一取 `inspector.url()` 就抛。

**改动**：新增 `runtime/ohos/process/inspector-stub.mjs`（`url()` 返回 `undefined`，`Session` 空实现，`open/close/waitForDebugger` 空转，`__dshInspectorStub = true`）与 `runtime/ohos/process/inspector-hooks.mjs`（ESM `resolve` 钩子把 `node:inspector` / `inspector` 指到垫片）；`runtime/ohos/preload.mjs` 里用 `module.register()` 注册钩子，并加 `Module._load` 兜底覆盖 CJS。选 `process/` 目录是因为 compose 打包白名单只收 `runtime/ohos/{net,publication,capabilities,lifecycle,phone,plugins,process}` 下的 `*.mjs`。
**验证**：PC 上 `/root/insp-test2.mjs` 四条路径（ESM `node:inspector`、ESM 裸 `inspector`、CJS `node:inspector`、CJS 裸 `inspector`）全部拿到 `__dshInspectorStub === true`；`node:fs`/`node:worker_threads` 不受影响。真机上 v31 每次启动都出现的 `dsh-market (dshmarket): failed to import` 行消失，插件页出现「插件市场」tab。
**限制**：`@deepseek-ai/dsh-experimental-inspector` 仍在 **worker 线程**里失败（主线程 loader 钩子不覆盖 Worker），启动告警 `2 entries did not activate` 其中之一就是它。
**产物**：unsigned md5 `6e86d1f970dbec34d414165fc793438a`；signed md5 `73032545dd21b932d96f7438523fd579`。

## v31 — versionCode 21 / 1.0.21：运行时安装被中断后自动续装

**问题**：升级 HAP 后首次启动要重铺 151 MB / 12 372 个运行时文件，此时 `aa force-stop` 会留下 `$APPFILES/dsh-runtime/installing.json`；下一次启动 `RuntimeCore.ets:192` 的 `installed()` 见到它就 `return null`，`RuntimeController` 直接把 `setupError` 设成「上次运行时安装未完成，请重新安装以继续」，App 永远卡在启动图标（8 分钟不动、`/proc/net/tcp` 里 App uid 没有监听端口 = 引擎从未启动）。

**改动**：`app/ohos/entry/src/main/ets/runtime/RuntimeController.ets` 的 `prepareRecovery()` —— 发现 `installed === null` 且存在 `installing.json` 时清空 `setupError` 并重跑 `installPayload()`，成功后重新读 `installed()`；失败才保留错误文案。
**验证**：真机 22:36:45 启动 → 22:37:15 `installing.json` 消失、`installed.json` 重写（**约 40 秒自动续装，原有数据不丢**）→ 引擎正常启动，日志出现 `[danmaku] progress feed armed`、`dsh web: http://127.0.0.1:…`、`[phone-hdc] probe ok`。

## v30 — versionCode 20 / 1.0.20：`uitest` 成功判定与 ui 工具增强

**问题**：`uitest uiInput` 即使失败也返回 0 退出码，工具却当成功；`dumpLayout` 失败时会留下半截 json。

**改动**：`runtime/ohos/phone/ui-tools.mjs`（263 → 290 行）——新增 `uiCommand(command, timeoutMs)`，**退出码 0 且 stdout 恰好 `No Error` 才算成功**，`uiClick/uiLongClick/uiInput/uiSwipe/uiKey` 全走它；`parseBounds` 丢弃零宽/零高节点；`dumpUi` 判 `DumpLayout failed:` 并失败也 `rm -f`；新增 `uiLongClick`、`uiClick` 的 `waitMs` 轮询（点完等目标出现再返回）、`pickTarget(nodes, needle)`。schema 增加 `waitMs` / `longclick`。
**来源**：`GeorgeGcs/maestro-harmonyos` 的 `patches/maestro/0001-harmonyos-host.patch`（Kotlin，本体装不进手机引擎，但判定细节可抄）。
**未验证**：真机行为（`waitMs`/`longclick`）。

## v29 — versionCode 19 / 1.0.19：插件包管理器补强 + 弹幕文案质量

**改动（包管理器）**：`runtime/ohos/plugins/install.mjs` 的 `linkBins()` 把 `.bin` 转发脚本改写为 `#!/bin/sh`（沙箱禁 symlink）；`installRemote()` 支持 GitHub / 归档；`ensure()` 用 `const host = container;` 修作用域包 `.bin` 归属；`resolveVersion()` 改为遍历 `this.registries`。`runtime/ohos/plugins/package-manager.mjs` 增加 `registryChain()` 与 `DEVICE_MIRRORS = ['https://registry.npmmirror.com/', 'https://registry.npmjs.org/']`（镜像优先：直连 npmjs 一个 4 MB tarball 要 36–87 s，镜像后 `dsh-genui@0.15.0` 13.2 s）；`viewProfilePackage` 支持逐 registry 试探。
**改动（弹幕）**：`runtime/ohos/phone/progress-feed.mjs` 新增 `CJK/cjkCount/readableLine/chineseOnly/TOOL_LABELS/labelOf/toolLine/toolArgs`，`clip()` 退到标点断句，`push()` 近似去重并保留更长版本 —— 把「⏳ 仍在处理…」这类英文/碎片文案换成「🛠 插件安装 · install_bundle」这样的中文短句。
**真机结果**：第二批 18 个第三方插件安装：成功 14（13 个原本已装直接跳过，另装好 `dsh-workbuddy-panel@0.5.1`），失败 3：`dsh-better-sidebar@0.30.0`（gbk 编码不支持）、`dsh-super-code@0.3.10`（`safer-buffer` 无匹配版本）、`dshmarket@1.73.11`（Inspector 不可用，v32 已修）。
**产物**：`dsh-ohos-v29-signed.hap` 108 760 192 B md5 `79ff525aba20e67e9c583bb1e6bebbeb`。

## v27–v28 — 纯 JS 包管理器接管插件安装（插件安装桥）

**问题**：鸿蒙本机引擎装不了插件（`这个引擎不能安装插件`），因为插件管理器缺 pnpm/网络/符号链接能力；且沙箱禁 `symlink`。

**改动**：
- 新增 `runtime/ohos/plugins/{semver,tar,registry,install,package-manager,remote}.mjs`：零依赖纯 JS 的 semver、tar 解包（符号链接降级为复制）、registry 客户端（镜像优先）、安装器（`.bin` 改为 `#!/bin/sh` 转发脚本）、GitHub/tarball 规格解析（`github:owner/repo#ref`、裸 `owner/repo`、`https://github.com/…`、`.tgz/.tar.gz` → `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref|HEAD>`）。
- `runtime/ohos/preload.mjs` 里 `globalThis.__dshOhosPackageManager = await import('./plugins/package-manager.mjs')`。
- 新增补丁 `runtime/patches/zzzzzzzzzzzzz-ohos-plugin-install-bridge.diff`（10 hunk）：`@deepseek-ai/dsh-plugin-manager` 的 `runProfilePnpm` / `readProfileRegistry` / `viewProfilePackage` 委派到 `__dshOhosPackageManager`，并给 `checkGithubConnection` / `chooseGitTransport` 加 OHOS 早退；`operations.js` 4 hunk。
- `runtime/ohos/package/compose-runtime.py:419` 目录白名单加入 `plugins`。
**文档/测试**：`docs/design/harmonyos/plugin-install-bridge.md`、`runtime/tests/ohos/plugin-install-bridge.mjs`、`plugin-registry-bridge.mjs`、`plugin-install-observer.mjs`；PC 上 `/root/pmtest-sim2.mjs` 11 项仿真全过。

## v26 — 后台进度弹幕（不依赖系统悬浮窗）

**问题**：用户要「切到后台也能看到思考进度」，但 `SYSTEM_FLOAT_WINDOW` / `FLOAT_VIEW` 是 system_basic 权限，HoKit 调试 profile 的 `allowed-acls: []` ⇒ 系统悬浮窗与 `floatView.start()`（201）都不可用，SDK 也没有 LiveViewKit。

**改动**：改为「应用内横幅 + 前台浮层」两层：ArkTS 侧 `app/ohos/entry/src/main/ets/danmaku/*` 出横幅，运行时 `runtime/ohos/phone/progress-feed.mjs` 把 agent 的思考/工具事件压缩成一行弹幕，通过 `dsh-app/danmaku-arkts.json` 与 `danmaku.jsonl` 交付；后台任务用常驻任务（v16）保活。
**证据**：`后台弹幕验证-v26.md`；真机 `phase=7`（常驻任务生效）。

## v16 — 切后台不被杀：常驻任务

**问题**：DSH 一切到后台任务就停。
**改动**：申请 `KEEP_BACKGROUND_RUNNING` + 常驻任务（ContinuousTask），真机验证后台相位 `phase=7`，任务继续执行。文档：`docs/design/harmonyos/continuous-task-keeping.md`。

---

## 维护约定

1. **先改日志再提交**：一个功能/修复 = 一个条目，写在文件最上面（最新在上）。
2. 条目必须含：版本号 + versionCode、问题、根因、改动文件与符号、验证证据（命令输出/md5/日志行）、已知限制。
3. 未验证的事必须写「未验证」，不许写成完成。
4. commit message 用 `feat(ohos-*)/fix(ohos-*)/docs(ohos):` 前缀，并在提交正文里贴本条目链接（`CHANGELOG-OHOS.md#vNN`）。

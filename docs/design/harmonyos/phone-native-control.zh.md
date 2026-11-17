# 原生操作鸿蒙：手机界面自动化能力现状（2026-11-17，移植到上游 hmos 基线）

本文回答一个问题：**手机版 dshgo 能不能像人一样直接操作这台鸿蒙手机**——读屏幕、点按、滑动、打字、按键、截图、启停应用。答案是能，而且这些能力已经在 runtime 里、已经随 HAP 打包，不需要投屏插件、不需要电脑在场。

本文只写有代码或日志支撑的部分；没在真机上验过的一律标「未验证」。

## 1. 结论先行

- 通道：App 内的 Node 进程**直连本机 hdcd**（`runtime/ohos/phone/hdc-link.mjs`，零依赖自实现的 HDC 客户端），以 **shell uid 2000** 执行 `uitest` / `bm` / `aa` / `snapshot_display`。
- 因此能力边界不是「我们写了什么」，而是「shell 权限能做什么」：读控件树、按控件或坐标点按、长按、滑动、输入文字、发按键、截图、启停任意应用，全部覆盖。
- 前提只有一个但很硬：**手机的 开发者选项 › 无线调试 必须打开**（没有 TCP 监听端口就没有通道）。App 的「系统操作」页已经把这四步引导写进界面，并有一键重新检测。
- 投屏（H.264 画面流）**没有**也不需要：模型看图靠 `shot` 截图落盘 + `read_image`，人看图靠手机屏幕。

## 2. 工具与动作表

四个 MCP 工具，随引擎注册（`runtime/ohos/phone/ui-tools.mjs`、`index.mjs`），只在 `process.platform === 'openharmony'` 时出现。

| 工具 | 动作 | 说明 |
|---|---|---|
| `mcp__phone__ui` | `dump` | 读当前屏幕控件树（`uitest dumpLayout`），返回可点/可输入/有文字的节点：`type`、`label`、`clickable`、`focused`、`editable`、`id`、`bundle`、`bounds{cx,cy}`；`filter` 按子串过滤，`limit` 默认 150 |
| | `click` | 按坐标点，或按 `text` 找控件再点；`waitMs` 可先等文字出现（默认 0 只查一次） |
| | `longclick` | 长按（坐标或文字） |
| | `input` | 输入文字（不给坐标时自动找当前可输入的焦点框） |
| | `swipe` | 滑动 `x1,y1 → x2,y2`，`speed` 默认 600 |
| | `key` | 发按键，如 `Back` / `Home` / `Power`（`uitest uiInput keyEvent <name>`） |
| | `shot` | 截图存到工作区 `phone-shots/shot-<ts>.jpg`（校验 JPEG 头 `ff d8`），随后可 `read_image` 给模型看 |
| | `wait` | 等待 `ms` |
| | `script` | **按顺序执行多步**（本文 §5，最多 20 步） |
| `mcp__phone__app` | `list` / `launch` / `stop` / `current` / `abilities` | `bm dump -a` 列包名；`launch` 从 `bm dump -n` 取 mainElementName 再 `aa start`；`stop` 走 `aa force-stop`；`current` 读前台 Ability 与 want；`abilities` 列 Ability |
| `mcp__phone__shell` | 任意命令 | 走 hdc shell，默认 30s 超时，输出截断到 6 KB / 12 KB |
| `mcp__phone__hdc` | 自检 | 无线调试端口、密钥来源（随包 / 用户自备 / 自动生成）与公钥指纹、鉴权是否成功、该让用户做哪几步；**只读**，不改设置 |

另有一组「原生回调」工具（`runtime/ohos/phone/catalog.mjs` + `tools.mjs`，走 native 队列而不是 hdc）：`open` / `intent` / `notify` / `clipboard` / `handoff`，用于打开应用、发通知、写剪贴板、把事交还给用户。这两组是互补的：前者要 App 在前台并持许可，后者不需要。

## 3. 坐标与控件：dump 之后怎么点

- `dump` 的节点中心坐标 `bounds.cx/cy` 是**手机像素**，直接喂给 `click`。
- 零宽、零高、反向的 bounds 会被判成 `null`——文字还看得见，但不会被当成点击目标（点它只会点到左上角）。
- 按文字找控件的顺序是：**label 精确 → label 包含 → id 包含**。所以「设置」这个字既可能命中标题也可能命中开关，必要时用 `filter` 先看一遍再决定坐标。
- 长页面上的项要先 `swipe` 再 `dump`；`dump` 拿不到时不要盲点，先 `shot` 看现场。

## 4. 成功口径与三态结果

`uitest uiInput` 即使内部报错也返回退出码 0（`ui_input.cpp` 对 `ApiCallErr` 也返回 `EXIT_SUCCESS`），所以：

- 输入类动作只有在 **stdout 恰好是 `No Error`** 时才算成功；
- `dumpLayout` 靠自己的 `DumpLayout failed:` 文案判定，拿回的内容必须先确认是 JSON；
- 结果对象与上游 `runtime/ohos/phone/catalog.mjs` 的 `phoneResultSchema` 同源（`{status, effect, evidence, dispatched, code, message}`，另带 `data` 放 `dump` 的完整控件列表），因为 Android 的 `PhoneToolCatalog.kt` 与 Dart 共享同一份 catalog，自造形状会分裂两个平台：
  - `status` ∈ `succeeded` / `failed` / `unknown`；`effect` 在上游那五个之外本地扩了 `screen_read` / `ui_acted` / `unknown`（`dump`/`shot`/`wait` → `screen_read`，点按输入滑动按键脚本 → `ui_acted`，`app launch` → `opened_ui`，`shell` → `unknown`，自检 → `none`）；
  - `failed` + `dispatched=false`：帧没写出去（连不上、鉴权失败），**可以安全重试**；
  - `unknown` + `dispatched=true`：命令已发出但没拿到结束回执，**不要直接重试**——重试一次就是真的多按一下，先 `dump`/`shot` 看现场；
  - 参数不对直接 `failed` + `code: invalid_args`，什么也没发生。
- 结果里还带当时只读的 native 快照（App 是否在前台、引擎第几代），给「未知」留现场依据。

## 5. `script`：一次调用连做几步（本次新增）

一次点按要一次工具往返，进设置改一项往往要点屏幕、等页面、滑一段、再点、再读回来——五六轮往返既慢又容易在中途被打断。`script` 把这些串成一次调用：

```json
{"action":"script","steps":[
  {"action":"click","x":114,"y":225},
  {"action":"wait","ms":600},
  {"action":"click","text":"设置"},
  {"action":"wait","ms":600},
  {"action":"dump","filter":"Linux"}
]}
```

语义（`runScript`）：

- 每步用的还是上表那几个动作函数、同一套 `No Error` 成功口径，**没有发明任何新命令**；
- 最多 **20 步**；`steps` 为空、超过 20、嵌套 `script`、未知 `action`、某步不是对象 → 直接 `invalid_args`，一步都不执行；
- 任一步失败**立即停**，返回里带着已完成的步骤清单（`1. dump · ok · …`）和失败的那一步，`dispatched` 反映「之前是否已经有动作真的点下去」；
- 审批弹窗会显示成 `script · 5 步：click→wait→click→wait→dump`，让人知道要连点哪几步再同意。

## 6. 截图交给模型看

`shot` 把画面存到**当前会话工作区**的 `phone-shots/shot-<时间戳>.jpg`，因为模型的 `read_image` 只能读工作区里的文件。这条链路的价值在于：拿不到无障碍节点的地方（游戏渲染、自绘容器、Flutter/ArkWeb 混合页）也能靠坐标操作——先看图，再按坐标点。前提是当前模型支持图片输入。

## 7. 授权路径与用户可见性

App 里已有完整界面，不是隐藏开关：

- 设置 › 系统操作（`app/lib/ui/phone/system_actions_page.dart`）：「能做的」卡、「界面操作（调试通道）」卡（点一下调 `probeHdc()` 重新检测）、「做不到的」卡、「确认方式」、最近操作。
- 未授权时显示四步引导（开发者选项 › 无线调试 › 首次连接选「始终允许」› 回来点重新检测），文案与 `hdc-link.mjs` 的 `GUIDE_WIRELESS` / `GUIDE_TRUST` 同源。
- 状态文件 `dsh-app/hdc-status.json`（`hdc-status.mjs`）记录 已授权 / 未授权 / 无端口 / 出错 / 未知，页面据此渲染。
- 每次动作都过 `tools/pre-execute` 审批钩子：会话审批策略为 `never` 或预设为 `auto` 时不打扰，否则弹「操作手机界面：点击 · 设置」。

## 8. 真机怎么验（下次拿手机时照这个跑）

1. 装包、首启完成后，看引擎日志 `<filesDir>/dsh-runtime/engine.log`（手机路径 `/data/app/el2/100/base/io.github.ccch1mneyyy.dsh_app/files/dsh-runtime/engine.log`，电脑侧可用 `hdc file recv` 取）。
2. 启动自检会打两行：
   - `[phone-hdc] probe ok <ms> rc=0 out=uid=2000(shell) …`
   - `[phone-probe] dump ok <ms> screen=1320x2848 nodes=N top=…`
   两行都在 = 通道通、控件树读得到。`DSH_GO_PHONE_PROBE=0` 可关自检。
3. 端到端：在会话里让模型执行「`mcp__phone__ui` 读屏 → 点某个 tile → `shot` → 看截图确认」。人眼核对手机屏幕是否真的变了。
4. 电脑侧对照：`hdc shell uitest dumpLayout -p /data/local/tmp/x.json` 与工具返回的节点数应基本一致（工具会多丢掉零宽节点）。

## 9. 证据

- **真机跑通过（旧包）**：`/root/logs` 里 v30–v32 的引擎日志命中
  `[phone-hdc] probe ok 864ms rc=0 out=uid=2000(shell) gid=2000(shell) groups=… context=u:r:sh:s0`、
  `[phone-probe] dump ok 4364ms screen=1320x2848 nodes=42 top=…`，另有 764 / 756 / 311 ms 的 probe ok 与 2048 / 2104 / 949 ms、nodes=47 / 36 / 45 的 dump ok。→ 通道、鉴权、`uitest dumpLayout`、`execBuffer` 回传都在真机上成立。
- **本次单测**（在上游 hmos 基线的移植工作树 `port66` 里跑）：
  - `node --test runtime/tests/ohos/phone-ui-tools.test.mjs` → **22 pass / 0 fail**（`script` 5 例：顺序执行、只读不算已派发、首个失败即停、中途抛错按三态归类、空/超长/嵌套/未知/非对象一律拒绝；`projectUiResult` 2 例：与 `phoneResultSchema` 同源、各动作的 status/effect 映射）；
  - `node --test runtime/tests/ohos/phone-hdc-status.test.mjs` → **8 pass / 0 fail**；
  - `flutter test app/test/state/system_actions_state_test.dart app/test/phone/system_actions_page_test.dart` → **48 pass / 0 fail**（新增 7 例：`hdc-status.json` → 页面形状 4 例、页面三态渲染 3 例）；`flutter analyze --no-pub` → No issues found。
- `node --test runtime/tests/ohos/*.test.mjs` 整体 586 例里 368 fail，是**环境性**的：这些用例要 CI 注入的 `OHOS_GRANT_HOST` / `OHOS_GRANT_PUBLISHER` / `OHOS_GRANT_ADDON` 与 `node_modules`，本机跑不动，与本文改动无关。

## 10. 已知缺口（未验证）

- **按键名未穷举**：`Back` / `Home` / `Power` 用过；音量加减、转屏没有真机确认，所以没写成动作，别指望它现在能做。
- **剪贴板读**：只有写（native 回调 `clipboard`），读没做（鸿蒙 7.0+ 的 `testhelper get-pastedata` 未验证）。
- **换基线后未真机复验**：上面第 9 节的日志来自 11-13/11-14 的 v30–v32（旧底座）。这次是把通道移植到上游 `claude/harmonyos-ohos` 基线（`port/v66`），ArkTS 的 `HdcChannelStatus`、Dart 的状态卡、`index.mjs` 的自检都只在单测里过；装机后第一件事就是看那两行 probe 日志。
- **`script` 只在单测里跑通**，没有真机端到端；上真机时先用 2–3 步的小脚本试。
- **不是无障碍服务**：走的是 hdc 调试通道，靠开发者选项；用户关掉无线调试就没了，App 文案已明说。

## 11. 为什么不内置 `ns-zzj/dsh-hos-scrcpy`

那个插件解决的是「在电脑上看手机画面并用鼠标点」，它的 provider 半区需要**桌面** JVM 启动 Java sidecar（`hosScrcpy-1.0.18-beta.jar` + `hdc.exe`），core 半区是往**网页版会话右上角**注入标签页的前端组件。手机版 dshgo 里既没有 JVM、也没有那个网页挂载点，装进去也不会激活。

我们真正缺的只是「让 AI 能动手」：读控件树、点、滑、输入、按键、截图、启停应用——这些本文已经列全，且不依赖电脑。对照关系：

| scrcpy 插件的能力 | 我们的对应实现 |
|---|---|
| 截图直交 AI | `mcp__phone__ui` `shot` + 工作区 `phone-shots/` + `read_image` |
| 控件清单 | `dump`（可 `filter`） |
| 点击 / 长按 / 滑动 | `click` / `longclick` / `swipe` |
| 文字输入 / 按键 | `input` / `key` |
| 多设备、H.264 画面流、转屏不黑屏 | **不做**（不需要画面；单机足够） |

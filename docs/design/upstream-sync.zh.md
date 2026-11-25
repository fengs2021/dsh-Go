# 上游同步状况与 cherry-pick 实验（2026-11-24）

## 1. 距离

| 项 | 值 |
|---|---|
| 上游 `origin/main` | `d5a78fbc9`（Merge PR #1927 perf/shell-batch17） |
| 本分支分叉点 | `c9d3c5825`（Merge PR #1728） |
| 落后 | **836 个提交** |
| 领先（端口补丁 + 近期工作） | 38 个提交 |
| 上游版本号 | 仍是 `1.3.0+1`，未跳版 |

改动分布（按目录，前 12）：`app/android/app` 156、`app/lib/ui` 147、`packages/dsh_tavern/test` 93、
`packages/dsh_tavern/lib` 58、`app/test/phone` 56、`packages/dsh_client/test` 51、`app/test/companion` 51、
`app/lib/companion` 41、`runtime/bridge/dsh-go-bridge` 34、`runtime/tests/fixtures` 29、
`packages/dsh_client/lib` 26、`app/lib/state` 23。

**`app/ohos` 上游没有**，鸿蒙层完全是我们分支独有，rebase 不会冲掉它。

## 2. cherry-pick 实验（分支 `probe/remote-fixes`）

目标：只把 remote 层的修复搬到当前基线上，验证上游是否已修掉我们 #1753 的断连问题。

| 提交 | 结果 |
|---|---|
| `7589b1a32` fix(remote): recover Control without restarting healthy tunnels | 可 pick，但**让 3 个测试由绿转红** |
| `6f3639263` fix(remote): 截止时间到了先等已收到的消息派发完 | **不能独立 pick**：依赖的 `_receiveTail` 字段在后续 `8933bae70` 里被 revert 掉了 |
| `57a07b5f9` fix(remote): 对端断开后会话立即算关闭 | 同上，属于被 revert 的 #7178 系列 |
| `8120ef518` fix(remote): 到点的请求立即不再开始发送 | 同上 |

反证：把 `packages/dsh_remote` + `app/lib/remote` 退回分叉点版本，同样两个测试文件 44 条**全绿**，
说明变红是 pick 引入的，不是环境问题。

失败用例：

- `test/relay_protocol_errors_test.dart` → `a dropped socket stays retryable`（Expected true / Actual false）
- `test/webrtc_transport_test.dart` → `connectHost a pending capability probe preserves terminal CONNECTION_REPLACED`、`… INVALID_MESSAGE`

## 3. 结论

1. remote 层在上游是**成批演进**的（PR 系列 + 一次整体 revert），单独摘某个修复会处在半套状态：
   代码 pick 进来了，配套的语义/测试没有。
2. 因此「定点搬运 remote 修复」这条路不通。要拿到上游那批正确性，只能**整体 rebase 到 main**。
3. 整体 rebase 的冲突面集中在 `app/lib/state`、`packages/dsh_client`（我们改过）、`app/lib/remote`；
   `app/ohos` 与 `app/assets/skills` 不冲突（上游没有）。
4. 上游正在建「用户自定义技能」体系（`feat(phone): 技能页…`、`draft skills from privacy-bounded task traces` 等），
   我们刚内置的 `night-run` 将来要跟这套页面/状态对齐。

## 4. 建议

短期不做全量 rebase；等需要上游 remote 修复时，单独开一条 `sync/upstream-<date>` 分支做整体 rebase，
逐门跑 `test/remote`、`test/state`、`test/chat`、`flutter analyze`、`check-arkts`，再决定合回。

## 5. 定点搬运（2026-11-26，分支 `sync/upstream-1126`）

上游从 `d5a78fbc9` 涨到 `d73c679c3`，新增 272 个提交，落后 836→1108。新提交绝大多数是
`companion`（伙伴小屋）与 `chat` 流式渲染微优化，依赖链长、与鸿蒙分支无关，不摘。按「平台无关 +
能独立生效 + 手机使用相关」筛出并实测 cherry-pick：

| 上游提交 | 内容 | 结果 |
|---|---|---|
| `33069b24e` | perf(client)：远程工作区大窗口 base64 放到 `Isolate.run` 后台解码 | ✅ 干净 |
| `34967116c` | fix(share)：导出前等的插件图标就是卡片上画的那张 | ✅ 干净 |
| `9750ffe9e` | perf(star)：求 Star 提示永久结束后停掉前台每分钟计时 | ✅ 干净（自动合并） |
| `e6b799814` | fix(web)：切主机后同会话号也打开所选对话 | ✅ 干净（自动合并） |
| `478fdb9d5` | perf(search)：checkpoint 缓存满不再按插入顺序逐出 | ✅ 干净（自动合并） |
| `a99b5e190` | fix(terminal)：键盘重新唤起与复制粘贴 #1935 | ❌ 依赖前置的 `showAppSheet.onRouteChanged`，单摘编译失败，已回退 |
| `2c9f771e4` | fix(phone)：手机操控回到发起处 #1938 | ❌ 冲突且耦合 companion/Android，已 abort |

**验证**：`flutter analyze` No issues；`test/star`、`test/search`、`test/share` 等 84 例全通过；
`packages/dsh_client` 测试与基线失败清单一致（仅基线固有的 `dsh_go_heartbeat_test.dart` 计时用例），
未引入新失败；`l10n_merge --check`、`guide_sync --check` 通过。5 个提交共 7 文件、81  insertions。

**结论**：定点搬运可行，但判据要严——只有无跨提交依赖、无 companion/Android 耦合的独立修复才单摘；
terminal 和 phone 那两个仍印证上一节的「成批演进」规律，要拿到只能整体 rebase。5 个提交已于
2026-11-26 合回 `port/v71`（fast-forward 到 `d9664fc64`）并出包 v91 装机验证通过。

### 5.1 terminal / phone 两个的依赖链根因（2026-11-26 追证）

不满足于「成批演进」的经验判断，追了依赖链，确认两个都挂在**整套 companion Pro 特性链**上：

- `onRouteChanged` 参数由上游 `4442548660`（11-21，companion agent「F03-pause-app / notes 前台暂停」）
  引入，一次改了 `showAppSheet`、`showAppDialog`、`showTextPrompt`、`showDirectoryPicker`、
  `confirmRisk` 等公共函数签名，并深度改造 `companion_page.dart`（notes 前台保活/暂停、审批风险路由观察）。
- terminal `a99b5e190`（11-24）用 `showAppSheet(..., onRouteChanged:)` 观察输入面板被键盘 route 覆盖，
  依赖上述整套改动；我们主线分叉时没有这条链，`showAppSheet` 签名里没有该参数，单摘即编译失败。
- phone `2c9f771e4`（11-24）本身改 companion 的 `companion_agent_phone_tools` / `companion_page`，
  还依赖已有的 `app/test/companion/companion_agent_phone_tools_test.dart`（我们分支删过），
  冲突面同样是这条 companion 链。

因此这俩不是「再补一两个前置提交」能解决，而是要搬 11-21 起的一整串 companion Pro 提交（彼此耦合、
还带 Android Kotlin 侧改动）。**判据**：凡改动触及 `app/lib/companion*`、`app/lib/ui/companion*`、
`app/lib/ui/common/app_{sheet,dialog}.dart` 的，一律不做定点搬运，列入「只能整体 rebase」清单。

### 5.2 按改动文件重筛（2026-11-26 第二轮）

第一轮按 commit message 关键词筛会漏掉「标题没点模块名」的提交，改用 GitHub API 拉每个提交的
**改动文件清单**再筛（rate limit 60/h，本次取到前 60 个）。新发现：

| 上游提交 | 内容 | 结果 |
|---|---|---|
| `e54f1532e0` | perf(remote)：分块传输大载荷（>256KB）的 UTF-8/JSON 解码放 `Isolate.run` | ✅ 已 pick 合回，HEAD `565547c0f` |
| `c0076093d9` / `bc1b8116dc` | perf(runtime)：改 `runtime/patches` + `pins.json` + `series`（pi-ai 空模型 / Office buffer） | ⏸ 不动：改引擎运行时字节，需重编 runtime + 全量门禁，不符合定点独立修复判据 |

`e54f1532e0` 与上次 revert 的 remote 提交（`_receiveTail` 那批）无关，纯性能优化、语义不变。
验证：dsh_remote analyze 仅 1 条既有 info（基线相同）、测试无失败；app analyze No issues。

**出包**：`565547c0f` 已随 v92 出包装机（见 §5.4）。

### 5.3 本地 diff-tree 全量重筛（2026-11-26 第三轮）

GitHub API rate limit（60/h）用尽后，改用本地 `git diff-tree --name-only -r <sha>` 扫全量 272 提交
（只读 tree、不拉 blob，绕开 API 限制）。非 companion、命中关键模块的候选 33 个，试 pick 4 个：

| 上游提交 | 内容 | 结果 |
|---|---|---|
| `797a2a9d11` | perf(chat)：已发送图片释放时逐出缩略图缓存；删除会话时关掉本对话也允许 | ✅ 干净合入 |
| `cb22636dd9` | perf(chat)：远端工作区图片少发一次 stat | ✅ 干净合入 |
| `1b07c55772` | perf(chat)：翻更早记录直接从响应字节解析 session/page | ❌ 冲突（`packages/dsh_client/lib/src/carrier.dart`，我们改过 client），abort |
| `45c5edbe90` | fix(companion)：她不在当前主机时返回入口按聊天打开那台主机 | ❌ 冲突面 launcher_entries/web_home/system_entry，同 phone #1938 的 companion 链，跳过 |

合入后 HEAD `2dec5465c`。验证：app analyze No issues；chat 相关 246 测试全通过。

剩余 33 候选里未试的：6 个 runtime/patches（改引擎字节，不做定点）、terminal `276d896754`
（perf，非必需）、约 18 个「第八波」chat 流式渲染批量 perf（成批演进、收益边际、互相依赖，
按判据整体 rebase 才拿，不做定点）。**定点搬运到此处收尾**：独立、有价值、无依赖的都进来了。

### 5.4 出包 v92（2026-11-26）

HEAD `e4d79d78c`（含 `565547c0f` + 2 个 chat 优化共 3 个 Dart 改动）已出 v92 并装机：
AOT run `45683254728` 成功（AOT_COMMIT=e4d79d78c）、`check-arkts`/`audit-hap` OK、
HoKit 重签 success、`hdc install -r` 成功，设备侧 `ccchimneyyy.dsh.go / 1.3.0`。
签名包 md5 `90284636055b6ea6158d3ae1f66cde74`，完整记录见 `hap-build/BUILD-v92.txt`。
全链路 `scripts/v92-pipeline.sh`（`PIPELINE_RC=0`），本次 hdc 文件通道正常。

## 6. 整体 merge 可行性预演（2026-11-26，隔离工作树 `probe/merge-main`）

第 3/4 节曾保守判断「整体 rebase 冲突面大、风险高」。用 `git merge-tree --write-tree`
只读预演 + 隔离工作树实做，**推翻该判断**：

- 分叉点 `c9d3c5825`，ours `c38dba28b` / theirs `d73c679c3`。
- **仅 2 个冲突文件**，其余 30+ 全部自动合并：
  1. `.github/workflows/ohos-compile.yml`——上游加了 `workflow_call`/`source_sha`（私有 HAP 构建用）、
     group 与 artifact 名按 source_sha；我们改了 `cancel-in-progress: false`。
     解法：保留上游全部新结构 + `cancel-in-progress: false`。
  2. `packages/dsh_client/lib/src/session_api.dart`——我们加 `HttpClient`/`httpClientFactory`
     构造参数（DoH），上游加 `_decodeLargeAttachment`；改在函数不同位置，
     唯一冲突是两个 import（`dart:io` vs `dart:isolate`），两个都留。
- **坑**：工作树是 sparse-checkout（白名单不含 `tooling/companion`），merge 带入的
  `tooling/companion/offline_http.dart` 进了索引但没落地，`analyze` 报 uri 不存在。
  `git sparse-checkout add tooling` 后消失——评估环境问题，非合并问题。

**验证全绿**：`l10n_merge --check`（9036 keys）、`guide_sync --check`（38 files）、
`flutter analyze` No issues、`test/chat` + `test/state` **3239 全通过**、
`check-arkts --full` OK（0 errors）+ `audit-hap` OK（用 v92 的 AOT 可正常出包）。
改动规模约 126 文件 / +8677−222 行。

**结论**：整体 merge 到 `origin/main` 技术上低代价、可验证通过，能一次性拿到 companion 链、
chat 批量 perf、runtime patches 等所有定点方式拿不到的上游改动。**待决策**：确实要引入这批
大改动吗（含 runtime 运行时字节变化、需重编 runtime + 全量门禁 + 真机验证 + 重新出包）？
预演成果保留在 `probe/merge-main` 工作树，未合回 `port/v71`。

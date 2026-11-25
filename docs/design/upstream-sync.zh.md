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
terminal 和 phone 那两个仍印证上一节的「成批演进」规律，要拿到只能整体 rebase。成果留在
`sync/upstream-1126`，未合回 `port/v71`，等真机出包验证后再决定。

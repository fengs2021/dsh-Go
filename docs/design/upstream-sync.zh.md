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

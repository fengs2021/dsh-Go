# 插件图的 peer 依赖：按 npm 语义解析

2026-11-18。真机 v67 安装 `dsh-mnemon@0.5.44` 报
`ERR_OHOS_PLUGIN_PACKAGE: dsh-mnemon: unsupported non-host peer react`，
本文件记录原因、改法与合并方式。

## 1. 原因

`runtime/ohos/plugins/graph.mjs` 的 `resolveGraph()` 只承认两种 peer 出口：
命中 `hostPackages`（引擎自身安装的包）当作 host edge，
或 `peerDependenciesMeta[name].optional === true` 记为 omitted，
其余一律 `unsupported non-host peer` 硬失败。而 npm 的 peer 语义是
「由消费方树提供，缺了由安装器补齐」，因此两类合法情况被误杀：

1. **web GUI 型 peer**：桌面插件的客户端半边跑在 web GUI 里，web GUI 自带 `react`，
   所以插件声明 `react` / `react-dom` peer。手机 UI 是 Flutter，没有也不该有第二份 react
   （装了反而让 web GUI 的 hooks 失效）。
2. **插件内部互相 peer**：`dsh-mnemon` 的 20 个子包互相声明 peer
   （如 `dsh-mnemon-provider-mem0` peer `dsh-mnemon-source-memory-spaces`）。
   它们本来就是同一次安装的一部分，平铺树里天然满足。

## 2. 改法（只动 `graph.mjs` 一处判定链）

peer 的判定顺序改为：

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | 名字在 `webGuiPeers`（`react`、`react-dom`、`react/jsx-runtime`、`react/jsx-dev-runtime`、`react-dom/client`、`react-dom/server`） | `omitted: 'web GUI peer, absent on OHOS'` |
| 2 | `hostPackages` 提供且版本兼容 | host edge（与原先一致，版本不兼容仍报错） |
| 3 | `peerDependenciesMeta[name].optional === true` | `omitted: 'missing optional peer'` |
| 4 | 注册表能取到（含图内已有同名包） | `{ type: 'package', id }` peer edge，与 npm 一样由安装补齐 |
| 5 | 以上都不成立 | `unsupported non-host peer <name>`（错误码与文案不变） |

细节：

- `webGuiPeers` 判定必须放在 `parseRegistrySpec()` **之前**——
  `react/jsx-runtime` 这种子路径不是注册表 spec，否则会先报 `Unsupported registry spec`。
- 第 4 步用 `visit(request, true)` 以 optional 方式试取，只把
  `ERR_PNPM_FETCH_404` 与「incompatible OHOS arm64 platform」当作「这个 peer 在这里不存在」；
  网络、完整性、锁冲突等失败原样上抛，不被静默吞掉。
- `resolution.mjs` 的 `lookup()` 已经支持 `edge.type === 'package'`
  （`owner.graph.nodes.find(item => item.id === edge.id)`），所以新增的 peer 形态不需要改下游。

## 3. 证据

- `node --test runtime/tests/ohos/plugin-graph.test.mjs` → 17 pass / 0 fail（新增
  「web GUI peers are recorded as absent instead of failing the install」）。
- 全部 `runtime/tests/ohos/plugin-*.test.mjs`：改动前后失败集合逐条比对 **完全相同**（63 条，
  全是需要 OHOS 原生绑定的环境性失败），无新增失败。
- 用真实 npm 元数据离线预演 `resolveGraph('dsh-mnemon@0.5.44')`（hostPackages 取自引擎
  `node_modules/@deepseek-ai/*`）：**41 个节点解析成功**，
  `react`/`react-dom` 记为 web GUI peer，`@deepseek-ai/cordis`0 等走 host edge，
  子包之间的 peer 走 package edge。修复前第一行就抛 `unsupported non-host peer react`。

## 4. 未验证

- 真机安装 `dsh-mnemon` 尚未复跑（该插件在手机端的实际运行行为未验）。
- 第 4 步会把「注册表里有、但没有任何一方提供」的 peer 也装进来；范围语义与 npm 一致，
  但会让少数插件的依赖图变大。`512 个节点的上限`仍然生效。

## 5. 后续基线更新时怎么合

改动刻意收在一个文件（`graph.mjs`）的 peer 判定链 + 一条测试，不掺其它重构：

```sh
git format-patch -1 <commit> --stdout > ohos-plugin-peer-graph.patch
cd <新基线工作树> && git am ohos-plugin-peer-graph.patch
```

若上游先改了这个循环，冲突点只有一处（`for (const [name, range] of Object.entries(fields(manifest, 'peerDependencies')))` 的循环体），
按上表五档顺序重新落一遍即可；`supplyPeer()` 辅助函数与 `webGuiPeers` 常量可整段搬过去。

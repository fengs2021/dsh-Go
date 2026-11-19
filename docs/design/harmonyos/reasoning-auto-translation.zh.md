# 思维链默认翻译（App 侧自动翻译 + 兜底通道）

2026-11-19，用户真机反馈：装上官方 `@deepseek-ai/dsh-experimental-cot-translation-bundle`
（插件详情页里叫「智能体输出时，把展开的"思考"行翻译成你选择的语言」）之后，
**本机引擎和远程服务器都没有任何效果**，希望「默认翻译思维链」。

## 1. 为什么原来没有效果

| 事实 | 证据 |
| --- | --- |
| Flutter 客户端只做「提供一颗胶囊」 | `app/lib/ui/chat/widgets/thinking_pill.dart`：`offered = limits != null && translator != null && reasoningNeedsTranslation(...)` 只决定是否显示 `_TranslateChip`（文案「翻译」）；翻译由用户点它触发 `_start()` |
| 插件的 UI 半边只跑 Web | `@deepseek-ai/dsh-experimental-client-ui-cot-translation/package.json` 的 `dsh.client.platform = "web"`；它给原生客户端留的是宿主侧远程服务 `cotTranslation/limits` 与 `cotTranslation/translate` |
| 官方 Web 客户端的口径也是「展开后才翻」 | 插件 README：「读者展开思考内容后才开始翻译」 |

也就是说：插件装对了、开关也开着，但手机上的 Flutter 界面只是多出一个小胶囊，
不点它永远不会翻译——用户看到的现象就是「没效果」。

## 2. 改法（三处）

### 2.1 默认展开就翻：设置项 `translateReasoning`

`app/lib/state/settings_state.dart`：

- `AppSettings.translateReasoning`（默认 **true**，键 `translate_reasoning`）；
- `setTranslateReasoning(bool)` 写入 SharedPreferences。

`app/lib/ui/chat/widgets/thinking_pill.dart`：`_TranslatableReasoningState.build` 里，
翻译开关打开、当前块还没有翻译控制器、且这次请求会被接受（`offered`）时，
在下一帧自动调用 `_start(limits, translator)`：

- 先画一帧再发请求，首帧不阻塞在 RPC 上；
- `_autoStarted` 保证每块思考只自动发起一次；
- 只要 `holder.controller != null` 就不再自动翻——用户点「查看原文」之后不会被
  下一帧又拉回译文；收起再展开同样保留当前选择。

关掉开关就完全回到上游行为：只显示「翻译」胶囊，点了才翻。

设置页入口：`设置 → 界面 → 对话 → 默认翻译思考过程`
（`app/lib/ui/settings/interface_page.dart`，同时登记在设置索引
`app/lib/ui/settings/index/spots.dart` 的 `Spots.translateReasoning`，
所以搜索与路径也能找到它）。

文案：`hubTranslateReasoning` / `hubTranslateReasoningHint`
（`app/lib/l10n/parts/hub_zh.arb`、`hub_en.arb`，经 `tool/l10n_merge.py` 合并生成，
不要手改 `app_*.arb` 与 `gen/`）。

### 2.2 兜底通道：引擎没有可用翻译时由 App 自己翻

`cotTranslation/limits` 拿不到（插件没装、没启用、宿主太老）时，
`app/lib/state/cot_translation_state.dart` 不再返回 null，而是返回
`localTranslationLimits`（`provider: 'local'`），由 `app/lib/state/local_translation.dart`
的 `BingTranslator` 直接请求那台免登录端点：

```
POST https://edge.microsoft.com/translate/translatetext?to=<lang>&isEnterpriseClient=false
body: ["<fragment>"]
```

——这正是插件默认的 `bing` 服务用的同一个接口（见
`@deepseek-ai/dsh-experimental-translator/lib/index.js` 的 `requestFor()`），
所以有无插件译文口径一致，也不用在手机上再装一份 react。

细节：

- 语言码：`zh` → `zh-Hans`、`zh-tw`/`zh-hant` → `zh-Hant`，其余原样；
- 单片上限 1800 字符（`localTranslationLimits.maxTextChars`），分段逻辑沿用
  `ReasoningTranslation`（按段翻、尾部未完成留原文、按 fragment 缓存）；
- 非 200、空响应、20 秒超时都抛错 → 保留原文并给「重试」；
- `localTranslatorProvider` 是这一层的接缝：测试或「不许外呼」的构建把它置 null，
  `cotTranslationProvider` 随之不再提供翻译。

## 3. 验证（本机）

| 内容 | 结果 |
| --- | --- |
| `flutter test test/agents/thinking_translate_auto_test.dart` | 2 pass（默认开：展开即翻、只发一次、切回原文后收起再展开不重发；关：只显示胶囊、不发请求） |
| `flutter test test/agents/thinking_translate_test.dart` | 10 pass（既有手动路径 8 例 + 4 张 golden 不变） |
| `flutter test test/state/cot_translation_fallback_test.dart` | 5 pass（请求构造、多段拼接、错误抛错、语言码、无插件时走兜底、本地 limits 走本地通道） |
| `flutter test test/chat/thinking_collapse_test.dart test/settings/index/index_sync_test.dart` | 27 pass |
| `flutter test test/settings/settings_ia_golden_test.dart` | 10 pass（界面页新增一行，golden 已按新布局更新） |
| `flutter analyze --no-pub` | No issues found |

## 4. 未验证

- **真机**：本次未装机（设备离线），「展开就翻」在 HAP 里的实际观感、以及手机上
  直连 `edge.microsoft.com` 是否稳定，都待真机确认。
- 中国大陆网络对 `edge.microsoft.com` 的连通性本机实测可用（WSL 直连 HTTP 200），
  但手机走移动网络/公司 Wi-Fi 的结果未验证；失败时界面保留原文并给「重试」。
- 网页模式（`UiMode.web`）的思考区是 Web 客户端自己的实现，本次只改了 Flutter 侧。

## 5. 后续基线更新时怎么合

三处改动互不依赖，可整段搬：

1. `app/lib/state/settings_state.dart`：一个字段 + 一个键 + `copyWith` + 一个 setter；
2. `app/lib/ui/chat/widgets/thinking_pill.dart`：`_autoStarted` 字段 + `build` 里那段
   auto-start（依赖 `settingsProvider.select`）；冲突点只在 `build` 开头几行；
3. `app/lib/state/cot_translation_state.dart` + 新文件 `local_translation.dart`：
   `cotTranslationProvider` 的兜底返回值与 `reasoningTranslatorProvider` 的分流。

补丁：`patches/ohos-reasoning-auto-translation.patch`（`git format-patch -1 <sha> --stdout`）。

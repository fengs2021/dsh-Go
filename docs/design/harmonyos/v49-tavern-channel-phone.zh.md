# v49 酒馆 · 渠道连接（这台手机）〔2026-11-15〕

## 1. 现象

v47/v48 让舞台的「模型」行能列出并选中 **设置 › 模型服务** 的自定义渠道，但真正生成时
一定失败，而且提示误导：

- 点「接着写」只弹 **「先在设置里填 DeepSeek API Key」**（`tavernErrorNoKey`），
  既没提渠道名，也不说这个渠道在 设置 里其实「已保存」。
- 舞台模型行显示 `WB Proxy · hy4-preview`，酒馆「我的」页也选好了自定义渠道，
  看起来一切就绪。

## 2. 根因（两层，缺一不可）

1. **密钥不在手机上。** `lib/state/provider_keys.dart` 的类注释就写着：连远程主机时
   输入的 Key 只进那台主机，「are never kept here」。`tavern_provider.dart` 却从
   手机本地 vault 取 key，取不到 → `TavernFailure.noKey`。
2. **地址在手机上不通。** `TavernModelConfig.baseUrl` 用的是渠道自己声明的
   `http://127.0.0.1:9100/v1`；酒馆由 `llm/model_client.dart` **从手机直连**，
   手机上的 127.0.0.1 就是手机自己。

再加一处**发送前守卫**：`tavern_chat_page.dart` 只要 `settingsProvider.hasApiKey` 为假
就跳 DeepSeek 密钥页 —— 选了渠道也照跳。这就是误导文案的真凶。

## 3. 为什么不做「主机代发」（方案 A 被否）

原本想的是「酒馆请求经已连接的主机引擎中转，Key 与网络都在主机侧」。取证后否掉了：

- 经中转的连接由 `ds-harness-remote/dist/harness-remote-bridge.js` 转发，
  `HARNESS_REMOTE_ALLOWLIST` 是**硬编码白名单**（约 110 个端点），`assertAllowed()`
  拒绝一切不在表里的端点（`METHOD_NOT_ALLOWED`）；插件的 HTTP 路由同样只有
  `PLUGIN_ROUTE_ALLOWLIST = ['api/bot','api/session/uploadFileBinary']`。
- 宿主 `llm` 命名空间只有 `discoverModels/listProviders/listConfigurableProviders`，
  **没有任何「跑一次补全」的端点**；`commands/execute` 是会话+agent 作用域的一次性
  结果，不适合流式。
- 要开只能 fork 第三方包并重启 `dsh web`（杀掉当前会话）。

而用户这台机器的渠道本来就 **LAN 可达**：WB Proxy 监听 `0.0.0.0:9100`（LAN MODE），
`curl -H 'Authorization: Bearer <面板 key>' http://192.168.2.230:9100/v1/models`
→ `200`、列出 21 个模型。所以只差「手机上填地址 + 手机上填 key」。

## 4. 修法 A′：酒馆从这台手机直连渠道

| 位置 | 改动 |
| --- | --- |
| `lib/tavern/tavern_channel_connection.dart`（新） | `TavernChannelKeys`（Keystore 前缀 `tavern_channel_key_<route>`，**只给酒馆用，绝不推给任何引擎**）、`SecureTavernChannelKeys`、`tavernChannelKey(ref, route)`（先本机键入、再 provider vault）、`tavernChannelKeyFrom(keys, vault, route)`（给 widget 用）、`tavernChannelModelsUri(baseUrl)`、`tavernChannelLoopback(baseUrl)`、`probeTavernChannel({baseUrl, key})`（GET /models，带 Bearer，20 s 超时） |
| `lib/tavern/tavern_settings.dart` | `TavernSettings.channelBaseUrls`（`Map<String,String>`）+ `channelBaseUrl(route)`；偏好键 `tavern.channelBaseUrl.<route>`；`setChannelBaseUrl(route, url)`（空 → 清）；`tavernProviderKeyStoredProvider` 改查 `tavernChannelKey` |
| `lib/tavern/tavern_provider.dart` | `apiKey: () => tavernChannelKey(ref, provider.id)`；`baseUrl: settings.channelBaseUrl(provider.id) ?? provider.baseUrl` |
| `lib/ui/tavern/tavern_channel_sheet.dart`（新） | 「渠道连接」弹层：地址（留空 = 渠道自己的）、密钥（obscure）、**测试连接**、保存、恢复渠道默认 |
| `lib/ui/tavern/tavern_settings_page.dart` | 「我的」页渠道组多了 `tavern-provider-address` 行；「渠道密钥」行改开这个弹层（不再跳 ProvidersPage）；地址是回环时追加红色说明 `tavern-provider-address-warning` |
| `lib/ui/tavern/tavern_chat_page.dart` | 发送前守卫、`_speak`、失败卡片动作都改走 `_keyMissingNow()` / `_keyAction()`：有渠道 → 开「渠道连接」，官方 → 开 DeepSeek 密钥页；`TavernFailure.noKey` 按来源给 `tavernErrorChannelNoKey` 或 `tavernErrorNoKey`；输入框占位与「没有 key」提示条按渠道判断 |
| `lib/l10n/parts/tavern_{zh,en}.arb` | 新增 13 个键（连接地址 / 渠道默认 / 测试连接 / 连接正常 · 列出 {count} 个模型 / 连不上：{message} / 恢复渠道默认 / 渠道连接 / 回环警告 / 渠道无密钥 …），`tool/l10n_merge.py` 重新生成 |

关键取舍：**酒馆的渠道 key 不写 provider vault**。vault 的语义是「缺失时补回本机引擎」
（`healProviderKeys`），把「手机直连用的 key」放进去会让它被推进某台引擎；所以另开一套
前缀，引擎永远看不到。

## 5. 证据

- `flutter analyze`：改动文件 0 error 0 warning（全项目仅剩 18 条既有 info）。
- `flutter test test/tavern/tavern_channel_connection_test.dart`：**14 pass**
  （地址拼接 / 回环判定 / 401 → `HTTP 401` / 传输异常不抛 / 非 URL 不拨号 /
  本机键入优先于 vault / vault 兜底 / 两处都空 → null / 安全存储抛错仍读 vault /
  每渠道地址写入-清空-下次启动读回 / copyWith 携带）。
- `flutter test test/tavern`：**530 pass**（v48 为 516）。
- 宿主侧可达性（面板 key 不落盘、不回显）：
  `GET http://192.168.2.230:9100/v1/models` → `200`，21 个模型
  （`hy4-preview-f`、`hy3`、`deepseek-v4.1-flash`、`glm-5.3` …）。

## 6. 边界

- 不做主机代发（理由见 §3）；不做渠道 key 的「在主机上安装」引导。
- 弹层只判可达与鉴权（GET /models），不校验所选模型是否存在；模型清单仍来自宿主
  声明的 `provider.models`。
- 手机上填的地址/密钥只影响酒馆的调用，设置 › 模型服务 里的渠道定义不变。

## 7. 真机验证 recipe（v49）

1. 酒馆 › 我的 › 渠道连接 → 地址填 `http://192.168.2.230:9100/v1`，密钥填 WB Proxy
   面板 key → **测试连接** 应显示 `连接正常 · 列出 21 个模型` → 保存。
2. 舞台 › 本局 › 模型 选 `WB Proxy · hy3`（`hy4-preview` 不在代理的模型表里）。
3. 发一句 → 应有流式回复，用量行显示该模型的 tokens。
4. 回滚：渠道连接 › 恢复渠道默认（清地址与 key）。

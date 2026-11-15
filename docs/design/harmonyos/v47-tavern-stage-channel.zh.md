# v47：酒馆舞台的「模型」行也能选自定义渠道（2026-11-15）

用户原话：「linux 可以了。酒馆的舞台也要能显示设置里面的自定义渠道。」

## 1. 现象与根因

- 「酒馆 › 我的」页早就支持「模型来源：官方 DeepSeek / 自定义渠道」，并给出渠道、渠道模型、渠道密钥三行（v42 做过，见 [v42-engine-rc3-and-tavern-channel.zh.md](v42-engine-rc3-and-tavern-channel.zh.md) §4）。
- 但同一份设置的另一个入口——**舞台面板 › 本局 › 正在用 › 模型**——只有一颗两段胶囊（`SettingsSegmentTile<String>` + `tavernModels`），永远只显示 Flash / V4 Pro，哪怕当前来源已经是自定义渠道。用户在舞台里既看不见渠道，也没法在那里换渠道。
- 根因是两处 UI 各自写了一份「模型」选择逻辑：
  - `app/lib/ui/tavern/tavern_settings_page.dart`（我的）按 `settings.providerRoute` 分支：官方给胶囊，自定义给渠道三行；
  - `app/lib/ui/tavern/tavern_stage_panel.dart`（舞台）无条件渲染官方胶囊。

## 2. 改法：舞台一行、一张清单，两个来源并列

新增 `app/lib/ui/tavern/tavern_model_picker.dart`：

| 导出 | 作用 |
| --- | --- |
| `tavernChannels(snapshot)` | 「设置 · 模型服务」里**能用的**渠道：OpenAI 兼容（Chat Completions）且至少列了一个模型。别的协议不进清单，与 `tavernModelSourceNote` 的说明一致。 |
| `tavernChannelModels(channel)` | 该渠道列出的模型 id。 |
| `tavernChannelModel(settings, channel)` | 这次调用实际用的模型：选中的那个（渠道仍列着才算），否则渠道第一个（引擎的默认）。 |
| `tavernChannelOf(settings, snapshot)` | `settings.providerRoute` 指向的渠道；官方来源或清单还在加载时为 null。 |
| `tavernModelChoiceLabel(context, settings, channel)` | 行尾那行字：官方是「Flash」/「V4 Pro」，渠道是「WB Proxy · hy4-preview」。 |
| `showTavernModelPicker(context)` | 底部弹层：一组「官方 DeepSeek」（Flash / V4 Pro），每个渠道一组（渠道名作组标题，组内是该渠道的模型）；没有可用渠道时给出 `tavernProviderNoChannels` 的去处说明。 |

- 点官方模型：`setProviderRoute(null)` → `setModel(id)`（先把来源切回官方，再选模型）。
- 点渠道模型：`setProviderRoute(channel.id)`（只在换渠道时）→ `setProviderModel(id)`，一次点到「哪个渠道的哪个模型」。
- 舞台面板的「模型」行改成普通行（`SettingsTile` + 右侧当前值 + 点开清单），键仍是 `tavern-session-model`，与其它行走同一套交互；正在生成（`busy`）时不可点。
- 选中渠道但**渠道密钥没填**时，这一段下面带一行 `tavernProviderKeyMissing`（「未填，去「模型服务」填」），免得下一次回复才失败。这份密钥只在 App 的「设置 · 模型服务」表单录入、且走本机引擎时读得到。

## 3. 证据

- `cd port40/app && flutter analyze` → 改动文件 0 issue；全项目仅 18 条既有 info（`lib/runtime/ohos_linux_runtime.dart` 与一个测试的 `print`）。
- `flutter test test/tavern/tavern_stage_test.dart` → **8 通过**，新增两例：
  - 「the 模型 row also offers 模型服务 channels, and picking one keeps its model」：注入一个 OpenAI 兼容渠道（WB Proxy：hy4-preview、hy4-pro）与一个 Anthropic 渠道，断言清单里只有前者；点 hy4-pro 后 `tavern.providerRoute=custom-wb`、`tavern.providerModel=hy4-pro`，行尾显示「WB Proxy · hy4-pro」；再点官方 Flash 后 route 清空、行尾回到「Flash」。
  - 「with no channel to pick, the picker says where they come from」：没有渠道时清单仍列官方两项，并提示去「模型服务」添加。
- `flutter test test/tavern`（全部）→ **516 通过**（v42 时 514，多出的 2 例即上面两例）。

## 4. 边界

- 舞台只读「设置 · 模型服务」，不在这里新建/改渠道；渠道本身仍由「模型服务」页管理。
- 渠道清单来自引擎（`customProvidersProvider`），引擎未连上时清单为空——此时只列官方两项，与「我的」页一致。
- 费用与用量仍按 DeepSeek 官方价估算，自定义渠道的仅供参考（`tavernModelSourceNote`）。

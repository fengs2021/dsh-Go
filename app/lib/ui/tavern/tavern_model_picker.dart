// 舞台「模型」这一行的选择器 (docs/design/roleplay-ui.md §8). One list holds
// both sources: the official DeepSeek models, and the custom channels 设置 ·
// 模型服务 declares — the same pick the 我的 page's 模型来源 makes, only here
// it is one tap to "that channel's that model" instead of source-then-model.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import '../../state/providers_state.dart';
import '../../tavern/tavern_settings.dart';
import '../common/app_sheet.dart';
import '../common/sheet_title_bar.dart';
import '../settings/settings_widgets.dart';
import '../theme/app_icons.dart';
import '../theme/theme.dart';

/// The custom channels the tavern can run on: the 模型服务 routes that speak
/// OpenAI Chat Completions and list at least one model, which is all the
/// tavern's one transport can use (tavernModelSourceNote says the rest).
List<CustomProvider> tavernChannels(ProvidersSnapshot? snapshot) => [
  for (final provider in snapshot?.providers ?? const <CustomProvider>[])
    if (provider.api == ProviderApi.openaiCompletions && provider.models.isNotEmpty) provider,
];

/// The model ids [channel] lists, in the order the engine has them.
List<String> tavernChannelModels(CustomProvider? channel) => [
  for (final spec in channel?.models ?? const <ProviderModelSpec>[]) spec.id,
];

/// The model of [channel] these calls go to: the one chosen while the channel
/// still lists it, else the channel's first (what the engine would pick).
String? tavernChannelModel(TavernSettings settings, CustomProvider? channel) {
  final models = tavernChannelModels(channel);
  final chosen = settings.providerModel;
  if (chosen != null && models.contains(chosen)) return chosen;
  return models.isEmpty ? null : models.first;
}

/// The channel [TavernSettings.providerRoute] names, while the engine still
/// declares it. Null for the official endpoint, and while the list loads.
CustomProvider? tavernChannelOf(TavernSettings settings, ProvidersSnapshot? snapshot) {
  final route = settings.providerRoute;
  if (route == null) return null;
  for (final provider in snapshot?.providers ?? const <CustomProvider>[]) {
    if (provider.id == route) return provider;
  }
  return null;
}

/// What the stage's 模型 row says: 「Flash」/「V4 Pro」 for the official endpoint,
/// or 「WB Proxy · hy4-preview」 for a channel.
String tavernModelChoiceLabel(BuildContext context, TavernSettings settings, CustomProvider? channel) {
  final l10n = context.l10n;
  final route = settings.providerRoute;
  if (route == null) {
    return settings.model == tavernModels[1] ? l10n.tavernModelPro : l10n.tavernModelFlash;
  }
  // The route id is the honest fallback: the channel list may still be
  // loading, or the route may have gone from 模型服务 since it was chosen.
  final name = channel?.displayName ?? route;
  final model = tavernChannelModel(settings, channel) ?? l10n.tavernProviderModelNone;
  return '$name · $model';
}

/// Picks what this chat runs on, from both sources at once.
Future<void> showTavernModelPicker(BuildContext context) => showAppSheet<void>(
  context,
  builder: (sheet) => Consumer(
    builder: (inner, ref, _) {
      final l10n = inner.l10n;
      final settings = ref.watch(tavernSettingsProvider);
      final controller = ref.read(tavernSettingsProvider.notifier);
      final async = ref.watch(customProvidersProvider);
      final channels = tavernChannels(async.value);
      final route = settings.providerRoute;

      Widget tick(bool on) => on
          ? Icon(AppIcons.selected, size: 18, color: Theme.of(inner).colorScheme.primary)
          : const SizedBox.shrink();

      /// The sheet closes first: the write lands on the row behind it.
      void choose(Future<void> Function() write) {
        Navigator.of(sheet).pop();
        unawaited(write());
      }

      return SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SheetTitleBar(l10n.tavernSettingsModel),
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    SheetGroup(
                      title: l10n.tavernModelSourceOfficial,
                      margin: const EdgeInsets.fromLTRB(SheetTitleBar.inset, 0, SheetTitleBar.inset, 12),
                      children: [
                        for (final (index, id) in tavernModels.indexed)
                          SettingsTile(
                            key: ValueKey('tavern-model-official-$id'),
                            icon: AppIcons.model,
                            tinted: false,
                            title: index == 0 ? l10n.tavernModelFlash : l10n.tavernModelPro,
                            value: tick(route == null && settings.model == id),
                            chevron: false,
                            onTap: () => choose(() async {
                              await controller.setProviderRoute(null);
                              await controller.setModel(id);
                            }),
                          ),
                      ],
                    ),
                    for (final provider in channels)
                      SheetGroup(
                        key: ValueKey('tavern-model-channel-${provider.id}'),
                        title: provider.displayName,
                        margin: const EdgeInsets.fromLTRB(SheetTitleBar.inset, 0, SheetTitleBar.inset, 12),
                        children: [
                          for (final id in tavernChannelModels(provider))
                            SettingsTile(
                              key: ValueKey('tavern-model-channel-${provider.id}-$id'),
                              icon: AppIcons.modelItem,
                              tinted: false,
                              title: id,
                              value: tick(route == provider.id && tavernChannelModel(settings, provider) == id),
                              chevron: false,
                              onTap: () => choose(() async {
                                if (route != provider.id) await controller.setProviderRoute(provider.id);
                                await controller.setProviderModel(id);
                              }),
                            ),
                        ],
                      ),
                    if (channels.isEmpty && !async.isLoading)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(SheetTitleBar.inset + 12, 0, SheetTitleBar.inset + 12, 16),
                        child: Text(
                          l10n.tavernProviderNoChannels,
                          style: Theme.of(inner).textTheme.bodySmall?.copyWith(
                            color: DshColors.of(inner).textTertiary,
                            height: 1.5,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      );
    },
  ),
);

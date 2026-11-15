// 渠道连接（这台手机）: the tavern dials a 自定义渠道 straight from this phone,
// so what it dials is not always what the host stored — a channel declared on a
// desktop may point at that machine's loopback (127.0.0.1), and the key that
// unlocks it may live only there. This sheet keeps, for one channel, the address
// to dial from here and the key to send with it (tavern_channel_connection.dart)
// and probes the pair before anything is generated.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import '../../state/provider_keys.dart';
import '../../state/providers_state.dart';
import '../../tavern/tavern_channel_connection.dart';
import '../../tavern/tavern_settings.dart';
import '../common/app_sheet.dart';
import '../common/sheet_title_bar.dart';
import '../engine_settings/field_sheets.dart' show SheetCard;
import '../theme/theme.dart';

Future<void> showTavernChannelSheet(BuildContext context, {required String route}) => showAppSheet<void>(
  context,
  isScrollControlled: true,
  builder: (_) => TavernChannelSheet(route: route),
);

class TavernChannelSheet extends ConsumerStatefulWidget {
  const TavernChannelSheet({super.key, required this.route});

  /// The channel route (模型服务's llm-pi-ai id) this connection is for.
  final String route;

  @override
  ConsumerState<TavernChannelSheet> createState() => _TavernChannelSheetState();
}

class _TavernChannelSheetState extends ConsumerState<TavernChannelSheet> {
  late final TextEditingController _address = TextEditingController(
    text: ref.read(tavernSettingsProvider).channelBaseUrl(widget.route) ?? '',
  );
  final _key = TextEditingController();
  TavernChannelProbe? _probe;
  var _probing = false;

  @override
  void dispose() {
    _address.dispose();
    _key.dispose();
    super.dispose();
  }

  /// What would be dialled with what is typed: the field's address, or the
  /// channel's own while it is empty.
  String get _url {
    final typed = _address.text.trim();
    if (typed.isNotEmpty) return typed;
    return ref.read(customProvidersProvider).value?.byId(widget.route)?.baseUrl ?? '';
  }

  Future<void> _probeNow() async {
    setState(() => _probing = true);
    final typed = _key.text.trim();
    final key = typed.isNotEmpty
        ? typed
        : await tavernChannelKeyFrom(
            ref.read(tavernChannelKeysProvider),
            ref.read(providerKeyVaultProvider),
            widget.route,
          );
    final probe = await probeTavernChannel(baseUrl: _url, key: key);
    if (!mounted) return;
    setState(() {
      _probing = false;
      _probe = probe;
    });
  }

  Future<void> _save() async {
    await ref.read(tavernSettingsProvider.notifier).setChannelBaseUrl(widget.route, _address.text);
    final key = _key.text.trim();
    if (key.isNotEmpty) await ref.read(tavernChannelKeysProvider).write(widget.route, key);
    ref.invalidate(tavernProviderKeyStoredProvider(widget.route));
    if (mounted) Navigator.of(context).pop();
  }

  Future<void> _reset() async {
    await ref.read(tavernSettingsProvider.notifier).setChannelBaseUrl(widget.route, null);
    try {
      await ref.read(tavernChannelKeysProvider).delete(widget.route);
    } catch (_) {
      // No secure storage: nothing was stored here anyway.
    }
    ref.invalidate(tavernProviderKeyStoredProvider(widget.route));
    if (!mounted) return;
    setState(() {
      _address.clear();
      _key.clear();
      _probe = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final dsh = DshColors.of(context);
    final channel = ref.watch(customProvidersProvider).value?.byId(widget.route);
    final probe = _probe;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SheetTitleBar(l10n.tavernChannelPhone),
              Padding(
                padding: const EdgeInsets.fromLTRB(SheetTitleBar.inset, 0, SheetTitleBar.inset, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    SheetCard(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Padding(
                            padding: const EdgeInsets.only(top: 12, bottom: 4),
                            child: Text(
                              channel?.displayName ?? widget.route,
                              key: const ValueKey('tavern-channel-name'),
                              style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
                            ),
                          ),
                          TextField(
                            key: const ValueKey('tavern-channel-address-field'),
                            controller: _address,
                            keyboardType: TextInputType.url,
                            autocorrect: false,
                            enableSuggestions: false,
                            decoration: InputDecoration(
                              labelText: l10n.tavernChannelAddress,
                              hintText: channel?.baseUrl,
                              helperText: l10n.tavernChannelAddressHint,
                              helperMaxLines: 2,
                            ),
                          ),
                          const SizedBox(height: 8),
                          TextField(
                            key: const ValueKey('tavern-channel-key-field'),
                            controller: _key,
                            obscureText: true,
                            autocorrect: false,
                            enableSuggestions: false,
                            decoration: InputDecoration(
                              labelText: l10n.tavernProviderKey,
                              hintText: l10n.tavernChannelKeyHint,
                              helperText: l10n.tavernChannelNote,
                              helperMaxLines: 3,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (probe != null)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
                        child: Text(
                          probe.ok
                              ? l10n.tavernChannelProbeOk(probe.models.length)
                              : l10n.tavernChannelProbeFailed(probe.message ?? ''),
                          key: const ValueKey('tavern-channel-probe-result'),
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: probe.ok ? theme.colorScheme.primary : dsh.textTertiary,
                            height: 1.5,
                          ),
                        ),
                      ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            key: const ValueKey('tavern-channel-probe'),
                            onPressed: _probing ? null : () => unawaited(_probeNow()),
                            child: Text(l10n.tavernChannelProbe),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: FilledButton(
                            key: const ValueKey('tavern-channel-save'),
                            onPressed: () => unawaited(_save()),
                            child: Text(l10n.tavernChannelSave),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    TextButton(
                      key: const ValueKey('tavern-channel-reset'),
                      onPressed: () => unawaited(_reset()),
                      child: Text(l10n.tavernChannelReset),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

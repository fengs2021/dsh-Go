// The app's one [Tavern]: the engine (packages/dsh_tavern) opened on
// `<app support>/tavern`. It opens asynchronously, so the screens get a
// [DeferredTavern] that queues calls until it is ready. It follows 酒馆设置
// and reads the key of whichever model source it names (the app's DeepSeek
// key, or a custom channel's) on every call; the key is never stored by the
// engine. Tests swap in the preview stand-in (tavern_preview.dart).

import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../state/provider_keys.dart';
import '../state/providers_state.dart';
import '../state/settings_state.dart';
import 'deferred_tavern.dart';
import 'tavern_script_host.dart';
import 'tavern_settings.dart';

final tavernProvider = Provider<Tavern>((ref) {
  final tavern = DeferredTavern(() async {
    final support = await getApplicationSupportDirectory();
    return openTavern('${support.path}/tavern');
  }());
  ref.onDispose(tavern.close);
  void configure(TavernSettings settings) => tavern.configure(tavernModelConfig(ref, settings));
  configure(ref.read(tavernSettingsProvider));
  ref.listen(tavernSettingsProvider, (previous, next) => configure(next));
  // The channels and the models they list are the engine's: a reload (a
  // channel edited in 模型服务, the list arriving after start) re-points the
  // calls, and the settings page's pickers read the same list.
  ref.listen(customProvidersProvider, (previous, next) => configure(ref.read(tavernSettingsProvider)));
  return tavern;
});

/// Where 酒馆设置 sends the calls: the official DeepSeek endpoint with the app's
/// own key, or one of the user's custom channels (自定义渠道, 模型服务).
///
/// A channel is used only when it speaks OpenAI Chat Completions (the one
/// transport llm/model_client.dart speaks) and lists at least one model. While
/// the channel list is not read back yet (engine offline, still loading) the
/// official endpoint stands in, rather than a half-configured call. Its key is
/// this phone's copy (provider_keys.dart); with none the call fails
/// TavernFailure.noKey before anything is sent, and 酒馆设置 says where to type
/// it. 费用/用量 estimates stay DeepSeek's list prices.
TavernModelConfig tavernModelConfig(Ref ref, TavernSettings settings) {
  final route = settings.providerRoute;
  final provider = route == null ? null : ref.read(customProvidersProvider).value?.byId(route);
  if (provider == null || provider.api != ProviderApi.openaiCompletions || provider.models.isEmpty) {
    return _officialModelConfig(ref, settings);
  }
  final models = [for (final model in provider.models) model.id];
  final chosen = settings.providerModel;
  return TavernModelConfig(
    apiKey: () async {
      final key = (await _providerKeys(ref))[provider.id]?.trim() ?? '';
      return key.isEmpty ? null : key;
    },
    baseUrl: provider.baseUrl,
    model: chosen != null && models.contains(chosen) ? chosen : models.first,
    // Only DeepSeek's own host takes its thinking field and /beta endpoint; a
    // channel proxying DeepSeek is still an ordinary OpenAI endpoint.
    deepseek: provider.host == 'api.deepseek.com',
    thinking: settings.thinking,
    headers: provider.headers,
  );
}

TavernModelConfig _officialModelConfig(Ref ref, TavernSettings settings) => TavernModelConfig(
  apiKey: () async {
    final key = ref.read(settingsProvider).apiKey.trim();
    return key.isEmpty ? null : key;
  },
  model: settings.model,
  thinking: settings.thinking,
);

Future<Map<String, String>> _providerKeys(Ref ref) async {
  try {
    return await ref.read(providerKeyVaultProvider).readAll();
  } catch (_) {
    // No secure storage (a test, a platform without it): no key, then.
    return const {};
  }
}

/// The app's host for card scripts, one per tavern: what the engine delivers
/// to a canvas page's script context goes to that page.
final tavernScriptPagesProvider = Provider<TavernScriptPages>((ref) {
  ref.watch(tavernProvider);
  return TavernScriptPages();
});

/// Every character, as the library lists them.
final tavernCharactersProvider = StreamProvider<List<TavernCharacter>>(
  (ref) => ref.watch(tavernProvider).watchCharacters(),
);

/// One character in full. The list carries only what a card in the grid
/// shows; greetings, the definition and the creator's notes come from here,
/// read again whenever the list changes (an edit, a re-import).
final tavernCharacterDetailProvider = FutureProvider.autoDispose.family<TavernCharacter?, String>((ref, id) {
  ref.watch(tavernCharactersProvider);
  return ref.watch(tavernProvider).character(id);
});

/// Chats, newest first; one character's when the argument is its id.
final tavernChatsProvider = StreamProvider.family<List<TavernChatSummary>, String?>(
  (ref, characterId) => ref.watch(tavernProvider).watchChats(characterId: characterId),
);

/// Saved personas (人设).
final tavernPersonasProvider = StreamProvider<List<TavernPersona>>((ref) => ref.watch(tavernProvider).watchPersonas());

/// Who you are in a chat (null: outside any chat, just the default). Read
/// again whenever the personas notify, which default and binding changes do.
final tavernPersonaSelectionProvider = FutureProvider.family<PersonaSelection, String?>((ref, chatId) {
  ref.watch(tavernPersonasProvider);
  return ref.watch(tavernProvider).personaSelection(chatId: chatId);
});

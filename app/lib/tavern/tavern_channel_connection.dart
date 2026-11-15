// 渠道连接（这台手机）: the tavern calls a 自定义渠道 (模型服务) straight from
// this phone, so what it dials is not always what the host stored — a channel
// declared on a desktop may point at that machine's own loopback (127.0.0.1),
// which on a phone is the phone itself, and the key that unlocks it may live
// only in that machine's credential store. This keeps, per channel, the address
// to dial from here and the key to send with it, both on this phone alone and
// never pushed to any engine (unlike provider_keys.dart, whose copies are put
// back into a local engine).

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import '../secrets/secure_storage.dart';
import '../state/provider_keys.dart';

/// A channel's key as typed on this phone, in the Keystore-backed storage
/// under `tavern_channel_key_<route>`. It is the tavern's own credential: no
/// engine ever sees it.
abstract class TavernChannelKeys {
  static const prefix = 'tavern_channel_key_';

  Future<Map<String, String>> readAll();

  Future<String?> read(String route);

  Future<void> write(String route, String key);

  Future<void> delete(String route);
}

class SecureTavernChannelKeys implements TavernChannelKeys {
  const SecureTavernChannelKeys([this._injected]);

  final FlutterSecureStorage? _injected;
  AppSecureStorage get _storage => AppSecureStorage(_injected);

  @override
  Future<Map<String, String>> readAll() async {
    final all = await _storage.readAll();
    return {
      for (final entry in all.entries)
        if (entry.key.startsWith(TavernChannelKeys.prefix) && entry.value.isNotEmpty)
          entry.key.substring(TavernChannelKeys.prefix.length): entry.value,
    };
  }

  @override
  Future<String?> read(String route) async {
    final value = await _storage.read(key: '${TavernChannelKeys.prefix}$route');
    return (value ?? '').trim().isEmpty ? null : value!.trim();
  }

  @override
  Future<void> write(String route, String key) =>
      _storage.write(key: '${TavernChannelKeys.prefix}$route', value: key.trim());

  @override
  Future<void> delete(String route) => _storage.delete(key: '${TavernChannelKeys.prefix}$route');
}

final tavernChannelKeysProvider = Provider<TavernChannelKeys>((ref) => const SecureTavernChannelKeys());

/// The key to send with [route] from this phone: the one typed here, else the
/// vault's copy (a channel key typed in the app while the **local** engine was
/// active). Null when neither has one.
Future<String?> tavernChannelKey(Ref ref, String route) => _channelKey(
  route,
  () => ref.read(tavernChannelKeysProvider).readAll(),
  () => ref.read(providerKeyVaultProvider).readAll(),
);

/// [tavernChannelKey] from the two stores themselves, for a widget that has
/// already read them.
Future<String?> tavernChannelKeyFrom(TavernChannelKeys keys, ProviderKeyVault vault, String route) =>
    _channelKey(route, keys.readAll, vault.readAll);

Future<String?> _channelKey(
  String route,
  Future<Map<String, String>> Function() typed,
  Future<Map<String, String>> Function() vault,
) async {
  try {
    final key = (await typed())[route]?.trim() ?? '';
    if (key.isNotEmpty) return key;
  } catch (_) {
    // No secure storage (a test, a platform without it): nothing typed here.
  }
  try {
    final key = (await vault())[route]?.trim() ?? '';
    return key.isEmpty ? null : key;
  } catch (_) {
    return null;
  }
}

/// `{base}/models`: the channel's own list, the cheapest probe its protocol
/// answers without a prompt. A base URL that already names the endpoint (as
/// the tavern accepts) is trimmed back to the root first.
Uri tavernChannelModelsUri(String baseUrl) {
  var base = baseUrl.trim();
  while (base.endsWith('/')) {
    base = base.substring(0, base.length - 1);
  }
  const chat = '/chat/completions';
  if (base.endsWith(chat)) base = base.substring(0, base.length - chat.length);
  while (base.endsWith('/')) {
    base = base.substring(0, base.length - 1);
  }
  return Uri.parse('$base/models');
}

/// Whether [baseUrl] names this machine itself (127.0.0.1, localhost, ::1,
/// 0.0.0.0): an address a phone can only dial to itself, which is what a
/// channel declared on a desktop usually has.
bool tavernChannelLoopback(String baseUrl) {
  final host = Uri.tryParse(baseUrl.trim())?.host.toLowerCase() ?? '';
  return host == '127.0.0.1' || host == 'localhost' || host == '::1' || host == '0.0.0.0';
}

/// What one probe of a channel from this phone came back with.
class TavernChannelProbe {
  const TavernChannelProbe.connected(this.models) : message = null;

  const TavernChannelProbe.failed(this.message) : models = const [];

  /// The model ids the channel listed (empty when it failed).
  final List<String> models;

  /// Why it failed, in the words of the transport or the status line.
  final String? message;

  bool get ok => message == null;
}

/// Asks [baseUrl] for its models from this phone: the one request that says
/// whether the address is reachable, the key is accepted and the protocol is
/// the OpenAI one the tavern speaks.
Future<TavernChannelProbe> probeTavernChannel({
  required String baseUrl,
  String? key,
  http.Client Function()? clientFactory,
  Duration timeout = const Duration(seconds: 20),
}) async {
  final Uri uri;
  try {
    uri = tavernChannelModelsUri(baseUrl);
    if (!uri.hasScheme || uri.host.isEmpty) return const TavernChannelProbe.failed('invalid url');
  } on FormatException {
    return const TavernChannelProbe.failed('invalid url');
  }
  final client = (clientFactory ?? http.Client.new)();
  try {
    final response = await client
        .get(uri, headers: {if ((key ?? '').isNotEmpty) 'Authorization': 'Bearer $key'})
        .timeout(timeout);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return TavernChannelProbe.failed('HTTP ${response.statusCode}');
    }
    final body = jsonDecode(utf8.decode(response.bodyBytes, allowMalformed: true));
    final data = body is Map ? body['data'] : null;
    return TavernChannelProbe.connected([
      for (final item in data is List ? data : const <Object?>[])
        if (item is Map && item['id'] is String) item['id'] as String,
    ]);
  } catch (error) {
    return TavernChannelProbe.failed('$error');
  } finally {
    client.close();
  }
}

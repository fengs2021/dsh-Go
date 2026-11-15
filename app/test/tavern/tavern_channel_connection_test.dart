// 渠道连接 (tavern_channel_connection.dart): what a phone dials for one 自定义
// channel, the key it sends, and the one request that says whether the pair
// works — the tavern calls a channel straight from the phone, so the address a
// desktop stored (often its own loopback) is not always one a phone can reach.

import 'dart:convert';

import 'package:dsh_app/state/provider_keys.dart';
import 'package:dsh_app/tavern/tavern_channel_connection.dart';
import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Keys implements TavernChannelKeys {
  _Keys([this.stored = const {}]);

  final Map<String, String> stored;
  final writes = <String, String>{};

  @override
  Future<Map<String, String>> readAll() async => {...stored, ...writes};

  @override
  Future<String?> read(String route) async => writes[route] ?? stored[route];

  @override
  Future<void> write(String route, String key) async => writes[route] = key;

  @override
  Future<void> delete(String route) async {
    stored.remove(route);
    writes.remove(route);
  }
}

class _NoStorage extends _Keys {
  @override
  Future<Map<String, String>> readAll() async => throw StateError('no secure storage');
}

class _Vault implements ProviderKeyVault {
  _Vault([this.stored = const {}]);

  final Map<String, String> stored;

  @override
  Future<Map<String, String>> readAll() async => stored;

  @override
  Future<void> write(String id, String key) async {}

  @override
  Future<void> delete(String id) async {}
}

/// [tavernChannelKey] as the app reads it, one route at a time.
final _keyOf = FutureProvider.family<String?, String>(tavernChannelKey);

void main() {
  group('the address a channel is dialled at', () {
    test('the probe asks the channel root for its models', () {
      expect(tavernChannelModelsUri('http://h:9100/v1').toString(), 'http://h:9100/v1/models');
      expect(tavernChannelModelsUri('http://h:9100/v1/').toString(), 'http://h:9100/v1/models');
      // A base URL that already names the endpoint is trimmed back to the root.
      expect(
        tavernChannelModelsUri('http://h:9100/v1/chat/completions').toString(),
        'http://h:9100/v1/models',
      );
      expect(tavernChannelModelsUri(' https://api.deepseek.com ').toString(), 'https://api.deepseek.com/models');
    });

    test('a loopback address dials the phone itself', () {
      expect(tavernChannelLoopback('http://127.0.0.1:9100/v1'), isTrue);
      expect(tavernChannelLoopback('http://localhost:8080/v1'), isTrue);
      expect(tavernChannelLoopback('http://[::1]:8080'), isTrue);
      expect(tavernChannelLoopback('http://0.0.0.0:3080'), isTrue);
      expect(tavernChannelLoopback('http://192.168.2.230:9100/v1'), isFalse);
      expect(tavernChannelLoopback('https://api.deepseek.com'), isFalse);
      expect(tavernChannelLoopback(''), isFalse);
    });
  });

  group('probing a channel from this phone', () {
    test('a list of models is the channel answering', () async {
      final client = MockClient((request) async {
        expect(request.url.toString(), 'http://192.168.2.230:9100/v1/models');
        expect(request.headers['Authorization'], 'Bearer secret');
        return http.Response(
          jsonEncode({
            'data': [
              {'id': 'hy4-preview'},
              {'id': 'hy3'},
              {'object': 'model'},
            ],
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      final probe = await probeTavernChannel(
        baseUrl: 'http://192.168.2.230:9100/v1',
        key: 'secret',
        clientFactory: () => client,
      );
      expect(probe.ok, isTrue);
      expect(probe.models, ['hy4-preview', 'hy3']);
      expect(probe.message, isNull);
    });

    test('no key sent when none is known', () async {
      final client = MockClient((request) async {
        expect(request.headers.containsKey('Authorization'), isFalse);
        return http.Response('{"data": []}', 200);
      });
      final probe = await probeTavernChannel(baseUrl: 'http://h:9100/v1', clientFactory: () => client);
      expect(probe.ok, isTrue);
      expect(probe.models, isEmpty);
    });

    test('a rejected key is reported with its status', () async {
      final client = MockClient((_) async => http.Response('{"error": "invalid api key"}', 401));
      final probe = await probeTavernChannel(baseUrl: 'http://h:9100/v1', key: 'wrong', clientFactory: () => client);
      expect(probe.ok, isFalse);
      expect(probe.models, isEmpty);
      expect(probe.message, 'HTTP 401');
    });

    test('a transport failure is reported, not thrown', () async {
      final client = MockClient((_) async => throw const SocketishFailure());
      final probe = await probeTavernChannel(baseUrl: 'http://h:9100/v1', clientFactory: () => client);
      expect(probe.ok, isFalse);
      expect(probe.message, contains('unreachable'));
    });

    test('an address that is not a URL fails before dialling', () async {
      var dialled = false;
      final client = MockClient((_) async {
        dialled = true;
        return http.Response('{}', 200);
      });
      final probe = await probeTavernChannel(baseUrl: 'not a url', clientFactory: () => client);
      expect(probe.ok, isFalse);
      expect(probe.message, 'invalid url');
      expect(dialled, isFalse);
    });
  });

  group('the key a channel calls with on this phone', () {
    test('the one typed here wins over the vault copy', () async {
      final container = ProviderContainer(
        overrides: [
          tavernChannelKeysProvider.overrideWithValue(_Keys({'wb': 'typed'})),
          providerKeyVaultProvider.overrideWithValue(_Vault({'wb': 'vault'})),
        ],
      );
      addTearDown(container.dispose);
      expect(await container.read(_keyOf('wb').future), 'typed');
    });

    test('the vault copy is used when nothing was typed here', () async {
      final container = ProviderContainer(
        overrides: [
          tavernChannelKeysProvider.overrideWithValue(_Keys()),
          providerKeyVaultProvider.overrideWithValue(_Vault({'wb': 'vault'})),
        ],
      );
      addTearDown(container.dispose);
      expect(await container.read(_keyOf('wb').future), 'vault');
    });

    test('no key anywhere is null', () async {
      final container = ProviderContainer(
        overrides: [
          tavernChannelKeysProvider.overrideWithValue(_Keys()),
          providerKeyVaultProvider.overrideWithValue(_Vault()),
        ],
      );
      addTearDown(container.dispose);
      expect(await container.read(_keyOf('wb').future), isNull);
    });

    test('a phone without secure storage still reads the vault', () async {
      final container = ProviderContainer(
        overrides: [
          tavernChannelKeysProvider.overrideWithValue(_NoStorage()),
          providerKeyVaultProvider.overrideWithValue(_Vault({'wb': 'vault'})),
        ],
      );
      addTearDown(container.dispose);
      expect(await container.read(_keyOf('wb').future), 'vault');
    });
  });

  group('the address is kept per channel', () {
    test('typed once, dialled until it is cleared', () async {
      SharedPreferences.setMockInitialValues({});
      final container = ProviderContainer();
      addTearDown(container.dispose);
      container.read(tavernSettingsProvider);
      await pumpEventQueue();

      await container
          .read(tavernSettingsProvider.notifier)
          .setChannelBaseUrl('wb', ' http://192.168.2.230:9100/v1 ');
      final stored = container.read(tavernSettingsProvider);
      expect(stored.channelBaseUrl('wb'), 'http://192.168.2.230:9100/v1');
      expect(stored.channelBaseUrl('other'), isNull);
      expect((await SharedPreferences.getInstance()).getString('tavern.channelBaseUrl.wb'),
          'http://192.168.2.230:9100/v1');

      // Empty goes back to the channel's own address, and leaves nothing behind.
      await container.read(tavernSettingsProvider.notifier).setChannelBaseUrl('wb', '   ');
      expect(container.read(tavernSettingsProvider).channelBaseUrl('wb'), isNull);
      expect((await SharedPreferences.getInstance()).getString('tavern.channelBaseUrl.wb'), isNull);
    });

    test('a stored address is loaded on the next start', () async {
      SharedPreferences.setMockInitialValues({'tavern.channelBaseUrl.wb': 'http://192.168.2.230:9100/v1'});
      final container = ProviderContainer();
      addTearDown(container.dispose);
      container.read(tavernSettingsProvider);
      await pumpEventQueue();
      expect(container.read(tavernSettingsProvider).channelBaseUrl('wb'), 'http://192.168.2.230:9100/v1');
    });

    test('copyWith carries the addresses', () {
      const base = TavernSettings();
      expect(base.channelBaseUrl('wb'), isNull);
      final withAddress = base.copyWith(channelBaseUrls: const {'wb': 'http://h:1/v1'});
      expect(withAddress.channelBaseUrl('wb'), 'http://h:1/v1');
      expect(base.channelBaseUrl('wb'), isNull);
      // Untouched by the other fields' updates.
      expect(withAddress.copyWith(thinking: true).channelBaseUrl('wb'), 'http://h:1/v1');
    });
  });
}

/// A failure that reads like a dead socket.
class SocketishFailure implements Exception {
  const SocketishFailure();

  @override
  String toString() => 'SocketException: unreachable';
}

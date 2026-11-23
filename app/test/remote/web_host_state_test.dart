// 远程 DSH model: address parsing, persistence (config in prefs, credential in
// the secret store) and the hostLinkProvider branch.

import 'dart:convert';

import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/remote/web/web_host_link.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _NoLocal extends LocalConnectionController {
  @override
  Future<HostConnection?> build() async => null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MemorySecretStore secrets;
  late List<WebHostConfig> built;

  ProviderContainer container() {
    final c = ProviderContainer(
      overrides: [
        secretStoreProvider.overrideWithValue(secrets),
        localConnectionProvider.overrideWith(_NoLocal.new),
        networkKicksProvider.overrideWithValue(const Stream.empty()),
        webLinkFactoryProvider.overrideWithValue((ref, config) {
          built.add(config);
          return WebHostLink(
            config: config,
            loadSecrets: () async => const WebHostSecrets(),
            login: (baseUri, password, {httpClient}) => throw StateError('never opens in this test'),
            connectClient: ({required baseUri, cookie, token, httpClient, httpClientFactory}) =>
                throw StateError('never opens in this test'),
          );
        }),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    secrets = MemorySecretStore();
    built = [];
  });

  group('WebAddress', () {
    test('fills in the scheme, keeps the port, drops path and query', () {
      expect(WebAddress.tryParse('192.168.1.10:3080')?.baseUrl, 'http://192.168.1.10:3080');
      expect(WebAddress.tryParse('https://dsh-pc.example.com')?.baseUrl, 'https://dsh-pc.example.com');
      expect(WebAddress.tryParse('  http://10.0.0.5:3080/chat?x=1#top ')?.baseUrl, 'http://10.0.0.5:3080');
    });

    test('takes the launch token out of a pasted URL', () {
      final address = WebAddress.tryParse('http://192.168.1.10:3080/?token=abc123');
      expect(address?.baseUrl, 'http://192.168.1.10:3080');
      expect(address?.token, 'abc123');
      expect(WebAddress.tryParse('http://192.168.1.10:3080/?token=')?.token, isNull);
    });

    test('rejects what has no host', () {
      expect(WebAddress.tryParse(''), isNull);
      expect(WebAddress.tryParse('   '), isNull);
      expect(WebAddress.tryParse('ftp://192.168.1.10'), isNull);
      expect(WebAddress.tryParse('http://user:pw@host:80'), isNull);
    });
  });

  group('WebHostConfig', () {
    test('json round-trip keeps the address and names the host when unnamed', () {
      const config = WebHostConfig(id: 'web-1', name: '客厅', baseUrl: 'http://192.168.1.10:3080');
      expect(WebHostConfig.fromJson(jsonDecode(jsonEncode(config.toJson()))), config);
      final unnamed = WebHostConfig.fromJson({'id': 'web-2', 'baseUrl': 'http://10.0.0.5:3080'})!;
      expect(unnamed.name, '10.0.0.5:3080');
      expect(WebHostConfig.fromJson({'id': 'web-3', 'baseUrl': 'ftp://192.168.1.10'}), isNull);
      expect(WebHostConfig.fromJson({'baseUrl': 'http://x'}), isNull);
      expect(WebHostConfig.newId(), matches(RegExp(r'^web-[0-9a-f]{16}$')));
    });

    test('a rename keeps the connection; a new address does not', () {
      const config = WebHostConfig(id: 'web-1', name: '客厅', baseUrl: 'http://192.168.1.10:3080');
      expect(config.copyWith(name: '书房').connectionKey, config.connectionKey);
      expect(config.copyWith(baseUrl: 'http://192.168.1.11:3080').connectionKey, isNot(config.connectionKey));
    });
  });

  group('HostRef', () {
    test('round-trips and labels as 远程 DSH', () {
      const ref = HostRef.web('web-1');
      expect(HostRef.decode(ref.encode()), ref);
      expect(hostLabel(HostKind.web, '客厅'), '客厅 · 远程 DSH');
      expect(hostLabel(HostKind.web, null), '远程 DSH');
      expect(
        hostLabel(HostKind.web, '一个名字特别特别特别特别长的服务器'),
        endsWith('… · 远程 DSH'),
      );
    });
  });

  group('HostsController', () {
    test('stores the config in prefs and the credential in the secret store', () async {
      final c = container();
      await c.read(hostsProvider.notifier).ready;
      const config = WebHostConfig(id: 'web-1', name: '客厅', baseUrl: 'http://192.168.1.10:3080');

      expect(await c.read(hostsProvider.notifier).saveWeb(config, secrets: const WebHostSecrets(password: 'hunter2')), isTrue);
      expect(c.read(hostsProvider).webById('web-1'), config);

      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(HostsController.webPrefsKey)!;
      expect(raw, contains('192.168.1.10:3080'));
      expect(raw, isNot(contains('hunter2')));

      final loaded = await c.read(hostsProvider.notifier).loadWebSecrets('web-1');
      expect(loaded.password, 'hunter2');
      expect(loaded.token, isNull);

      // Switching the credential kind drops the other one.
      await c.read(hostsProvider.notifier).saveWeb(config, secrets: const WebHostSecrets(token: 'tok-9'));
      final switched = await c.read(hostsProvider.notifier).loadWebSecrets('web-1');
      expect(switched.password, isNull);
      expect(switched.token, 'tok-9');
    });

    test('a saved host survives a reload', () async {
      final first = container();
      await first.read(hostsProvider.notifier).ready;
      const config = WebHostConfig(id: 'web-1', name: '客厅', baseUrl: 'http://192.168.1.10:3080');
      await first.read(hostsProvider.notifier).saveWeb(config, secrets: const WebHostSecrets(token: 'tok-9'));

      final second = container();
      await second.read(hostsProvider.notifier).ready;
      expect(second.read(hostsProvider).webById('web-1'), config);
      expect(secrets.values.keys, contains('web.web-1.token'));
    });

    test('removing the host drops its secrets and forgets it as active', () async {
      final c = container();
      await c.read(hostsProvider.notifier).ready;
      const config = WebHostConfig(id: 'web-1', name: '客厅', baseUrl: 'http://192.168.1.10:3080');
      await c.read(hostsProvider.notifier).saveWeb(config, secrets: const WebHostSecrets(password: 'hunter2'));
      c.read(activeHostProvider.notifier).select(const HostRef.web('web-1'));
      expect(c.read(activeHostProvider), const HostRef.web('web-1'));

      await c.read(hostsProvider.notifier).removeWeb('web-1');
      expect(c.read(hostsProvider).webById('web-1'), isNull);
      expect(secrets.values.keys, isNot(contains('web.web-1.password')));
      expect(c.read(activeHostProvider).isLocal, isTrue);
    });

    test('the link for a saved host is built from its config', () async {
      final c = container();
      await c.read(hostsProvider.notifier).ready;
      const config = WebHostConfig(id: 'web-1', name: '客厅', baseUrl: 'http://192.168.1.10:3080');
      await c.read(hostsProvider.notifier).saveWeb(config);

      final link = c.read(hostLinkProvider(const HostRef.web('web-1')));
      expect(link, isA<WebHostLink>());
      expect(built.single, config);
      expect(c.read(hostNameProvider(const HostRef.web('web-1'))), '客厅');
      // An unknown id has no link at all.
      expect(c.read(hostLinkProvider(const HostRef.web('web-nope'))), isNull);
    });
  });
}

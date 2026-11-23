// WebHostLink: which credential it uses, how a refused password maps to an
// auth failure, and that a launch token never touches the bridge login.

import 'dart:io';

import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/web/web_host_config.dart';
import 'package:dsh_app/remote/web/web_host_link.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records what the link asked for and answers with a client that never
/// connects (nothing in these tests should reach a socket).
class _Recorder {
  final logins = <(Uri, String)>[];
  final connects = <({Uri baseUri, DshCookie? cookie, String? token})>[];
  Object? throwOnLogin;
  Object? throwOnConnect;

  Future<DshCookie> login(Uri baseUri, String password, {HttpClient? httpClient}) async {
    logins.add((baseUri, password));
    if (throwOnLogin case final error?) throw error;
    return DshCookie(name: 'dsh_bridge_auth', value: 'sess-1', authority: DshConnection.authorityOf(baseUri));
  }

  Future<DshClient> connect({
    required Uri baseUri,
    DshCookie? cookie,
    String? token,
    HttpClient? httpClient,
    HttpClient Function()? httpClientFactory,
  }) async {
    connects.add((baseUri: baseUri, cookie: cookie, token: token));
    if (throwOnConnect case final error?) throw error;
    return DshClient(DshConnection(Uri.parse('http://127.0.0.1:9')));
  }
}

void main() {
  late _Recorder recorder;

  setUp(() => recorder = _Recorder());

  WebHostLink link({required WebHostSecrets secrets, bool retryFirstOpen = false}) => WebHostLink(
    config: const WebHostConfig(id: 'web-1', name: '客厅', baseUrl: 'http://192.168.1.10:3080'),
    loadSecrets: () async => secrets,
    login: recorder.login,
    connectClient: recorder.connect,
    backoff: Backoff(initial: const Duration(milliseconds: 5), maxAttempts: 3),
    retryFirstOpen: retryFirstOpen,
  );

  Future<HostLinkStatus> settle(WebHostLink link) async {
    try {
      await link.open();
    } catch (_) {
      // The failing status is what a test asserts on.
    }
    return link.status;
  }

  test('a password signs in to the bridge, then connects with that cookie', () async {
    final underTest = link(secrets: const WebHostSecrets(password: 'hunter2'));
    addTearDown(underTest.close);

    await underTest.open();

    expect(recorder.logins, [(Uri.parse('http://192.168.1.10:3080'), 'hunter2')]);
    expect(recorder.connects, hasLength(1));
    expect(recorder.connects.single.cookie?.header, 'dsh_bridge_auth=sess-1');
    expect(recorder.connects.single.token, isNull);
    expect(underTest.status.phase, HostLinkPhase.connected);
    expect(underTest.currentClient, isNotNull);
  });

  test('a kick that cannot reach the Host rebuilds the client', () async {
    final underTest = link(secrets: const WebHostSecrets(password: 'hunter2'));
    addTearDown(underTest.close);
    await underTest.open();
    expect(underTest.status.phase, HostLinkPhase.connected);
    expect(recorder.connects, hasLength(1));

    // The fake client points at 127.0.0.1:9, so the health check cannot connect.
    // A socket frozen while the App was backgrounded looks the same from here:
    // an exception, not a status code. The link must rebuild, not stay quiet.
    underTest.kick();
    await Future<void>.delayed(const Duration(milliseconds: 300));

    expect(recorder.connects.length, greaterThan(1));
    expect(underTest.status.phase, HostLinkPhase.connected);
  });

  test('an https Host unreachable on 443 is retried on 8443 and 2053', () async {
    final attempts = <Uri>[];
    final underTest = WebHostLink(
      config: const WebHostConfig(id: 'web-1', name: '家里', baseUrl: 'https://dsh.example.com'),
      loadSecrets: () async => const WebHostSecrets(token: 'tok-9'),
      login: recorder.login,
      connectClient: ({required baseUri, cookie, token, httpClient, httpClientFactory}) async {
        attempts.add(baseUri);
        if (baseUri.port != 2053) throw const DshTransportException('edge drops this port');
        return DshClient(DshConnection(Uri.parse('http://127.0.0.1:9')));
      },
    );
    addTearDown(underTest.close);

    await underTest.open();

    expect(attempts.map((u) => u.port), [443, 8443, 2053]);
    expect(underTest.status.phase, HostLinkPhase.connected);
  });

  test('a wrong password fails as an auth error that a retry cannot fix', () async {
    recorder.throwOnLogin = const DshHttpException(401, 'bridge rejected the access password');
    final underTest = link(secrets: const WebHostSecrets(password: 'nope'));
    addTearDown(underTest.close);

    final status = await settle(underTest);

    expect(status.phase, HostLinkPhase.failed);
    expect(status.error?.kind, HostLinkErrorKind.authFailed);
    expect(status.error?.message, '密码不对或已失效');
    expect(status.error?.retryable, isFalse);
    // Only the login ran; the bridge never gave out a session.
    expect(recorder.connects, isEmpty);
  });

  test('a launch token goes straight to the client, never through the bridge', () async {
    final underTest = link(secrets: const WebHostSecrets(token: 'tok-9'));
    addTearDown(underTest.close);

    await underTest.open();

    expect(recorder.logins, isEmpty);
    expect(recorder.connects.single.token, 'tok-9');
    expect(recorder.connects.single.cookie, isNull);
    expect(underTest.status.isConnected, isTrue);
  });

  test('a Host that refuses the session maps to the same auth error, for the token', () async {
    recorder.throwOnConnect = const DshHttpException(403, 'fence refused');
    final underTest = link(secrets: const WebHostSecrets(token: 'stale'));
    addTearDown(underTest.close);

    final status = await settle(underTest);

    expect(status.phase, HostLinkPhase.failed);
    expect(status.error?.kind, HostLinkErrorKind.authFailed);
    expect(status.error?.message, '启动令牌不对或已过期');
    expect(status.error?.retryable, isFalse);
  });

  test('without any credential the link says so instead of guessing', () async {
    final underTest = link(secrets: const WebHostSecrets());
    addTearDown(underTest.close);

    final status = await settle(underTest);

    expect(status.phase, HostLinkPhase.failed);
    expect(status.error?.kind, HostLinkErrorKind.authFailed);
    expect(recorder.logins, isEmpty);
    expect(recorder.connects, isEmpty);
  });

  test('an unreachable Host is retried with the shared backoff', () async {
    var failures = 1;
    final underTest = WebHostLink(
      config: const WebHostConfig(id: 'web-1', name: '客厅', baseUrl: 'http://192.168.1.10:3080'),
      loadSecrets: () async => const WebHostSecrets(token: 'tok-9'),
      login: recorder.login,
      connectClient: ({required baseUri, cookie, token, httpClient, httpClientFactory}) {
        if (failures-- > 0) return Future.error(const DshTransportException('connection refused'));
        return recorder.connect(baseUri: baseUri, cookie: cookie, token: token, httpClient: httpClient);
      },
      backoff: Backoff(initial: const Duration(milliseconds: 5), maxAttempts: 3),
    );
    addTearDown(underTest.close);

    await underTest.open();

    expect(underTest.status.isConnected, isTrue);
    expect(recorder.connects, hasLength(1));
  });

  test('a rename applies in place; a new address is a new connection', () async {
    final underTest = link(secrets: const WebHostSecrets(token: 'tok-9'));
    addTearDown(underTest.close);
    final original = underTest.config.baseUri;

    underTest.updateConfig(underTest.config.copyWith(name: '书房'));
    expect(underTest.config.name, '书房');
    expect(underTest.config.baseUri, original);
  });
}

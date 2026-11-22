// Bridge password login: the one exchange that turns an access password into
// the `dsh_bridge_auth` cookie a DshClient then sends on every request.

import 'dart:convert';
import 'dart:io';

import 'package:dsh_client/dsh_client.dart';
import 'package:test/test.dart';

/// A fake `@wenbin_wb/dsh-bridge` gate: one login route with a canned answer.
class _Bridge {
  _Bridge(this.handler);

  final Future<void> Function(HttpRequest request) handler;
  late HttpServer _server;

  Uri get baseUri => Uri.parse('http://127.0.0.1:${_server.port}');

  Future<void> start() async {
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server.listen((request) async {
      try {
        await handler(request);
      } catch (_) {
        // A failed expectation surfaces through the client call.
      }
    });
  }

  Future<void> close() => _server.close(force: true);

  static Future<void> login(HttpRequest request, {int status = 200, List<String> cookies = const [], String body = '{"ok":true}'}) async {
    request.response.statusCode = status;
    for (final cookie in cookies) {
      request.response.headers.add(HttpHeaders.setCookieHeader, cookie);
    }
    request.response.headers.contentType = ContentType.json;
    request.response.write(body);
    await request.response.close();
  }

  static Future<Map<String, Object?>> readJson(HttpRequest request) async =>
      jsonDecode(await utf8.decodeStream(request)) as Map<String, Object?>;
}

void main() {
  late _Bridge bridge;

  tearDown(() => bridge.close());

  Future<DshCookie> login({int status = 200, List<String> cookies = const [], void Function(HttpRequest)? inspect}) async {
    bridge = _Bridge((request) async {
      inspect?.call(request);
      await _Bridge.login(request, status: status, cookies: cookies);
    });
    await bridge.start();
    return loginDshBridge(bridge.baseUri, 'hunter2');
  }

  test('200 with the bridge cookie returns it bound to host:port', () async {
    String? path;
    String? contentType;
    final cookie = await login(
      cookies: ['dsh_bridge_auth=sess-1; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'],
      inspect: (request) {
        path = request.uri.path;
        contentType = request.headers.contentType?.mimeType;
      },
    );
    expect(path, dshBridgeLoginPath);
    expect(contentType, 'application/json');
    expect(cookie.name, dshBridgeCookieName);
    expect(cookie.value, 'sess-1');
    expect(cookie.authority, '127.0.0.1:${bridge.baseUri.port}');
    expect(cookie.header, 'dsh_bridge_auth=sess-1');
  });

  test('sends the password as a JSON body', () async {
    late Map<String, Object?> sent;
    bridge = _Bridge((request) async {
      sent = await _Bridge.readJson(request);
      await _Bridge.login(request, cookies: ['dsh_bridge_auth=sess-1; Max-Age=60']);
    });
    await bridge.start();
    await loginDshBridge(bridge.baseUri, 'hunter2');
    expect(sent, {'password': 'hunter2'});
  });

  test('Max-Age sets the expiry', () async {
    final cookie = await login(cookies: ['dsh_bridge_auth=sess-1; Max-Age=120']);
    final left = cookie.expiresAt!.difference(DateTime.now());
    expect(left.inSeconds, inInclusiveRange(118, 121));
  });

  test('without Max-Age the cookie still gets the 30-day default', () async {
    final cookie = await login(cookies: ['dsh_bridge_auth=sess-1; Path=/; HttpOnly']);
    final left = cookie.expiresAt!.difference(DateTime.now());
    expect(left.inDays, 29);
  });

  test('several Set-Cookie headers: only dsh_bridge_auth is taken', () async {
    final cookie = await login(
      cookies: ['theme=dark; Path=/', 'dsh_bridge_auth=sess-2; Max-Age=60', 'cdn=eu; Path=/'],
    );
    expect(cookie.name, dshBridgeCookieName);
    expect(cookie.value, 'sess-2');
  });

  test('401 is an auth failure, not a protocol failure', () async {
    bridge = _Bridge((request) async {
      await _Bridge.login(request, status: 401, body: '{"ok":false,"error":"wrong password"}');
    });
    await bridge.start();
    await expectLater(
      loginDshBridge(bridge.baseUri, 'nope'),
      throwsA(isA<DshHttpException>().having((e) => e.statusCode, 'statusCode', 401)),
    );
  });

  test('200 without the cookie is a protocol failure', () async {
    bridge = _Bridge((request) async {
      await _Bridge.login(request, cookies: ['theme=dark; Path=/']);
    });
    await bridge.start();
    await expectLater(loginDshBridge(bridge.baseUri, 'hunter2'), throwsA(isA<DshProtocolException>()));
  });

  test('an empty cookie value is not a session', () async {
    bridge = _Bridge((request) async {
      await _Bridge.login(request, cookies: ['dsh_bridge_auth=; Path=/']);
    });
    await bridge.start();
    await expectLater(loginDshBridge(bridge.baseUri, 'hunter2'), throwsA(isA<DshProtocolException>()));
  });

  test('nothing listening is a transport failure', () async {
    final dead = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = dead.port;
    await dead.close();
    await expectLater(
      loginDshBridge(Uri.parse('http://127.0.0.1:$port'), 'hunter2'),
      throwsA(isA<DshTransportException>()),
    );
  });
}

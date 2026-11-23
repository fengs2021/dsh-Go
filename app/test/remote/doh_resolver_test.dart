// DoH resolution: the answer decides where to dial, the name still decides the
// Host header (and, over TLS, SNI and the certificate check).

import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/remote/web/doh_resolver.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a DoH answer dials the address while Host keeps the name', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    var lookups = 0;
    final hosts = <String>[];
    server.listen((request) {
      if (request.uri.path == '/resolve') {
        lookups++;
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode({
          'Status': 0,
          'Answer': [
            {'name': 'dsh.test.', 'type': 1, 'TTL': 60, 'data': '127.0.0.1'},
          ],
        }));
        request.response.close();
        return;
      }
      hosts.add(request.headers.value(HttpHeaders.hostHeader) ?? '');
      request.response.write('ok');
      request.response.close();
    });

    final resolver = DohResolver(endpoint: Uri.parse('http://127.0.0.1:${server.port}/resolve'));
    final client = resolver.client();
    addTearDown(client.close);

    for (var i = 0; i < 2; i++) {
      final request = await client.getUrl(Uri.parse('http://dsh.test:${server.port}/hello'));
      final response = await request.close();
      await response.drain<void>();
      expect(response.statusCode, 200);
    }

    expect(hosts, ['dsh.test:${server.port}', 'dsh.test:${server.port}']);
    expect(lookups, 1, reason: 'the answer is cached for its TTL');
  });

  test('a refused answer leaves the name to the platform resolver', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((request) {
      request.response.statusCode = 500;
      request.response.close();
    });

    final resolver = DohResolver(endpoint: Uri.parse('http://127.0.0.1:${server.port}/resolve'));
    expect(await resolver.lookup('dsh.test'), isNull);
    expect(await resolver.lookup('127.0.0.1'), isNotNull);
    resolver.close();
  });
}

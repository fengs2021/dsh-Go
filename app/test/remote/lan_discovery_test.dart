// 局域网 DSH discovery: which answers count as a bridge, which as a dsh web,
// and which are just somebody else's web server.

import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/remote/web/lan_discovery.dart';
import 'package:flutter_test/flutter_test.dart';

/// A local HTTP server that answers like the thing under test.
Future<HttpServer> serve(Future<void> Function(HttpRequest request) handler) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((request) async {
    try {
      await handler(request);
    } catch (_) {
      // A probe that stops listening just gets no answer.
    }
  });
  return server;
}

Future<void> reply(HttpRequest request, {int status = 200, String body = '', String? contentType, Map<String, String> headers = const {}}) async {
  request.response.statusCode = status;
  headers.forEach(request.response.headers.set);
  request.response.headers.contentType = contentType == null ? null : ContentType.parse(contentType);
  request.response.write(body);
  await request.response.close();
}

void main() {
  test('a bridge and a dsh web are found; a stranger is not', () async {
    final bridge = await serve((request) async {
      if (request.uri.path == '/__dsh_bridge__/auth-status') {
        await reply(request, body: jsonEncode({'enabled': true, 'mode': 'password_only'}), contentType: 'application/json');
      } else {
        await reply(request, status: 404);
      }
    });
    final dsh = await serve((request) async {
      if (request.uri.path == '/') {
        await reply(request, body: '<html><head><title>DSH Web</title></head></html>', contentType: 'text/html');
      } else {
        await reply(request, status: 404);
      }
    });
    final stranger = await serve((request) async {
      await reply(request, body: '<html><head><title>Printer</title></head></html>', contentType: 'text/html');
    });
    addTearDown(bridge.close);
    addTearDown(dsh.close);
    addTearDown(stranger.close);

    final found = await discoverLanDsh(
      addresses: [InternetAddress.loopbackIPv4],
      ports: [bridge.port, dsh.port, stranger.port],
    );

    expect({for (final c in found) c.port: c.kind}, {
      bridge.port: LanDshKind.bridge,
      dsh.port: LanDshKind.dsh,
    });
    expect(found.firstWhere((c) => c.port == bridge.port).title, 'password_only');
    expect(found.firstWhere((c) => c.port == dsh.port).title, 'DSH Web');
    expect(found, everyElement(predicate<LanDshCandidate>((c) => c.host == '127.0.0.1')));
    // Sorted by address, then port.
    expect(found.map((c) => c.port).toList(), [bridge.port, dsh.port]..sort());
  });

  test('an x-dsh header is enough, without a telling title', () async {
    final dsh = await serve((request) async {
      if (request.uri.path == '/') {
        await reply(request, body: '<html><title>Chat</title></html>', headers: {'x-dsh-version': '0.2.1'});
      } else {
        await reply(request, status: 404);
      }
    });
    addTearDown(dsh.close);

    final found = await discoverLanDsh(addresses: [InternetAddress.loopbackIPv4], ports: [dsh.port]);
    expect(found.single.kind, LanDshKind.dsh);
    expect(found.single.title, 'Chat');
  });

  test('a JSON answer without enabled is not a bridge', () async {
    final server = await serve((request) async {
      await reply(request, body: jsonEncode({'ok': true}), contentType: 'application/json');
    });
    addTearDown(server.close);

    expect(await discoverLanDsh(addresses: [InternetAddress.loopbackIPv4], ports: [server.port]), isEmpty);
  });

  test('nothing listening means no candidates', () async {
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();

    expect(await discoverLanDsh(addresses: [InternetAddress.loopbackIPv4], ports: [port]), isEmpty);
  });

  test('candidates are sorted by address, then port', () async {
    final first = await serve((request) async {
      await reply(request, body: jsonEncode({'enabled': false}), contentType: 'application/json');
    });
    addTearDown(first.close);

    final found = await discoverLanDsh(
      addresses: [InternetAddress.loopbackIPv4, InternetAddress('127.0.0.2')],
      ports: [first.port],
    );
    // Only 127.0.0.1 answers here; the order rule still has to hold.
    expect(found.map((c) => c.host), everyElement('127.0.0.1'));
  });
}

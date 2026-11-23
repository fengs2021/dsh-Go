import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Resolves a host name over DNS-over-HTTPS and hands out an [HttpClient] that
/// dials the resolved address while keeping the original name for `Host`, SNI
/// and certificate checks.
///
/// Why: a host behind a Cloudflare tunnel is chosen by SNI, so an IP literal is
/// not a substitute — the name has to resolve. On a network whose DNS refuses a
/// domain (company split-horizon, filtering) HTTPS to the same edge still works,
/// so the app resolves the name itself and keeps everything else name-based.
class DohResolver {
  DohResolver({
    Uri? endpoint,
    this.timeout = const Duration(seconds: 4),
    HttpClient? queryClient,
  })  : endpoint = endpoint ?? Uri.parse('https://223.5.5.5/resolve'),
        _query = queryClient ?? HttpClient()..connectionTimeout = timeout;

  static const Duration minTtl = Duration(minutes: 1);
  static const Duration maxTtl = Duration(minutes: 10);

  /// A JSON DoH endpoint (`/resolve?name=&type=A`). AliDNS by default: it answers
  /// bare IPs as well as names and needs no account.
  final Uri endpoint;

  /// One lookup, connection included.
  final Duration timeout;

  final HttpClient _query;
  final Map<String, _CacheEntry> _cache = {};

  /// IPv4 for [host], or `null` when the resolver cannot answer.
  ///
  /// An IP literal is returned as-is without a query. Failures are not fatal:
  /// the caller falls back to the platform resolver.
  Future<InternetAddress?> lookup(String host, {bool refresh = false}) async {
    final literal = InternetAddress.tryParse(host);
    if (literal != null) return literal;
    final cached = _cache[host];
    if (!refresh && cached != null && cached.expiresAt.isAfter(DateTime.now())) return cached.address;
    return _query4(host);
  }

  /// A client whose connections go to the DoH answer but behave, for TLS and
  /// `Host`, exactly as if the platform had resolved the name.
  HttpClient client() {
    final client = HttpClient()..connectionTimeout = timeout;
    client.connectionFactory = _connect;
    return client;
  }

  Future<ConnectionTask<Socket>> _connect(Uri uri, String? proxyHost, int? proxyPort) async {
    if (proxyHost != null) {
      // This client never configures a proxy; honour the platform resolver if a
      // future caller does, rather than dialing the origin behind its back.
      return _dial(proxyHost, proxyPort ?? uri.port, uri);
    }
    final address = await lookup(uri.host);
    if (address == null) return _dial(uri.host, uri.port, uri);
    return _dial(address.address, uri.port, uri);
  }

  /// Connects to [host] (a literal or a name) and, for `https`, completes the
  /// TLS handshake here: [HttpClient.connectionFactory] hands the socket
  /// straight to the protocol layer, so a plain socket would send the request
  /// in clear text (the origin answers "plain HTTP request sent to HTTPS
  /// port"). SNI and the certificate check stay on [uri]'s host name.
  Future<ConnectionTask<Socket>> _dial(String host, int port, Uri uri) async {
    final socket = await Socket.connect(host, port, timeout: timeout);
    if (uri.scheme != 'https') {
      return ConnectionTask.fromSocket(Future<Socket>.value(socket), () => socket.destroy());
    }
    final secure = await SecureSocket.secure(socket, host: uri.host);
    return ConnectionTask.fromSocket(Future<Socket>.value(secure), () {
      secure.destroy();
      socket.destroy();
    });
  }

  Future<InternetAddress?> _query4(String host) async {
    final uri = endpoint.replace(queryParameters: {
      ...endpoint.queryParameters,
      'name': host,
      'type': 'A',
    });
    try {
      final request = await _query.getUrl(uri).timeout(timeout);
      request.headers.set(HttpHeaders.acceptHeader, 'application/dns-json');
      final response = await request.close().timeout(timeout);
      final body = await response.transform(utf8.decoder).join().timeout(timeout);
      if (response.statusCode != 200) return null;
      final decoded = jsonDecode(body);
      if (decoded is! Map) return null;
      final answers = decoded['Answer'];
      if (answers is! List) return null;
      Duration ttl = const Duration(minutes: 5);
      for (final answer in answers) {
        if (answer is! Map) continue;
        if (answer['type'] != 1) continue;
        final data = answer['data'];
        final address = data is String ? InternetAddress.tryParse(data) : null;
        if (address == null) continue;
        final seconds = answer['TTL'];
        if (seconds is int && seconds > 0) {
          final candidate = Duration(seconds: seconds);
          ttl = candidate < minTtl ? minTtl : (candidate > maxTtl ? maxTtl : candidate);
        }
        _cache[host] = _CacheEntry(address, DateTime.now().add(ttl), ttl);
        return address;
      }
      return null;
    } on Object {
      return null;
    }
  }

  void close() => _query.close(force: true);
}

class _CacheEntry {
  _CacheEntry(this.address, this.expiresAt, [this.ttl = const Duration(minutes: 5)]);
  final InternetAddress address;
  final DateTime expiresAt;
  final Duration ttl;
}

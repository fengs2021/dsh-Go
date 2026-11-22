import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

/// What answered at a candidate address.
enum LanDshKind {
  /// `dsh-bridge` in front of a DSH: sign in with its access password.
  bridge,

  /// A `dsh web` itself: sign in with its launch token.
  dsh,
}

/// One DSH found on the local network.
class LanDshCandidate {
  const LanDshCandidate({required this.host, required this.port, required this.kind, this.title});

  final String host;
  final int port;
  final LanDshKind kind;

  /// What the Host called itself: the page title of a `dsh web`, or the
  /// bridge's auth `mode` (`password_only`).
  final String? title;

  Uri get baseUri => Uri(scheme: 'http', host: host, port: port);

  String get address => '$host:$port';

  @override
  bool operator ==(Object other) =>
      other is LanDshCandidate && other.host == host && other.port == port && other.kind == kind;

  @override
  int get hashCode => Object.hash(host, port, kind);

  @override
  String toString() => 'LanDshCandidate($address, ${kind.name})';
}

/// Ports `dsh web` and the bridge are usually served on.
const lanDshPorts = [3080, 8080];

/// One round, one deadline: no retries, no full port scan.
const lanDshScanTimeout = Duration(milliseconds: 300);

/// How many probes may be in flight at once.
const lanDshScanConcurrency = 64;

/// The DSH instances reachable on this network, sorted by address.
///
/// Scans the /24 around each local IPv4 address on [ports] and asks each
/// address two questions: is `dsh-bridge` in front of a DSH
/// (`GET /__dsh_bridge__/auth-status` answering a JSON object with `enabled`),
/// or is a `dsh web` itself answering on `/` (an `x-dsh-*` header or a page
/// that names itself DSH). Anything else — silence, a timeout, a stranger's
/// web server — is not a candidate.
///
/// [addresses] replaces the local /24 (tests point it at loopback); [client]
/// and [timeout] are injection points too. Nothing is retried and no mDNS is
/// used: this is one bounded pass.
Future<List<LanDshCandidate>> discoverLanDsh({
  Duration timeout = lanDshScanTimeout,
  List<int> ports = lanDshPorts,
  List<InternetAddress>? addresses,
  HttpClient? client,
}) async {
  final hosts = addresses ?? await localSubnetAddresses();
  final targets = [
    for (final address in hosts)
      for (final port in ports) (address.address, port),
  ];
  if (targets.isEmpty) return const [];
  final http = client ?? (HttpClient()..connectionTimeout = timeout);
  final found = <LanDshCandidate>[];
  var next = 0;
  Future<void> worker() async {
    while (next < targets.length) {
      final (host, port) = targets[next++];
      final candidate = await _probe(http, host, port, timeout);
      if (candidate != null) found.add(candidate);
    }
  }

  try {
    await Future.wait([
      for (var i = 0; i < math.min(lanDshScanConcurrency, targets.length); i++) worker(),
    ]);
  } finally {
    if (client == null) http.close(force: true);
  }
  found.sort((a, b) {
    final (left, right) = (_numeric(a.host), _numeric(b.host));
    final byHost = left.compareTo(right);
    return byHost != 0 ? byHost : a.port.compareTo(b.port);
  });
  return found;
}

/// The other addresses of each local IPv4 /24 (the phone itself excluded).
Future<List<InternetAddress>> localSubnetAddresses() async {
  final hosts = <String>{};
  List<NetworkInterface> interfaces;
  try {
    interfaces = await NetworkInterface.list(
      type: InternetAddressType.IPv4,
      includeLoopback: false,
      includeLinkLocal: false,
    );
  } on Object {
    return const [];
  }
  for (final interface in interfaces) {
    for (final address in interface.addresses) {
      final bytes = address.rawAddress;
      if (address.isLoopback || bytes.length != 4) continue;
      final self = bytes[3];
      for (var last = 1; last < 255; last++) {
        if (last == self) continue;
        hosts.add('${bytes[0]}.${bytes[1]}.${bytes[2]}.$last');
      }
    }
  }
  return [for (final host in hosts) InternetAddress(host)];
}

int _numeric(String host) {
  final parts = host.split('.');
  if (parts.length != 4) return 0;
  var value = 0;
  for (final part in parts) {
    value = value * 256 + (int.tryParse(part) ?? 0);
  }
  return value;
}

/// Asks one address what it is; null when it is not a DSH.
Future<LanDshCandidate?> _probe(HttpClient http, String host, int port, Duration timeout) async {
  final bridge = await _get(http, 'http://$host:$port/__dsh_bridge__/auth-status', timeout);
  if (bridge != null && bridge.status == 200) {
    final decoded = _decodeObject(bridge.body);
    if (decoded != null && decoded['enabled'] is bool) {
      final mode = decoded['mode'];
      return LanDshCandidate(host: host, port: port, kind: LanDshKind.bridge, title: mode is String ? mode : null);
    }
  }
  final page = await _get(http, 'http://$host:$port/', timeout);
  if (page != null && page.status == 200 && page.looksLikeDsh) {
    return LanDshCandidate(host: host, port: port, kind: LanDshKind.dsh, title: page.title);
  }
  return null;
}

typedef _Page = ({int status, String body, bool looksLikeDsh, String? title});

/// One bounded GET: a probe that hangs or errors is simply not an answer.
Future<_Page?> _get(HttpClient http, String url, Duration timeout) async {
  try {
    final request = await http.getUrl(Uri.parse(url)).timeout(timeout);
    request.followRedirects = false;
    request.persistentConnection = false;
    final response = await request.close().timeout(timeout);
    final body = <int>[];
    await for (final chunk in response.timeout(timeout)) {
      body.addAll(chunk);
      if (body.length >= 8192) break;
    }
    final text = utf8.decode(body, allowMalformed: true);
    var dshHeader = false;
    response.headers.forEach((name, _) {
      if (name.toLowerCase().startsWith('x-dsh-')) dshHeader = true;
    });
    final title = RegExp(r'<title[^>]*>([^<]*)</title>', caseSensitive: false).firstMatch(text)?.group(1)?.trim();
    final named = title != null && (title.toUpperCase().startsWith('DSH') || text.contains('dsh web'));
    return (
      status: response.statusCode,
      body: text,
      looksLikeDsh: dshHeader || named,
      title: title == null || title.isEmpty ? null : title,
    );
  } on Object {
    return null;
  }
}

Map<String, Object?>? _decodeObject(String text) {
  try {
    final decoded = jsonDecode(text);
    return decoded is Map ? Map<String, Object?>.from(decoded) : null;
  } on FormatException {
    return null;
  }
}

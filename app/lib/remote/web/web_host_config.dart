import 'dart:math' as math;

/// One saved 远程 DSH: an HTTP-reached `dsh web`, either behind
/// `@wenbin_wb/dsh-bridge` (access password) or a `dsh web` that is already
/// running on the same network (launch token).
///
/// Persisted as JSON in SharedPreferences without credentials; the password or
/// token lives in the [SecretStore] under [WebHostSecrets] keys, exactly like
/// an SSH host's password.
class WebHostConfig {
  const WebHostConfig({
    required this.id,
    required this.name,
    required this.baseUrl,
    this.doh = false,
  });

  /// Stable id (`web-<hex>`); also the secret-store namespace.
  final String id;

  /// What the person calls it ("客厅的电脑").
  final String name;

  /// `scheme://host[:port]`, no path and no query.
  final String baseUrl;

  /// Resolve the host through the app's DoH client instead of the platform
  /// resolver. For a network whose DNS refuses the domain while HTTPS to the
  /// same edge still works.
  final bool doh;

  Uri get baseUri => Uri.parse(baseUrl);

  /// Fields that require a new connection when they change (the name does not).
  String get connectionKey => '$baseUrl\u0000$doh';

  WebHostConfig copyWith({String? name, String? baseUrl, bool? doh}) => WebHostConfig(
    id: id,
    name: name ?? this.name,
    baseUrl: baseUrl ?? this.baseUrl,
    doh: doh ?? this.doh,
  );

  Map<String, Object?> toJson() => {
    'id': id,
    'name': name,
    'baseUrl': baseUrl,
    if (doh) 'doh': true,
  };

  static WebHostConfig? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    final baseUrl = raw['baseUrl'];
    if (id is! String || id.isEmpty || baseUrl is! String || baseUrl.isEmpty) return null;
    final address = WebAddress.tryParse(baseUrl);
    if (address == null) return null;
    final name = raw['name'];
    return WebHostConfig(
      id: id,
      name: name is String && name.trim().isNotEmpty ? name.trim() : WebAddress.hostOf(address.baseUrl),
      baseUrl: address.baseUrl,
      doh: raw['doh'] == true,
    );
  }

  static String newId([math.Random? random]) {
    final r = random ?? math.Random.secure();
    final hex = List.generate(8, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    return 'web-$hex';
  }

  @override
  bool operator ==(Object other) =>
      other is WebHostConfig &&
      other.id == id &&
      other.name == name &&
      other.baseUrl == baseUrl &&
      other.doh == doh;

  @override
  int get hashCode => Object.hash(id, name, baseUrl, doh);
}

/// A typed-in address: the base URL to store, plus the launch token a pasted
/// `…/?token=…` URL carried.
class WebAddress {
  const WebAddress(this.baseUrl, this.token);

  final String baseUrl;
  final String? token;

  /// Accepts `192.168.1.10:3080`, `http://host:port`, `https://name` and a
  /// full `http://host:port/?token=…`; null for anything without a host.
  /// Path, query and fragment are dropped — a saved host is an origin.
  static WebAddress? tryParse(String raw) {
    var text = raw.trim();
    if (text.isEmpty) return null;
    if (!text.contains('://')) text = 'http://$text';
    final uri = Uri.tryParse(text);
    if (uri == null || uri.host.isEmpty || uri.userInfo.isNotEmpty) return null;
    if (uri.scheme != 'http' && uri.scheme != 'https') return null;
    final base = Uri(scheme: uri.scheme, host: uri.host, port: uri.hasPort ? uri.port : null);
    final token = uri.queryParameters['token'];
    return WebAddress(base.toString(), token == null || token.isEmpty ? null : token);
  }

  /// `host:port` as typed (for a name suggestion and error details).
  static String hostOf(String baseUrl) => Uri.parse(baseUrl).authority;
}

/// The secret material for one 远程 DSH, loaded from the [SecretStore].
///
/// At most one of [password] and [token] is set: a bridge wants the access
/// password, a bare `dsh web` wants its launch token.
class WebHostSecrets {
  const WebHostSecrets({this.password, this.token});

  final String? password;

  /// The `?token=` value `dsh web` printed on start.
  final String? token;

  static String passwordKey(String hostId) => 'web.$hostId.password';
  static String tokenKey(String hostId) => 'web.$hostId.token';

  String? get passwordOrNull => password == null || password!.isEmpty ? null : password;

  String? get tokenOrNull => token == null || token!.trim().isEmpty ? null : token!.trim();
}

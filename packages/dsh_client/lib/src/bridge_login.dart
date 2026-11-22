/// Password sign-in for `@wenbin_wb/dsh-bridge`.
///
/// The bridge sits in front of a `dsh web` on a PC and is reached over the
/// LAN or a Cloudflare tunnel. Its own gate is an access password, not the
/// launch token: `POST /__dsh_bridge__/login {"password": …}` answers 200 with
/// `Set-Cookie: dsh_bridge_auth=<session>`, 401 when the password is wrong.
/// Every later request carries that cookie, including the WebSocket upgrade,
/// so the returned [DshCookie] can go straight into `DshClient.connect`.
library;

import 'dart:io';

import 'connection.dart';
import 'errors.dart';

/// Name of the cookie the bridge mints for an authorized session.
const dshBridgeCookieName = 'dsh_bridge_auth';

/// The bridge's login route, relative to the address it is served on.
const dshBridgeLoginPath = '/__dsh_bridge__/login';

/// Cookie lifetime assumed when the answer carries no `Max-Age`/`Expires`
/// (the bridge sends `Max-Age=2592000`, i.e. 30 days).
const dshBridgeCookieLifetime = Duration(days: 30);

/// Exchanges [password] for the bridge's session cookie on [baseUri].
///
/// One call is one attempt: no retries, no cache, no shared state. The caller
/// owns the result — a bridge session can be revoked server-side at any time,
/// so a long-lived link logs in again on each connect instead of storing it.
///
/// Throws [DshHttpException] with status 401/403 when the password (or the
/// Host fence) was refused, [DshProtocolException] when the answer carried no
/// usable `dsh_bridge_auth` cookie, and [DshTransportException] when nothing
/// answered.
Future<DshCookie> loginDshBridge(
  Uri baseUri,
  String password, {
  HttpClient? httpClient,
  Duration connectTimeout = const Duration(seconds: 10),
  Duration requestTimeout = const Duration(seconds: 15),
}) async {
  final connection = DshConnection(
    baseUri,
    httpClient: httpClient,
    connectTimeout: connectTimeout,
    requestTimeout: requestTimeout,
  );
  try {
    final response = await connection.postJson(dshBridgeLoginPath, {'password': password});
    if (response.statusCode != 200) {
      throw DshHttpException(
        response.statusCode,
        response.statusCode == 401 || response.statusCode == 403
            ? 'bridge rejected the access password'
            : 'unexpected bridge login response',
        body: response.text,
      );
    }
    final authority = DshConnection.authorityOf(baseUri);
    final minted = response.setCookies
        .map((raw) => parseSetCookie(raw, authority))
        .whereType<DshCookie>()
        .where((cookie) => cookie.name == dshBridgeCookieName && cookie.value.isNotEmpty)
        .firstOrNull;
    if (minted == null) {
      throw const DshProtocolException('bridge login carried no dsh_bridge_auth cookie');
    }
    return DshCookie(
      name: minted.name,
      value: minted.value,
      authority: minted.authority,
      expiresAt: minted.expiresAt ?? DateTime.now().add(dshBridgeCookieLifetime),
    );
  } finally {
    connection.close();
  }
}

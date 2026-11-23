import 'dart:async';
import 'dart:io';

import 'package:dsh_client/dsh_client.dart';

import '../../l10n/l10n.dart';
import '../link_status.dart';
import 'doh_resolver.dart';
import 'web_host_config.dart';

/// Opens a [DshClient] for one 远程 DSH. Injectable so tests can assert which
/// credential was used without a server.
typedef WebClientConnector = Future<DshClient> Function({
  required Uri baseUri,
  DshCookie? cookie,
  String? token,
  HttpClient? httpClient,
  HttpClient Function()? httpClientFactory,
});

/// Signs in to `dsh-bridge`; injectable for the same reason.
typedef BridgeLogin = Future<DshCookie> Function(Uri baseUri, String password, {HttpClient? httpClient});

Future<DshClient> _defaultConnector({
  required Uri baseUri,
  DshCookie? cookie,
  String? token,
  HttpClient? httpClient,
  HttpClient Function()? httpClientFactory,
}) {
  if (cookie == null && token == null) {
    // A bare `dsh web` that asks for no credential. It is only reachable on a
    // loopback the phone itself trusts, so there is nothing to log in with.
    final connection = DshConnection(baseUri, httpClient: httpClient);
    final client = DshClient(connection);
    return client.mux.ready().then((_) => client, onError: (Object error, StackTrace stack) async {
      await client.close().catchError((_) {});
      Error.throwWithStackTrace(error, stack);
    });
  }
  return DshClient.connect(
    baseUri: baseUri,
    cookie: cookie,
    token: cookie == null ? token : null,
    httpClient: httpClient,
    httpClientFactory: httpClientFactory,
  );
}

/// A DSH reached over plain HTTP: `dsh-bridge` behind an access password, or a
/// `dsh web` on the same network behind its launch token.
///
/// There is no transport to keep alive — no SSH session, no tunnel — so this
/// link is thin: sign in, connect, watch the mux, and reconnect with the same
/// [Backoff] as every other host when the connection drops. The bridge cookie
/// is minted on every connect and never stored: the Host can revoke a bridge
/// session at any time, and the password is the durable credential.
class WebHostLink implements HostLink {
  WebHostLink({
    required this._config,
    required this._loadSecrets,
    BridgeLogin? login,
    WebClientConnector? connectClient,
    Stream<void>? kicks,
    Backoff? backoff,
    DohResolver? resolver,
    this.retryFirstOpen = true,
    this.probeTimeout = const Duration(seconds: 5),
  }) : _login = login ?? loginDshBridge,
       _connectClient = connectClient ?? _defaultConnector,
       _resolver = resolver ?? DohResolver(),
       _backoff = backoff ?? Backoff() {
    _kickSub = kicks?.listen((_) => kick());
  }

  WebHostConfig _config;
  final Future<WebHostSecrets> Function() _loadSecrets;
  final BridgeLogin _login;
  final WebClientConnector _connectClient;
  final DohResolver _resolver;
  final Backoff _backoff;

  /// The DoH-backed client of the current attempt; closed when it is replaced
  /// or the link closes, since [DshConnection] does not own an injected client.
  HttpClient? _dohHttp;

  /// A fresh client for one attempt, or null when the platform resolver is
  /// fine. Previous attempt's client is closed first: it holds its own sockets.
  HttpClient? _openHttp() {
    _dohHttp?.close(force: true);
    _dohHttp = null;
    if (!_config.doh) return null;
    return _dohHttp = _resolver.client();
  }

  /// The same resolver for the client's isolated bounded GETs; those close the
  /// client they were given, so each call gets its own.
  HttpClient Function()? get _httpFactory => _config.doh ? _resolver.client : null;

  /// Bounds the health check a network change triggers.
  final Duration probeTimeout;

  /// False for "测试连接": report the first failure instead of retrying.
  final bool retryFirstOpen;

  final _statuses = StreamController<HostLinkStatus>.broadcast(sync: true);
  final _clients = StreamController<DshClient>.broadcast();
  final _delay = InterruptibleDelay();
  StreamSubscription<void>? _kickSub;
  StreamSubscription<DshConnectionState>? _muxSub;
  HostLinkStatus _status = HostLinkStatus.idle;

  DshClient? _client;
  Future<DshClient>? _opening;
  bool _closed = false;
  bool _recovering = false;

  WebHostConfig get config => _config;

  /// Takes a rename without touching the connection.
  void updateConfig(WebHostConfig next) => _config = _config.copyWith(name: next.name);

  @override
  HostLinkStatus get status => _status;

  @override
  DshClient? get currentClient => _status.isConnected ? _client : null;

  @override
  Stream<HostLinkStatus> get statuses => _statuses.stream;

  @override
  Stream<DshClient> get clients => _clients.stream;

  void _emit(HostLinkStatus next) {
    if (_closed && next.phase != HostLinkPhase.idle) return;
    _status = next;
    _statuses.add(next);
  }

  @override
  Future<DshClient> open() {
    if (_closed) return Future.error(StateError('link closed'));
    final client = _client;
    if (client != null && _status.isConnected) return Future.value(client);
    return _opening ??= _openFirst().whenComplete(() => _opening = null);
  }

  Future<DshClient> _openFirst() async {
    _backoff.reset();
    _emit(const HostLinkStatus(HostLinkPhase.connecting, step: HostLinkStep.connect));
    try {
      return await _connectOnce();
    } on HostLinkError catch (e) {
      if (!e.retryable || !retryFirstOpen) {
        _fail(e);
        rethrow;
      }
      return _recover(e);
    } catch (e) {
      final error = HostLinkError(
        HostLinkErrorKind.other,
        appL10n.remoteDshHostErrConnect,
        detail: '$e',
        retryable: true,
      );
      if (!retryFirstOpen) {
        _fail(error);
        throw error;
      }
      return _recover(error);
    }
  }

  void _fail(HostLinkError error) {
    _emit(HostLinkStatus(HostLinkPhase.failed, step: _status.step, completed: _status.completed, error: error));
  }

  void _checkOpen() {
    if (_closed) throw StateError('link closed');
  }

  /// One full attempt: read the stored credential, sign in to the bridge when
  /// that is the credential, connect, publish the client.
  Future<DshClient> _connectOnce() async {
    var step = _status.withStep(HostLinkStep.connect, detail: _config.baseUrl);
    void at(HostLinkStep s, {String? detail}) {
      step = step.withStep(s, detail: detail);
      _emit(step);
    }

    at(HostLinkStep.connect, detail: _config.baseUrl);
    final secrets = await _loadSecrets();
    _checkOpen();
    // One DoH-backed client per attempt; null keeps the platform resolver.
    final httpClient = _openHttp();
    final password = secrets.passwordOrNull;
    final token = secrets.tokenOrNull;
    final base = _config.baseUri;
    DshCookie? cookie;
    if (password != null) {
      at(HostLinkStep.login);
      try {
        cookie = await _login(base, password, httpClient: httpClient);
      } on DshHttpException catch (e) {
        throw _httpError(e, password: true);
      } on DshTransportException catch (e) {
        throw HostLinkError(
          HostLinkErrorKind.unreachable,
          appL10n.remoteDshHostErrUnreachable,
          detail: e.message,
          retryable: true,
        );
      } on DshException catch (e) {
        throw HostLinkError(
          HostLinkErrorKind.unreachable,
          appL10n.remoteDshHostErrUnreachable,
          detail: '$e',
          retryable: true,
        );
      }
    } else if (token == null) {
      throw HostLinkError(HostLinkErrorKind.authFailed, appL10n.remoteDshHostErrNoCredential);
    }
    _checkOpen();

    at(HostLinkStep.login);
    final DshClient client;
    try {
      client = await _connectClient(
        baseUri: base,
        cookie: cookie,
        token: cookie == null ? token : null,
        httpClient: httpClient,
        httpClientFactory: _httpFactory,
      );
    } on DshHttpException catch (e) {
      throw _httpError(e, password: password != null);
    } on DshTransportException catch (e) {
      throw HostLinkError(
        HostLinkErrorKind.unreachable,
        appL10n.remoteDshHostErrUnreachable,
        detail: e.message,
        retryable: true,
      );
    } on TimeoutException catch (e) {
      throw HostLinkError(HostLinkErrorKind.dshTimeout, appL10n.remoteDshHostErrConnect, detail: '$e', retryable: true);
    } on DshException catch (e) {
      throw HostLinkError(HostLinkErrorKind.other, appL10n.remoteDshHostErrConnect, detail: '$e', retryable: true);
    }
    if (_closed) {
      await client.close().catchError((_) {});
      throw StateError('link closed');
    }
    final previous = _client;
    _client = client;
    _watchMux(client);
    if (previous != null) {
      _clients.add(client);
      unawaited(previous.close().catchError((_) {}));
    }
    _emit(HostLinkStatus(HostLinkPhase.connected, completed: HostLinkStep.values.toSet(), detail: _config.baseUrl));
    return client;
  }

  /// A refused credential is the person's to fix; a refused request or an
  /// unexpected status keeps retrying, because the Host may be mid-restart.
  HostLinkError _httpError(DshHttpException e, {required bool password}) {
    final auth = e.statusCode == 401 || e.statusCode == 403;
    return HostLinkError(
      auth ? HostLinkErrorKind.authFailed : HostLinkErrorKind.other,
      auth
          ? (password ? appL10n.remoteDshHostErrPassword : appL10n.remoteDshHostErrToken)
          : appL10n.remoteDshHostErrConnect,
      detail: '${e.statusCode}: ${e.message}',
      retryable: !auth,
    );
  }

  void _watchMux(DshClient client) {
    unawaited(_muxSub?.cancel());
    _muxSub = client.mux.states.listen((state) {
      if (!identical(client, _client)) return;
      switch (state) {
        case DshConnectionState.unauthorized:
          _lost(HostLinkError(HostLinkErrorKind.authFailed, appL10n.remoteDshHostErrSignInExpired, retryable: true));
        case DshConnectionState.closed:
          // The mux gave up on its own carrier; nothing here can revive it, only
          // a fresh client can.
          _lost(HostLinkError(HostLinkErrorKind.unreachable, appL10n.remoteDshHostErrUnreachable, retryable: true));
        case DshConnectionState.idle ||
            DshConnectionState.connecting ||
            DshConnectionState.connected ||
            DshConnectionState.reconnecting:
          break;
      }
    });
  }

  /// Is the Host still answering? Asks on resume and on a network change, which
  /// is exactly when the system may have frozen the socket behind our back.
  Future<void> _probe() async {
    final client = _client;
    if (client == null || !_status.isConnected) return;
    DshHealth health;
    try {
      health = await client.connection.checkHealth(timeout: probeTimeout);
    } on Object {
      // A suspended socket surfaces as an exception, not as a status code. It
      // is as dead as a refused connection: rebuild instead of staying quiet.
      health = DshHealth.unreachable;
    }
    if (!identical(client, _client)) return;
    switch (health) {
      case DshHealth.ok:
        // The HTTP side answers, but the chat stream rides the mux: a socket
        // that died while the App was in the background never fires an error,
        // so a mux that is not connected means a client that must be rebuilt.
        if (client.mux.state == DshConnectionState.connected) return;
        _backoff.reset();
        _lost(HostLinkError(HostLinkErrorKind.unreachable, appL10n.remoteDshHostErrUnreachable, retryable: true));
      case DshHealth.unauthorized:
        _backoff.reset();
        _lost(HostLinkError(HostLinkErrorKind.authFailed, appL10n.remoteDshHostErrSignInExpired, retryable: true));
      case DshHealth.unreachable:
        _backoff.reset();
        _lost(HostLinkError(HostLinkErrorKind.unreachable, appL10n.remoteDshHostErrUnreachable, retryable: true));
    }
  }

  void _lost(HostLinkError reason) {
    if (_closed || _recovering || _status.phase != HostLinkPhase.connected) return;
    final client = _client;
    _client = null;
    if (client != null) unawaited(client.close().catchError((_) {}));
    unawaited(_recover(reason).then((_) {}, onError: (_) {}));
  }

  /// Reconnect loop with backoff. Resolves with the (possibly new) client.
  Future<DshClient> _recover(HostLinkError reason) async {
    _recovering = true;
    var last = reason;
    try {
      while (!_closed) {
        if (_backoff.exhausted) {
          final error = HostLinkError(
            last.kind,
            last.message,
            detail: [if (last.detail != null) last.detail!, appL10n.remoteRetryCount(_backoff.attempt)].join('\n'),
            retryable: true,
          );
          _fail(error);
          throw error;
        }
        final delay = _backoff.next();
        _emit(
          HostLinkStatus(
            HostLinkPhase.reconnecting,
            attempt: _backoff.attempt,
            error: last,
            nextRetryAt: DateTime.now().add(delay),
          ),
        );
        await _delay.wait(delay);
        if (_closed) break;
        try {
          final client = await _connectOnce();
          _backoff.reset();
          return client;
        } on HostLinkError catch (e) {
          if (_closed) break;
          if (!e.retryable) {
            _fail(e);
            rethrow;
          }
          last = e;
        } catch (e) {
          if (_closed) break;
          last = HostLinkError(HostLinkErrorKind.other, appL10n.remoteDshHostErrConnect, detail: '$e', retryable: true);
        }
      }
      throw StateError('link closed');
    } finally {
      _recovering = false;
    }
  }

  @override
  void kick() {
    if (_closed) return;
    switch (_status.phase) {
      case HostLinkPhase.connected:
        unawaited(_probe());
      case HostLinkPhase.reconnecting:
        _backoff.reset();
        _delay.skip();
      case HostLinkPhase.failed:
        if (_status.error?.retryable ?? false) retry();
      case HostLinkPhase.idle || HostLinkPhase.connecting:
        break;
    }
  }

  @override
  void retry() {
    if (_closed || _status.isBusy && _status.phase != HostLinkPhase.reconnecting) return;
    if (_status.phase == HostLinkPhase.reconnecting) {
      _backoff.reset();
      _delay.skip();
      return;
    }
    if (_status.phase == HostLinkPhase.failed || _status.phase == HostLinkPhase.idle) {
      unawaited(open().then((_) {}, onError: (_) {}));
    }
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _emit(HostLinkStatus.idle);
    _closed = true;
    _delay.cancel();
    await _kickSub?.cancel();
    await _muxSub?.cancel();
    _dohHttp?.close(force: true);
    _dohHttp = null;
    final client = _client;
    _client = null;
    if (client != null) await client.close().catchError((_) {});
    await _statuses.close();
    await _clients.close();
  }
}

import 'dart:async';
import 'dart:io';

import 'package:dsh_client/dsh_client.dart' show WorkspaceBaseline;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import '../../remote/web/lan_discovery.dart';
import '../../remote/web/web_host_link.dart';
import '../../state/hosts_state.dart';
import '../common/app_dialog.dart';
import '../common/discard_guard.dart';
import '../common/form_bar.dart';
import '../common/smooth_size.dart';
import '../providers/provider_widgets.dart' show FormFieldBlock, FormFieldGroup;
import '../settings/credential_recovery_dialog.dart';
import '../settings/settings_widgets.dart';
import '../shell/page_frame.dart';
import '../theme/app_icons.dart';
import '../theme/theme.dart';
import 'link_progress.dart';

/// Which credential a 远程 DSH takes: dsh-bridge wants its access password, a
/// bare `dsh web` wants the launch token it printed on start.
enum WebHostCredentialMode { password, token }

/// Add or edit a 远程 DSH (dsh-bridge or a `dsh web` on this network), with a
/// "扫描局域网" helper and a "测试连接" that runs the real connect flow.
class WebHostFormPage extends ConsumerStatefulWidget {
  const WebHostFormPage({super.key, this.existing});

  /// Null to add a new host.
  final WebHostConfig? existing;

  @override
  ConsumerState<WebHostFormPage> createState() => _WebHostFormPageState();
}

class _WebHostFormPageState extends ConsumerState<WebHostFormPage> {
  late final String _id = widget.existing?.id ?? WebHostConfig.newId();
  late bool _doh = widget.existing?.doh ?? false;
  late final _name = TextEditingController(text: widget.existing?.name ?? '');
  late final _address = TextEditingController(text: widget.existing?.baseUrl ?? '');
  final _password = TextEditingController();
  final _token = TextEditingController();

  WebHostCredentialMode _mode = WebHostCredentialMode.password;
  bool _obscure = true;
  bool _saving = false;
  String? _formError;
  Map<_F, String> _errors = const {};
  final _fieldKeys = {for (final f in _F.values) f: GlobalKey()};

  bool _scanning = false;
  bool _scanned = false;
  List<LanDshCandidate> _candidates = const [];

  WebHostLink? _test;
  StreamSubscription<HostLinkStatus>? _testSub;
  HostLinkStatus? _testStatus;

  /// Workspaces the test-connection's Host reported, when it answered.
  int? _workspaceCount;

  bool get _editing => widget.existing != null;

  /// An IP literal needs no resolver; the switch is pointless there.
  static bool _isIpLiteral(String baseUrl) {
    final host = Uri.tryParse(baseUrl)?.host ?? '';
    return InternetAddress.tryParse(host) != null;
  }

  late String _clean = _signature();
  late final Listenable _edits = Listenable.merge([_name, _address, _password, _token]);

  String _signature() => [
    _name.text,
    _address.text,
    _password.text,
    _token.text,
    _mode.name,
    _doh ? 'doh' : '',
  ].join('\u0000');

  @override
  void initState() {
    super.initState();
    if (_editing) unawaited(_loadSecrets());
  }

  Future<void> _loadSecrets() async {
    final typedPassword = _password.text;
    final typedToken = _token.text;
    final WebHostSecrets secrets;
    try {
      secrets = await ref.read(hostsProvider.notifier).loadWebSecrets(_id);
    } catch (_) {
      return;
    }
    if (!mounted) return;
    setState(() {
      // What the person typed (or pasted) while storage was read wins.
      if (_password.text == typedPassword && secrets.passwordOrNull != null) _password.text = secrets.passwordOrNull!;
      if (_token.text == typedToken && secrets.tokenOrNull != null) _token.text = secrets.tokenOrNull!;
      _mode = secrets.tokenOrNull != null ? WebHostCredentialMode.token : WebHostCredentialMode.password;
      _clean = _signature();
    });
  }

  @override
  void dispose() {
    unawaited(_testSub?.cancel());
    unawaited(_test?.close());
    for (final c in [_name, _address, _password, _token]) {
      c.dispose();
    }
    super.dispose();
  }

  WebHostSecrets get _secrets => WebHostSecrets(
    password: _mode == WebHostCredentialMode.password ? _password.text : null,
    token: _mode == WebHostCredentialMode.token ? _token.text.trim() : null,
  );

  /// The host as typed and the credential to use; null (with [_errors] set)
  /// when something is missing. A pasted `…/?token=…` URL gives up its token
  /// and is stored as a bare origin.
  ({WebHostConfig config, WebHostSecrets secrets})? _draft() {
    final typed = _address.text.trim();
    final address = WebAddress.tryParse(typed);
    // A pasted `…/?token=…` URL carries the launch token: it moves into the
    // token field and the address keeps its origin.
    final urlToken = address?.token;
    if (urlToken != null && _token.text.isEmpty) _token.text = urlToken;
    final mode = urlToken != null ? WebHostCredentialMode.token : _mode;
    final errors = <_F, String>{
      if (typed.isEmpty) _F.address: context.l10n.remoteDshHostAddressRequired,
      if (typed.isNotEmpty && address == null) _F.address: context.l10n.remoteDshHostAddressInvalid,
      if (mode == WebHostCredentialMode.password && _password.text.isEmpty)
        _F.password: context.l10n.remoteDshHostPasswordRequired,
      if (mode == WebHostCredentialMode.token && _token.text.trim().isEmpty)
        _F.token: context.l10n.remoteDshHostTokenRequired,
    };
    setState(() {
      _errors = errors;
      _formError = null;
      _mode = mode;
      if (address != null && address.baseUrl != typed) _address.text = address.baseUrl;
    });
    if (errors.isNotEmpty) {
      _revealFirstError();
      return null;
    }
    final baseUri = address!.baseUrl;
    return (
      config: WebHostConfig(
        id: _id,
        name: _name.text.trim().isEmpty ? WebAddress.hostOf(baseUri) : _name.text.trim(),
        baseUrl: baseUri,
        doh: _doh && !_isIpLiteral(baseUri),
      ),
      secrets: _secrets,
    );
  }

  void _revealFirstError() {
    final first = _F.values.firstWhere(_errors.containsKey);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final target = _fieldKeys[first]!.currentContext;
      if (target == null || !target.mounted) return;
      unawaited(
        Scrollable.ensureVisible(
          target,
          alignment: 0.3,
          duration: AppMotion.of(context, AppMotion.emphasized),
          curve: AppMotion.glide,
        ),
      );
    });
  }

  void _edited(_F field) {
    if (_errors.containsKey(field)) setState(() => _errors = {..._errors}..remove(field));
  }

  Future<void> _scan() async {
    setState(() {
      _scanning = true;
      _scanned = false;
      _candidates = const [];
    });
    List<LanDshCandidate> found;
    try {
      found = await discoverLanDsh();
    } catch (_) {
      found = const [];
    }
    if (!mounted) return;
    setState(() {
      _scanning = false;
      _scanned = true;
      _candidates = found;
    });
  }

  /// One tap fills the address (and the credential the Host asks for) in.
  void _pick(LanDshCandidate candidate) {
    setState(() {
      _address.text = candidate.baseUri.toString();
      _mode = candidate.kind == LanDshKind.bridge
          ? WebHostCredentialMode.password
          : WebHostCredentialMode.token;
      _errors = {..._errors}..remove(_F.address);
      _testStatus = null;
      _workspaceCount = null;
    });
  }

  Future<void> _runTest() async {
    FocusManager.instance.primaryFocus?.unfocus();
    final draft = _draft();
    if (draft == null) return;
    await _testSub?.cancel();
    await _test?.close();
    final secrets = draft.secrets;
    final link = WebHostLink(
      config: draft.config,
      loadSecrets: () async => secrets,
      // The form's own link reports the first failure; retrying is the
      // person's call here, not a background loop.
      retryFirstOpen: false,
    );
    _test = link;
    setState(() {
      _testStatus = const HostLinkStatus(HostLinkPhase.connecting, step: HostLinkStep.connect);
      _workspaceCount = null;
    });
    _testSub = link.statuses.listen((s) {
      if (mounted && s.phase != HostLinkPhase.idle) setState(() => _testStatus = s);
    });
    try {
      final client = await link.open();
      final update = await client.watchWorkspaces().first.timeout(const Duration(seconds: 10));
      if (mounted) setState(() => _workspaceCount = update is WorkspaceBaseline ? update.workspaces.length : null);
    } catch (_) {
      // Shown in the progress card.
    } finally {
      await _testSub?.cancel();
      _testSub = null;
      if (identical(_test, link)) {
        _test = null;
        if (mounted) setState(() {});
      }
      await link.close();
    }
  }

  Future<void> _save() async {
    FocusManager.instance.primaryFocus?.unfocus();
    final draft = _draft();
    if (draft == null) return;
    setState(() => _saving = true);
    try {
      final saved = await ref.read(hostsProvider.notifier).saveWeb(draft.config, secrets: draft.secrets);
      if (!mounted) return;
      if (!saved) {
        setState(() => _formError = context.l10n.commonSaveFailed);
        return;
      }
      Navigator.of(context).pop(draft.config);
    } catch (e) {
      if (mounted) {
        setState(() => _formError = context.l10n.commonSaveFailed);
        // Nothing was saved: the form stays filled in.
        await offerCredentialRecovery(context, ref, e);
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _delete() async {
    final name = widget.existing!.name;
    final ok = await showAppDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(context.l10n.remoteDeleteHostTitle(name)),
        content: Text(context.l10n.remoteDeleteHostBody),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog, false), child: Text(context.l10n.commonCancel)),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: DshColors.of(dialog).danger,
              foregroundColor: DshColors.of(dialog).onDanger,
            ),
            onPressed: () => Navigator.pop(dialog, true),
            child: Text(context.l10n.commonDelete),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await ref.read(hostsProvider.notifier).removeWeb(_id);
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final colors = DshColors.of(context);
    final testing = _test != null;
    final mono = AppType.mono(size: 15, color: scheme.onSurface, height: 1.4);

    final page = AppPage.list(
      title: _editing ? l10n.remoteEditHost : l10n.remoteDshHostAdd,
      subtitle: Text(l10n.remoteDshHostIntro),
      children: [
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SettingsSection(
              title: l10n.remoteHostBasicInfo,
              children: [
                FormFieldGroup(
                  children: [
                    FormFieldBlock(
                      label: l10n.commonName,
                      child: TextField(
                        controller: _name,
                        textInputAction: TextInputAction.next,
                        decoration: InputDecoration(hintText: l10n.remoteHostNameHint),
                      ),
                    ),
                    FormFieldBlock(
                      key: _fieldKeys[_F.address],
                      error: _errors[_F.address],
                      label: l10n.remoteDshHostAddress,
                      child: TextField(
                        controller: _address,
                        keyboardType: TextInputType.url,
                        autocorrect: false,
                        textInputAction: TextInputAction.next,
                        style: mono,
                        onChanged: (_) => _edited(_F.address),
                        decoration: InputDecoration(
                          hintText: l10n.remoteDshHostAddressHint,
                          error: _errors[_F.address] == null ? null : const SizedBox.shrink(),
                        ),
                      ),
                    ),
                  ],
                ),
                SettingsSwitchTile(
                  icon: AppIcons.search,
                  tinted: false,
                  title: l10n.remoteDshHostDoh,
                  subtitle: l10n.remoteDshHostDohHelp,
                  value: _doh,
                  onChanged: (v) => setState(() {
                    _doh = v;
                    _testStatus = null;
                  }),
                ),
              ],
            ),
            SettingsSection(
              title: l10n.remoteDshHostCredential,
              footer: Text(l10n.remoteDshHostStorageHelp),
              children: [
                FormFieldGroup(
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: SegmentedPill<WebHostCredentialMode>(
                        segments: [
                          PillSegment(WebHostCredentialMode.password, l10n.remoteDshHostPassword),
                          PillSegment(WebHostCredentialMode.token, l10n.remoteDshHostToken),
                        ],
                        selected: _mode,
                        onChanged: (v) => setState(() {
                          _mode = v;
                          _testStatus = null;
                        }),
                      ),
                    ),
                    if (_mode == WebHostCredentialMode.password)
                      FormFieldBlock(
                        key: _fieldKeys[_F.password],
                        error: _errors[_F.password],
                        label: l10n.remoteDshHostPassword,
                        helper: l10n.remoteDshHostPasswordHelp,
                        child: TextField(
                          controller: _password,
                          obscureText: _obscure,
                          obscuringCharacter: '•',
                          autocorrect: false,
                          enableSuggestions: false,
                          enableIMEPersonalizedLearning: false,
                          keyboardType: TextInputType.visiblePassword,
                          onChanged: (_) => _edited(_F.password),
                          decoration: InputDecoration(
                            error: _errors[_F.password] == null ? null : const SizedBox.shrink(),
                            suffixIcon: IconButton(
                              tooltip: _obscure ? l10n.remoteShow : l10n.commonHide,
                              icon: Icon(_obscure ? AppIcons.showSecret : AppIcons.hideSecret, size: 20),
                              onPressed: () => setState(() => _obscure = !_obscure),
                            ),
                          ),
                        ),
                      )
                    else
                      FormFieldBlock(
                        key: _fieldKeys[_F.token],
                        error: _errors[_F.token],
                        label: l10n.remoteDshHostToken,
                        helper: l10n.remoteDshHostTokenHelp,
                        child: TextField(
                          controller: _token,
                          obscureText: true,
                          obscuringCharacter: '•',
                          autocorrect: false,
                          enableSuggestions: false,
                          enableIMEPersonalizedLearning: false,
                          onChanged: (_) => _edited(_F.token),
                          decoration: InputDecoration(
                            error: _errors[_F.token] == null ? null : const SizedBox.shrink(),
                          ),
                        ),
                      ),
                  ],
                ),
              ],
            ),
            SettingsSection(
              title: l10n.remoteDshHostScan,
              footer: _scanned && _candidates.isEmpty && !_scanning ? Text(l10n.remoteDshHostScanEmpty) : null,
              children: [
                SettingsTile(
                  icon: AppIcons.search,
                  tinted: false,
                  title: _scanning ? l10n.remoteDshHostScanning : l10n.remoteDshHostScan,
                  subtitle: _candidates.isEmpty ? null : l10n.remoteDshHostScanHint,
                  trailing: _scanning
                      ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2))
                      : null,
                  onTap: _scanning ? null : () => unawaited(_scan()),
                ),
                for (final candidate in _candidates)
                  SettingsTile(
                    key: ValueKey('lan-dsh-${candidate.address}'),
                    icon: candidate.kind == LanDshKind.bridge ? AppIcons.lock : AppIcons.webConsole,
                    tinted: false,
                    title: candidate.title ?? candidate.address,
                    subtitle:
                        '${candidate.kind == LanDshKind.bridge ? l10n.remoteDshHostScanBridge : l10n.remoteDshHostScanDsh}'
                        ' · ${candidate.address}',
                    onTap: () => _pick(candidate),
                  ),
              ],
            ),
            _Reveal(
              child: _testStatus == null
                  ? const SizedBox(width: double.infinity)
                  : Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          LinkProgressCard(
                            status: _testStatus!,
                            steps: const [HostLinkStep.connect, HostLinkStep.login],
                            onRetry: testing ? null : () => unawaited(_runTest()),
                          ),
                          if (_workspaceCount case final count?)
                            Padding(
                              padding: const EdgeInsets.fromLTRB(4, 8, 4, 0),
                              child: Text(
                                l10n.remoteDshHostConnected(count),
                                style: theme.textTheme.bodySmall?.copyWith(color: colors.success),
                              ),
                            ),
                        ],
                      ),
                    ),
            ),
            if (_formError case final error?)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
                child: Text(error, style: theme.textTheme.bodySmall?.copyWith(color: colors.danger)),
              ),
            if (_editing)
              Center(
                child: TextButton.icon(
                  style: TextButton.styleFrom(foregroundColor: colors.danger),
                  onPressed: _delete,
                  icon: const Icon(AppIcons.delete, size: 19),
                  label: Text(l10n.remoteDeleteHost),
                ),
              ),
            const SizedBox(height: FormBar.height),
          ],
        ),
      ],
    );

    return DiscardGuard(
      listenable: _edits,
      isDirty: () => !_saving && _signature() != _clean,
      child: Stack(
        children: [
          page,
          Positioned(
            left: 0,
            right: 0,
            bottom: MediaQuery.viewInsetsOf(context).bottom,
            child: FormBar(
              children: [
                Expanded(
                  child: FilledButton.tonalIcon(
                    onPressed: testing || _saving ? null : () => unawaited(_runTest()),
                    icon: testing
                        ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(AppIcons.testConnection, size: 19),
                    label: Text(testing ? l10n.remoteTesting : l10n.remoteTestConnection),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: _saving ? null : () => unawaited(_save()),
                    child: Text(l10n.commonSave),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The fields of the form.
enum _F { address, password, token }

/// [AnimatedSize] unless animations are off (a zero-duration AnimatedSize
/// re-dirties itself during layout).
class _Reveal extends StatelessWidget {
  const _Reveal({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final duration = AppMotion.of(context, AppMotion.standard);
    if (duration == Duration.zero) return child;
    return SmoothSize(duration: duration, curve: AppMotion.std, alignment: Alignment.topCenter, child: child);
  }
}

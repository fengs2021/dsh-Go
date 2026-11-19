// 兜底翻译通道:引擎没有(或没启用)官方 cot-translation 插件时,App 自己
// 请求微软 Edge 的免费端点,口径与插件的 bing 服务一致。

import 'dart:convert';

import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/cot_translation_state.dart';
import 'package:dsh_app/state/local_translation.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// A host without the bundle: `cotTranslation/limits` is not an RPC there, so
/// the call fails (a closed port answers immediately).
final _host = HostConnection(client: DshClient(DshConnection(Uri.parse('http://127.0.0.1:9'))), isLocal: true);

MockClient _service({
  required List<Map<String, Object?>> groups,
  int status = 200,
  void Function(http.Request request)? seen,
}) => MockClient((request) async {
  seen?.call(request);
  final body = status == 200 ? jsonEncode(groups) : '[]';
  return http.Response.bytes(utf8.encode(body), status, headers: {'content-type': 'application/json'});
});

void main() {
  group('BingTranslator', () {
    test('posts the fragment as JSON and joins the translated groups', () async {
      http.Request? sent;
      final translator = BingTranslator(
        client: _service(
          groups: [
            {
              'translations': [
                {'text': '用户希望连点登录按钮时只发出一次请求。', 'to': 'zh-Hans'},
              ],
            },
            {
              'translations': [
                {'text': '我应该在请求进行中禁用按钮。', 'to': 'zh-Hans'},
              ],
            },
          ],
          seen: (request) => sent = request,
        ),
      );
      final translated = await translator.translate('Two sentences.', target: 'zh');
      expect(translated, '用户希望连点登录按钮时只发出一次请求。我应该在请求进行中禁用按钮。');
      expect(sent!.method, 'POST');
      expect(sent!.url.host, 'edge.microsoft.com');
      expect(sent!.url.path, '/translate/translatetext');
      expect(sent!.url.queryParameters, {'to': 'zh-Hans', 'isEnterpriseClient': 'false'});
      expect(sent!.headers['content-type'], startsWith('application/json'));
      expect(jsonDecode(sent!.body), ['Two sentences.']);
    });

    test('an error status or an empty payload throws, so the original is kept', () async {
      final failing = BingTranslator(client: _service(groups: const [], status: 429));
      await expectLater(failing.translate('Hello.', target: 'zh'), throwsA(isA<StateError>()));
      final empty = BingTranslator(client: _service(groups: const []));
      await expectLater(empty.translate('Hello.', target: 'zh'), throwsA(isA<StateError>()));
    });

    test('language codes: zh needs a region, others pass through', () {
      expect(bingLanguage('zh'), 'zh-Hans');
      expect(bingLanguage('zh-Hant'), 'zh-Hant');
      expect(bingLanguage('zh-tw'), 'zh-Hant');
      expect(bingLanguage('en'), 'en');
      expect(bingLanguage('ja'), 'ja');
    });
  });

  group('fallback wiring', () {
    ProviderContainer container({LocalTranslate? local}) {
      final c = ProviderContainer(
        overrides: [
          activeConnectionProvider.overrideWithValue(AsyncData<HostConnection?>(_host)),
          localTranslatorProvider.overrideWithValue(local),
        ],
      );
      addTearDown(c.dispose);
      return c;
    }

    test('a host without the bundle falls back to the app own channel', () async {
      final limits = await container(local: (text, {required target}) async => '译文').read(cotTranslationProvider.future);
      expect(limits, isNotNull);
      expect(limits!.provider, localTranslationProvider);
      expect(limits.usable, isTrue);
      expect(limits.targetFor('zh'), 'zh');
    });

    test('the translator sends local limits to the fallback and host limits to the host', () async {
      final asked = <(String, String)>[];
      final c = container(local: (text, {required target}) async {
        asked.add((text, target));
        return '译文';
      });
      final translate = c.read(reasoningTranslatorProvider)!;
      expect(await translate('Two sentences.', limits: localTranslationLimits), '译文');
      expect(asked, hasLength(1));
      expect(asked.single.$2, reasoningUiLanguage);
    });
  });
}

// 官方 cot-translation 插件没装、没启用、或它自己没有任何可用翻译服务时,
// App 自己翻:直接请求微软 Edge 的免登录翻译端点——插件默认用的 bing 就是
// 这个接口,所以译文口径与插件一致。只在展开思考、翻译开关打开时才会走到。

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// A [ReasoningTranslator] that needs no engine (a seam for tests).
typedef LocalTranslate = Future<String> Function(String text, {required String target});

const localTranslationEndpoint = 'https://edge.microsoft.com/translate/translatetext';

/// bing 要带地区的语言码:界面语言的 `zh` 得写成 `zh-Hans`。
String bingLanguage(String target) {
  final code = target.trim().toLowerCase();
  return switch (code) {
    'zh' || 'zh-cn' || 'zh-hans' || 'zh-sg' => 'zh-Hans',
    'zh-tw' || 'zh-hk' || 'zh-hant' => 'zh-Hant',
    '' => 'en',
    _ => target.trim(),
  };
}

/// Posts one fragment to the same free endpoint the bundle's `bing` provider
/// uses and returns the joined translation. A non-200, a payload without text
/// or a timeout throws: [ReasoningTranslation] then keeps the original and
/// offers a retry.
class BingTranslator {
  BingTranslator({this.client, this.endpoint = localTranslationEndpoint, this.timeout = const Duration(seconds: 20)});

  final String endpoint;
  final Duration timeout;

  /// A stub in tests; null posts through a throwaway [http.Client].
  final http.Client? client;

  Future<String> translate(String text, {required String target}) async {
    final uri = Uri.parse(
      endpoint,
    ).replace(queryParameters: {'to': bingLanguage(target), 'isEnterpriseClient': 'false'});
    final client = this.client ?? http.Client();
    try {
      final response = await client
          .post(uri, headers: const {'content-type': 'application/json'}, body: jsonEncode([text]))
          .timeout(timeout);
      if (response.statusCode != 200) {
        throw StateError('translation service answered HTTP ${response.statusCode}');
      }
      final decoded = jsonDecode(utf8.decode(response.bodyBytes));
      if (decoded is! List) throw StateError('unexpected translation payload');
      final parts = <String>[];
      for (final group in decoded) {
        final translations = group is Map ? group['translations'] : null;
        if (translations is! List || translations.isEmpty) continue;
        final first = translations.first;
        final value = first is Map ? first['text'] : null;
        if (value is String && value.isNotEmpty) parts.add(value);
      }
      final translated = parts.join().trim();
      if (translated.isEmpty) throw StateError('the translation service returned nothing');
      return translated;
    } finally {
      if (this.client == null) client.close();
    }
  }
}

// 默认翻译思考过程:展开就翻,不需要先点一次「翻译」。设置关掉后回到
// thinking_translate_test.dart 里那条「点胶囊才翻」的路。

import 'package:dsh_app/state/cot_translation_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/chat/widgets/thinking_pill.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../chat/support/harness.dart';

const _english =
    'The user wants double taps on the login button to send one request.\n\n'
    'I should disable the button while the request is in flight, then '
    're-enable it when the response arrives.';

const _limits = CotTranslationLimits(
  maxTextChars: 4000,
  provider: 'bing',
  targetLanguage: 'auto',
  availableProviders: ['bing', 'google'],
);

const _translations = {
  'The user wants double taps on the login button to send one request.': '用户希望连点登录按钮时只发出一次请求。',
  'I should disable the button while the request is in flight, then '
          're-enable it when the response arrives.':
      '我应该在请求进行中禁用按钮，收到响应后再恢复。',
};

class _Translator {
  final asked = <String>[];

  Future<String> call(String text, {required CotTranslationLimits limits, String? sessionId}) async {
    asked.add(text);
    return _translations[text] ?? text;
  }
}

class _Settings extends SettingsController {
  _Settings(this.value);

  final AppSettings value;

  @override
  AppSettings build() => value;
}

Widget _app(String reasoning, {required bool translateReasoning, _Translator? translator}) => testApp(
  Scaffold(
    body: SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Align(alignment: Alignment.topLeft, child: ThinkingPill(reasoning: reasoning)),
      ),
    ),
  ),
  overrides: [
    currentSessionProvider.overrideWith(() => FixedSession('s1')),
    cotTranslationProvider.overrideWith((ref) async => _limits),
    reasoningTranslatorProvider.overrideWithValue((translator ?? _Translator()).call),
    settingsProvider.overrideWith(() => _Settings(AppSettings(loaded: true, translateReasoning: translateReasoning))),
  ],
);

Future<void> _expand(WidgetTester tester) async {
  await tester.tap(find.text('思考'));
  await pumpFrames(tester, 6);
}

void main() {
  setUpAll(loadTestFonts);

  testWidgets('on by default: expanding translates without asking first', (tester) async {
    final translator = _Translator();
    await tester.pumpWidget(_app(_english, translateReasoning: true, translator: translator));
    await pumpFrames(tester, 2);
    expect(find.text('翻译'), findsNothing);
    await _expand(tester);
    // No chip tap: the translation is already in flight.
    expect(find.text('翻译'), findsNothing);
    expect(find.textContaining('只发出一次请求'), findsOneWidget);
    expect(find.text('查看原文'), findsOneWidget);
    expect(translator.asked, hasLength(2));

    // Back to the original, then collapse and reopen: nothing is re-sent and the
    // reader stays on the original (自动翻译只发生一次)。
    await tester.tap(find.text('查看原文'));
    await pumpFrames(tester, 2);
    expect(find.textContaining('double taps'), findsOneWidget);
    expect(find.text('查看译文'), findsOneWidget);
    await tester.tap(find.text('思考'));
    await pumpFrames(tester, 6);
    await _expand(tester);
    expect(find.textContaining('double taps'), findsOneWidget);
    expect(find.text('查看译文'), findsOneWidget);
    expect(find.text('翻译'), findsNothing);
    expect(translator.asked, hasLength(2));

    // 切回译文仍然不用重新请求。
    await tester.tap(find.text('查看译文'));
    await pumpFrames(tester, 2);
    expect(find.textContaining('只发出一次请求'), findsOneWidget);
    expect(translator.asked, hasLength(2));
  });

  testWidgets('off: the chip still asks first and sends nothing on its own', (tester) async {
    final translator = _Translator();
    await tester.pumpWidget(_app(_english, translateReasoning: false, translator: translator));
    await pumpFrames(tester, 2);
    await _expand(tester);
    expect(find.text('翻译'), findsOneWidget);
    expect(translator.asked, isEmpty);
    expect(find.textContaining('double taps'), findsOneWidget);
  });
}

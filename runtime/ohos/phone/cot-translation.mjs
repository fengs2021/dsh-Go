// Portions derived from DeepSeek Harness (https://github.com/deepseek-ai/deepseek-harness), MIT.
// 原生思考链翻译（cot = chain of thought）。
// App（Flutter）侧早已实现完整界面与 RPC（cotTranslation.limits / translate），引擎侧差的就是这两个官方插件被挂上；
// 手机上没有 npm / profile bundle，所以在宿主插件里动态 import 随包发布的官方插件，再 ctx.plugin 挂到子 fiber 上。

const mountedSymbol = Symbol.for('dsh.go.ohos.cotTranslation');
const simulationSymbol = Symbol.for('dsh.go.ohos.sim');

export const COT_TRANSLATOR = '@deepseek-ai/dsh-experimental-translator';
export const COT_CONTROLLER = '@deepseek-ai/dsh-experimental-client-ui-cot-translation';
// translator 的 Config 只认这四个 provider；深寻两条要密钥，匿名免费的只有 bing 与 google。
// 实测国内 google 端点 20 秒超时不可达，bing 端点 0.45 秒返回，所以默认 bing。
export const COT_PROVIDERS = Object.freeze(['bing', 'google', 'deepseek-account', 'deepseek-official']);
export const DEFAULT_PROVIDER = 'bing';
// targetLanguage 为 auto 时 controller 接受客户端每次请求里带的目标语言（App 按界面语言算）。
export const DEFAULT_TARGET_LANGUAGE = 'auto';

const brief = (value, max = 200) => {
  const text = String(value && value.message ? value.message : value);
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
};

export function pickProvider(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return DEFAULT_PROVIDER;
  return COT_PROVIDERS.includes(value) ? value : DEFAULT_PROVIDER;
}

export function pickTargetLanguage(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value === '' ? DEFAULT_TARGET_LANGUAGE : value;
}

// 优先级是 显式参数 > 环境变量 > 默认值。环境变量只用于装机后临时改，不必重新打包。
export function cotConfig(options = {}, env = process.env) {
  return {
    provider: pickProvider(options.provider !== undefined ? options.provider : env.DSH_GO_COT_PROVIDER),
    targetLanguage: pickTargetLanguage(options.targetLanguage !== undefined ? options.targetLanguage : env.DSH_GO_COT_TARGET),
  };
}

export function cotTranslationActive() {
  return Object.hasOwn(globalThis, mountedSymbol);
}

export function cotTranslationState() {
  return globalThis[mountedSymbol];
}

// 挂上官方 translator 与 cotTranslation controller，返回实际使用的配置；平台不符或已挂过时返回 undefined。
export async function startCotTranslation(ctx, options = {}) {
  const log = options.log || ((line) => console.error('[cot] ' + line));
  const platform = options.platform || process.platform;
  if (platform !== 'openharmony' && globalThis[simulationSymbol] !== true) return undefined;
  if (cotTranslationActive()) {
    log('already mounted in this engine, keeping the first instance');
    return undefined;
  }
  if (!ctx || typeof ctx.plugin !== 'function') {
    log('engine has no ctx.plugin, cannot mount child plugins');
    return undefined;
  }
  const config = cotConfig(options, options.env || process.env);
  const load = options.load || ((name) => import(name));
  let Translator;
  let Controller;
  try {
    const translatorModule = await load(COT_TRANSLATOR);
    const controllerModule = await load(COT_CONTROLLER);
    Translator = translatorModule && translatorModule.default;
    Controller = controllerModule && controllerModule.default;
  } catch (error) {
    log('load failed: ' + brief(error));
    return undefined;
  }
  if (typeof Translator !== 'function' || typeof Controller !== 'function') {
    log('unexpected exports translator=' + typeof Translator + ' controller=' + typeof Controller);
    return undefined;
  }
  // 子 fiber 随宿主插件的 fiber 一起销毁，不需要额外的停机代码。
  const mounted = [];
  const start = (label, plugin, pluginConfig) => {
    try {
      const fiber = ctx.plugin(plugin, pluginConfig);
      // 依赖服务（translator / typert / sessionController）没就绪时 fiber 会一直等着，这里只做观测。
      Promise.resolve(fiber).then(
        () => log('applied ' + label),
        (error) => log('apply failed ' + label + ': ' + brief(error)),
      );
      mounted.push(label);
      log('mount ' + label + ' ' + JSON.stringify(pluginConfig));
    } catch (error) {
      log('mount failed ' + label + ': ' + brief(error));
    }
  };
  start('translator', Translator, { provider: config.provider });
  start('cot-translation', Controller, { provider: config.provider, targetLanguage: config.targetLanguage });
  if (mounted.length === 0) return undefined;
  Object.defineProperty(globalThis, mountedSymbol, { value: Object.freeze({ ...config, mounted }), configurable: true, writable: false });
  return { ...config, mounted };
}

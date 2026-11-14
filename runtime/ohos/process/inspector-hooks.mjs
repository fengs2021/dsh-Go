// ESM 侧：把 node:inspector / inspector 静态解析到 ./inspector-stub.mjs（说明见该文件）。
const STUB_URL = new URL('./inspector-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'node:inspector' || specifier === 'inspector') {
    return { url: STUB_URL, format: 'module', shortCircuit: true };
  }
  return next(specifier, context);
}

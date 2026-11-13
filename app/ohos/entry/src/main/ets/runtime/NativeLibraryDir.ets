// 未在鸿蒙真机核实过：ApplicationInfo.nativeLibraryPath 在 libIsolation 关闭时可能给空串，
// 因此这里在公开 Context 给出的根目录下按真实目录落地校验，绝不拼接未校验的外部输入。
import fs from '@ohos.file.fs';
import { RuntimeChannelError, resolveNativeLibraryDir } from './RuntimeCore';

const ABI_DIRS: string[] = ['arm64', 'arm64-v8a'];
const REQUIRED: string[] = ['libnode.so', 'libdsh_host.so'];

export function resolveNativeLibraryDirForDevice(bundleCodeDir: string, nativeLibraryPath: string): string {
  const root = bundleCodeDir.replace(/\/+$/, '');
  const raw: string = typeof nativeLibraryPath === 'string' ? nativeLibraryPath : '';
  const candidates: string[] = [];
  try {
    candidates.push(resolveNativeLibraryDir(bundleCodeDir, raw));
  } catch (error) {
  }
  for (const abi of ABI_DIRS) candidates.push(root + '/libs/' + abi);
  candidates.push(root + '/libs');
  for (const candidate of candidates) {
    let entries: string[] = [];
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      entries = fs.listFileSync(candidate);
    } catch (error) {
      continue;
    }
    if (REQUIRED.every((name: string): boolean => entries.includes(name))) return candidate;
  }
  throw new RuntimeChannelError('ohos_native_library_path',
    '系统原生库目录无效（bundleCodeDir=' + (root.length === 0 ? '<空>' : root) +
      '，nativeLibraryPath=' + (raw.length === 0 ? '<空>' : raw) + '）。');
}

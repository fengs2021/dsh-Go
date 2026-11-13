// 读取引擎侧导出的后台进度快照（runtime/ohos/phone/progress-feed.mjs 写入）。
// 纯只读：引擎不跑或文件缺失时安静返回 null，绝不打扰用户。
import fs from '@ohos.file.fs';
import { RuntimePaths } from './RuntimePaths';

export interface DanmakuSnapshot {
  v: number;
  updatedAt: number;
  stage: string;
  line: string;
  tool: string;
  step: number;
  steps: number;
  status: string;
  elapsedMs: number;
  quietMs: number;
  seq: number;
}

export class DanmakuFeed {
  private readonly file: string;

  constructor(filesDir: string) {
    this.file = new RuntimePaths(filesDir).dshHome + '/dsh-app/progress.json';
  }

  path(): string {
    return this.file;
  }

  read(): DanmakuSnapshot | null {
    try {
      const text: string = fs.readTextSync(this.file);
      if (text.length === 0) return null;
      const snapshot = JSON.parse(text) as DanmakuSnapshot;
      if (snapshot === null || snapshot.line === undefined) return null;
      return snapshot;
    } catch (error) {
      return null;
    }
  }
}

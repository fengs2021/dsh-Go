// 「系统操作」页要看的调试通道（界面操作）授权状态。
// 引擎（runtime/ohos/phone/hdc-status.mjs）把诊断结果写进 dsh-app/hdc-status.json，
// 这里只读它；点「重新检测」时写 dsh-app/hdc-probe.json 的一个序号，引擎轮询到就再诊断一次。
import fs from '@ohos.file.fs';
import { RuntimePaths } from '../runtime/RuntimePaths';

interface HdcStatusFile {
  v: number;
  updatedAt: number;
  source: string;
  stage: string;
  authorized: boolean;
  port: number;
  ports: number[];
  defaultPort: number;
  ms: number;
  error: string;
  keySource: string;
  keyPath: string;
  pemBytes: number;
  fingerprint: string;
  hints: string[];
}

function text(value: string | undefined): string {
  return typeof value === 'string' ? value : '';
}

function int(value: number | undefined): number {
  return typeof value === 'number' && isFinite(value) ? value : 0;
}

export class HdcChannelStatus {
  private readonly home: string;

  constructor(filesDir: string) {
    this.home = new RuntimePaths(filesDir).dshHome;
  }

  /** 状态文件；引擎没跑过自检时不存在。 */
  path(): string {
    return this.home + '/dsh-app/hdc-status.json';
  }

  private requestPath(): string {
    return this.home + '/dsh-app/hdc-probe.json';
  }

  /** 读出状态；present=false 表示引擎还没写过（没启动，或还没跑过自检）。 */
  read(): Map<string, Object | null> {
    const out = new Map<string, Object | null>();
    try {
      const raw: string = fs.readTextSync(this.path());
      if (raw.length === 0) return out;
      const file = JSON.parse(raw) as HdcStatusFile;
      if (file === null || file.stage === undefined) return out;
      out.set('present', true);
      out.set('stage', text(file.stage));
      out.set('authorized', file.authorized === true);
      out.set('updatedAt', int(file.updatedAt));
      out.set('port', int(file.port));
      out.set('ports', Array.isArray(file.ports) ? file.ports : []);
      out.set('ms', int(file.ms));
      out.set('error', text(file.error));
      out.set('keySource', text(file.keySource));
      out.set('pemBytes', int(file.pemBytes));
      out.set('hints', Array.isArray(file.hints) ? file.hints : []);
      return out;
    } catch (error) {
      return out;
    }
  }

  /** 让引擎再检测一次：写请求序号，引擎轮询到就更新状态文件。 */
  request(): Map<string, Object | null> {
    const at = Date.now();
    const dir = this.requestPath().substring(0, this.requestPath().lastIndexOf('/'));
    try { fs.mkdirSync(dir, true); } catch (error) { /* 已存在 */ }
    const file = fs.openSync(this.requestPath(), fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.WRITE_ONLY);
    try { fs.writeSync(file.fd, JSON.stringify({ at })); } finally { fs.closeSync(file); }
    return new Map<string, Object | null>([['at', at]]);
  }
}

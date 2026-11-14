// 给「没有 WebAssembly 的 libnode」提供 undici 所需的 llhttp 替身。
//
// 背景：undici 的 client-h1 用 WebAssembly 实例化内联的 llhttp wasm 来解析 HTTP/1.1 响应
// （undici/lib/llhttp/llhttp-wasm.js 是 base64 的 wasm）。我们的 libnode 用 --jitless 编译且
// 关掉了 webassembly（runtime/ohos/node/build-node.py），于是 new WebAssembly.Module() 抛
// ReferenceError，所有走 undici 自带实现（而不是 node:http）的出站请求都变成
// "fetch failed <- WebAssembly is not defined"。billion-context 把自己的 undici bundle 进了
// dist/index.js，所以手机上的 bili 代理每个上游请求都 502。
//
// 这里给出的不是通用 WebAssembly，而是「llhttp 形状」的最小替身：
//   new WebAssembly.Module(bytes)  -> 标记对象（不校验、不编译）
//   new WebAssembly.Instance(mod, { env }) -> { exports }，exports 实现 undici 用到的
//     llhttp_alloc / llhttp_free / llhttp_execute / llhttp_finish / llhttp_pause /
//     llhttp_resume / llhttp_get_error_pos / llhttp_get_error_reason，
//     以及 malloc / free / memory（undici 把 socket 数据拷进这块内存再交给 execute）。
// 解析器本身是纯 JS 的 HTTP/1.1 响应状态机，按 undici 的偏移约定
// （start = at - currentBufferPtr + currentBufferRef.byteOffset）回调 env.wasm_on_*。
//
// 只实现「响应」方向（TYPE.RESPONSE = 2）：undici 的 Client 只解析响应。

const OK = 0;
const INTERNAL = 1;
const INVALID_CONSTANT = 8;
const INVALID_HEADER_TOKEN = 10;
const INVALID_CHUNK_SIZE = 12;
const INVALID_STATUS = 13;
const INVALID_EOF_STATE = 14;
const CR_EXPECTED = 25;
const PAUSED = 21;

const CR = 13;
const LF = 10;
const SP = 32;
const HT = 9;
const COLON = 58;
const SEMI = 59;

const ZERO = 0x30;
const NINE = 0x39;
const UPPER_A = 0x41;
const UPPER_F = 0x46;
const LOWER_A = 0x61;
const LOWER_F = 0x66;

const sniffedHeaders = new Set(['content-length', 'transfer-encoding', 'connection']);

class Stop extends Error {
  constructor(code, position, reason) {
    super(reason || 'llhttp-stop');
    this.code = code;
    this.position = position;
    this.reason = reason || '';
  }
}

// 内存块：undici 会 new Uint8Array(llhttp.memory.buffer, ptr, size)，所以 buffer 必须一直可用；
// 增长时换一块更大的 ArrayBuffer 并把旧内容拷到同偏移处（指针是偏移，因此保持有效）。
class Memory {
  constructor() {
    this.view = new ArrayBuffer(64 * 1024);
  }

  get buffer() {
    return this.view;
  }

  ensure(need) {
    if (need <= this.view.byteLength) return;
    let size = this.view.byteLength;
    while (size < need) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.view));
    this.view = next;
  }
}

class Heap {
  constructor() {
    this.memory = new Memory();
    this.top = 64;
    this.blocks = new Map();
    // 空闲块列表不能叫 free：会和下面的 free(ptr) 方法同名，实例属性会把方法盖掉。
    this.freeBlocks = [];
  }

  malloc(size) {
    const want = Math.max(16, Math.ceil(size / 16) * 16);
    for (let index = 0; index < this.freeBlocks.length; index += 1) {
      const block = this.freeBlocks[index];
      if (block.size >= want) {
        this.freeBlocks.splice(index, 1);
        return block.ptr;
      }
    }
    const ptr = this.top;
    this.top += want;
    this.memory.ensure(this.top);
    this.blocks.set(ptr, want);
    return ptr;
  }

  free(ptr) {
    const size = this.blocks.get(ptr);
    if (size === undefined) return;
    this.blocks.delete(ptr);
    this.freeBlocks.push({ ptr, size });
  }

  writeCString(text) {
    const bytes = Buffer.from(String(text), 'latin1');
    const ptr = this.malloc(bytes.length + 1);
    new Uint8Array(this.memory.view, ptr, bytes.length).set(bytes);
    new Uint8Array(this.memory.view, ptr + bytes.length, 1)[0] = 0;
    return ptr;
  }
}

const ascii = (bytes, start, end) => {
  let text = '';
  for (let index = start; index < end; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
};

class ResponseParser {
  constructor(pointer, env, heap) {
    this.pointer = pointer;
    this.env = env;
    this.heap = heap;
    this.paused = false;
    this.errorPos = 0;
    this.errorReason = '';
    this.consumeHint = 0;
    this.beginMessage();
  }

  beginMessage() {
    this.stage = 'begin';
    this.versionText = '';
    this.major = 1;
    this.minor = 1;
    this.codeText = '';
    this.statusCode = 0;
    this.nameText = '';
    this.valueText = '';
    this.sniff = new Map();
    this.runStart = 0;
    this.nameStart = 0;
    this.valueStart = 0;
    this.valueSkip = false;
    this.valueEmitted = false;
    this.remaining = 0;
    this.chunkText = '';
    this.chunkRemaining = 0;
  }

  execute(bufferPtr, length) {
    const bytes = new Uint8Array(this.heap.memory.view, bufferPtr, length);
    try {
      this.run(bytes, bufferPtr);
      this.errorPos = bufferPtr + length;
      return OK;
    } catch (error) {
      if (error instanceof Stop) {
        this.errorPos = bufferPtr + error.position;
        if (error.reason) this.errorReason = error.reason;
        return error.code;
      }
      this.errorPos = bufferPtr;
      this.errorReason = String((error && error.message) || error);
      return INTERNAL;
    }
  }

  finish() {
    try {
      if (this.stage === 'body-eof') {
        const ret = this.completeMessage();
        return ret === 0 ? OK : PAUSED;
      }
      if (this.stage === 'begin') return OK;
      this.errorReason = 'unexpected end of stream in stage ' + this.stage;
      return INVALID_EOF_STATE;
    } catch (error) {
      return error instanceof Stop ? error.code : INTERNAL;
    }
  }

  completeMessage() {
    const ret = this.env.wasm_on_message_complete ? this.env.wasm_on_message_complete(this.pointer) : 0;
    this.beginMessage();
    return ret;
  }

  applyVersion() {
    const match = /^HTTP\/(\d)\.(\d)$/.exec(this.versionText);
    if (match === null) throw new Stop(INVALID_CONSTANT, this.consumeHint, 'invalid http version ' + this.versionText);
    this.major = Number(match[1]);
    this.minor = Number(match[2]);
  }

  applyCode() {
    const code = Number(this.codeText);
    if (!Number.isInteger(code) || code < 100 || code > 999) throw new Stop(INVALID_STATUS, this.consumeHint, 'invalid status code ' + this.codeText);
    this.statusCode = code;
  }

  appendName(bytes, start, end) {
    if (this.nameText.length >= 64) return;
    this.nameText += ascii(bytes, start, end).toLowerCase();
  }

  appendValue(bytes, start, end) {
    if (!sniffedHeaders.has(this.nameText)) return;
    if (this.valueText.length >= 128) return;
    this.valueText += ascii(bytes, start, end);
  }

  completeHeaders() {
    const connection = String(this.sniff.get('connection') || '').toLowerCase();
    const transfer = String(this.sniff.get('transfer-encoding') || '').toLowerCase();
    const contentLength = this.sniff.get('content-length');
    const keepAlive = connection.includes('keep-alive')
      ? 1
      : (this.major === 1 && this.minor >= 1 && !connection.includes('close') ? 1 : 0);
    const ret = this.env.wasm_on_headers_complete
      ? this.env.wasm_on_headers_complete(this.pointer, this.statusCode, 0, keepAlive)
      : 0;
    if (ret !== 0) {
      this.stage = 'body-none';
      return ret;
    }
    if (this.statusCode < 200 || this.statusCode === 204 || this.statusCode === 304) {
      this.stage = 'body-none';
      return 0;
    }
    if (transfer.includes('chunked')) {
      this.stage = 'chunk-size';
      this.chunkText = '';
      return 0;
    }
    const declared = contentLength === undefined ? '' : String(contentLength).trim();
    if (declared !== '' && /^\d+$/.test(declared)) {
      this.remaining = Number(declared);
      this.stage = this.remaining === 0 ? 'body-none' : 'body-length';
      return 0;
    }
    this.stage = 'body-eof';
    return 0;
  }

  run(bytes, bufferPtr) {
    const env = this.env;
    const length = bytes.length;
    // 每块数据开始时，跨块延续的 token 从句首重新计偏移：undici 会把同一 header 的
    // 多次回调拼起来，所以分片回调是安全的（status 文本除外，只影响显示）。
    if (this.stage === 'reason') this.runStart = 0;
    if (this.stage === 'headers-name') this.nameStart = 0;
    if (this.stage === 'headers-value') this.valueStart = 0;
    let index = 0;
    while (index < length) {
      this.consumeHint = index;
      switch (this.stage) {
        case 'begin': {
          const ret = env.wasm_on_message_begin ? env.wasm_on_message_begin(this.pointer) : 0;
          if (ret !== 0) throw new Stop(INTERNAL, index, 'message begin rejected');
          this.stage = 'version';
          break;
        }
        case 'version': {
          const byte = bytes[index];
          if (byte === SP) {
            this.applyVersion();
            this.codeText = '';
            this.stage = 'code';
            index += 1;
          } else if (byte === CR || byte === LF) {
            throw new Stop(INVALID_CONSTANT, index);
          } else {
            if (this.versionText.length < 16) this.versionText += String.fromCharCode(byte);
            index += 1;
          }
          break;
        }
        case 'code': {
          const byte = bytes[index];
          if (byte >= ZERO && byte <= NINE) {
            if (this.codeText.length < 4) this.codeText += String.fromCharCode(byte);
            index += 1;
          } else if (byte === SP) {
            this.applyCode();
            this.stage = 'reason';
            this.runStart = index + 1;
            index += 1;
          } else if (byte === CR) {
            this.applyCode();
            this.stage = 'status-cr';
            index += 1;
          } else if (byte === LF) {
            this.applyCode();
            this.stage = 'headers-line';
            index += 1;
          } else {
            throw new Stop(INVALID_STATUS, index);
          }
          break;
        }
        case 'reason': {
          let cursor = index;
          while (cursor < length && bytes[cursor] !== CR && bytes[cursor] !== LF) cursor += 1;
          if (cursor > this.runStart && env.wasm_on_status) {
            env.wasm_on_status(this.pointer, bufferPtr + this.runStart, cursor - this.runStart);
          }
          if (cursor >= length) {
            this.runStart = 0;
            index = length;
            break;
          }
          this.stage = bytes[cursor] === CR ? 'status-cr' : 'headers-line';
          index = cursor + 1;
          break;
        }
        case 'status-cr': {
          if (bytes[index] !== LF) throw new Stop(CR_EXPECTED, index);
          this.stage = 'headers-line';
          index += 1;
          break;
        }
        case 'headers-line': {
          const byte = bytes[index];
          if (byte === CR) {
            this.stage = 'headers-end-cr';
            index += 1;
          } else if (byte === LF) {
            const ret = this.completeHeaders();
            if (ret !== 0) throw new Stop(PAUSED, index + 1, 'headers complete rejected');
            index += 1;
          } else {
            this.nameText = '';
            this.valueText = '';
            this.nameStart = index;
            this.stage = 'headers-name';
          }
          break;
        }
        case 'headers-end-cr': {
          if (bytes[index] !== LF) throw new Stop(CR_EXPECTED, index);
          const ret = this.completeHeaders();
          if (ret !== 0) throw new Stop(PAUSED, index + 1, 'headers complete rejected');
          index += 1;
          break;
        }
        case 'headers-name': {
          let cursor = index;
          while (cursor < length && bytes[cursor] !== COLON && bytes[cursor] !== CR && bytes[cursor] !== LF) cursor += 1;
          if (cursor > this.nameStart) {
            if (env.wasm_on_header_field) env.wasm_on_header_field(this.pointer, bufferPtr + this.nameStart, cursor - this.nameStart);
            this.appendName(bytes, this.nameStart, cursor);
          }
          if (cursor >= length) {
            this.nameStart = 0;
            index = length;
            break;
          }
          if (bytes[cursor] !== COLON) throw new Stop(INVALID_HEADER_TOKEN, cursor, 'header without colon');
          this.valueStart = cursor + 1;
          this.valueSkip = true;
          this.valueEmitted = false;
          this.valueText = '';
          this.stage = 'headers-value';
          index = cursor + 1;
          break;
        }
        case 'headers-value': {
          let cursor = index;
          if (this.valueSkip) {
            while (cursor < length && (bytes[cursor] === SP || bytes[cursor] === HT)) cursor += 1;
            if (cursor > this.valueStart) this.valueStart = cursor;
            if (cursor >= length) {
              this.valueStart = 0;
              index = length;
              break;
            }
            this.valueSkip = false;
          }
          while (cursor < length && bytes[cursor] !== CR && bytes[cursor] !== LF) cursor += 1;
          if (cursor > this.valueStart && env.wasm_on_header_value) {
            env.wasm_on_header_value(this.pointer, bufferPtr + this.valueStart, cursor - this.valueStart);
            this.appendValue(bytes, this.valueStart, cursor);
            this.valueEmitted = true;
          } else if (!this.valueEmitted && env.wasm_on_header_value) {
            // 空值也必须回调一次：undici 用 headers 数组的奇偶性配对字段与值。
            env.wasm_on_header_value(this.pointer, bufferPtr + this.valueStart, 0);
            this.valueEmitted = true;
          }
          if (cursor >= length) {
            this.valueStart = 0;
            index = length;
            break;
          }
          this.sniff.set(this.nameText, this.valueText);
          this.stage = 'headers-cr';
          index = cursor + 1;
          break;
        }
        case 'headers-cr': {
          if (bytes[index] === LF) index += 1;
          this.stage = 'headers-line';
          break;
        }
        case 'body-none': {
          const ret = this.completeMessage();
          if (ret !== 0) throw new Stop(PAUSED, index, 'message complete paused');
          break;
        }
        case 'body-length': {
          if (this.remaining === 0) {
            const ret = this.completeMessage();
            if (ret !== 0) throw new Stop(PAUSED, index, 'message complete paused');
            break;
          }
          const end = Math.min(length, index + this.remaining);
          const ret = env.wasm_on_body ? env.wasm_on_body(this.pointer, bufferPtr + index, end - index) : 0;
          this.remaining -= end - index;
          index = end;
          if (ret !== 0) throw new Stop(PAUSED, index, 'body paused');
          break;
        }
        case 'body-eof': {
          const ret = env.wasm_on_body ? env.wasm_on_body(this.pointer, bufferPtr + index, length - index) : 0;
          index = length;
          if (ret !== 0) throw new Stop(PAUSED, index, 'body paused');
          break;
        }
        case 'chunk-size': {
          let cursor = index;
          while (cursor < length && this.chunkText.length < 12) {
            const byte = bytes[cursor];
            if (byte === CR || byte === LF || byte === SEMI) break;
            const hex = (byte >= ZERO && byte <= NINE) || (byte >= UPPER_A && byte <= UPPER_F) || (byte >= LOWER_A && byte <= LOWER_F);
            if (!hex) throw new Stop(INVALID_CHUNK_SIZE, cursor);
            this.chunkText += String.fromCharCode(byte);
            cursor += 1;
          }
          index = cursor;
          if (cursor >= length) break;
          const terminator = bytes[cursor];
          // 块长度必须在看到 ; / CR / LF 时就解析：分片很可能把 "4" 和 ";" 拆到两次 execute。
          if (this.chunkText.length !== 0) {
            this.chunkRemaining = parseInt(this.chunkText, 16);
            this.chunkText = '';
            if (!Number.isInteger(this.chunkRemaining) || this.chunkRemaining < 0) throw new Stop(INVALID_CHUNK_SIZE, cursor);
          } else if (terminator !== SEMI) {
            throw new Stop(INVALID_CHUNK_SIZE, cursor);
          }
          if (terminator === SEMI) {
            this.stage = 'chunk-ext';
            index = cursor + 1;
          } else if (terminator === CR) {
            this.stage = 'chunk-size-cr';
            index = cursor + 1;
          } else {
            this.stage = this.chunkRemaining === 0 ? 'trailers-line' : 'chunk-data';
            index = cursor + 1;
          }
          break;
        }
        case 'chunk-ext': {
          let cursor = index;
          while (cursor < length && bytes[cursor] !== CR) cursor += 1;
          index = cursor;
          if (cursor >= length) break;
          this.stage = 'chunk-size-cr';
          index = cursor + 1;
          break;
        }
        case 'chunk-size-cr': {
          if (bytes[index] === LF) index += 1;
          this.stage = this.chunkRemaining === 0 ? 'trailers-line' : 'chunk-data';
          break;
        }
        case 'chunk-data': {
          const end = Math.min(length, index + this.chunkRemaining);
          const ret = env.wasm_on_body ? env.wasm_on_body(this.pointer, bufferPtr + index, end - index) : 0;
          this.chunkRemaining -= end - index;
          index = end;
          if (ret !== 0) throw new Stop(PAUSED, index, 'body paused');
          if (this.chunkRemaining === 0) this.stage = 'chunk-data-cr';
          break;
        }
        case 'chunk-data-cr': {
          if (bytes[index] === CR) {
            this.stage = 'chunk-data-lf';
            index += 1;
          } else if (bytes[index] === LF) {
            this.stage = 'chunk-size';
            index += 1;
          } else {
            throw new Stop(CR_EXPECTED, index);
          }
          break;
        }
        case 'chunk-data-lf': {
          this.stage = 'chunk-size';
          index += 1;
          break;
        }
        case 'trailers-line': {
          const byte = bytes[index];
          if (byte === CR) {
            this.stage = 'trailers-end';
            index += 1;
            break;
          }
          if (byte === LF) {
            const ret = this.completeMessage();
            if (ret !== 0) throw new Stop(PAUSED, index + 1, 'message complete paused');
            index += 1;
            break;
          }
          let cursor = index;
          while (cursor < length && bytes[cursor] !== CR && bytes[cursor] !== LF) cursor += 1;
          index = cursor;
          break;
        }
        case 'trailers-end': {
          const ret = this.completeMessage();
          if (ret !== 0) throw new Stop(PAUSED, index, 'message complete paused');
          if (bytes[index] === LF) index += 1;
          break;
        }
        default: {
          throw new Stop(INTERNAL, index, 'unknown stage ' + this.stage);
        }
      }
    }
    // 无正文（204/304/Content-Length: 0）或正文刚好在本块收尾时，llhttp 会立刻回调
    // message_complete；undici 依赖它把响应交出去，所以这里补一次收尾。
    if (this.stage === 'body-none' || (this.stage === 'body-length' && this.remaining === 0)) {
      const ret = this.completeMessage();
      if (ret !== 0) throw new Stop(PAUSED, length, 'message complete paused');
    }
  }
}

function createLlhttpExports(env) {
  const heap = new Heap();
  const parsers = new Map();
  let nextPointer = 0x10000;
  const parserOf = (pointer) => parsers.get(pointer);
  return {
    get memory() {
      return heap.memory;
    },
    malloc(size) {
      return heap.malloc(size);
    },
    free(pointer) {
      heap.free(pointer);
    },
    llhttp_alloc() {
      const pointer = nextPointer;
      nextPointer += 8;
      parsers.set(pointer, new ResponseParser(pointer, env, heap));
      return pointer;
    },
    llhttp_free(pointer) {
      parsers.delete(pointer);
    },
    llhttp_init() {
      // undici 只调 llhttp_alloc；留着做形状兼容。
    },
    llhttp_reset(pointer) {
      const parser = parserOf(pointer);
      if (parser !== undefined) parser.beginMessage();
      return OK;
    },
    llhttp_execute(pointer, bufferPtr, length) {
      const parser = parserOf(pointer);
      if (parser === undefined) return INTERNAL;
      return parser.execute(bufferPtr, length);
    },
    llhttp_finish(pointer) {
      const parser = parserOf(pointer);
      if (parser === undefined) return INTERNAL;
      return parser.finish();
    },
    llhttp_pause(pointer) {
      const parser = parserOf(pointer);
      if (parser !== undefined) parser.paused = true;
      return OK;
    },
    llhttp_resume(pointer) {
      const parser = parserOf(pointer);
      if (parser !== undefined) parser.paused = false;
      return OK;
    },
    llhttp_get_error_pos(pointer) {
      const parser = parserOf(pointer);
      return parser === undefined ? 0 : parser.errorPos;
    },
    llhttp_get_error_reason(pointer) {
      const parser = parserOf(pointer);
      return heap.writeCString(parser === undefined ? '' : parser.errorReason);
    },
    llhttp_get_errno() {
      return 0;
    },
    __dshStage(pointer) {
      const parser = parserOf(pointer);
      return parser === undefined ? '' : parser.stage;
    },
  };
}

class ShimModule {
  constructor(bytes) {
    this.__dshWasmShim = true;
    this.byteLength = bytes === undefined || bytes === null ? 0 : (bytes.byteLength ?? bytes.length ?? 0);
  }
}

class ShimInstance {
  constructor(module, imports) {
    if (!(module instanceof ShimModule)) throw new TypeError('WebAssembly.Instance: 需要 shim 的 Module');
    const env = (imports && imports.env) || {};
    this.exports = createLlhttpExports(env);
  }
}

// 装上 shim；已经真的有 WebAssembly 时什么都不做（返回 false）。
export function installWebAssemblyShim(log = console.error) {
  if (typeof globalThis.WebAssembly !== 'undefined' && globalThis.WebAssembly !== null) return false;
  globalThis.WebAssembly = {
    Module: ShimModule,
    Instance: ShimInstance,
    validate: () => false,
    compile: async () => new ShimModule(),
    instantiate: async (bytes, imports) => {
      const module = new ShimModule(bytes);
      return { module, instance: new ShimInstance(module, imports) };
    },
  };
  log('[wasm-shim] libnode 没有 WebAssembly，已装入 llhttp 纯 JS 替身（undici Client 可用）');
  return true;
}

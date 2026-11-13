// HDC 客户端（零依赖）：手机内 Node 直连本机 hdcd（开发者选项里的无线调试端口），
// 完成 SessionHandShake 公钥/签名鉴权后以 shell uid 执行命令，从而驱动 uitest 等系统工具。
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// 随包内置的已授权密钥（调试用）：存在时优先使用，避免首次连接弹「是否信任此设备」。
const moduleDir = path.dirname(new URL(import.meta.url).pathname);
const shippedKeyPath = path.join(moduleDir, 'hdc-key', 'id_rsa');
// 无线调试端口每次重连/重启都会变：从 /proc/net/tcp 里找 hdcd（以 shell uid 2000 运行）的监听端口。
const discoverPorts = () => {
  const ports = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 8) continue;
      if (cols[3] !== '0A') continue;
      if (Number(cols[7]) !== 2000) continue;
      const port = parseInt(cols[1].split(':')[1], 16);
      if (!port || port === 8710) continue;
      if (!ports.includes(port)) ports.push(port);
    }
  }
  return ports;
};

const HANDSHAKE_MESSAGE = 'OHOS HDC';
const SEP = '\x0C';
const VERSION = 'Ver: 3.2.0b';
const CMD_HANDSHAKE = 1;
const CMD_CHANNEL_CLOSE = 2;
const CMD_ECHO_RAW = 10;
const CMD_UNITY_EXECUTE = 1001;
const MAX_OUTPUT = 8 * 1024 * 1024;

const varint = (n) => {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return Buffer.from(out);
};
const tag = (field, wire) => varint((field << 3) | wire);
const encStr = (field, str) => { const b = Buffer.from(str, 'utf8'); return Buffer.concat([tag(field, 2), varint(b.length), b]); };
const encVarint = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const readVarint = (buf, off) => {
  let result = 0, shift = 0, i = off;
  while (i < buf.length) {
    const b = buf[i++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if ((b & 0x80) === 0) return [result, i];
  }
  throw new Error('varint truncated');
};
const parseFields = (buf) => {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const [key, j] = readVarint(buf, i);
    const field = key >> 3, wire = key & 7;
    i = j;
    if (wire === 0) { const [v, k] = readVarint(buf, i); out[field] = v; i = k; }
    else if (wire === 2) { const [len, k] = readVarint(buf, i); out[field] = buf.subarray(k, k + len); i = k + len; }
    else if (wire === 5) { out[field] = buf.subarray(i, i + 4); i += 4; }
    else if (wire === 1) { out[field] = buf.subarray(i, i + 8); i += 8; }
    else throw new Error('bad wire ' + wire);
  }
  return out;
};
const handshakeMsg = (o) => {
  const parts = [encStr(1, o.banner || HANDSHAKE_MESSAGE), encVarint(2, o.authType || 0), encVarint(3, o.sessionId >>> 0)];
  if (o.connectKey) parts.push(encStr(4, o.connectKey));
  if (o.buf) parts.push(encStr(5, o.buf));
  parts.push(encStr(6, o.version || VERSION));
  return Buffer.concat(parts);
};
const parseHandshake = (payload) => {
  const f = parseFields(payload);
  return {
    banner: f[1] ? f[1].toString('utf8') : '',
    authType: f[2] || 0,
    sessionId: f[3] || 0,
    connectKey: f[4] ? f[4].toString('utf8') : '',
    buf: f[5] ? f[5].toString('utf8') : '',
    version: f[6] ? f[6].toString('utf8') : '',
  };
};
const protectOf = (channelId, cmd) => Buffer.concat([encVarint(1, channelId), encVarint(2, cmd), encVarint(3, 0), encVarint(4, 0x09)]);
export const frame = (channelId, cmd, payload) => {
  const p = protectOf(channelId, cmd);
  const body = payload && payload.length ? payload : Buffer.alloc(0);
  const h = Buffer.alloc(11);
  h.write('HW', 0, 'ascii');
  h.writeUInt16BE(0, 2);
  h[4] = 1;
  h.writeUInt16BE(p.length, 5);
  h.writeUInt32BE(body.length, 7);
  return Buffer.concat([h, p, body]);
};
export class FrameReader {
  constructor(onFrame) { this.buf = Buffer.alloc(0); this.onFrame = onFrame; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 11) return;
      if (this.buf[0] !== 0x48 || this.buf[1] !== 0x57) throw new Error('bad magic ' + this.buf.subarray(0, 11).toString('hex'));
      const headSize = this.buf.readUInt16BE(5);
      const dataSize = this.buf.readUInt32BE(7);
      if (this.buf.length < 11 + headSize + dataSize) return;
      const pf = parseFields(this.buf.subarray(11, 11 + headSize));
      const payload = this.buf.subarray(11 + headSize, 11 + headSize + dataSize);
      this.buf = this.buf.subarray(11 + headSize + dataSize);
      this.onFrame({ channelId: pf[1] || 0, cmd: pf[2] || 0, payload });
    }
  }
}

// 设备端 AlreadyInKnownHosts 要求公钥字符串长度恰为 625（含末尾换行），否则「始终信任」永不生效。
export const pubPemOf = (key) => {
  const pem = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
  return pem.endsWith('\n') ? pem : pem + '\n';
};
export const signToken = (key, token) => crypto.privateEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING },
  Buffer.from(token, 'utf8')).toString('base64');

export function loadOrCreateKey(keyPath) {
  if (fs.existsSync(keyPath)) return crypto.createPrivateKey(fs.readFileSync(keyPath));
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(keyPath + '.pub', publicKey);
  return crypto.createPrivateKey(privateKey);
}

export class HdcLink {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 45957;
    this.hostname = options.hostname || 'dsh-phone';
    this.keyPath = options.keyPath || process.env.DSH_GO_PHONE_KEY
      || (fs.existsSync(shippedKeyPath) ? shippedKeyPath
        : path.join(process.env.DSH_GO_PHONE_HOME || process.env.HOME || '/tmp', '.dsh', 'hdc-client', 'id_rsa'));
    this.connectTimeoutMs = options.connectTimeoutMs || 20000;
    this.socket = null; this.authed = false; this.pending = new Map(); this.nextChannel = 1;
    this.connecting = null;
  }

  async ready() {
    if (this.socket && this.authed && !this.socket.destroyed) return this;
    if (!this.connecting) this.connecting = this.#connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #connect() {
    const candidates = [this.port, ...discoverPorts().filter((port) => port !== this.port)];
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const port = candidates[index];
      try {
        const timeoutMs = index === 0 ? this.connectTimeoutMs : Math.min(this.connectTimeoutMs, 6000);
        const link = await this.#connectPort(port, timeoutMs);
        this.port = port;
        return link;
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('hdc 服务不可达');
  }

  #connectPort(port, connectTimeoutMs) {
    const debug = process.env.DSH_HDC_DEBUG ? (m) => process.stderr.write('[dbg] ' + m + '\n') : () => {};
    debug('connect start ' + this.host + ':' + port + ' key=' + this.keyPath);
    const key = loadOrCreateKey(this.keyPath);
    debug('key loaded');
    const pub = pubPemOf(key);
    const sessionId = (Math.floor(Math.random() * 0x7fffffff)) + 1;
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port });
      socket.setNoDelay(true);
      let sentPubkeyCounter = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.destroy(); } catch { /* ignore */ }
        this.socket = null; this.authed = false;
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('hdc 鉴权超时（可能手机正在等待「允许调试」确认，或无线调试已关闭）')), connectTimeoutMs);
      const reader = new FrameReader((fr) => {
        if (fr.cmd === CMD_HANDSHAKE) {
          const hs = parseHandshake(fr.payload);
          debug('handshake authType=' + hs.authType + ' buf=' + hs.buf.slice(0, 60));
          if (hs.authType === 3) {
            sentPubkeyCounter += 1;
            socket.write(frame(0, CMD_HANDSHAKE, handshakeMsg({ authType: 3, sessionId, buf: this.hostname + SEP + pub })));
            return;
          }
          if (hs.authType === 2) {
            socket.write(frame(0, CMD_HANDSHAKE, handshakeMsg({ authType: 2, sessionId, buf: signToken(key, hs.buf) })));
            return;
          }
          if (hs.authType === 4 && hs.buf.includes('SUCCESS')) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.socket = socket; this.authed = true;
            resolve(this);
            return;
          }
          if (hs.authType === 5) { fail(new Error('hdc 鉴权被拒：' + hs.buf.slice(0, 200))); return; }
          return;
        }
        if (fr.channelId !== 0) debug('frame ch=' + fr.channelId + ' cmd=' + fr.cmd + ' size=' + fr.payload.length);
        const waiter = this.pending.get(fr.channelId);
        if (!waiter) return;
        if (fr.cmd === CMD_ECHO_RAW) { waiter.chunks.push(fr.payload); waiter.bytes += fr.payload.length; if (waiter.bytes > MAX_OUTPUT) waiter.stop('输出超过上限'); return; }
        if (fr.cmd === CMD_CHANNEL_CLOSE) { waiter.done(); }
      });
      socket.on('connect', () => { debug('socket connected'); socket.write(frame(0, CMD_HANDSHAKE, handshakeMsg({ authType: 0, sessionId, version: VERSION }))); });
      socket.on('data', (chunk) => { try { reader.push(chunk); } catch (error) { this.#die(error); fail(error); } });
      socket.on('error', (error) => { debug('socket error ' + error.message); this.#die(error); fail(error); });
      socket.on('close', () => { debug('socket close'); this.#die(new Error('hdc 连接已关闭')); fail(new Error('hdc 连接在鉴权完成前关闭（手机可能还没点「始终允许」）')); });
    });
  }

  #die(error) {
    this.socket = null; this.authed = false;
    for (const [channel, waiter] of this.pending) { this.pending.delete(channel); waiter.reject(error); }
  }

  execBuffer(command, timeoutMs = 30000) {
    const dbg = process.env.DSH_HDC_DEBUG ? (m) => process.stderr.write('[dbg] ' + m + '\n') : () => {};
    dbg('execBuffer enter');
    return this.ready().then(() => new Promise((resolve, reject) => {
      dbg('execBuffer ready ch=' + this.nextChannel);
      const socket = this.socket;
      if (!socket || socket.destroyed) { reject(new Error('hdc 连接不可用')); return; }
      const channel = this.nextChannel++;
      if (this.nextChannel > 0x7fffffff) this.nextChannel = 1;
      const chunks = [];
      const waiter = { chunks, bytes: 0 };
      const finish = (error) => {
        if (!this.pending.has(channel)) return;
        this.pending.delete(channel);
        clearTimeout(timer);
        if (error) reject(error); else resolve(Buffer.concat(chunks));
      };
      const timer = setTimeout(() => {
        try { socket.write(frame(channel, CMD_CHANNEL_CLOSE, Buffer.alloc(0))); } catch { /* ignore */ }
        finish(new Error('命令执行超时 ' + timeoutMs + 'ms'));
      }, timeoutMs);
      waiter.done = () => finish(null);
      waiter.reject = finish;
      waiter.stop = (why) => finish(new Error(why));
      this.pending.set(channel, waiter);
      socket.write(frame(channel, CMD_UNITY_EXECUTE, Buffer.from(command, 'utf8')));
      dbg('exec written ch=' + channel + ' cmd=' + command);
    }));
  }

  async exec(command, timeoutMs = 30000) { return (await this.execBuffer(command, timeoutMs)).toString('utf8'); }

  close() { try { this.socket?.destroy(); } catch { /* ignore */ } this.socket = null; this.authed = false; }
}

let shared = null;
export function getLink(options) {
  if (!shared) shared = new HdcLink(options || { host: process.env.DSH_GO_PHONE_HDC_HOST, port: Number(process.env.DSH_GO_PHONE_HDC_PORT) || undefined });
  return shared;
}
export const hdcPort = () => Number(process.env.DSH_GO_PHONE_HDC_PORT || 45957);

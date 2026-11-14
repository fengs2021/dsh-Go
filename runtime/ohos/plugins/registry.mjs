// Dependency-free npm registry client: metadata documents and tarballs over
// node:https, with the registry and bearer token taken from .npmrc files.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const ABBREVIATED = 'application/vnd.npm.install-v1+json';
const USER_AGENT = 'dsh-ohos-package-manager/1.0';

/** Normalise a registry URL so paths append cleanly. */
export function normalizeRegistry(text) {
  const value = String(text ?? '').trim();
  if (value === '') return DEFAULT_REGISTRY;
  return value.endsWith('/') ? value : value + '/';
}

function npmrcValues(dir) {
  const values = new Map();
  const files = [join(homedir(), '.npmrc')];
  if (typeof dir === 'string' && dir !== '') files.unshift(join(dir, '.npmrc'));
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
      const equals = line.indexOf('=');
      if (equals <= 0) continue;
      const key = line.slice(0, equals).trim();
      let value = line.slice(equals + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      value = value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name) => process.env[name] ?? match);
      values.set(key, value);
    }
  }
  return values;
}

/** The registry the profile would use, without asking a package manager. */
export function registryFor(dir) {
  const values = npmrcValues(dir);
  const configured = values.get('registry');
  if (configured !== undefined && configured !== '') return normalizeRegistry(configured);
  const scoped = values.get('@deepseek-ai:registry');
  return normalizeRegistry(scoped);
}

function authorization(values, url) {
  const host = url.host;
  const path = url.pathname.replace(/[^/]*$/, '');
  for (const [key, value] of values) {
    if (!key.endsWith(':_authToken')) continue;
    const prefix = key.slice(0, -':_authToken'.length).replace(/^\/+/, '');
    const target = prefix === '' ? host : prefix + path;
    if (prefix === '' || host.endsWith(prefix.replace(/\/.*$/, ''))) return 'Bearer ' + value;
  }
  return undefined;
}

/**
 * One HTTP GET with redirect handling.
 * @param url Absolute URL text.
 * @param options Headers, byte cap, cancellation and timeout.
 * @returns The response bytes and its content type.
 */
export function getBuffer(url, options = {}) {
  const limit = options.maxBytes ?? 64 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 60000;
  const redirects = options.redirects ?? 5;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    if (options.signal?.aborted === true) {
      fail(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }));
      return;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      fail(error);
      return;
    }
    const headers = {
      'user-agent': USER_AGENT,
      'accept-encoding': 'identity',
      ...options.headers ?? {},
    };
    const req = request(parsed, { method: 'GET', headers, timeout: timeoutMs }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location !== undefined) {
        response.resume();
        if (redirects <= 0) {
          fail(Object.assign(new Error('too many redirects for ' + url), { code: 'EREDIRECT' }));
          return;
        }
        const next = new URL(response.headers.location, parsed).toString();
        settled = true;
        resolve(getBuffer(next, { ...options, redirects: redirects - 1 }));
        return;
      }
      if (status !== 200) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 500);
          const error = new Error('GET ' + url + ' failed with ' + String(status) + (body === '' ? '' : ': ' + body));
          error.code = status === 404 ? 'E404' : status === 401 || status === 403 ? 'EAUTH' : 'EREGISTRY';
          error.status = status;
          fail(error);
        });
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          response.destroy();
          fail(Object.assign(new Error('response for ' + url + ' exceeds ' + String(limit) + ' bytes'), { code: 'ETOOLARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ body: Buffer.concat(chunks), type: String(response.headers['content-type'] ?? '') });
      });
      response.on('error', fail);
    });
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('request for ' + url + ' timed out after ' + String(timeoutMs) + 'ms'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', fail);
    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', () => {
        req.destroy(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }));
      }, { once: true });
    }
    req.end();
  });
}

const cache = new Map();

/** Fetch a package's metadata document, abbreviated unless the caller needs publication times. */
export async function packument(registry, name, options = {}) {
  const key = normalizeRegistry(registry) + '|' + name + (options.full === true ? '|full' : '');
  const cached = cache.get(key);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < (options.cacheMs ?? 300000)) return cached.value;
  const url = normalizeRegistry(registry) + name.replace('/', '%2f');
  const values = options.npmrc ?? new Map();
  const token = authorization(values, new URL(url));
  const answer = await getBuffer(url, {
    headers: { accept: options.full === true ? 'application/json' : ABBREVIATED, ...(token === undefined ? {} : { authorization: token }) },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  let value;
  try {
    value = JSON.parse(answer.body.toString('utf8'));
  } catch (error) {
    throw Object.assign(new Error('registry returned unparseable metadata for ' + name), { code: 'EREGISTRY', cause: error });
  }
  if (cache.size > 256) cache.clear();
  cache.set(key, { at: now, value });
  return value;
}

/** Download one version's tarball bytes. */
export async function tarball(url, options = {}) {
  const values = options.npmrc ?? new Map();
  let token;
  try {
    token = authorization(values, new URL(url));
  } catch {
    token = undefined;
  }
  const answer = await getBuffer(url, {
    headers: token === undefined ? {} : { authorization: token },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes ?? 128 * 1024 * 1024,
  });
  return answer.body;
}

export { DEFAULT_REGISTRY };

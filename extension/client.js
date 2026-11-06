'use strict';

const { randomBytes } = require('node:crypto');
const { constants } = require('node:fs');
const { copyFile, link, open, unlink } = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const defaultService = { origin: 'http://127.0.0.1:4318', sessionCookie: 'portal_session' };
const MAX_UPLOAD = 5 * 1024 ** 3;
const TRANSFER_TIMEOUT = 30 * 60_000;
const HEX_TOKEN = /^[a-f0-9]{64}$/;

class ApiError extends Error {
  constructor(message, { status = 0, code = 'REQUEST_FAILED' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function apiUrl(route, origin) {
  if (typeof route !== 'string' || !route.startsWith('/api/') || /[\\\x00-\x1f]/.test(route)) {
    throw new ApiError('工作台接口路径无效。');
  }
  const url = new URL(route, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/api/') || url.hash) {
    throw new ApiError('工作台接口路径无效。');
  }
  return url;
}

function deadline(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function transportError(error, signal) {
  if (error instanceof ApiError) return error;
  if (signal?.aborted) {
    return signal.reason?.name === 'TimeoutError'
      ? new ApiError('等待工作台响应超时。请检查资源状态后重试。', { code: 'TIMEOUT' })
      : new ApiError('操作已取消。', { code: 'CANCELLED' });
  }
  return new ApiError('无法连接插件内置服务。请重载 VS Code 窗口后重试。', { code: 'SERVICE_UNAVAILABLE' });
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new ApiError('本机工作台返回的数据无法读取。', { status: response.status });
  }
}

function reportTransfer(onProgress, total) {
  let transferred = 0;
  let lastReported = -Infinity;
  function publish(phase) {
    lastReported = Date.now();
    try { onProgress?.({ transferred, total, phase }); } catch { /* Display updates must not interrupt a transfer. */ }
  }
  publish('transfer');
  return {
    add(bytes) {
      transferred += bytes;
      if (Date.now() - lastReported >= 150) publish('transfer');
    },
    saving() { publish('saving'); },
  };
}

class WorkbenchClient {
  #session = null;
  #revision = 0;
  #fetch;
  #getService;

  constructor({ fetchImpl = fetch, getService = async () => defaultService } = {}) {
    this.#fetch = fetchImpl;
    this.#getService = getService;
  }

  get authenticated() { return this.#session !== null; }
  service() { return this.#getService(); }

  async #call(route, { method = 'GET', json, body, headers, signal, timeoutMs = 90_000 } = {}) {
    const { origin, sessionCookie } = await this.service();
    const url = apiUrl(route, origin);
    const session = this.#session;
    const requestHeaders = new Headers(headers);
    requestHeaders.set('Accept', 'application/json');
    if (session) {
      requestHeaders.set('Cookie', `${sessionCookie}=${session.sid}`);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) requestHeaders.set('X-CSRF-Token', session.csrf);
    }
    if (json !== undefined) {
      requestHeaders.set('Content-Type', 'application/json');
      body = JSON.stringify(json);
    }
    const requestSignal = deadline(signal, timeoutMs);
    let response;
    try {
      response = await this.#fetch(url, {
        method, headers: requestHeaders, body, signal: requestSignal,
        redirect: 'error', ...(body && typeof body[Symbol.asyncIterator] === 'function' ? { duplex: 'half' } : {}),
      });
    } catch (error) {
      throw transportError(error, requestSignal);
    }
    if (!response.ok) {
      if (response.status === 401 && url.pathname !== '/api/login' && this.#session === session) {
        this.#session = null;
      }
      const error = await readJson(response).catch(() => null);
      throw new ApiError(
        typeof error?.message === 'string' ? error.message.slice(0, 500) : `工作台请求失败（${response.status}）。`,
        { status: response.status, code: typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED' },
      );
    }
    return response;
  }

  async request(route, { method, json, signal, timeoutMs } = {}) {
    return readJson(await this.#call(route, { method, json, signal, timeoutMs }));
  }

  challenge() { return this.request('/api/login/challenge', { timeoutMs: 30_000 }); }

  async login({ username, password, challengeId, captchaCode }) {
    const revision = ++this.#revision;
    const response = await this.#call('/api/login', {
      method: 'POST', json: { username, password, challengeId, captchaCode },
    });
    const data = await readJson(response);
    const { sessionCookie } = await this.service();
    const sid = new RegExp(`^${sessionCookie}=([a-f0-9]{64});`).exec(response.headers.get('set-cookie') || '')?.[1];
    if (data.authenticated !== true || !sid || !HEX_TOKEN.test(data.csrfToken || '')) {
      throw new ApiError('工作台没有建立有效会话。');
    }
    if (revision !== this.#revision) throw new ApiError('此登录请求已结束。', { code: 'CANCELLED' });
    this.#session = { sid, csrf: data.csrfToken };
    return { authenticated: true, username: data.username };
  }

  async logout() {
    const session = this.#session;
    ++this.#revision;
    try {
      if (session) await this.request('/api/logout', { method: 'POST', timeoutMs: 5000 });
    } finally {
      if (this.#session === session) this.#session = null;
    }
  }

  async upload(resourceId, folder, localPaths, { signal, onProgress } = {}) {
    if (!localPaths.length || localPaths.length > 20) throw new ApiError('请选择 1 至 20 个文件。');
    const boundary = `workbench-${randomBytes(24).toString('hex')}`;
    const files = [];
    let total = 0;
    try {
      for (const filename of localPaths) {
        signal?.throwIfAborted();
        const name = path.basename(filename);
        if (!name || /["\\\x00-\x1f\x7f]/.test(name)) throw new ApiError('文件名含有无法上传的字符。');
        const handle = await open(filename, 'r');
        const file = { handle };
        files.push(file);
        const info = await handle.stat();
        if (!info.isFile()) throw new ApiError('只能上传普通文件。');
        total += info.size;
        if (total > MAX_UPLOAD) throw new ApiError('单次上传总量超过 5 GB。');
        file.size = info.size;
        file.header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      }
      const lineEnd = Buffer.from('\r\n');
      const ending = Buffer.from(`--${boundary}--\r\n`);
      const contentLength = total + ending.length + files.reduce((length, file) => length + file.header.length + lineEnd.length, 0);
      const transfer = reportTransfer(onProgress, total);
      async function* multipart() {
        for (const { handle, header, size } of files) {
          yield header;
          for (let sent = 0; sent < size;) {
            signal?.throwIfAborted();
            const chunk = Buffer.allocUnsafe(Math.min(size - sent, 1024 * 1024));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, sent);
            if (!bytesRead) throw new ApiError('上传期间文件大小发生变化，请重新选择文件。');
            sent += bytesRead;
            yield chunk.subarray(0, bytesRead);
            transfer.add(bytesRead);
          }
          yield lineEnd;
        }
        yield ending;
        transfer.saving();
      }
      const query = new URLSearchParams({ resourceId, path: folder });
      return await readJson(await this.#call(`/api/files/upload?${query}`, {
        method: 'POST', body: multipart(), signal, timeoutMs: TRANSFER_TIMEOUT,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(contentLength) },
      }));
    } catch (error) {
      if (signal?.aborted) throw transportError(error, signal);
      if (error instanceof ApiError) throw error;
      throw new ApiError('无法读取所选文件。请检查文件是否仍存在并可读取。');
    } finally {
      await Promise.allSettled(files.map(({ handle }) => handle.close()));
    }
  }

  async download(resourceId, remotePath, destination, { signal, onProgress } = {}) {
    const query = new URLSearchParams({ resourceId, path: remotePath });
    const operationSignal = deadline(signal, TRANSFER_TIMEOUT);
    const temp = path.join(path.dirname(destination), `.compute-download-${randomBytes(16).toString('hex')}.part`);
    let tempHandle;
    try {
      // Reserve the path before fetching. Only remove paths this call created.
      tempHandle = await open(temp, 'wx', 0o600);
      const response = await this.#call(`/api/files/download?${query}`, { signal: operationSignal, timeoutMs: TRANSFER_TIMEOUT });
      if (!response.body) throw new ApiError('工作台没有返回下载内容。');
      const header = response.headers.get('content-length');
      const size = header && /^\d+$/.test(header) ? Number(header) : null;
      const transfer = reportTransfer(onProgress, Number.isSafeInteger(size) ? size : null);
      const meter = new Transform({ transform(chunk, _encoding, done) {
        transfer.add(chunk.length);
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), meter, tempHandle.createWriteStream(), { signal: operationSignal });
      operationSignal.throwIfAborted();
      transfer.saving();
      try {
        await link(temp, destination);
      } catch (error) {
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL'].includes(error.code)) throw error;
        await copyFile(temp, destination, constants.COPYFILE_EXCL);
      }
      return destination;
    } catch (error) {
      if (error.code === 'EEXIST') throw new ApiError('目标文件已存在，请选择其他保存位置。', { code: 'FILE_EXISTS' });
      if (operationSignal.aborted) throw transportError(error, operationSignal);
      if (error instanceof ApiError) throw error;
      throw new ApiError('下载未保存。请检查保存位置的写入权限和剩余空间。');
    } finally {
      if (tempHandle) {
        await tempHandle.close().catch(() => {});
        await unlink(temp).catch(() => {});
      }
    }
  }
}

module.exports = { WorkbenchClient, ApiError };

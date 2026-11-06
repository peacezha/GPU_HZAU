import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream';
import httpProxy from 'http-proxy';

const UPSTREAM = new URL('https://xrapi.wuhan.net.cn:9443');
const TOKEN = /^[a-f0-9]{64}$/;
const MAX_TICKETS = 128;
const MAX_CONNECTIONS = 256;
const MAX_SOCKETS = 64;
const SECRET_QUERY = /token|auth|secret|password|credential|session|key/i;
const randomToken = () => randomBytes(32).toString('hex');
const problem = (status, message) => Object.assign(new Error(message), { status });
const cookieValue = (value, name) => String(value || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);

function safePath(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return false;
  let decoded = pathname;
  for (let depth = 0; depth < 5; depth++) {
    if (/[\\\x00-\x1f\x7f]/.test(decoded) || /%2f|%5c/i.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) return false;
    let next;
    try { next = decodeURIComponent(decoded); } catch { return depth > 0; }
    if (next === decoded) return true;
    decoded = next;
  }
  return false;
}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw problem(502, '工作区地址不可用。'); }
  const match = /^\/notebook\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})(?:\/|$)/.exec(url.pathname);
  if (url.origin !== UPSTREAM.origin || url.username || url.password || url.hash || !match || [...url.searchParams.keys()].some(key => SECRET_QUERY.test(key))) throw problem(502, '工作区地址不在允许的范围。');
  const prefix = `/notebook/${match[1]}/`;
  if (url.pathname === prefix.slice(0, -1)) url.pathname = prefix;
  if (!safePath(url.pathname, prefix)) throw problem(502, '工作区地址不在允许的范围。');
  return { url, prefix };
}

// Service cookies remain in this process, including cookies refreshed by the IDE.
// They are never exposed in browser cookies, redirects or response JSON.
class ServiceCookies {
  constructor(header) {
    this.values = new Map();
    if (typeof header !== 'string' || !header || header.length > 32768 || /[\r\n]/.test(header)) throw problem(502, '工作区登录态不可用，请重新登录。');
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index > 0) this.store(part.slice(0, index).trim(), part.slice(index + 1).trim(), '/', Infinity, true);
    }
    if (!this.values.size) throw problem(502, '工作区登录态不可用，请重新登录。');
  }
  store(name, value, path, expires = Infinity, seeded = false) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || /[\x00-\x20\x7f;]/.test(value) || value.length > 8192) return;
    // The provider supplies a Cookie header without the original Path metadata.
    // A real Set-Cookie supersedes that unknown-path seed, avoiding duplicate
    // old/new session values when the IDE uses a narrower cookie path.
    if (!seeded) for (const [key, cookie] of this.values) if (cookie.seeded && cookie.name === name) this.values.delete(key);
    const key = `${name}\0${path}`;
    if (expires <= Date.now()) { this.values.delete(key); return; }
    if (!this.values.has(key) && this.values.size >= 64) return;
    this.values.set(key, { name, value, path, expires, seeded });
  }
  update(headers, requestPath) {
    for (const header of Array.isArray(headers) ? headers : headers ? [headers] : []) {
      const [first, ...attributes] = String(header).split(';');
      const index = first.indexOf('=');
      if (index <= 0) continue;
      const options = new Map(attributes.map(attribute => { const split = attribute.indexOf('='); return split < 0 ? [attribute.trim().toLowerCase(), ''] : [attribute.slice(0, split).trim().toLowerCase(), attribute.slice(split + 1).trim()]; }));
      const domain = options.get('domain')?.replace(/^\./, '').toLowerCase();
      if (domain && domain !== UPSTREAM.hostname && !UPSTREAM.hostname.endsWith(`.${domain}`)) continue;
      const candidate = options.get('path');
      const path = candidate?.startsWith('/') ? candidate : requestPath.slice(0, requestPath.lastIndexOf('/') + 1) || '/';
      let expires = Infinity;
      if (options.has('max-age') && /^-?\d+$/.test(options.get('max-age'))) expires = Date.now() + Number(options.get('max-age')) * 1000;
      else if (options.has('expires')) { const timestamp = Date.parse(options.get('expires')); if (Number.isFinite(timestamp)) expires = timestamp; }
      this.store(first.slice(0, index).trim(), first.slice(index + 1).trim(), path, expires);
    }
  }
  header(pathname) {
    const result = [];
    for (const [key, cookie] of this.values) {
      if (cookie.expires <= Date.now()) { this.values.delete(key); continue; }
      if (pathname === cookie.path || pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)) result.push(cookie);
    }
    return result.sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }
  clear() { this.values.clear(); }
}

/** Create an unbound loopback-only HTTP/WebSocket proxy. */
export function createWorkspaceProxy({ getSession, portalPort = Number(process.env.PORT || 4318), cookieName = 'workspace_session' } = {}) {
  if (typeof getSession !== 'function') throw new TypeError('getSession is required');
  const configuredPort = Number(process.env.WORKSPACE_PORT || 4320);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) throw new Error('工作区代理端口配置无效。');
  const tickets = new Map();
  const connections = new Map();
  const sockets = new Map();
  const outgoingSockets = new Set();
  const outgoingRequests = new Set();
  const guardedSockets = new WeakSet();
  function guardSocket(socket) {
    if (!socket || typeof socket.on !== 'function' || guardedSockets.has(socket)) return;
    guardedSockets.add(socket);
    // Node releases its HTTP error handler during a WebSocket upgrade. Keep
    // ownership from accept/connect through asynchronous authorization/close.
    socket.on('error', () => { if (!socket.destroyed) socket.destroy(); });
  }
  let closed = false;
  const proxy = httpProxy.createProxyServer({ target: UPSTREAM.origin, secure: true, changeOrigin: true, ws: true, xfwd: false, followRedirects: false, selfHandleResponse: true, proxyTimeout: 120000 });
  const server = http.createServer((req, res) => {
    req.on('error', () => res.destroy());
    res.on('error', () => res.destroy());
    handleHttp(req, res).catch(() => sendError(res, 502));
  });
  server.on('connection', guardSocket);
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;

  const nativeListen = server.listen.bind(server);
  server.listen = (...args) => {
    if (typeof args[0] === 'object' && args[0] !== null) {
      if (args[0].path || (args[0].host && args[0].host !== '127.0.0.1')) throw new Error('工作区代理仅允许监听本机地址。');
      return nativeListen({ ...args[0], host: '127.0.0.1' }, ...args.slice(1));
    }
    const port = args[0] ?? configuredPort;
    if (!/^\d+$/.test(String(port)) || Number(port) > 65535) throw new Error('工作区代理端口配置无效。');
    if (typeof args[1] === 'string' && args[1] !== '127.0.0.1') throw new Error('工作区代理仅允许监听本机地址。');
    return nativeListen(Number(port), '127.0.0.1', ...(typeof args[1] === 'string' ? args.slice(2) : args.slice(1)));
  };

  function localOrigin() {
    const address = server.address();
    if (!address || typeof address === 'string') throw problem(503, '工作区代理尚未启动。');
    return `http://127.0.0.1:${address.port}`;
  }
  async function alive(session) {
    return !closed && !!session && typeof session._sid === 'string' && TOKEN.test(session._sid) && Number.isFinite(session.expiresAt) && session.expiresAt > Date.now() && !!session.provider && !session.provider.closed && await getSession(session._sid) === session;
  }
  function sendError(destination, status = 502, reason = 'workspace') {
    if (!destination || destination.destroyed || destination.writableEnded) return;
    const message = status === 401 ? '工作区会话已结束，请返回工作台重新打开。' : status === 403 ? '工作区请求不在允许的范围。' : '工作区暂时无法连接，请返回工作台重试。';
    if (destination instanceof http.ServerResponse) {
      if (destination.headersSent) { destination.destroy(); return; }
      destination.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Workbench-Proxy-Error': reason });
      destination.end(message);
    } else if (!destination.destroyed) {
      destination.end(`HTTP/1.1 ${status} Error\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
    }
  }
  function requestUrl(req) {
    const origin = localOrigin();
    if (req.headers.host !== new URL(origin).host || typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) throw problem(403, '工作区请求不在允许的范围。');
    return new URL(req.url, origin);
  }
  async function authorize(req, websocket = false) {
    const url = requestUrl(req);
    if ((websocket && req.headers.origin !== localOrigin()) || (req.headers.origin && req.headers.origin !== localOrigin()) || req.headers['sec-fetch-site'] === 'cross-site') throw problem(403, '工作区请求来源无效。');
    const id = cookieValue(req.headers.cookie, cookieName);
    const record = TOKEN.test(id || '') ? connections.get(id) : null;
    if (!record || !await alive(record.session)) throw problem(401, '工作区会话已结束。');
    if (!safePath(url.pathname, record.prefix)) throw problem(403, '工作区请求不在允许的范围。');
    req.url = url.pathname + url.search;
    req.workspaceRecord = record;
    const headers = { ...req.headers };
    for (const key of Object.keys(headers)) if (['cookie', 'authorization', 'proxy-authorization', 'x-csrf-token', 'forwarded', 'referer'].includes(key) || key.startsWith('x-forwarded-')) delete headers[key];
    const cookie = record.cookies.header(url.pathname);
    if (cookie) headers.cookie = cookie;
    if (headers.origin) headers.origin = UPSTREAM.origin;
    const xsrf = cookieValue(cookie, '_xsrf');
    if (xsrf && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) headers['x-xsrftoken'] = xsrf;
    req.headers = headers;
    return record;
  }
  function rewriteResponse(response, req) {
    const record = req.workspaceRecord;
    record.cookies.update(response.headers['set-cookie'], new URL(req.url, UPSTREAM).pathname);
    delete response.headers['set-cookie'];
    delete response.headers['x-workbench-proxy-error'];
    const location = response.headers.location;
    if (location) {
      let destination;
      try { destination = new URL(location, new URL(req.url, UPSTREAM)); } catch { return false; }
      if (destination.origin !== UPSTREAM.origin || destination.username || destination.password || !safePath(destination.pathname, record.prefix) || [...destination.searchParams.keys()].some(key => SECRET_QUERY.test(key))) return false;
      response.headers.location = `${localOrigin()}${destination.pathname}${destination.search}${destination.hash}`;
    }
    if (response.headers.refresh) return false;
    // A service worker must stay inside the notebook URL space.
    const workerScope = response.headers['service-worker-allowed'];
    if (workerScope) {
      let scope;
      try { scope = new URL(workerScope, new URL(req.url, UPSTREAM)); } catch { return false; }
      if (scope.origin !== UPSTREAM.origin || !safePath(scope.pathname, record.prefix)) return false;
    }
    return true;
  }
  async function handleHttp(req, res) {
    let url;
    try { url = requestUrl(req); } catch (error) { sendError(res, error.status || 403); return; }
    const connect = /^\/connect\/([a-f0-9]{64})$/.exec(url.pathname);
    if (connect) {
      const origins = [`http://127.0.0.1:${portalPort}`, `http://localhost:${portalPort}`, `http://[::1]:${portalPort}`, localOrigin()];
      if (!['GET', 'HEAD'].includes(req.method) || url.search || (req.headers.origin && !origins.includes(req.headers.origin))) { sendError(res, 403); return; }
      const ticket = tickets.get(connect[1]);
      // Consume before the asynchronous session lookup: concurrent requests
      // cannot both redeem the same ticket, even with an async getSession.
      tickets.delete(connect[1]);
      if (!ticket || ticket.expiresAt <= Date.now() || !await alive(ticket.record.session)) { tickets.delete(connect[1]); sendError(res, 401); return; }
      const id = randomToken();
      if (connections.size >= MAX_CONNECTIONS) { sendError(res, 503); return; }
      connections.set(id, ticket.record);
      res.writeHead(303, { Location: `${localOrigin()}${ticket.record.initialPath}`, 'Set-Cookie': `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=${ticket.record.prefix}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Length': '0' });
      res.end();
      return;
    }
    try { await authorize(req); } catch (error) { sendError(res, error.status || 401); return; }
    if (req.aborted || req.socket.destroyed || res.destroyed) return;
    proxy.web(req, res, {}, () => sendError(res, 502));
  }

  proxy.on('proxyRes', (upstream, req, res) => {
    if (!rewriteResponse(upstream, req)) { upstream.destroy(); sendError(res, 502, 'upstream-response-rejected'); return; }
    const headers = { ...upstream.headers };
    for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete headers[name];
    res.writeHead(upstream.statusCode || 502, headers);
    pipeline(upstream, res, error => { if (error) res.destroy(); });
  });
  proxy.on('proxyReqWs', (upstream, req, socket) => {
    guardSocket(socket);
    upstream.on('socket', guardSocket);
    upstream.on('error', () => socket.destroy());
    outgoingRequests.add(upstream);
    upstream.once('close', () => outgoingRequests.delete(upstream));
    upstream.setTimeout(30000, () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
    // http-proxy installs its handshake handlers after this event, so these
    // listeners filter response headers before anything reaches the browser.
    upstream.on('upgrade', (response, proxySocket) => {
      guardSocket(proxySocket);
      socket.once('close', () => proxySocket.destroy());
      proxySocket.once('close', () => socket.destroy());
      if (!rewriteResponse(response, req)) { response.headers = {}; sendError(socket, 502); socket.destroy(); }
    });
    upstream.on('response', response => {
      if (!rewriteResponse(response, req)) { response.upgrade = true; response.destroy(); sendError(socket, 502); }
    });
  });
  proxy.on('proxyReq', request => { request.on('socket', guardSocket); outgoingRequests.add(request); request.once('close', () => outgoingRequests.delete(request)); });
  proxy.on('open', socket => { guardSocket(socket); outgoingSockets.add(socket); socket.once('close', () => outgoingSockets.delete(socket)); });
  proxy.on('error', (_error, _req, destination) => sendError(destination, 502));
  server.on('upgrade', (req, socket, head) => {
    guardSocket(socket);
    req.on('error', () => socket.destroy());
    (async () => {
      if (sockets.size >= MAX_SOCKETS) { sendError(socket, 503); return; }
      let record;
      try { record = await authorize(req, true); } catch (error) { sendError(socket, error.status || 401); return; }
      if (socket.destroyed || req.aborted) return;
      if (sockets.size >= MAX_SOCKETS) { sendError(socket, 503); return; }
      sockets.set(socket, record);
      socket.once('close', () => sockets.delete(socket));
      proxy.ws(req, socket, head, {}, () => sendError(socket, 502));
    })().catch(() => sendError(socket, 502));
  });
  server.on('clientError', (_error, socket) => { if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });

  let sweeping = false;
  const cleanup = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const [id, ticket] of tickets) if (ticket.expiresAt <= Date.now() || !await alive(ticket.record.session)) { ticket.record.cookies.clear(); tickets.delete(id); }
      for (const [id, record] of connections) if (!await alive(record.session)) { record.cookies.clear(); connections.delete(id); }
      for (const [socket, record] of sockets) if (!await alive(record.session)) socket.destroy();
    } catch { /* Failed lookups deny subsequent requests; never log credentials. */ }
    finally { sweeping = false; }
  }, 1000);
  cleanup.unref();

  async function issue(session, resourceId) {
    const origin = localOrigin();
    const record = await resolveWorkspace(session, resourceId);
    if (tickets.size >= MAX_TICKETS) { record.cookies.clear(); throw problem(429, '工作区打开请求过多，请稍后重试。'); }
    const ticket = randomToken();
    tickets.set(ticket, { expiresAt: Date.now() + 60000, record });
    return { proxyUrl: `${origin}/connect/${ticket}` };
  }
  async function resolveWorkspace(session, resourceId, expectedPrefix) {
    if (!await alive(session)) throw problem(401, '当前会话已结束，请重新登录。');
    if (typeof resourceId !== 'string' || !resourceId || resourceId.length > 256) throw problem(400, '资源编号无效。');
    const connection = await session.provider.getWorkspaceConnection(resourceId);
    if (!connection?.url || connection.supported === false || !await alive(session)) throw problem(503, '此工作区当前无法通过本机代理打开。');
    const { url, prefix } = endpoint(connection.url);
    if (expectedPrefix !== undefined && prefix !== expectedPrefix) throw problem(409, '资源已切换到新的算力实例，请在新实例部署。');
    const cookies = new ServiceCookies(connection.headers?.Cookie || connection.headers?.cookie);
    return { session, prefix, cookies, initialPath: url.pathname + url.search };
  }
  // Internal access for an isolated browser context. The opaque cookie stays
  // scoped to this instance and is never sent to the upstream service.
  async function openAutomation(session, resourceId, expectedPrefix) {
    const origin = localOrigin();
    if (typeof expectedPrefix !== 'string') throw problem(400, '缺少算力实例范围。');
    const record = await resolveWorkspace(session, resourceId, expectedPrefix);
    if (connections.size >= MAX_CONNECTIONS) { record.cookies.clear(); throw problem(429, '工作区连接过多，请稍后重试。'); }
    const id = randomToken();
    connections.set(id, record);
    return {
      url: `${origin}${record.initialPath}`, cookie: id, cookieName,
      close() {
        connections.delete(id);
        record.cookies.clear();
        for (const [socket, owner] of sockets) if (owner === record) socket.destroy();
      },
    };
  }
  async function close() {
    closed = true;
    clearInterval(cleanup);
    for (const ticket of tickets.values()) ticket.record.cookies.clear();
    for (const record of connections.values()) record.cookies.clear();
    tickets.clear(); connections.clear();
    for (const socket of sockets.keys()) socket.destroy();
    for (const socket of outgoingSockets) socket.destroy();
    for (const request of outgoingRequests) request.destroy();
    sockets.clear(); outgoingSockets.clear(); outgoingRequests.clear();
    server.closeAllConnections();
    await new Promise(resolve => { if (!server.listening) resolve(); else server.close(resolve); });
  }
  return { server, issue, openAutomation, close };
}

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream';
import httpProxy from 'http-proxy';

export const JUPYTER_ORIGIN = 'https://xrapi.wuhan.net.cn:9443';
export const NOTEBOOK_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const KEY = /^[a-zA-Z0-9_-]{1,128}$/;
const randomToken = () => randomBytes(32).toString('hex');

// A reopened window or a second computer gets its own server in the same
// instance. An earlier server can finish its work without surrendering a port.
export function jupyterPort(pairToken) {
  return 40000 + (Number.parseInt(pairToken.slice(0, 4), 16) & 0x3fff);
}

function permitted(path, method, websocket) {
  const [empty, api, type, id, action, ...rest] = path.split('/');
  if (empty || api !== 'api' || rest.length || (id !== undefined && !KEY.test(id))) return false;
  if (websocket) return method === 'GET' && type === 'kernels' && NOTEBOOK_ID.test(id) && action === 'channels';
  if (!type || type === 'status') return method === 'GET' && id === undefined;
  if (type === 'kernelspecs') return method === 'GET' && action === undefined;
  if (type === 'sessions') return action === undefined && (id === undefined
    ? ['GET', 'POST'].includes(method) : ['GET', 'PATCH', 'DELETE'].includes(method));
  if (type === 'kernels') {
    if (!id) return action === undefined && ['GET', 'POST'].includes(method);
    if (!NOTEBOOK_ID.test(id)) return false;
    if (action !== undefined) return method === 'POST' && ['restart', 'interrupt'].includes(action);
    return ['GET', 'DELETE'].includes(method);
  }
  return false;
}

function validToken(given, expected) {
  return typeof given === 'string' && TOKEN.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function createJupyterProxy({ getSession, upstreamOrigin = JUPYTER_ORIGIN } = {}) {
  const upstream = new URL(upstreamOrigin);
  if (typeof getSession !== 'function' || upstream.origin !== upstreamOrigin ||
      (upstream.origin !== JUPYTER_ORIGIN && !(upstream.protocol === 'http:' && upstream.hostname === '127.0.0.1'))) {
    throw new TypeError('Invalid Jupyter proxy options');
  }
  const records = new Map();
  const sockets = new Map();
  const proxy = httpProxy.createProxyServer({ target: upstream.origin, secure: true, changeOrigin: true,
    ws: true, followRedirects: false, selfHandleResponse: true, proxyTimeout: 30_000 });
  let closed = false;
  const server = http.createServer((req, res) => {
    req.on('error', () => res.destroy());
    res.on('error', () => res.destroy());
    forward(req, res).catch(() => reject(res, 502));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on('connection', guard);
  server.on('upgrade', (req, socket, head) => {
    req.on('error', () => socket.destroy());
    forward(req, socket, head).catch(() => reject(socket, 502));
  });

  function guard(socket) {
    socket.on('error', () => socket.destroy());
  }

  function origin() {
    return server.listening ? `http://127.0.0.1:${server.address().port}` : '';
  }

  async function live(session) {
    return !closed && session?.expiresAt > Date.now() && !session.provider?.closed &&
      TOKEN.test(session._sid || '') && await getSession(session._sid) === session;
  }

  function reject(destination, status) {
    if (destination.destroyed || destination.writableEnded) return;
    if (destination instanceof http.ServerResponse) {
      if (destination.headersSent) return destination.destroy();
      destination.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      destination.end(JSON.stringify({ message: 'Jupyter connection unavailable.' }));
    } else {
      destination.end(`HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  }

  async function forward(req, destination, head) {
    const websocket = head !== undefined;
    const local = origin();
    if (!local || req.headers.host !== new URL(local).host ||
        (req.headers.origin !== undefined && req.headers.origin !== local) || req.headers['sec-fetch-site'] === 'cross-site' ||
        typeof req.url !== 'string' || req.url.length > 4096) return reject(destination, 403);
    // Work on the raw path. URL normalization can silently remove dot segments.
    const [rawPath, rawQuery = ''] = req.url.split(/\?(.*)/s, 2);
    const match = /^\/jupyter\/([0-9a-f]{64})(\/api(?:\/[a-zA-Z0-9_-]+)*)$/.exec(rawPath);
    if (!match || !permitted(match[2], req.method, websocket)) return reject(destination, 404);
    const record = records.get(match[1]);
    const query = new URLSearchParams(rawQuery);
    const tokens = query.getAll('token');
    const auth = /^token ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!record || (req.headers.authorization !== undefined && !validToken(auth?.[1], record.token)) ||
        (tokens.length && (tokens.length !== 1 || !validToken(tokens[0], record.token))) ||
        (!auth && !tokens.length) || !await live(record.session) || records.get(match[1]) !== record) return reject(destination, 401);
    if (destination.destroyed || req.aborted || req.socket.destroyed) return;
    if (websocket && sockets.size >= 64) return reject(destination, 503);
    query.delete('token');
    req.url = `${record.target.prefix}proxy/${jupyterPort(record.pairToken)}${match[2]}${query.size ? `?${query}` : ''}`;
    const headers = { host: upstream.host, cookie: record.target.headers.Cookie, authorization: `token ${record.pairToken}` };
    if (record.target.headers['X-XSRF-TOKEN']) headers['x-xsrf-token'] = record.target.headers['X-XSRF-TOKEN'];
    if (req.headers.origin) headers.origin = upstream.origin;
    for (const key of (websocket ? ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']
      : ['accept', 'content-type', 'content-length', 'transfer-encoding'])) {
      if (req.headers[key] !== undefined) headers[key] = req.headers[key];
    }
    req.headers = headers;
    if (websocket) {
      sockets.set(destination, record);
      destination.once('close', () => sockets.delete(destination));
      proxy.ws(req, destination, head, {}, () => reject(destination, 502));
    } else {
      proxy.web(req, destination, {}, () => reject(destination, 502));
    }
  }

  proxy.on('proxyRes', (response, _req, res) => {
    const status = response.statusCode || 502;
    const contentType = response.headers['content-type'];
    if (status >= 300 && status < 400 || response.headers.refresh ||
        (status !== 204 && !/^application\/json\b/i.test(contentType || ''))) {
      response.destroy();
      reject(res, 502);
      return;
    }
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    for (const name of ['content-type', 'content-length', 'content-encoding']) {
      if (response.headers[name]) headers[name] = response.headers[name];
    }
    res.writeHead(status, headers);
    pipeline(response, res, error => { if (error) res.destroy(); });
  });
  proxy.on('proxyReqWs', (request, _req, socket) => {
    request.on('socket', guard);
    socket.once('close', () => request.destroy());
    request.setTimeout(15_000, () => request.destroy());
    request.on('upgrade', (response, peer) => {
      guard(peer);
      for (const name of Object.keys(response.headers)) {
        if (!['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions'].includes(name)) delete response.headers[name];
      }
      socket.once('close', () => peer.destroy());
      peer.once('close', () => socket.destroy());
    });
    request.on('response', response => {
      // http-proxy would otherwise copy upstream error headers and HTML.
      response.upgrade = true;
      response.destroy();
      reject(socket, 502);
    });
  });
  proxy.on('error', (_error, _req, destination) => reject(destination, 502));

  async function issue(session, target, pairToken, resourceId = '') {
    if (!origin() || !await live(session) || !NOTEBOOK_ID.test(target?.instanceId || '') ||
        target.prefix !== `/notebook/${target.instanceId}/` || !TOKEN.test(pairToken) ||
        typeof target.headers?.Cookie !== 'string' || !target.headers.Cookie || /[\r\n]/.test(target.headers.Cookie)) {
      throw new Error('Jupyter target is unavailable');
    }
    for (const [id, record] of records) {
      if (record.session === session && record.resourceId === resourceId && record.target.instanceId === target.instanceId && record.pairToken === pairToken) {
        record.target = target;
        return `${origin()}/jupyter/${id}/?token=${record.token}`;
      }
    }
    revoke(session, resourceId);
    if (records.size >= 64) throw new Error('Too many Jupyter connections');
    const id = randomToken(), token = randomToken();
    records.set(id, { session, resourceId, target, token, pairToken });
    return `${origin()}/jupyter/${id}/?token=${token}`;
  }

  function remove(id, record) {
    records.delete(id);
    for (const [socket, owner] of sockets) if (owner === record) socket.destroy();
  }

  function revoke(session, resourceId) {
    for (const [id, record] of records) {
      if (record.session === session && (resourceId === undefined || record.resourceId === resourceId)) remove(id, record);
    }
  }

  const sweep = setInterval(async () => {
    for (const [id, record] of records) {
      if (!await live(record.session).catch(() => false) && records.get(id) === record) remove(id, record);
    }
  }, 1000);
  sweep.unref();

  const nativeListen = server.listen.bind(server);
  server.listen = () => { throw new Error('Use the loopback Jupyter listener'); };
  function listen(port = 4321) {
    return new Promise((resolve, rejectListen) => {
      server.once('error', rejectListen);
      nativeListen(port, '127.0.0.1', () => {
        server.off('error', rejectListen);
        resolve(origin());
      });
    });
  }

  async function close() {
    closed = true;
    clearInterval(sweep);
    for (const [id, record] of records) remove(id, record);
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }

  return { server, listen, issue, revoke, close };
}

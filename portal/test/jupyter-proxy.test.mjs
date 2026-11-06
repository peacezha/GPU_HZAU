import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createJupyterProxy, jupyterPort } from '../server/jupyter-proxy.mjs';

const instanceId = '052ae4c1-481b-41fd-b043-ba06100af10f';
const kernelId = '11111111-1111-4111-8111-111111111111';
const prefix = `/notebook/${instanceId}/`;
const pairToken = 'b'.repeat(64);
const upstreamPort = jupyterPort(pairToken);
const platformCookie = 'platform_session=server-only';
const jupyterProtocol = 'v1.kernel.websocket.jupyter.org';

async function setup(t) {
  const requests = [];
  const upstreamSockets = new Set();
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.setHeader('Set-Cookie', 'upstream_session=private; Path=/');
    if (req.url.endsWith('/api/status?redirect=1')) {
      res.writeHead(302, { Location: 'https://example.com/unrelated' });
      res.end();
      return;
    }
    const created = req.method === 'POST' && req.url.endsWith('/api/sessions');
    if (created) res.setHeader('Location', `/api/sessions/${kernelId}`);
    res.writeHead(created ? 201 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready: true }));
  });
  upstream.on('connection', socket => {
    upstreamSockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => upstreamSockets.delete(socket));
  });
  upstream.on('upgrade', (req, socket) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, websocket: true });
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${jupyterProtocol}\r\nSet-Cookie: websocket_session=private; Path=/\r\n\r\n`);
    socket.once('data', () => {
      const result = Buffer.from('kernel reply');
      socket.write(Buffer.concat([Buffer.from([0x81, result.length]), result]));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const session = { _sid: 'a'.repeat(64), expiresAt: Date.now() + 60_000, provider: { closed: false } };
  const sessions = new Map([[session._sid, session]]);
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = createJupyterProxy({ getSession: sid => sessions.get(sid), upstreamOrigin });
  t.after(async () => {
    await proxy.close();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  await proxy.listen(0);
  const target = { instanceId, prefix, headers: { Cookie: platformCookie } };
  const endpoint = new URL(await proxy.issue(session, target, pairToken, 'gpu'));
  const token = endpoint.searchParams.get('token');
  const authorization = `token ${token}`;
  const url = (path, query = '') => new URL(`${endpoint.pathname}${path}${query}`, endpoint.origin);
  return { proxy, session, sessions, target, requests, endpoint, token, authorization, url };
}

function rawRequest(endpoint, path, headers = {}, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: endpoint.hostname, port: endpoint.port, method, path, headers }, response => {
      response.resume();
      resolve(response);
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('Local test HTTP request timed out')));
    request.on('upgrade', (response, socket) => { socket.destroy(); resolve(response); });
    request.end();
  });
}

test('Jupyter REST scopes the instance and substitutes only server-side credentials', async t => {
  const { requests, endpoint, token, authorization, url } = await setup(t);
  assert.match(endpoint.href, /^http:\/\/127\.0\.0\.1:\d+\/jupyter\/[0-9a-f]{64}\/\?token=[0-9a-f]{64}$/);
  assert.notEqual(token, pairToken);
  const response = await fetch(url('api/kernelspecs', `?token=${token}`), {
    headers: { Authorization: authorization, Cookie: 'local_session=never-forward', 'X-Forwarded-Host': 'untrusted.example' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { ready: true });
  const forwarded = requests[0];
  assert.equal(forwarded.url, `${prefix}proxy/${upstreamPort}/api/kernelspecs`);
  assert.equal(forwarded.headers.authorization, `token ${pairToken}`);
  assert.equal(forwarded.headers.cookie, platformCookie);
  assert.equal(forwarded.headers['x-forwarded-host'], undefined);

  const body = { path: 'untitled.ipynb', type: 'notebook', name: 'untitled.ipynb', kernel: { name: 'python3' } };
  const start = await fetch(url('api/sessions'), { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(start.status, 201);
  assert.equal(start.headers.get('location'), null);
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].url, `${prefix}proxy/${upstreamPort}/api/sessions`);
  assert.deepEqual(JSON.parse(requests[1].body), body);
});

test('Jupyter local proxy rejects browser origins, forged hosts, tokens and paths before forwarding', async t => {
  const { requests, endpoint, token, authorization } = await setup(t);
  const statusPath = `${endpoint.pathname}api/status`;
  const blocked = [
    [statusPath, {}],
    [statusPath, { Authorization: `token ${'c'.repeat(64)}` }],
    [`${statusPath}?token=${token}&token=${token}`, {}],
    [`${statusPath}?token=${'c'.repeat(64)}`, { Authorization: authorization }],
    [statusPath, { Authorization: authorization, Origin: 'https://untrusted.example' }],
    [statusPath, { Authorization: authorization, Host: 'untrusted.example' }],
    [statusPath, { Authorization: authorization, 'Sec-Fetch-Site': 'cross-site' }],
    [`${endpoint.pathname}api/contents`, { Authorization: authorization }],
    [`${endpoint.pathname}api/terminals`, { Authorization: authorization }],
    [`${endpoint.pathname}api/status/../status`, { Authorization: authorization }],
    [`${endpoint.pathname}api/status/%252e%252e/status`, { Authorization: authorization }],
    [`/jupyter/${'d'.repeat(64)}/api/status`, { Authorization: authorization }],
  ];
  for (const [path, headers] of blocked) {
    const response = await rawRequest(endpoint, path, headers);
    assert.ok([400, 401, 403, 404].includes(response.statusCode), `Unexpected status ${response.statusCode} for ${path.split('?')[0]}`);
  }
  const response = await rawRequest(endpoint, statusPath, { Authorization: authorization }, { method: 'POST' });
  assert.ok([400, 403, 404, 405].includes(response.statusCode));
  assert.equal(requests.length, 0);
});

test('Jupyter proxy suppresses redirects and strips upstream cookies', async t => {
  const { requests, url, authorization } = await setup(t);
  const response = await fetch(url('api/status', '?redirect=1'), { redirect: 'manual', headers: { Authorization: authorization } });
  assert.ok(response.status >= 400);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(requests.length, 1);
});

test('Jupyter kernel WebSocket forwards messages and closes when the connection is revoked', async t => {
  const { proxy, session, requests, endpoint, token, authorization, url } = await setup(t);
  const channel = `api/kernels/${kernelId}/channels`;
  const upgradeHeaders = {
    Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': 'MTIzNDU2Nzg5MDEyMzQ1Ng==', 'Sec-WebSocket-Protocol': jupyterProtocol,
  };
  const channelPath = `${endpoint.pathname}${channel}`;
  const crossSite = await rawRequest(endpoint, channelPath, { ...upgradeHeaders, Authorization: authorization, Origin: 'https://untrusted.example' });
  assert.ok([401, 403, 404].includes(crossSite.statusCode));
  const unsupportedPath = await rawRequest(endpoint, `${endpoint.pathname}api/terminals/websocket/1`, { ...upgradeHeaders, Authorization: authorization });
  assert.ok([401, 403, 404].includes(unsupportedPath.statusCode));
  assert.equal(requests.length, 0);
  const handshake = await rawRequest(endpoint, channelPath, { ...upgradeHeaders, Authorization: authorization });
  assert.equal(handshake.statusCode, 101);
  assert.equal(handshake.headers['set-cookie'], undefined);

  const remote = url(channel, `?session_id=${kernelId}&token=${token}`);
  remote.protocol = 'ws:';
  const socket = new WebSocket(remote, jupyterProtocol);
  const timeout = { signal: AbortSignal.timeout(5000) };
  await once(socket, 'open', timeout);
  const reply = once(socket, 'message', timeout);
  socket.send('execute_request');
  assert.equal((await reply)[0].data, 'kernel reply');
  const forwarded = requests.at(-1);
  assert.equal(forwarded.url, `${prefix}proxy/${upstreamPort}/${channel}?session_id=${kernelId}`);
  assert.equal(forwarded.headers.authorization, `token ${pairToken}`);
  assert.equal(forwarded.headers.cookie, platformCookie);
  assert.equal(forwarded.headers['sec-websocket-protocol'], jupyterProtocol);
  const closed = once(socket, 'close', timeout);
  await proxy.revoke(session, 'gpu');
  await closed;
  const response = await fetch(url('api/status'), { headers: { Authorization: authorization } });
  assert.ok([401, 403, 404].includes(response.status));
});

test('Jupyter routes require the same live workbench session for their full lifetime', async t => {
  const { proxy, session, sessions, requests, authorization, url } = await setup(t);
  await proxy.revoke({ ...session }, 'gpu');
  let response = await fetch(url('api/status'), { headers: { Authorization: authorization } });
  assert.equal(response.status, 200);
  await response.json();
  sessions.delete(session._sid);
  response = await fetch(url('api/status'), { headers: { Authorization: authorization } });
  assert.ok([401, 403, 404].includes(response.status));
  assert.equal(requests.length, 1);
});

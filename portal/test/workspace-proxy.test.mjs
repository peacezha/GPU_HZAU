import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createWorkspaceProxy } from '../server/workspace-proxy.mjs';

async function setup(t, { sessionDelay = 0 } = {}) {
  const received = [];
  const upstreamSockets = new Set();
  const upstream = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    if (req.url.includes('/outside')) { res.writeHead(302, { Location: 'https://example.com/elsewhere', 'Set-Cookie': 'remote=rotated; Path=/' }); res.end(); return; }
    if (req.url.includes('/other-instance')) { res.writeHead(302, { Location: 'https://xrapi.wuhan.net.cn:9443/notebook/another/' }); res.end(); return; }
    if (req.url.includes('/redirect')) { res.writeHead(302, { Location: '/notebook/instance-1/editor?folder=/home/work', 'Set-Cookie': 'remote=rotated; Path=/notebook/instance-1/' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Frame-Options': 'SAMEORIGIN' });
    res.end('workspace');
  });
  upstream.on('upgrade', (req, socket) => {
    received.push({ url: req.url, headers: req.headers, websocket: true });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: ws-secret=hidden; Path=/\r\nX-Frame-Options: SAMEORIGIN\r\n\r\n');
    socket.on('data', () => {});
    socket.on('error', () => {});
  });
  upstream.on('connection', socket => { upstreamSockets.add(socket); socket.once('close', () => upstreamSockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  // Keep the production target hardcoded. Redirect only this test process's
  // transport to a fake upstream so no external account or network is used.
  const originalRequest = https.request;
  https.request = (options, callback) => {
    assert.equal(options.hostname, 'xrapi.wuhan.net.cn');
    assert.equal(String(options.port), '9443');
    assert.notEqual(options.rejectUnauthorized, false);
    return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: upstream.address().port, agent: undefined }, callback);
  };
  const session = { _sid: 'a'.repeat(64), expiresAt: Date.now() + 60000, provider: { closed: false, getWorkspaceConnection: async () => ({ url: 'https://xrapi.wuhan.net.cn:9443/notebook/instance-1/?folder=/home/work', headers: { Cookie: 'remote=initial; _xsrf=server-xsrf' } }) } };
  const sessions = new Map([[session._sid, session]]);
  const workspace = createWorkspaceProxy({ getSession: async sid => { if (sessionDelay) await new Promise(resolve => setTimeout(resolve, sessionDelay)); return sessions.get(sid); } });
  await new Promise(resolve => workspace.server.listen(0, resolve));
  const base = `http://127.0.0.1:${workspace.server.address().port}`;
  t.after(async () => {
    await workspace.close();
    https.request = originalRequest;
    for (const socket of upstreamSockets) socket.destroy();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  async function bootstrap() {
    const issued = await workspace.issue(session, 'instance-1');
    const response = await fetch(issued.proxyUrl, { redirect: 'manual' });
    assert.equal(response.status, 303);
    return { issued, response, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  return { workspace, base, received, session, sessions, bootstrap };
}

test('workspace bootstrap is one-use and leaves only an opaque scoped cookie', async t => {
  const { bootstrap, base, received } = await setup(t);
  const { issued, response, cookie } = await bootstrap();
  assert.match(issued.proxyUrl, /\/connect\/[a-f0-9]{64}$/);
  assert.equal(response.headers.get('location'), `${base}/notebook/instance-1/?folder=/home/work`);
  const flags = response.headers.get('set-cookie');
  assert.match(flags, /HttpOnly/); assert.match(flags, /SameSite=Strict/); assert.match(flags, /Path=\/notebook\/instance-1\//);
  assert.ok(!flags.includes('initial'));
  assert.match(cookie, /^workspace_session=[a-f0-9]{64}$/);
  assert.equal((await fetch(issued.proxyUrl, { redirect: 'manual' })).status, 401);
  assert.equal(received.length, 0);
});

test('concurrent bootstrap requests cannot redeem the same ticket twice', async t => {
  const { workspace, session } = await setup(t, { sessionDelay: 10 });
  const issued = await workspace.issue(session, 'instance-1');
  const responses = await Promise.all([fetch(issued.proxyUrl, { redirect: 'manual' }), fetch(issued.proxyUrl, { redirect: 'manual' })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [303, 401]);
});

test('isolated automation authenticates directly and closes access for the exact instance', async t => {
  const { workspace, session, received, base } = await setup(t);
  await assert.rejects(workspace.openAutomation(session, 'instance-1', '/notebook/another/'), /新.*实例/);
  const access = await workspace.openAutomation(session, 'instance-1', '/notebook/instance-1/');
  assert.equal(access.url, `${base}/notebook/instance-1/?folder=/home/work`);
  assert.match(access.cookie, /^[a-f0-9]{64}$/);
  const headers = { Cookie: `workspace_session=${access.cookie}` };
  assert.equal((await fetch(access.url, { headers })).status, 200);
  assert.equal(received[0].headers.cookie, 'remote=initial; _xsrf=server-xsrf');
  assert.equal((await fetch(`${base}/notebook/another/`, { headers })).status, 403);
  access.close();
  assert.equal((await fetch(access.url, { headers })).status, 401);
});

test('workspace requests inject only server-side credentials and preserve upstream framing policy', async t => {
  const { bootstrap, base, received } = await setup(t);
  const { cookie } = await bootstrap();
  const response = await fetch(`${base}/notebook/instance-1/api/save`, { method: 'POST', headers: { Cookie: `${cookie}; portal_session=portal-secret`, Authorization: 'Bearer browser-secret', 'X-CSRF-Token': 'portal-csrf', Origin: base }, body: 'data' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(received[0].headers.cookie, 'remote=initial; _xsrf=server-xsrf');
  assert.equal(received[0].headers.authorization, undefined);
  assert.equal(received[0].headers['x-csrf-token'], undefined);
  assert.equal(received[0].headers['x-xsrftoken'], 'server-xsrf');
  assert.equal(received[0].headers.origin, 'https://xrapi.wuhan.net.cn:9443');
  assert.equal(received[0].headers.host, 'xrapi.wuhan.net.cn:9443');
});

test('workspace scope, origin and live main-session checks run before proxying', async t => {
  const { bootstrap, base, received, session, sessions } = await setup(t);
  const { cookie } = await bootstrap();
  assert.equal((await fetch(`${base}/notebook/instance-1/`)).status, 401);
  assert.equal((await fetch(`${base}/notebook/another/`, { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await fetch(`${base}/notebook/instance-1/%252e%252e/another`, { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await fetch(`${base}/notebook/instance-1/`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.example' } })).status, 403);
  sessions.delete(session._sid);
  assert.equal((await fetch(`${base}/notebook/instance-1/`, { headers: { Cookie: cookie } })).status, 401);
  assert.equal(received.length, 0);
});

test('redirects stay inside the notebook and rotated service cookies stay server-side', async t => {
  const { bootstrap, base, received } = await setup(t);
  const { cookie } = await bootstrap();
  let response = await fetch(`${base}/notebook/instance-1/redirect`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `${base}/notebook/instance-1/editor?folder=/home/work`);
  assert.equal(response.headers.get('set-cookie'), null);
  await fetch(`${base}/notebook/instance-1/editor`, { headers: { Cookie: cookie } });
  assert.equal(received.at(-1).headers.cookie, 'remote=rotated; _xsrf=server-xsrf');
  for (const route of ['outside', 'other-instance']) {
    response = await fetch(`${base}/notebook/instance-1/${route}`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('x-workbench-proxy-error'), 'upstream-response-rejected');
  }
});

test('workspace WebSocket upgrades authenticate origin and hide service cookies', async t => {
  const { bootstrap, base, received } = await setup(t);
  const { cookie } = await bootstrap();
  function connect(origin) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${base}/notebook/instance-1/socket`, { headers: { Cookie: `${cookie}; portal_session=hidden`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'test', ...(origin ? { Origin: origin } : {}) } });
      req.on('error', reject);
      req.on('upgrade', (response, socket) => { socket.destroy(); resolve(response); });
      req.on('response', response => { response.resume(); resolve(response); });
      req.end();
    });
  }
  assert.equal((await connect()).statusCode, 403);
  assert.equal((await connect('https://untrusted.example')).statusCode, 403);
  const response = await connect(base);
  assert.equal(response.statusCode, 101);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(received.at(-1).headers.origin, 'https://xrapi.wuhan.net.cn:9443');
  assert.ok(!received.at(-1).headers.cookie.includes('hidden'));
});

test('workspace rejects alternate upstreams and public listeners', async t => {
  const { workspace, session, base } = await setup(t);
  assert.throws(() => workspace.server.listen(0, '0.0.0.0'), /本机地址/);
  session.provider.getWorkspaceConnection = async () => ({ url: 'https://xrapi.wuhan.net.cn:9443/notebook/instance-1?folder=/home/work', headers: { Cookie: 'remote=secret' } });
  const issued = await workspace.issue(session, 'instance-1');
  assert.equal((await fetch(issued.proxyUrl, { redirect: 'manual' })).headers.get('location'), `${base}/notebook/instance-1/?folder=/home/work`);
  for (const url of ['https://example.com/notebook/instance-1/', 'https://xrapi.wuhan.net.cn:9443/notebook/instance-1/?token=secret', 'https://xrapi.wuhan.net.cn:9443/notebook/instance-1/%2fother']) {
    session.provider.getWorkspaceConnection = async () => ({ url, headers: { Cookie: 'remote=secret' } });
    await assert.rejects(workspace.issue(session, 'instance-1'), /允许的范围/);
  }
});

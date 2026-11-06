import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.mjs';
import { createTunnelManager } from '../server/tunnel-manager.mjs';

const origin = 'https://xrapi.wuhan.net.cn:9443';
const firstInstance = '11111111-1111-4111-8111-111111111111';
const secondInstance = '22222222-2222-4222-8222-222222222222';
const resource = 'notebook-resource';
const tunnelName = 'wuhan-a800';
const deviceUrl = 'https://github.com/login/device';
const accepted = { name: tunnelName, acceptServerLicense: true };

function snapshot(instanceId, overrides = {}) {
  return { instanceId, state: 'idle', tunnelName: null, deviceCode: null, deviceUrl: null, codeExpiresAt: null,
    message: 'Helper test state', ...overrides };
}

function fixture() {
  let instance = firstInstance;
  let connectionOverride = {};
  let helper;
  const sent = [];
  const provider = {
    getWorkspaceConnection: async id => {
      assert.equal(id, resource);
      return {
        supported: true,
        url: `${origin}/notebook/${instance}/?folder=/home/work`,
        allowedPrefix: `/notebook/${instance}/`,
        headers: { Cookie: 'fixture=upstream-session', 'X-XSRF-TOKEN': 'fixture-upstream-xsrf',
          Authorization: 'Bearer untrusted-upstream-value', Origin: 'https://unexpected.example' },
        ...connectionOverride,
      };
    },
    close() {},
  };
  const manager = createTunnelManager({
    loadAgent: async () => Buffer.from('# test fixture\n'),
    fetchImpl: async (url, options) => {
      const request = {
        url: new URL(url), method: options.method, headers: new Headers(options.headers),
        body: options.body === undefined ? undefined : JSON.parse(options.body),
        redirect: options.redirect,
      };
      sent.push(request);
      if (helper) return helper(request);
      const action = request.url.pathname.split('/').at(-1);
      return Response.json(snapshot(instance, {
        state: action === 'start' ? 'starting' : action === 'stop' ? 'stopped' : 'idle',
        tunnelName: action === 'start' ? request.body.name : null,
      }));
    },
  });
  return { manager, provider, sent, session: { provider }, newSession: () => ({ provider }),
    replaceInstance(id) { instance = id; }, setConnection(fields) { connectionOverride = fields; },
    setHelper(reply) { helper = reply; } };
}

function preparedToken(prepared) {
  const match = /'token': '([a-f0-9]{64})'/.exec(prepared.setupCommand || '');
  assert.ok(match, 'The setup command contains an opaque helper pairing token');
  return match[1];
}

test('tunnel start requires an explicit true license decision and never posts on invalid input', async () => {
  const { manager, session, sent } = fixture();
  await manager.prepare(session, resource);
  for (const body of [{ name: tunnelName }, { name: tunnelName, acceptServerLicense: false },
    { name: tunnelName, acceptServerLicense: 'true' }, { name: tunnelName, acceptServerLicense: 1 },
    { name: '../other', acceptServerLicense: true }]) {
    assert.equal((await manager.start(session, resource, body)).state, 'failed');
  }
  assert.deepEqual(sent, []);

  assert.equal((await manager.start(session, resource, accepted)).state, 'starting');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.deepEqual(sent[0].body, accepted);
});

test('helper transport is confined to the authorized platform instance and fixed action paths', async () => {
  const { manager, session, sent, setConnection } = fixture();
  for (const fields of [
    { url: `https://wrong.example/notebook/${firstInstance}/` },
    { url: `https://account@xrapi.wuhan.net.cn:9443/notebook/${firstInstance}/` },
    { url: `${origin}/notebook/${secondInstance}/` },
    { allowedPrefix: `/notebook/${firstInstance}/../` },
    { url: `${origin}/notebook/not-an-instance-uuid/`, allowedPrefix: '/notebook/not-an-instance-uuid/' },
    { headers: {} },
  ]) {
    setConnection(fields);
    const denied = await manager.prepare(session, resource);
    assert.equal(denied.state, 'unavailable');
    assert.equal(denied.setupCommand, undefined);
    assert.equal(sent.length, 0);
  }
});

test('helper proxy requests use only server session headers and the paired bearer', async () => {
  const { manager, session, sent } = fixture();
  const prepared = await manager.prepare(session, resource);
  const pair = preparedToken(prepared);
  const state = await manager.status(session, resource);
  assert.equal(state.state, 'idle');
  assert.ok(!JSON.stringify(state).includes(pair));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url.href, `${origin}/notebook/${firstInstance}/proxy/38751/status`);
  assert.equal(sent[0].method, 'GET');
  assert.equal(sent[0].redirect, 'error');
  assert.equal(sent[0].headers.get('cookie'), 'fixture=upstream-session');
  assert.equal(sent[0].headers.get('authorization'), `Bearer ${pair}`);
  assert.equal(sent[0].headers.get('origin'), null);

  await manager.start(session, resource, accepted);
  assert.equal(sent[1].url.href, `${origin}/notebook/${firstInstance}/proxy/38751/start`);
  assert.equal(sent[1].headers.get('content-type'), 'application/json');
});

test('GitHub codes are returned only for the paired waiting state with the exact URL and a live expiry', async () => {
  const { manager, session, setHelper } = fixture();
  await manager.prepare(session, resource);
  const good = { state: 'waiting_github', tunnelName, deviceCode: 'ABCD-1234', deviceUrl, codeExpiresAt: Date.now() + 30_000 };
  const reply = value => setHelper(() => Response.json(value));
  reply(snapshot(firstInstance, { ...good, unrelatedSecret: 'not for the client', message: `row\n${'x'.repeat(400)}` }));
  const waiting = await manager.status(session, resource);
  assert.equal(waiting.state, 'waiting_github');
  assert.equal(waiting.deviceCode, good.deviceCode);
  assert.equal(waiting.deviceUrl, deviceUrl);
  assert.equal(waiting.codeExpiresAt, good.codeExpiresAt);
  assert.equal(waiting.unrelatedSecret, undefined);
  assert.ok(waiting.message.length <= 320);
  assert.doesNotMatch(waiting.message, /[\x00-\x1f\x7f]/);

  for (const fields of [{ deviceUrl: `${deviceUrl}?next=https://wrong.example` },
    { deviceCode: 'abcd-1234' }, { codeExpiresAt: Date.now() - 1 }, { state: 'starting_tunnel' }, { state: 'ready' }]) {
    reply(snapshot(firstInstance, { ...good, ...fields }));
    const state = await manager.status(session, resource);
    assert.equal(state.deviceCode, null);
    assert.equal(state.deviceUrl, null);
    assert.equal(state.codeExpiresAt, null);
  }
  for (const value of [snapshot(secondInstance, good), snapshot(firstInstance, { state: 'unknown' }),
    snapshot(firstInstance, { state: 'ready', tunnelName: '../unsafe' })]) {
    reply(value);
    assert.equal((await manager.status(session, resource)).state, 'unavailable');
  }
});

test('a separately paired portal session cannot stop another session’s task', async () => {
  const { manager, session, newSession, sent } = fixture();
  const other = newSession();
  const ownerPair = preparedToken(await manager.prepare(session, resource));
  const otherPair = preparedToken(await manager.prepare(other, resource));
  assert.notEqual(ownerPair, otherPair);
  assert.equal((await manager.start(session, resource, accepted)).state, 'starting');
  assert.equal((await manager.stop(other, resource)).state, 'unavailable');
  assert.equal(sent.length, 1);
  assert.equal((await manager.stop(session, resource)).state, 'stopped');
  assert.equal(sent[1].url.href, `${origin}/notebook/${firstInstance}/proxy/38751/stop`);
  assert.equal(sent[1].headers.get('authorization'), `Bearer ${ownerPair}`);
  assert.equal((await manager.stop(session, resource)).state, 'unavailable');
  assert.equal(sent.length, 2);
});

test('an upstream start conflict neither exposes another job’s GitHub code nor claims its stop privilege', async () => {
  const { manager, session, sent, setHelper } = fixture();
  await manager.prepare(session, resource);
  setHelper(() => Response.json(snapshot(firstInstance, { state: 'waiting_github', tunnelName: 'different-job',
    deviceUrl, deviceCode: 'ABCD-1234', codeExpiresAt: Date.now() + 30_000 }), { status: 409 }));

  const conflict = await manager.start(session, resource, accepted);
  assert.equal(conflict.state, 'failed');
  assert.equal(conflict.deviceCode, null);
  assert.equal(conflict.deviceUrl, null);
  assert.equal((await manager.stop(session, resource)).state, 'unavailable');
  assert.equal(sent.length, 1);
});

test('instance replacement invalidates old pairing and ownership before mutations', async () => {
  const { manager, session, sent, replaceInstance } = fixture();
  const oldPair = preparedToken(await manager.prepare(session, resource));
  await manager.start(session, resource, accepted);
  replaceInstance(secondInstance);

  const denied = await manager.stop(session, resource);
  assert.equal(denied.instanceId, secondInstance);
  assert.equal(denied.state, 'unavailable');
  assert.equal((await manager.start(session, resource, accepted)).state, 'unavailable');
  assert.equal(sent.length, 1);

  const newPair = preparedToken(await manager.prepare(session, resource));
  assert.notEqual(newPair, oldPair);
  assert.equal((await manager.start(session, resource, accepted)).state, 'starting');
  assert.equal(sent[1].url.href, `${origin}/notebook/${secondInstance}/proxy/38751/start`);
  assert.equal(sent[1].headers.get('authorization'), `Bearer ${newPair}`);
});

test('tunnel routes require a live portal session, CSRF, and allowed origin before reaching the manager', async t => {
  const calls = [];
  const tunnelManager = { start: async (session, id, body) => {
    calls.push({ username: session.username, id, body });
    return { state: 'starting' };
  } };
  const app = createApp({ login: async () => ({ close() {} }), tunnelManager });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test-user', password: 'test-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await login.json();
  const start = headers => fetch(`${base}/api/resources/${resource}/tunnel/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(accepted),
  });

  assert.equal((await start({})).status, 401);
  assert.equal((await start({ cookie })).status, 403);
  assert.equal((await start({ cookie, 'X-CSRF-Token': session.csrfToken, Origin: 'https://wrong.example' })).status, 403);
  assert.deepEqual(calls, []);
  const response = await start({ cookie, 'X-CSRF-Token': session.csrfToken, Origin: base });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls, [{ username: 'test-user', id: resource, body: accepted }]);
});

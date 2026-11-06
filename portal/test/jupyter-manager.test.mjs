import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createJupyterManager } from '../server/jupyter-manager.mjs';
import { jupyterPort } from '../server/jupyter-proxy.mjs';

const origin = 'https://xrapi.wuhan.net.cn:9443';
const first = '10000000-0000-0000-0000-000000000001';
const second = '10000000-0000-0000-0000-000000000002';
const makeConnection = (instanceId = first, host = origin) => ({
  supported: true, url: `${host}/notebook/${instanceId}/?folder=/home/work`,
  allowedPrefix: `/notebook/${instanceId}/`, headers: { Cookie: 'platform=synthetic' },
});

function fixture({ present = true, terminal = false, verificationFails = false } = {}) {
  let connection = makeConnection(), secured = true, token = '';
  const requests = [], revoked = [], issued = [], uploads = [], executions = [];
  const proxy = {
    revoke: (...args) => revoked.push(args),
    issue: (...args) => { issued.push(args); return 'synthetic-local-url'; },
  };
  const session = { provider: {
    getWorkspaceConnection: async () => connection,
    listFiles: async () => ({ available: true, items: present ? [{ name: 'A800-Jupyter-Python312-offline.zip', type: 'file' }] : [] }),
    uploadFiles: async (_id, path, files) => { uploads.push({ path, files }); present = true; },
  } };
  const manager = createJupyterManager({ getProxy: () => proxy,
    loadBootstrap: async () => 'TOKEN = "__COMPUTE_JUPYTER_TOKEN__"\r\nPORT = "__COMPUTE_JUPYTER_PORT__"\r\nINSTALL = "__COMPUTE_JUPYTER_INSTALL__" == "True"\r\n',
    loadOfflineBundle: async () => Buffer.from('synthetic zip'),
    runTerminal: terminal ? async ({ command }) => {
      assert.match(command, /INSTALL = "True" == "True"/);
      token = /TOKEN = "([a-f0-9]{64})"/.exec(command)?.[1];
      assert.ok(token);
      executions.push('terminal');
    } : undefined,
    verifyConnection: async () => { executions.push('verify'); if (verificationFails) throw new Error('synthetic kernel failure'); },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const headers = { 'X-Compute-Jupyter-Pair': createHash('sha256').update(token, 'ascii').digest('hex') };
      return !secured || init.headers.Authorization === `token ${token}`
        ? Response.json({ kernelspecs: { python3: { spec: { language: 'python' } } } }, { headers })
        : new Response(null, { status: 403, headers });
    },
  });
  return { manager, session, requests, revoked, issued, uploads, executions,
    setConnection(value) { connection = value; }, setSecured(value) { secured = value; },
    async prepare() {
      const result = await manager.prepare(session, 'a800');
      token = /TOKEN = "([a-f0-9]{64})"/.exec(result.setupCommand)?.[1] || '';
      return { result, token };
    },
  };
}

test('Jupyter prepares only a current authorized instance and issues a URL only after authenticated discovery', async () => {
  const f = fixture();
  assert.equal((await f.manager.status(f.session, 'a800')).state, 'needs_setup');
  assert.equal(f.requests.length, 0);
  const { result, token } = await f.prepare();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.ok(result.setupCommand.startsWith("python3 - <<'COMPUTE_JUPYTER_SETUP'\n"));
  assert.equal(result.instanceId, first);
  assert.equal((await f.prepare()).token, token);
  assert.match(result.setupCommand, /INSTALL = "False" == "True"/);
  assert.ok(result.setupCommand.includes(`PORT = "${jupyterPort(token)}"`));
  const withDependencies = await f.manager.prepare(f.session, 'a800', { installDependencies: true });
  assert.match(withDependencies.setupCommand, /INSTALL = "True" == "True"/);
  assert.ok(withDependencies.setupCommand.includes(token));
  assert.equal((await f.manager.prepare(f.session, 'a800', { installDependencies: 'true' })).state, 'unavailable');

  const connected = await f.manager.connect(f.session, 'a800');
  assert.deepEqual({ state: connected.state, url: connected.serverUrl }, { state: 'ready', url: 'synthetic-local-url' });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].url.href, `${origin}/notebook/${first}/proxy/${jupyterPort(token)}/api/kernelspecs`);
  assert.equal(f.requests[0].init.headers.Authorization, `token ${token}`);
  assert.equal(f.requests[1].init.headers.Authorization, undefined);
  assert.equal(f.issued[0][0], f.session);
  assert.equal(f.issued[0][2], token);
  assert.doesNotMatch(JSON.stringify(connected), new RegExp(token));

  f.manager.disconnect(f.session, 'a800');
  assert.deepEqual(f.revoked, [[f.session, 'a800']]);
  f.manager.logout(f.session);
  assert.equal((await f.manager.status(f.session, 'a800')).state, 'needs_setup');
});

test('one-click deployment uploads a missing bundle once and verifies kernel execution', async () => {
  const f = fixture({ present: false, terminal: true });
  const deploy = await f.manager.deploy(f.session, 'a800');
  assert.equal(deploy.state, 'deploying');
  await new Promise(resolve => setImmediate(resolve));
  const ready = await f.manager.status(f.session, 'a800');
  assert.equal(ready.state, 'ready');
  assert.equal(ready.supportsDeployment, true);
  assert.deepEqual(f.executions, ['terminal', 'verify']);
  assert.deepEqual(f.uploads.map(({ path, files }) => [path, files[0].name]), [['/mnt/data', 'A800-Jupyter-Python312-offline.zip']]);
  await f.manager.deploy(f.session, 'a800');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.executions, ['terminal', 'verify', 'verify']);
  assert.equal(f.uploads.length, 1);
});

test('one-click deployment reuses a present bundle and fails if the kernel cannot execute', async () => {
  const f = fixture({ terminal: true, verificationFails: true });
  assert.equal((await f.manager.deploy(f.session, 'a800')).state, 'deploying');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.manager.status(f.session, 'a800')).state, 'failed');
  assert.deepEqual(f.executions, ['terminal', 'verify']);
  assert.equal(f.uploads.length, 0);
});

test('Jupyter rejects a public kernel, foreign origin and obsolete instance pairing', async () => {
  const f = fixture();
  const { token } = await f.prepare();
  f.setSecured(false);
  assert.equal((await f.manager.connect(f.session, 'a800')).state, 'unavailable');
  assert.equal(f.issued.length, 0);
  f.setConnection(makeConnection(second));
  assert.deepEqual((await f.manager.status(f.session, 'a800')).instanceId, second);
  assert.deepEqual(f.revoked, [[f.session, 'a800']]);
  assert.notEqual((await f.prepare()).token, token);
  f.setConnection(makeConnection(second, 'https://unrelated.invalid'));
  assert.equal((await f.manager.prepare(f.session, 'a800')).state, 'unavailable');
  assert.equal(f.requests.length, 2);
});

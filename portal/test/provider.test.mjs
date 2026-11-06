import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createChallenge, login, internals } from '../server/provider.mjs';

const { CookieJar, cleanPath } = internals;
test('provider matches verified platform contracts and protects session state', async t => {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'resource-provider-test-'));
  const uploadPath = path.join(uploadDir, 'upload-test.txt');
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const origin = 'https://xr.wuhan.net.cn:30443';
  const json = (value, extra = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', ...extra } });
  const ok = value => json({ status: { code: 'ok' }, ...value });
  const calls = [];
  const fixture = {
    uuid: 'notebook-1', name: '测试资源', status: 'Running', createTime: '1700000000', deleteAfter: '1800000000',
    accelerator: { cpu: 8, mem: 32, acceleratorType: 'GPU', acceleratorNum: 1, acceleratorModel: 'A100' },
    imageConfig: { url: 'registry/image:1' },
    endpoint: 'https://xrapi.wuhan.net.cn:9443/notebook/instance-1/?folder=/home/work',
    instance: { uuid: 'instance-1', status: 'Starting', createTime: '1700000000' },
    // Credential-like fields must never appear in normalized results.
    envList: [{ name: 'API_KEY', value: 'secret-not-for-client' }],
    mountInfo: [{ mountPath: '/mnt/data', mountMode: 'ReadWrite', storageInfo: { type: 'Object', ossInfo: { bucketUuid: 'bucket-1', bucketName: 'dataset', subPath: '/research/' } } }],
  };
  let listCalls = 0;
  let failEdgeEvents = false;
  let denyBills = false;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(url.origin, origin);
    if (url.pathname.endsWith('/captcha/generate')) return ok({ data: { uuid: 'captcha-1', captchaBase64: 'data:image/png;base64,YQ==', expireTime: String(Math.floor(Date.now() / 1000) + 120) } });
    if (url.pathname.endsWith('/systemSetting/get')) return ok({ data: { enableLoginMfa: false } });
    if (url.pathname === '/xrops/v1/auth/login') {
      const body = JSON.parse(options.body);
      assert.equal(body.type, 1);
      assert.equal(body.from, 'local');
      assert.equal(Buffer.from(body.account_info, 'base64').length, 256);
      assert.ok(!options.body.includes('correct-password'));
      return json({ status: { code: 0 } }, { 'Set-Cookie': 'platform_session=not-for-client; Path=/; Secure; HttpOnly' });
    }
    assert.ok(options.headers.Cookie.split('; ').includes('platform_session=not-for-client'));
    if (url.pathname === '/tai/overview/index') {
      assert.equal(options.method, 'GET');
      return new Response('<!doctype html><html></html>', { headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'XSRF-TOKEN=csrf%2Bvalue%3D; Path=/; Secure' } });
    }
    if (options.method === 'POST') {
      assert.equal(options.headers.Origin, origin);
      assert.equal(options.headers.Referer, `${origin}/tai/overview/index`);
      assert.equal(options.headers['X-XSRF-TOKEN'], 'csrf+value=');
    }
    if (url.pathname.endsWith('/enterpriseSpace/getAuthorizedData')) return ok({ data: [{ enterpriseSpaceUuid: 'space-1', enterpriseSpaceName: '机构', isAuthorized: false, workspaces: [{ workspaceUuid: 'workspace-1', workspaceName: '项目' }, { workspaceUuid: 'workspace-denied', workspaceName: '无开发环境权限的项目' }] }] });
    if (options.headers['Grpc-Metadata-X-Workspace-Uuid'] === 'workspace-denied') {
      assert.ok(url.pathname.endsWith('/notebook/list'), 'denied projects must not contribute quota requests');
      return new Response('', { status: 403 });
    }
    assert.equal(options.headers['Grpc-Metadata-X-Workspace-Uuid'], 'workspace-1');
    assert.equal(options.headers['Grpc-Metadata-X-EnterpriseSpace-Uuid'], 'space-1');
    if (url.pathname.endsWith('/notebook/list')) {
      listCalls++;
      assert.equal(url.searchParams.get('paging.page'), '1');
      return ok({ items: [fixture], paging: { totalRecord: 1 } });
    }
    if (url.pathname.endsWith('/quotaPolicyGlobal/getWorkspaceQuotaOverview')) return ok({ data: [{ resourceType: 'cpu', capacity: 64, used: 8, assignmentType: 'Dedicated' }, { resourceType: 'gpu', resourceModel: 'A100', capacity: 4, used: 1, assignmentType: 'Dedicated' }] });
    if (url.pathname.endsWith('/notebook/get')) {
      assert.equal(url.searchParams.get('uuid'), fixture.uuid);
      return ok({ detail: fixture });
    }
    if (url.pathname.endsWith('/notebook/start')) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { uuid: fixture.uuid });
      return ok({});
    }
    if (url.pathname.endsWith('/notebook/stop')) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { uuid: fixture.uuid });
      return ok({});
    }
    if (url.pathname.endsWith('/billing/listWsBill')) {
      assert.equal(options.method, 'GET');
      assert.equal(url.searchParams.get('billingCycle'), '2020-01');
      assert.equal(url.searchParams.get('paging.page'), '1');
      assert.equal(url.searchParams.get('paging.perPage'), '100');
      assert.deepEqual(url.searchParams.getAll('billingTransactionTypes'), ['1', '2', '3', '4', '5', '13', '99']);
      if (denyBills) return new Response('', { status: 403 });
      const byNotebook = url.searchParams.get('keyword') === fixture.uuid;
      assert.ok(byNotebook || url.searchParams.get('keyword') === fixture.instance.uuid);
      const notebook = { itResourceId: fixture.uuid, taskId: fixture.instance.uuid, billingTransactionType: 4,
        chargingItem: 'gpu', chargingItemName: 'GPU 时长', usage: '2.5', usageUnit: '卡时', amount: '0', payAmount: '0', discountAmount: '0' };
      const rows = byNotebook ? [notebook, { itResourceId: `${fixture.uuid}-unrelated`, amount: 10 }] : [notebook,
        { realResourceId: fixture.instance.uuid, usage: '0', usageUnit: '小时', hidePrice: true, amount: '17.99', payAmount: '17.99' }];
      return ok({ data: rows, paging: { totalRecord: rows.length } });
    }
    if (url.pathname.endsWith('/event/listServiceEvent')) {
      assert.equal(options.method, 'GET');
      assert.equal(url.searchParams.get('uuid'), 'notebook-1');
      assert.equal(url.searchParams.get('type'), 'Notebook');
      return ok({ events: [{ level: 'Info', action: 'Start', userMessage: '启动请求已接收', timestamp: '1793767000000', password: 'ignored-secret-field' }], paging: { totalRecord: 1 } });
    }
    if (url.pathname.endsWith('/event/list')) {
      assert.equal(options.method, 'GET');
      assert.equal(url.searchParams.get('uuid'), 'notebook-1');
      assert.equal(url.searchParams.get('scene'), 'Notebook');
      return ok({ events: [{ level: 'Warning', action: 'FailedScheduling', userMessage: '0/3 nodes available: Insufficient nvidia.com/gpu; token=diagnostic-secret', timestamp: '1793767100000' }], paging: { totalRecord: 1 } });
    }
    if (url.pathname.endsWith('/event/listEdgeEvent')) {
      assert.equal(options.method, 'GET');
      assert.equal(url.searchParams.get('instanceUuid'), 'instance-1');
      assert.equal(url.searchParams.get('type'), 'Notebook');
      if (failEdgeEvents) return new Response('', { status: 403 });
      return ok({ items: [{ level: 'Warning', action: 'FailedMount', userMessage: 'Volume mount failed; password=not-for-ui platform_session=not-for-client', timestamp: '1793767200000' }], paging: { totalRecord: 1 } });
    }
    if (url.pathname.endsWith('/oss/listObjects')) {
      assert.equal(url.searchParams.get('bucketUuid'), 'bucket-1');
      assert.equal(url.searchParams.get('prefix'), 'research/');
      return ok({ data: { commonPrefixes: [{ prefix: 'research/folder/' }], contents: [{ key: 'research/data.txt', size: '3', lastModified: '2026-11-04T00:00:00Z' }], isTruncated: false } });
    }
    if (url.pathname.endsWith('/oss/createFolder')) {
      assert.deepEqual(JSON.parse(options.body), { bucketUuid: 'bucket-1', folderKey: 'research/new/' });
      return ok({});
    }
    if (url.pathname.endsWith('/oss/uploadObject')) {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      assert.equal(String(body.length), options.headers['Content-Length']);
      assert.match(body.toString(), /name="body"; filename="new.txt"/);
      assert.match(body.toString(), /research\/new.txt/);
      assert.match(body.toString(), /\r\nabc\r\n/);
      return ok({});
    }
    if (url.pathname.endsWith('/oss/downloadObject')) {
      assert.equal(url.searchParams.get('objectKey'), 'research/data.txt');
      return new Response('abc');
    }
    throw new Error(`Unexpected route ${url.pathname}`);
  });

  const challenge = await createChallenge();
  assert.equal(challenge.captchaImage, 'data:image/png;base64,YQ==');
  assert.ok(challenge.expiresAt <= Date.now() + 5 * 60 * 1000);
  const provider = await login('test-account', 'correct-password', { challengeId: challenge.challengeId, captchaCode: 'abcd' });
  await assert.rejects(login('test-account', 'correct-password', { challengeId: challenge.challengeId, captchaCode: 'abcd' }), { code: 'CAPTCHA_EXPIRED' });
  const listed = await provider.listResources();
  assert.equal(listCalls, 1);
  assert.equal(listed.items[0].gpuCount, 1);
  assert.equal(listed.items[0].memoryGb, 32);
  assert.equal(listed.items[0].autoStopAt, new Date(1800000000000).toISOString());
  assert.equal(listed.items[0].runtimeInstanceCreatedAt, new Date(1700000000000).toISOString());
  assert.equal(listed.items[0].canStop, true);
  assert.equal(listed.quota.cpu, 64);
  assert.equal(listed.quota.gpu, 4);
  assert.equal(listed.quota.storageGb, null);
  assert.equal(listed.quotaUsed.gpu, 1);
  assert.equal(listed.warnings.length, 1);
  assert.match(listed.warnings[0], /1 个/);
  await provider.listResources();
  assert.equal(calls.filter(call => call.options.headers['Grpc-Metadata-X-Workspace-Uuid'] === 'workspace-denied').length, 1, 'a 403 project should be cached and skipped on refresh');
  assert.equal(listed.items[0].mounts[0].supported, true);
  assert.ok(!JSON.stringify(listed).includes('secret-not-for-client'));
  fixture.status = 'Stopped';
  assert.deepEqual(await provider.startResource('notebook-1'), { ok: true, id: 'notebook-1', submitted: true, message: '启动请求已提交，请稍后刷新资源状态。' });
  await assert.rejects(provider.stopResource('notebook-1'), { status: 409, code: 'RESOURCE_NOT_STOPPABLE' });
  fixture.status = 'Running';
  await assert.rejects(provider.startResource('notebook-1'), { status: 409, code: 'RESOURCE_NOT_STARTABLE' });
  assert.deepEqual(await provider.stopResource('notebook-1'), { ok: true, id: 'notebook-1', submitted: true, message: '关闭请求已提交，请稍后刷新资源状态。' });
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/notebook/stop')).length, 1);
  const billing = await provider.getResourceBilling('notebook-1', '2020-01');
  assert.equal(billing.available, true);
  assert.equal(billing.currency, 'CNY');
  assert.deepEqual(billing.rows.map(row => [row.resourceId, row.usage, row.usageUnit, row.payAmount, row.hidePrice]),
    [['notebook-1', 2.5, '卡时', 0, false], ['instance-1', 0, '小时', null, true]]);
  assert.ok(!JSON.stringify(billing).includes('17.99'));
  denyBills = true;
  const deniedBilling = await provider.getResourceBilling('notebook-1', '2020-01');
  assert.equal(deniedBilling.available, false);
  assert.deepEqual(deniedBilling.rows, []);
  assert.match(deniedBilling.message, /没有账单查询权限/);
  await assert.rejects(provider.getResourceBilling('notebook-1', '2020-13'), { status: 400, code: 'INVALID_BILL_MONTH' });
  const diagnostics = await provider.getResourceDiagnostics('notebook-1');
  assert.equal(diagnostics.instance.id, 'instance-1');
  assert.equal(diagnostics.events.length, 3);
  assert.equal(diagnostics.events[0].source, 'instance');
  assert.match(diagnostics.reasons.join('\n'), /Insufficient nvidia.com\/gpu/);
  assert.ok(!/diagnostic-secret|not-for-ui|not-for-client|ignored-secret-field/.test(JSON.stringify(diagnostics)));
  failEdgeEvents = true;
  const partialDiagnostics = await provider.getResourceDiagnostics('notebook-1');
  assert.equal(partialDiagnostics.events.length, 2);
  assert.equal(partialDiagnostics.warnings.length, 1);
  assert.equal(partialDiagnostics.eventSources.find(source => source.source === 'instance').available, false);
  failEdgeEvents = false;
  const workspace = await provider.getWorkspace('notebook-1');
  assert.equal(workspace.supported, true);
  assert.equal(workspace.iframeVerified, false);
  assert.equal((await provider.getWorkspaceConnection('notebook-1')).supported, false);
  provider.client.jar.absorb(new Response('', { headers: { 'Set-Cookie': 'bridge=only-server; Domain=.wuhan.net.cn; Path=/; Secure; HttpOnly' } }), new URL(origin));
  const connection = await provider.getWorkspaceConnection('notebook-1');
  assert.equal(connection.supported, true);
  assert.equal(connection.headers.Cookie, 'bridge=only-server');
  assert.equal(connection.allowedOrigin, 'https://xrapi.wuhan.net.cn:9443');
  assert.equal(connection.allowedPrefix, '/notebook/instance-1/');
  assert.ok(!JSON.stringify(await provider.getWorkspace('notebook-1')).includes('only-server'));
  provider.client.jar.entries.clear();
  provider.client.jar.absorb(new Response('', { headers: { 'Set-Cookie': 'platform_session=not-for-client; Path=/; Secure; HttpOnly' } }), new URL(origin));
  provider.client.jar.absorb(new Response('', { headers: { 'Set-Cookie': 'XSRF-TOKEN=csrf%2Bvalue%3D; Path=/; Secure' } }), new URL(origin));
  const root = await provider.listFiles('notebook-1', '/');
  assert.equal(root.items[0].path, '/mnt/data');
  const files = await provider.listFiles('notebook-1', '/mnt/data/');
  assert.deepEqual(files.items.map(file => file.path), ['/mnt/data/folder', '/mnt/data/data.txt']);
  assert.equal((await provider.listFiles('notebook-1', '/home/work')).available, false);
  await provider.mkdir('notebook-1', '/mnt/data', 'new');
  await writeFile(uploadPath, 'abc');
  const uploaded = await provider.uploadFiles('notebook-1', '/mnt/data', [{ name: 'new.txt', path: uploadPath, mimeType: 'text/plain' }]);
  assert.equal(uploaded.count, 1);
  const uploadRequests = () => calls.filter(call => call.url.pathname.endsWith('/oss/uploadObject')).length;
  const beforeConflicts = uploadRequests();
  await assert.rejects(provider.uploadFiles('notebook-1', '/mnt/data', [{ name: 'data.txt', buffer: Buffer.from('x') }]), { status: 409, code: 'FILE_EXISTS' });
  await assert.rejects(provider.uploadFiles('notebook-1', '/mnt/data', [{ name: 'duplicate.txt', buffer: Buffer.from('x') }, { name: 'duplicate.txt', buffer: Buffer.from('y') }]), { status: 409, code: 'DUPLICATE_FILE_NAME' });
  assert.equal(uploadRequests(), beforeConflicts, 'conflicts must be rejected before any upstream upload');
  assert.equal(await (await provider.downloadFile('notebook-1', '/mnt/data/data.txt')).text(), 'abc');
  await assert.rejects(provider.uploadFiles('notebook-1', '/mnt/data', [{ name: '../bad', buffer: Buffer.from('x') }]), { code: 'INVALID_NAME' });
  assert.throws(() => cleanPath('/mnt/data/../secret'), { code: 'INVALID_PATH' });
  fixture.endpoint = 'https://evil.example/notebook/1';
  assert.equal((await provider.getWorkspace('notebook-1')).supported, false);
  fixture.endpoint = 'https://xrapi.wuhan.net.cn:9443/notebook/1?token=secret';
  assert.equal((await provider.getWorkspace('notebook-1')).url, '');
  provider.close();
  await assert.rejects(provider.getResource('notebook-1'), { code: 'SESSION_CLOSED' });

  const jar = new CookieJar();
  jar.absorb(new Response('', { headers: { 'Set-Cookie': 'scoped=1; Path=/xrops; Secure' } }), new URL(origin));
  assert.equal(jar.header(new URL(`${origin}/xrops/user`)), 'scoped=1');
  assert.equal(jar.header(new URL(`${origin}/xrops-not-a-subpath`)), '');
  assert.equal(jar.header(new URL('https://evil.example/xrops/user')), '');
  assert.equal(jar.header(new URL('http://xr.wuhan.net.cn:30443/xrops/user')), '');
  jar.absorb(new Response('', { headers: { 'Set-Cookie': 'XSRF-TOKEN=server-only; Path=/; Secure; HttpOnly' } }), new URL(origin));
  assert.equal(jar.readable('XSRF-TOKEN', new URL(`${origin}/tai/overview/index`)), '', 'HttpOnly values must never be used as document.cookie XSRF tokens');
  assert.equal(calls.filter(call => call.url.pathname === '/tai/overview/index').length, 1, 'mutations share one authenticated bootstrap');
  assert.ok(calls.length >= 25);
});

test('diagnostics return at most 100 recent selected events per source', async () => {
  const requestedPages = [];
  const item = { uuid: 'notebook-paged', status: 'Starting' };
  const client = {
    jar: { entries: new Map() },
    async json(route, options) {
      if (route.endsWith('/notebook/get')) return { detail: item };
      assert.ok(route.endsWith('/event/listServiceEvent') || route.endsWith('/event/list'));
      const page = Number(options.query['paging.page']);
      requestedPages.push(page);
      const start = (page - 1) * 100;
      const count = Math.max(0, Math.min(100, 250 - start));
      return { events: Array.from({ length: count }, (_, offset) => ({ level: 'Info', action: 'Observe', userMessage: `event-${start + offset + 1}`, timestamp: String(1793767000000 + (start + offset) * 1000), env: { API_KEY: 'never-copy-raw' } })), paging: { totalRecord: 250 } };
    },
  };
  const provider = new internals.Provider('test', client);
  provider.records.set(item.uuid, { item, context: { workspaceUuid: 'workspace-1', enterpriseSpaceUuid: 'space-1' } });
  const diagnostics = await provider.getResourceDiagnostics(item.uuid);
  assert.equal(diagnostics.events.length, 200);
  assert.equal(diagnostics.events.filter(event => event.source === 'business').length, 100);
  assert.equal(diagnostics.events.filter(event => event.source === 'dispatch').length, 100);
  assert.equal(diagnostics.events[0].message, 'event-250');
  assert.ok(diagnostics.eventSources.every(source => source.truncated));
  assert.equal(requestedPages.length, 6);
  assert.ok(!JSON.stringify(diagnostics).includes('never-copy-raw'));
});

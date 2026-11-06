import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JUPYTER_ORIGIN, NOTEBOOK_ID, jupyterPort } from './jupyter-proxy.mjs';
import { verifyJupyterConnection } from './jupyter-verify.mjs';

const unavailable = (message, instanceId) => ({ state: 'unavailable', message, instanceId });
const needsSetup = instanceId => ({ state: 'needs_setup', instanceId,
  message: '当前实例尚未部署 Jupyter。' });
const OFFLINE_NAME = 'A800-Jupyter-Python312-offline.zip';
const OFFLINE_HASH = '1fdb947cfc45e4a401e2c54499d5f73551132701dabb799b9c3c4ff57cb7c1d5';

async function readOfflineBundle() {
  const bundled = new URL(`../connectors/${OFFLINE_NAME}`, import.meta.url);
  const adjacent = new URL(`../../${OFFLINE_NAME}`, import.meta.url);
  const bytes = await readFile(bundled).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return readFile(adjacent);
  });
  if (createHash('sha256').update(bytes).digest('hex') !== OFFLINE_HASH) throw new Error('Invalid offline bundle');
  return bytes;
}

async function kernelspecs(response) {
  if (!response.ok || !response.body || !/^application\/json\b/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel().catch(() => {});
    return false;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) return false;
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return !!data?.kernelspecs?.python3?.spec;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createJupyterManager({ getProxy, fetchImpl = fetch, runTerminal, verifyConnection = verifyJupyterConnection,
  loadOfflineBundle = readOfflineBundle,
  loadBootstrap = () => readFile(new URL('../connectors/jupyter-bootstrap.py', import.meta.url), 'utf8') } = {}) {
  const bySession = new WeakMap();
  const deployments = new Map();
  const deploymentAvailable = typeof runTerminal === 'function';

  function ensurePair(resolved, id) {
    if (resolved.pair) return resolved.pair;
    const { resources, target } = resolved;
    if (resources.size >= 20) return null;
    const pair = { instanceId: target.instanceId, token: randomBytes(32).toString('hex'), generation: 0 };
    resources.set(id, pair);
    return pair;
  }

  async function makeCommand(pair, installDependencies) {
    const bootstrap = (await loadBootstrap()).replace(/\r\n/g, '\n').trimEnd()
      .replace('__COMPUTE_JUPYTER_TOKEN__', pair.token)
      .replace('__COMPUTE_JUPYTER_PORT__', String(jupyterPort(pair.token)))
      .replace('__COMPUTE_JUPYTER_INSTALL__', installDependencies ? 'True' : 'False');
    return `python3 - <<'COMPUTE_JUPYTER_SETUP'\n${bootstrap}\nCOMPUTE_JUPYTER_SETUP\n`;
  }

  const jobStatus = (pair, state, message) => ({ state, message, instanceId: pair.instanceId });

  function abortDeployment(pair) {
    pair?.job?.controller.abort();
  }

  async function resolve(session, resourceId) {
    const proxy = getProxy?.();
    if (!proxy) return { state: unavailable('本机 Jupyter 连接服务未启动。请更新并启动新版工作台后台。') };
    const connection = await session.provider.getWorkspaceConnection(resourceId);
    const instanceId = /^\/notebook\/([^/]+)\/$/.exec(connection?.allowedPrefix || '')?.[1];
    let target;
    if (connection?.supported && NOTEBOOK_ID.test(instanceId || '') && connection.headers?.Cookie) {
      let url;
      try { url = new URL(connection.url); } catch { /* Invalid platform endpoints cannot be proxied. */ }
      if (url?.origin === JUPYTER_ORIGIN && url.pathname.startsWith(connection.allowedPrefix) && !url.username && !url.password) {
        target = { instanceId, prefix: connection.allowedPrefix, headers: connection.headers };
      }
    }
    let resources = bySession.get(session);
    if (!resources) bySession.set(session, resources = new Map());
    let pair = resources.get(resourceId);
    if (pair && pair.instanceId !== target?.instanceId) {
      abortDeployment(pair);
      proxy.revoke(session, resourceId);
      resources.delete(resourceId);
      pair = undefined;
    }
    if (!target) return { state: unavailable('请启动当前算力资源，并确认其网页工作区可以打开。') };
    return { proxy, target, resources, pair };
  }

  async function ensureOfflineBundle(provider, id) {
    const directory = await provider.listFiles(id, '/mnt/data');
    if (!directory.available) throw new Error('无法检查 /mnt/data 中的离线包，请确认已挂载对象存储。');
    const existing = directory.items.find(item => item.name === OFFLINE_NAME);
    if (existing?.type === 'file') return;
    if (existing) throw new Error('持久目录中有与离线包同名的目录。');
    if (directory.readOnly) throw new Error('持久目录为只读，无法上传离线包。');
    let buffer;
    try { buffer = await loadOfflineBundle(); }
    catch { throw new Error('本机离线包缺失或校验失败。请重新解压工作台安装包。'); }
    try { await provider.uploadFiles(id, '/mnt/data', [{ name: OFFLINE_NAME, mimeType: 'application/zip', buffer }]); }
    catch (error) {
      if (error.code !== 'FILE_EXISTS') throw new Error('上传 Jupyter 离线包失败，请检查 /mnt/data 的写权限或重试。');
      const refreshed = await provider.listFiles(id, '/mnt/data');
      if (!refreshed.items.some(item => item.name === OFFLINE_NAME && item.type === 'file')) throw new Error('无法确认离线包已上传。');
    }
  }

  async function deployJob(session, id, resolved, pair, job) {
    const { target, proxy } = resolved;
    const { signal } = job.controller;
    const phase = text => { job.status = jobStatus(pair, 'deploying', text); };
    try {
      const ready = await probe(target, pair);
      signal.throwIfAborted();
      if (ready.state !== 'ready') {
        phase('正在检查持久目录中的离线依赖包。');
        await ensureOfflineBundle(session.provider, id);
        signal.throwIfAborted();
        const current = await resolve(session, id);
        if (current.pair !== pair) throw new Error('资源实例已更换。请在当前实例重新部署。');
        phase('正在网页工作区安装依赖并启动 Jupyter。');
        await runTerminal({ session, resourceId: id, target: current.target, command: await makeCommand(pair, true), signal });
      }
      signal.throwIfAborted();
      phase('正在验证内核能否执行代码。');
      const current = await resolve(session, id);
      if (current.pair !== pair) throw new Error('资源实例已更换。请在当前实例重新部署。');
      const verified = await probe(current.target, pair);
      if (verified.state !== 'ready') throw new Error('Jupyter 已启动，但工作台无法通过平台代理访问。');
      const localUrl = await proxy.issue(session, current.target, pair.token, id);
      try { await verifyConnection(localUrl, { signal }); }
      catch { throw new Error('已访问 Jupyter，但测试内核执行失败。请检查工作区连接后重试。'); }
      signal.throwIfAborted();
      job.status = jobStatus(pair, 'ready', 'Jupyter 已部署，测试内核执行成功。');
    } catch (error) {
      const detail = error?.message?.replace(/[\r\n\u0000-\u001f]|[a-f0-9]{64}|https?:\/\/\S+/gi, ' ').slice(0, 200);
      job.status = jobStatus(pair, 'failed', signal.aborted ? '部署已结束。请确认实例正在运行后重试。' : detail || '部署失败，请重试。');
    } finally {
      if (deployments.get(pair.instanceId) === job) deployments.delete(pair.instanceId);
    }
  }

  async function probe(target, pair) {
    if (!pair) return needsSetup(target.instanceId);
    const url = new URL(`${target.prefix}proxy/${jupyterPort(pair.token)}/api/kernelspecs`, JUPYTER_ORIGIN);
    const headers = { Accept: 'application/json', Cookie: target.headers.Cookie };
    const options = { redirect: 'manual', signal: AbortSignal.timeout(7000) };
    const fingerprint = createHash('sha256').update(pair.token, 'ascii').digest('hex');
    try {
      const response = await fetchImpl(url, { ...options, headers: { ...headers, Authorization: `token ${pair.token}` } });
      if (await kernelspecs(response)) {
        // A notebook reached without its scoped token must never be offered.
        const unauthenticated = await fetchImpl(url, { ...options, headers });
        const authenticationRequired = response.headers.get('X-Compute-Jupyter-Pair') === fingerprint &&
          [401, 403].includes(unauthenticated.status) && unauthenticated.headers.get('X-Compute-Jupyter-Pair') === fingerprint;
        await unauthenticated.body?.cancel().catch(() => {});
        if (authenticationRequired) return { state: 'ready', instanceId: target.instanceId,
          message: '已找到需要令牌认证的 Python 内核。可以添加到本机 Notebook。' };
        return unavailable('Jupyter 的令牌认证未通过检查。请在当前实例重新准备内核。', target.instanceId);
      }
    } catch { /* A stopped server or reset is a setup failure, never a ready kernel. */ }
    return needsSetup(target.instanceId);
  }

  return {
    async status(session, id) {
      const resolved = await resolve(session, id);
      const job = resolved.pair?.job?.status;
      let status = resolved.state;
      if (!status) {
        status = job?.state === 'deploying' ? job : await probe(resolved.target, resolved.pair);
        if (job?.state === 'failed' || (job?.state === 'ready' && status.state === 'ready')) status = job;
      }
      return { ...status, supportsDependencyInstallation: true, supportsDeployment: deploymentAvailable };
    },
    async prepare(session, id, { installDependencies = false } = {}) {
      if (typeof installDependencies !== 'boolean') {
        return unavailable('依赖安装选项无效。请在工作台重新选择准备方式。');
      }
      const resolved = await resolve(session, id);
      if (resolved.state) return resolved.state;
      const pair = ensurePair(resolved, id);
      if (!pair) return unavailable('当前工作台会话连接的资源过多。');
      return { ...needsSetup(pair.instanceId), setupCommand: await makeCommand(pair, installDependencies) };
    },
    async deploy(session, id) {
      if (!deploymentAvailable) return unavailable('当前后台不支持自动部署。');
      const resolved = await resolve(session, id);
      if (resolved.state) return resolved.state;
      const pair = ensurePair(resolved, id);
      if (!pair) return unavailable('当前工作台会话连接的资源过多。');
      const active = deployments.get(pair.instanceId);
      if (active) return active === pair.job ? active.status : jobStatus(pair, 'failed', '当前实例已有部署正在进行。');
      const job = { controller: new AbortController(), status: jobStatus(pair, 'deploying', '正在检查当前 Jupyter 环境。') };
      pair.job = job;
      deployments.set(pair.instanceId, job);
      void deployJob(session, id, resolved, pair, job);
      return job.status;
    },
    async connect(session, id) {
      const resolved = await resolve(session, id);
      if (resolved.state) return resolved.state;
      const { proxy, target, resources, pair } = resolved;
      const generation = pair?.generation;
      const status = await probe(target, pair);
      if (status.state !== 'ready') return status;
      if (bySession.get(session) !== resources || resources.get(id) !== pair || generation !== pair.generation) {
        return unavailable('本次连接已结束或算力实例已变化。请刷新后再连接。');
      }
      try { return { ...status, serverUrl: await proxy.issue(session, target, pair.token, id) }; }
      catch { return unavailable('无法建立本机连接。请重新登录工作台并重试。', target.instanceId); }
    },
    disconnect(session, id) {
      const pair = bySession.get(session)?.get(id);
      if (pair) pair.generation++;
      getProxy?.()?.revoke(session, id);
      return { state: 'ready', message: '已断开本机 Jupyter 连接。' };
    },
    logout(session) {
      for (const pair of bySession.get(session)?.values() || []) abortDeployment(pair);
      bySession.delete(session);
      getProxy?.()?.revoke(session);
    },
    resourceStopped(session, id) {
      const resources = bySession.get(session);
      abortDeployment(resources?.get(id));
      resources?.delete(id);
      getProxy?.()?.revoke(session, id);
    },
  };
}

'use strict';

const vscode = require('vscode');
const { randomBytes } = require('node:crypto');

const extensionId = 'ms-toolsai.jupyter';
const collectionLabel = '算力工作台 · 远程 Jupyter';
const notebookType = 'jupyter-notebook';
const serverPattern = /^(http:\/\/127\.0\.0\.1:[1-9]\d{0,4})(\/jupyter\/[a-f0-9]{64}\/)\?token=([a-f0-9]{64})$/;
const pollIntervalMs = 2500;

function message(value, fallback) {
  if (typeof value !== 'string') return fallback;
  return value.replace(/https?:\/\/\S+|[a-f0-9]{64}/gi, '[连接信息]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 400) || fallback;
}

function serverInfo(value, jupyterOrigin) {
  const match = typeof value === 'string' && serverPattern.exec(value);
  if (!match || match[0] !== value || match[1] !== jupyterOrigin) throw new Error('本机工作台没有返回有效的 Jupyter 连接地址。');
  return { baseUrl: vscode.Uri.parse(match[1] + match[2]), token: match[3] };
}

function panelScript() {
  const host = acquireVsCodeApi();
  const get = id => document.getElementById(id);
  const actions = ['deploy', 'selectKernel', 'copyConnection'];
  for (const action of actions) {
    get(action).addEventListener('click', () => {
      for (const name of actions) get(name).disabled = true;
      host.postMessage({ type: action });
    });
  }
  window.addEventListener('message', event => {
    const view = event.data;
    if (view?.type !== 'jupyterState') return;
    get('heading').textContent = view.resourceName + ' · Jupyter';
    get('state').textContent = view.label;
    get('message').textContent = view.message;
    get('deploy').textContent = view.retry ? '重试部署' : '部署并连接';
    get('deploy').hidden = view.connected || view.deploying;
    get('selectKernel').hidden = !view.connected;
    get('copyConnection').hidden = !view.fallback;
    for (const action of actions) get(action).disabled = view.busy;
  });
  host.postMessage({ type: 'ready' });
}

function panelHtml() {
  const nonce = randomBytes(18).toString('base64');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
<style nonce="${nonce}">
body{max-width:720px;margin:0 auto;padding:32px 24px;line-height:1.65}h1{font-size:1.6em;margin:0 0 16px}h2{font-size:1.2em;margin:0}
section{border:1px solid var(--vscode-panel-border,var(--vscode-widget-border));padding:18px;border-radius:6px}p{overflow-wrap:anywhere}
button{font:inherit;margin:4px 8px 0 0;padding:6px 12px;border:0;border-radius:3px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}[hidden]{display:none!important}
</style></head><body><main><h1 id="heading">Jupyter</h1>
<section aria-label="Jupyter 部署状态"><h2 id="state" aria-live="polite">正在检查资源</h2>
<p id="message" role="status"></p>
<button id="deploy" disabled>部署并连接</button><button id="selectKernel" hidden>选择 Notebook 内核</button><button id="copyConnection" hidden>复制连接地址</button>
</section></main><script nonce="${nonce}">(${panelScript.toString()})();</script></body></html>`;
}

function createJupyterConnection(client, { onSessionExpired } = {}) {
  const servers = new Map();
  const views = new Map();
  const changed = new vscode.EventEmitter();
  let collection;
  let disposed = false;

  function forget(resourceId) {
    if (servers.delete(resourceId)) changed.fire();
  }

  function resourceStopped(resourceId) {
    forget(resourceId);
    views.get(resourceId)?.panel.dispose();
  }

  function clear() {
    for (const view of views.values()) view.panel.dispose();
    views.clear();
    servers.clear();
    changed.fire();
  }

  async function registerCollection(extension) {
    if (collection) return true;
    try {
      const api = await extension.activate();
      if (disposed || typeof api?.createJupyterServerCollection !== 'function') return false;
      collection ??= api.createJupyterServerCollection('compute-resources', collectionLabel, {
        onDidChangeServers: changed.event,
        provideJupyterServers: () => [...servers.values()]
          .filter(server => server.isCurrent())
          .map(({ id, label }) => ({ id, label })),
        resolveJupyterServer: selected => {
          const server = [...servers.values()].find(item => item.id === selected.id && item.isCurrent());
          return server && { id: server.id, label: server.label, connectionInformation: server.connectionInformation };
        },
      });
      return Boolean(collection);
    } catch {
      return false;
    }
  }

  function request(resource, action, signal) {
    const route = '/api/resources/' + encodeURIComponent(resource.id) + '/jupyter';
    return client.request(action ? route + '/' + action : route, { method: action ? 'POST' : 'GET', signal, timeoutMs: 40_000 });
  }

  function usableNotebook(notebook) {
    return notebook?.notebookType === notebookType && !notebook.isClosed && ['file', 'untitled'].includes(notebook.uri.scheme);
  }

  async function openPicker(view) {
    if (!usableNotebook(view.notebook)) {
      const sample = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '!nvidia-smi -L', 'python');
      view.notebook = await vscode.workspace.openNotebookDocument(notebookType, new vscode.NotebookData([sample]));
    }
    if (!view.active()) return;
    await vscode.window.showNotebookDocument(view.notebook);
    if (view.active()) await vscode.commands.executeCommand('notebook.selectKernel');
  }

  async function attach(view, snapshot, signal) {
    const { resource } = view;
    const extension = vscode.extensions.getExtension(extensionId);
    if (!extension) throw new Error('请安装微软 Jupyter 扩展，再点击重试部署。');
    const result = await request(resource, 'connect', signal);
    if (!view.active()) return;
    if (result?.state !== 'ready' || result.instanceId !== snapshot.instanceId) {
      forget(resource.id);
      throw new Error(message(result?.message, '实例已变化，请重新部署。'));
    }
    const { jupyterOrigin } = await client.service();
    if (!view.active()) return;
    const server = {
      id: resource.id + ':' + snapshot.instanceId,
      label: message(resource.name, '算力资源'),
      instanceId: snapshot.instanceId,
      connectionInformation: serverInfo(result.serverUrl, jupyterOrigin),
      isCurrent: view.isCurrent,
    };
    servers.set(resource.id, server);
    changed.fire();
    const registered = await registerCollection(extension);
    if (!view.active()) return;
    view.connected = true;
    view.fallback = !registered;
    view.label = 'Jupyter 可以连接';
    view.message = registered
      ? '在 Notebook 选择「选择其他内核」，进入「算力工作台 · 远程 Jupyter」，然后选择 ' + server.label + ' 的 Python 内核。'
      : '微软 Jupyter 扩展的服务器列表不可用。复制连接地址后，在内核选择器的「现有 Jupyter 服务器」中粘贴。';
    publish(view);
    await openPicker(view).catch(() => {
      view.message += ' 请从 Notebook 右上角打开内核选择器。';
    });
  }

  function publish(view) {
    if (!view.active()) return;
    void view.panel.webview.postMessage({ type: 'jupyterState', resourceName: message(view.resource.name, '算力资源'),
      label: view.label, message: view.message, busy: Boolean(view.controller), retry: view.retry,
      connected: view.connected, deploying: view.deploying, fallback: view.connected && view.fallback,
    });
  }

  async function run(view, action) {
    if (!view.active() || view.controller) return publish(view);
    clearTimeout(view.timer);
    const controller = new AbortController();
    const { signal } = controller;
    const { resource } = view;
    view.controller = controller;
    publish(view);
    try {
      if (action === 'selectKernel' && view.connected) {
        await openPicker(view);
        return;
      }
      if (action === 'copyConnection' && view.connected && view.fallback) {
        const connection = servers.get(resource.id)?.connectionInformation;
        if (connection) await vscode.env.clipboard.writeText(connection.baseUrl.toString() + '?token=' + connection.token);
        return;
      }
      if (action !== 'deploy' && action !== 'poll') return;
      const current = await request(resource, '', signal);
      if (!view.active()) return;
      if (current?.supportsDeployment !== true) throw new Error('当前后台不支持自动部署。请启动更新后的算力工作台后台。');
      const snapshot = action === 'deploy' && !['deploying', 'unavailable'].includes(current.state)
        ? await request(resource, 'deploy', signal) : current;
      if (!view.active()) return;
      if (servers.get(resource.id)?.instanceId !== snapshot?.instanceId) forget(resource.id);
      view.deploying = snapshot?.state === 'deploying';
      view.connected = false;
      view.label = view.deploying ? '正在部署 Jupyter' : '部署尚未完成';
      view.message = message(snapshot?.message, '请确认资源已启动，然后重试。');
      view.retry = !view.deploying;
      if (snapshot?.state === 'ready' && typeof snapshot.instanceId === 'string' && snapshot.instanceId) {
        await attach(view, snapshot, signal);
      }
    } catch (error) {
      if (error?.status === 401) {
        await onSessionExpired?.();
        return;
      }
      if (!view.active() || signal.aborted) return;
      view.deploying = false;
      view.label = '操作未完成';
      view.retry = true;
      view.message = error?.status === 404
        ? '当前后台不支持自动部署。请启动更新后的算力工作台后台。'
        : message(error?.message, '请检查工作台和资源状态，再重试。');
    } finally {
      if (view.controller === controller) view.controller = undefined;
      publish(view);
      if (view.active() && view.deploying) view.timer = setTimeout(() => void run(view, 'poll'), pollIntervalMs);
    }
  }

  async function connect(resource, isCurrent) {
    if (vscode.env.remoteName) {
      void vscode.window.showInformationMessage('请在本机 VS Code 窗口打开 Notebook，再使用此连接入口。');
      return;
    }
    const current = views.get(resource.id);
    if (current) {
      current.panel.reveal();
      publish(current);
      if (!current.deploying) await run(current, 'deploy');
      return;
    }
    const panel = vscode.window.createWebviewPanel('resourceWorkbench.jupyter', message(resource.name, '算力资源') + ' · Jupyter',
      vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    const view = { resource, panel, isCurrent, label: '正在检查资源', message: '',
      active: () => !disposed && views.get(resource.id) === view && isCurrent(),
      notebook: vscode.window.activeNotebookEditor?.notebook,
    };
    views.set(resource.id, view);
    const receiver = panel.webview.onDidReceiveMessage(data => {
      if (data?.type === 'ready') return publish(view);
      if (['deploy', 'selectKernel', 'copyConnection'].includes(data?.type)) return run(view, data.type);
    });
    panel.onDidDispose(() => {
      receiver.dispose();
      clearTimeout(view.timer);
      view.controller?.abort();
      if (views.get(resource.id) === view) views.delete(resource.id);
    });
    panel.webview.html = panelHtml();
    await run(view, 'deploy');
  }

  async function disconnect(resource, isCurrent) {
    const view = views.get(resource.id);
    if (view?.deploying || view?.controller) return;
    const result = await request(resource, 'disconnect');
    if (!isCurrent()) return;
    resourceStopped(resource.id);
    void vscode.window.showInformationMessage(message(result?.message, '已断开本机 Jupyter 连接。'));
  }

  return { connect, disconnect, resourceStopped, clear, dispose() {
    disposed = true;
    clear();
    collection?.dispose();
    changed.dispose();
  } };
}

module.exports = { createJupyterConnection };

'use strict';

const vscode = require('vscode');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { WorkbenchClient } = require('./client');
const { openLoginPanel, configureAI, openChatPanel, closeSessionPanels } = require('./panels');
const { openTunnelPanel, closeTunnelPanels } = require('./tunnel-panel');
const { createJupyterConnection } = require('./jupyter');
const { createFileTransfer } = require('./files-panel');
const { createLocalService } = require('./local-service');

const namespace = 'resourceWorkbench';
const viewId = namespace + '.resources';
const marketplace = vscode.Uri.parse('https://marketplace.visualstudio.com/items?itemName=ms-vscode.remote-server');
let localService;
const tunnelPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;
const statusLabels = {
  Running: '运行中',
  Stopped: '已停止',
  Starting: '启动中',
  StartFailed: '启动失败',
  Pending: '排队中',
  Scheduling: '调度中',
  Creating: '创建中',
  ImageBuilding: '构建镜像中',
  Stopping: '停止中',
  StopFailed: '停止失败',
  Failed: '失败',
  Unknown: '状态未知',
};

function plain(value, limit = 500) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
}

function statusLabel(value) {
  return Object.hasOwn(statusLabels, value) ? statusLabels[value] : plain(value, 60) || '状态未知';
}

function isStartable(status) {
  return status === 'Stopped' || status === 'StartFailed';
}

function capacity(item) {
  const kind = item.acceleratorType || (item.gpuCount > 0 ? 'GPU' : 'CPU');
  const model = item.acceleratorModel || item.gpuModel || kind;
  const count = item.acceleratorCount ?? item.gpuCount;
  const gpu = kind !== 'CPU' && Number(count) > 0 ? plain(model, 80) + ' × ' + count : '';
  return [gpu, item.cpu == null ? '' : 'CPU ' + item.cpu + ' 核', item.memoryGb == null ? '' : '内存 ' + item.memoryGb + ' GB']
    .filter(Boolean).join(' · ');
}

function date(value) {
  const stamp = Date.parse(value || '');
  return Number.isFinite(stamp) ? new Date(stamp).toLocaleString() : '—';
}

function billingValue(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { maximumFractionDigits: 10, useGrouping: false }) : '—';
}

function bytes(value) {
  if (value == null || !Number.isFinite(Number(value)) || Number(value) < 0) return '';
  const size = Number(value);
  if (size < 1024) return size + ' B';
  if (size < 1024 ** 2) return (size / 1024).toFixed(1) + ' KiB';
  if (size < 1024 ** 3) return (size / 1024 ** 2).toFixed(1) + ' MiB';
  return (size / 1024 ** 3).toFixed(1) + ' GiB';
}

function resourceRoute(resource, suffix = '') {
  return '/api/resources/' + encodeURIComponent(resource.id) + suffix;
}

function action(label, icon, command, resource) {
  return { label, icon, command, resource };
}

class ResourceTree {
  constructor() {
    this.items = [];
    this.warnings = [];
    this.signedIn = false;
    this.loading = false;
    this.error = '';
    this.starting = new Set();
    this.stopping = new Set();
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  getTreeItem(node) {
    if (node.kind === 'resource') {
      const resource = node.resource;
      const treeItem = new vscode.TreeItem(plain(resource.name) || '未命名资源', vscode.TreeItemCollapsibleState.Collapsed);
      const starting = this.starting.has(resource.id);
      const stopping = this.stopping.has(resource.id);
      treeItem.id = 'resource:' + resource.id;
      treeItem.description = [stopping ? '正在关闭' : starting ? '等待平台状态' : statusLabel(resource.status), capacity(resource)].filter(Boolean).join(' · ');
      treeItem.tooltip = [plain(resource.name), treeItem.description, resource.autoStopAt ? '自动停止 ' + date(resource.autoStopAt) : '', plain(resource.workspaceName), plain(resource.description, 200)].filter(Boolean).join('\n');
      treeItem.iconPath = new vscode.ThemeIcon(starting || stopping ? 'sync~spin' : resource.status === 'Running' ? 'vm-running' : 'vm');
      treeItem.contextValue = stopping ? 'resource.active' : !starting && isStartable(resource.status) ? 'resource.startable'
        : resource.status === 'Running' ? 'resource.running' : resource.canStop === true ? 'resource.stoppable' : 'resource.active';
      return treeItem;
    }
    const treeItem = new vscode.TreeItem(node.label);
    treeItem.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.description) treeItem.description = node.description;
    if (node.tooltip) treeItem.tooltip = node.tooltip;
    if (node.command) treeItem.command = {
      command: namespace + '.' + node.command,
      title: node.label,
      arguments: node.resource ? [{ kind: 'resource', resource: node.resource }] : [],
    };
    return treeItem;
  }

  getChildren(node) {
    if (node?.kind === 'resource') {
      const resource = node.resource;
      const children = [
        action('资源详情', 'info', 'details', resource),
        action('用量和费用', 'graph', 'billing', resource),
        action('运行诊断', 'pulse', 'diagnostics', resource),
      ];
      if (resource.autoStopAt) {
        children.unshift({ ...action('自动停止', 'clock'), description: date(resource.autoStopAt) });
      }
      const stopping = this.stopping.has(resource.id);
      if (!stopping && isStartable(resource.status) && !this.starting.has(resource.id)) {
        children.push(action(resource.status === 'StartFailed' ? '重试启动' : '启动资源', 'play', 'start', resource));
      }
      children.push(action('浏览和传输文件', 'folder', 'files', resource));
      if (!stopping && resource.status === 'Running') {
        children.push(action('部署并连接 Jupyter', 'notebook', 'jupyter', resource));
        children.push(action('设置桌面隧道', 'remote', 'setupTunnel', resource));
        children.push(action('打开网页开发环境', 'link-external', 'web', resource));
      }
      if (!stopping && resource.canStop === true) children.push(action('关闭资源', 'debug-stop', 'stop', resource));
      return children;
    }
    if (node || !this.signedIn) return [];
    const children = this.items.map(resource => ({ kind: 'resource', resource }));
    if (this.loading && !children.length) children.push(action('正在读取资源…', 'sync~spin'));
    if (this.error) children.unshift({ ...action('读取失败，点击重试', 'warning', 'refresh'), tooltip: this.error });
    if (!this.loading && !this.error && !children.length) children.push(action('没有可访问的开发环境', 'info'));
    if (this.warnings.length) children.push({
      ...action('部分资源信息不可用', 'warning'),
      tooltip: this.warnings.join('\n'),
    });
    return children;
  }

  update(resource) {
    const index = this.items.findIndex(item => item.id === resource.id);
    if (index >= 0) this.items[index] = resource;
    this.changed.fire();
  }

  dispose() {
    this.changed.dispose();
  }
}

function workspaceAddress(response, workspaceOrigin) {
  const usingProxy = typeof response?.proxyUrl === 'string' && response.proxyUrl.length > 0;
  let address;
  try {
    address = new URL(usingProxy ? response.proxyUrl : response?.url);
  } catch {
    return undefined;
  }
  if (address.username || address.password || address.hash) return undefined;
  if (usingProxy) {
    if (address.origin !== workspaceOrigin || !/^\/connect\/[a-f0-9]{64}$/.test(address.pathname) || address.search) return undefined;
  } else {
    if (address.origin !== 'https://xrapi.wuhan.net.cn:9443' || !/^\/notebook\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\/?$/.test(address.pathname)) return undefined;
    for (const [key, value] of address.searchParams) {
      if (key !== 'folder' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value) || value.split('/').includes('..')) return undefined;
    }
  }
  return vscode.Uri.parse(address.toString());
}

async function withCancellation(title, task) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
      return await task(controller.signal, progress);
    } finally {
      cancellation.dispose();
    }
  });
}

async function withTransferProgress(title, task) {
  return withCancellation(title, async (signal, progress) => {
    let active = true;
    let saving = false;
    let highWater = 0;
    let percent = 0;
    let lastReport = 0;
    const onProgress = update => {
      if (!active || signal.aborted || !update) return;
      if (update.phase === 'saving') {
        if (!saving) progress.report({ message: '正在保存并确认结果…' });
        saving = true;
        return;
      }
      if (saving || !Number.isFinite(update.transferred) || update.transferred < highWater) return;
      highWater = update.transferred;
      const totalKnown = Number.isFinite(update.total) && update.total > 0;
      const next = totalKnown ? Math.min(100, Math.floor(100 * highWater / update.total)) : 0;
      const now = Date.now();
      if ((next < 100 || percent >= 99) && now - lastReport < 200) return;
      const amount = bytes(highWater) || '0 B';
      const message = totalKnown ? amount + ' / ' + bytes(update.total) + ' · ' + next + '%' : '已传输 ' + amount;
      const bar = Math.min(99, next);
      if (totalKnown && bar > percent) {
        progress.report({ message, increment: bar - percent });
        percent = bar;
      } else {
        progress.report({ message });
      }
      lastReport = now;
    };
    try {
      return await task({ signal, onProgress });
    } finally {
      active = false;
    }
  });
}

function activate(context) {
  localService = createLocalService(context.extensionPath);
  const client = new WorkbenchClient({ getService: localService.get });
  const tree = new ResourceTree();
  const treeView = vscode.window.createTreeView(viewId, { treeDataProvider: tree, showCollapseAll: true });
  const documents = new Map();
  const docScheme = 'compute-resource-report';
  const reportChanged = new vscode.EventEmitter();
  context.subscriptions.push(tree, treeView, reportChanged, vscode.workspace.registerTextDocumentContentProvider(docScheme, {
    onDidChange: reportChanged.event,
    provideTextDocumentContent: uri => documents.get(uri.toString()) || '报告已关闭。请重新打开资源详情。',
  }), vscode.workspace.onDidCloseTextDocument(doc => {
    if (doc.uri.scheme === docScheme) documents.delete(doc.uri.toString());
  }));

  let revision = 0;
  let loadController;
  let activeLoad;
  let disposed = false;
  let loggingOut = false;
  async function onSessionExpired() {
    if (disposed || loggingOut || !tree.signedIn || client.authenticated) return;
    await clearSession();
    void vscode.window.showWarningMessage('算力会话已失效，请重新登录。');
  }
  const jupyter = createJupyterConnection(client, { onSessionExpired });
  const files = createFileTransfer(client, { withTransferProgress, bytes,
    sessionActive: () => !disposed && !loggingOut && client.authenticated, sessionExpired: onSessionExpired });
  context.subscriptions.push({ dispose() {
    disposed = true;
    loadController?.abort();
    closeSessionPanels(client);
    closeTunnelPanels(client);
    files.close();
    jupyter.dispose();
    documents.clear();
  } });

  async function publishSession(signedIn, username = '') {
    tree.signedIn = signedIn;
    treeView.description = signedIn ? plain(username, 50) : '';
    await vscode.commands.executeCommand('setContext', namespace + '.authenticated', signedIn);
    tree.changed.fire();
  }

  async function clearSession() {
    revision++;
    loadController?.abort();
    activeLoad = undefined;
    closeSessionPanels(client);
    closeTunnelPanels(client);
    files.close();
    jupyter.clear();
    for (const key of documents.keys()) {
      documents.delete(key);
      reportChanged.fire(vscode.Uri.parse(key));
    }
    tree.items = [];
    tree.warnings = [];
    tree.error = '';
    tree.loading = false;
    tree.starting.clear();
    tree.stopping.clear();
    await publishSession(false);
  }

  async function refresh() {
    if (activeLoad) return activeLoad;
    const generation = revision;
    const controller = new AbortController();
    loadController = controller;
    tree.loading = true;
    tree.error = '';
    tree.changed.fire();
    const operation = (async () => {
      try {
        const data = await client.request('/api/resources', { timeoutMs: 120000, signal: controller.signal });
        if (disposed || generation !== revision || !client.authenticated) return;
        if (!Array.isArray(data?.items)) throw new Error('工作台返回的资源列表格式不正确。');
        const updated = data.items.filter(item => typeof item?.id === 'string' && item.id.length > 0 && item.id.length <= 256);
        for (const resource of updated) {
          if (['Stopped', 'Stopping'].includes(resource.status)) jupyter.resourceStopped(resource.id);
        }
        tree.items = updated;
        tree.warnings = Array.isArray(data.warnings) ? data.warnings.map(item => plain(item, 200)) : [];
      } catch (error) {
        if (disposed || generation !== revision || controller.signal.aborted) return;
        if (error.status === 401 || !client.authenticated) {
          await clearSession();
          await vscode.window.showWarningMessage('算力会话已失效，请重新登录。');
          return;
        }
        tree.error = plain(error.message, 300) || '无法读取资源。';
      } finally {
        if (!disposed && generation === revision) {
          tree.loading = false;
          tree.changed.fire();
        }
      }
    })();
    activeLoad = operation;
    try {
      await operation;
    } finally {
      if (activeLoad === operation) activeLoad = undefined;
    }
  }

  function login() {
    if (loggingOut) return;
    if (client.authenticated) return vscode.window.showInformationMessage('已登录算力平台。切换账号请先退出。');
    return openLoginPanel(context, client, async session => {
      if (disposed || !client.authenticated) return;
      await publishSession(true, session?.username);
      await refresh();
    });
  }

  async function showReport(title, content) {
    const id = randomUUID();
    const uri = vscode.Uri.from({ scheme: docScheme, path: '/' + title + '.txt', query: id });
    documents.set(uri.toString(), content);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      documents.delete(uri.toString());
      throw error;
    }
  }

  async function selectResource(node) {
    if (node?.kind === 'resource') return tree.items.find(item => item.id === node.resource?.id);
    if (tree.loading) await activeLoad;
    if (!tree.items.length) {
      await vscode.window.showInformationMessage('暂时没有可选资源。可从侧栏刷新列表。');
      return undefined;
    }
    if (tree.items.length === 1) return tree.items[0];
    const selected = await vscode.window.showQuickPick(tree.items.map(resource => ({
      label: plain(resource.name) || '未命名资源',
      description: statusLabel(resource.status),
      detail: [capacity(resource), plain(resource.workspaceName)].filter(Boolean).join(' · '),
      resource,
    })), { title: '选择开发环境', matchOnDescription: true, matchOnDetail: true });
    return selected?.resource;
  }

  async function details(resource) {
    const generation = revision;
    const item = await client.request(resourceRoute(resource));
    if (generation !== revision || disposed) return;
    tree.update(item);
    await showReport('算力资源详情', [
      plain(item.name),
      '',
      '运行状态    ' + statusLabel(item.status),
      '资源编号    ' + plain(item.id),
      '计算配置    ' + (capacity(item) || '—'),
      '项目        ' + (plain(item.workspaceName) || '—'),
      '组织        ' + (plain(item.enterpriseSpaceName) || '—'),
      '创建时间    ' + date(item.createdAt),
      '实例创建    ' + date(item.runtimeInstanceCreatedAt),
      '自动停止    ' + date(item.autoStopAt),
      '镜像        ' + (plain(item.image) || '—'),
      '描述        ' + (plain(item.description) || '—'),
      '',
      '挂载目录',
      ...(item.mounts || []).map(mount => {
        const access = mount.readOnly ? '只读' : '读写';
        return '  ' + [plain(mount.path), plain(mount.source), access, mount.supported ? '支持扩展文件管理' : '请在工作区内访问'].join('  ');
      }),
    ].join('\n'));
  }

  async function billing(resource) {
    const generation = revision;
    const result = await client.request(resourceRoute(resource, '/billing'));
    if (generation !== revision || disposed) return;
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    await showReport('算力用量和费用', [
      plain(resource.name),
      '账期        ' + (plain(result?.month) || '—'),
      '币种        ' + (plain(result?.currency) || '—'),
      plain(result?.message, 1200),
      '',
      ...(result?.available === true ? rows.flatMap(row => [
        plain(row.chargingItemName || row.chargingItem) || '计费项',
        ...(row.consumeStartAt || row.consumeEndAt ? ['计费时间    ' + date(row.consumeStartAt) + ' 至 ' + date(row.consumeEndAt)] : []),
        '用量        ' + [billingValue(row.usage), plain(row.usageUnit, 60)].filter(Boolean).join(' '),
        '费用        ' + (row.hidePrice ? '平台隐藏金额' : billingValue(row.amount)),
        '实付        ' + (row.hidePrice ? '平台隐藏金额' : billingValue(row.payAmount)),
        '优惠        ' + (row.hidePrice ? '平台隐藏金额' : billingValue(row.discountAmount)),
        '',
      ]) : []),
    ].join('\n'));
  }

  async function diagnostics(resource) {
    const generation = revision;
    const item = await client.request(resourceRoute(resource, '/diagnostics'), { timeoutMs: 90000 });
    if (generation !== revision || disposed) return;
    if (item.resource) tree.update(item.resource);
    const events = Array.isArray(item.events) ? item.events : [];
    await showReport('算力运行诊断', [
      plain(resource.name),
      '资源状态    ' + statusLabel(item.status),
      '实例状态    ' + (item.instance ? statusLabel(item.instance.status) : '平台未返回运行实例'),
      '检查时间    ' + date(item.checkedAt),
      ...(item.status === 'Running'
        ? ['平台显示资源正在运行。下方事件含历史记录，请对照时间查看。']
        : item.reason ? ['平台提示    ' + plain(item.reason, 2000)] : []),
      ...(Array.isArray(item.warnings) ? item.warnings.map(value => plain(value)) : []),
      '',
      '最近平台事件',
      ...(events.length ? events.slice(0, 100).map(event =>
        [date(event.timestamp), plain(event.source), plain(event.level), plain(event.action), plain(event.message, 2000)].filter(Boolean).join(' · ')
      ) : ['没有返回事件。']),
      '',
      '此报告读取算力平台状态。桌面隧道的连接结果请查看 VS Code「输出」中的 Remote - Tunnels。',
    ].join('\n'));
  }

  async function start(resource) {
    if (tree.starting.has(resource.id) || tree.stopping.has(resource.id)) return;
    const generation = revision;
    tree.starting.add(resource.id);
    tree.changed.fire();
    try {
      const current = await client.request(resourceRoute(resource));
      if (generation !== revision || disposed) return;
      tree.update(current);
      if (!isStartable(current.status)) {
        await vscode.window.showInformationMessage('当前资源状态为' + statusLabel(current.status) + '，无需提交启动。');
        return;
      }
      const confirm = current.status === 'StartFailed' ? '重试启动' : '启动';
      const selected = await vscode.window.showInformationMessage(confirm + '「' + plain(current.name) + '」？', { modal: true }, confirm);
      if (selected !== confirm || generation !== revision || disposed) return;
      const result = await client.request(resourceRoute(current, '/start'), { method: 'POST' });
      if (result?.submitted !== true) throw new Error('平台没有确认已收到启动请求。');
      let latest = current;
      try {
        await withCancellation('已提交启动请求，等待算力平台更新状态', async signal => {
          for (let attempt = 0; attempt < 6 && generation === revision && !disposed; attempt++) {
            await delay(4000, undefined, { signal });
            latest = await client.request(resourceRoute(current), { timeoutMs: 6000, signal });
            if (generation !== revision || disposed) return;
            tree.update(latest);
            if (['Running', 'Failed'].includes(latest.status) || (latest.status === 'StartFailed' && current.status !== 'StartFailed')) return;
          }
        });
      } catch (error) {
        if (error.status === 401) throw error;
        if (generation === revision && !disposed) {
          void vscode.window.showInformationMessage('启动请求已提交。' + (error.name === 'AbortError' || error.code === 'CANCELLED' ? '已停止等待。' : '暂未取得最新状态。') + '可稍后刷新。');
        }
        return;
      }
      if (generation === revision && !disposed) {
        void vscode.window.showInformationMessage(latest.status === 'Running'
          ? '平台显示「' + plain(current.name) + '」正在运行。'
          : '启动请求已提交。当前平台状态为' + statusLabel(latest.status) + '，可刷新或查看运行诊断。');
      }
    } finally {
      if (generation === revision && !disposed) {
        tree.starting.delete(resource.id);
        tree.changed.fire();
      }
    }
  }

  async function stop(resource) {
    if (tree.stopping.has(resource.id)) return;
    const generation = revision;
    tree.stopping.add(resource.id);
    tree.changed.fire();
    try {
      const current = await client.request(resourceRoute(resource));
      if (generation !== revision || disposed) return;
      tree.update(current);
      if (current.canStop !== true) {
        void vscode.window.showInformationMessage('平台当前状态为' + statusLabel(current.status) + '，关闭操作不可用。');
        return;
      }
      const confirm = '关闭资源';
      const selected = await vscode.window.showWarningMessage('关闭「' + plain(current.name) + '」？运行中的任务和连接会中断。', { modal: true }, confirm);
      if (selected !== confirm || generation !== revision || disposed) return;
      const result = await client.request(resourceRoute(current, '/stop'), { method: 'POST' });
      if (generation !== revision || disposed) return;
      if (result?.submitted !== true) throw new Error('平台没有确认已收到关闭请求。');
      jupyter.resourceStopped(resource.id);
      let latest = current;
      try {
        await withCancellation('关闭请求已提交，正在等待平台更新状态', async signal => {
          for (let attempt = 0; attempt < 6 && generation === revision && !disposed; attempt++) {
            await delay(3000, undefined, { signal });
            latest = await client.request(resourceRoute(current), { timeoutMs: 6000, signal });
            if (generation !== revision || disposed) return;
            tree.update(latest);
            if (latest.status === 'Stopped' || (latest.status === 'StopFailed' && current.status !== 'StopFailed')) return;
          }
        });
      } catch (error) {
        if (error.status === 401) throw error;
        if (generation === revision && !disposed) void vscode.window.showInformationMessage('关闭请求已提交。请刷新资源查看结果。');
        return;
      }
      if (generation !== revision || disposed) return;
      void vscode.window.showInformationMessage('「' + plain(current.name) + '」' + statusLabel(latest.status)
        + (latest.status === 'Stopped' ? '。' : '。可刷新资源查看最新状态。'));
    } finally {
      if (generation === revision && !disposed) {
        tree.stopping.delete(resource.id);
        tree.changed.fire();
      }
    }
  }

  async function web(resource) {
    const generation = revision;
    const response = await client.request(resourceRoute(resource, '/workspace'));
    if (generation !== revision || disposed) return;
    const { workspaceOrigin } = await client.service();
    const address = response?.supported && workspaceAddress(response, workspaceOrigin);
    if (!address) throw new Error(plain(response?.reason) || '平台没有提供可用的网页开发环境地址。');
    if (!await vscode.env.openExternal(address)) throw new Error('系统没有打开网页开发环境，请检查默认浏览器。');
  }

  async function connectTunnel(name) {
    if (!tunnelPattern.test(name) || disposed || !client.authenticated) return;
    if (!vscode.extensions.getExtension('ms-vscode.remote-server')) {
      const action = '查看微软扩展';
      if (await vscode.window.showInformationMessage('请先在本机安装微软 Remote - Tunnels 扩展。', action) === action) {
        await vscode.env.openExternal(marketplace);
      }
      return;
    }
    const destination = vscode.Uri.from({ scheme: 'vscode-remote', authority: 'tunnel+' + name, path: '/home/work' });
    void vscode.window.showInformationMessage('正在打开桌面连接。是否连通以新窗口的远程状态和终端输出为准。');
    await vscode.commands.executeCommand('vscode.openFolder', destination, { forceNewWindow: true });
  }

  function suggestedTunnelName(resource, stored) {
    const remembered = stored && Object.hasOwn(stored, resource.id) ? stored[resource.id] : undefined;
    if (typeof remembered === 'string' && tunnelPattern.test(remembered)) return remembered;
    return '';
  }

  async function tunnel(resource) {
    const generation = revision;
    const latest = await client.request(resourceRoute(resource));
    if (generation !== revision || disposed) return;
    tree.update(latest);
    if (latest.status !== 'Running') {
      await vscode.window.showInformationMessage('平台显示当前资源' + statusLabel(latest.status) + '。启动资源并确认远端隧道在线后再连接。');
      return;
    }
    const stored = context.globalState.get('resourceTunnelNames', {});
    const name = await vscode.window.showInputBox({
      title: '连接手动启动的 VS Code 隧道',
      prompt: '请输入已在当前算力实例手动启动的隧道名称。',
      value: suggestedTunnelName(latest, stored),
      placeHolder: '隧道名称',
      validateInput: value => tunnelPattern.test(value.trim()) ? undefined : '请输入由字母、数字和连字符组成的有效隧道名。',
    });
    if (!name || !tunnelPattern.test(name.trim()) || !client.authenticated || generation !== revision || disposed) return;
    const chosen = name.trim();
    await context.globalState.update('resourceTunnelNames', { ...stored, [resource.id]: chosen });
    if (generation === revision) await connectTunnel(chosen);
  }

  function setupTunnel(resource) {
    const generation = revision;
    return openTunnelPanel(context, client, resource, {
      initialName: suggestedTunnelName(resource, context.globalState.get('resourceTunnelNames', {})),
      onManual: () => generation === revision ? tunnel(resource) : undefined,
      onOpenWorkspace: () => generation === revision ? web(resource) : undefined,
      onConnect: name => generation === revision ? connectTunnel(name) : undefined,
      async onSessionExpired() {
        if (generation !== revision || disposed) return;
        await clearSession();
        void vscode.window.showWarningMessage('算力会话已失效，请重新登录。');
      },
    });
  }

  function jupyterCommand(action) {
    return resource => {
      const generation = revision;
      return jupyter[action](resource, () => generation === revision && !disposed && !loggingOut && client.authenticated);
    };
  }

  function register(name, handler, { session = false, resource = false } = {}) {
    const command = vscode.commands.registerCommand(namespace + '.' + name, async node => {
      const generation = revision;
      try {
        if (session && loggingOut) return;
        if (session && !client.authenticated) {
          if (tree.signedIn) await clearSession();
          const choice = await vscode.window.showInformationMessage('请先登录算力平台。', '登录');
          if (choice === '登录') await login();
          return;
        }
        const input = resource ? await selectResource(node) : undefined;
        if (session && (generation !== revision || !client.authenticated || loggingOut)) return;
        if (!resource || input) await handler(input);
      } catch (error) {
        if (disposed || (generation !== revision && name !== 'logout') || error?.name === 'AbortError' || error?.code === 'CANCELLED' || error instanceof vscode.CancellationError) return;
        if (error?.status === 401) {
          await clearSession();
          void vscode.window.showWarningMessage('算力会话已失效，请重新登录。');
          return;
        }
        void vscode.window.showErrorMessage('算力工作台 · ' + (plain(error?.message, 400) || '操作失败，请重试。'));
      }
    });
    context.subscriptions.push(command);
  }

  const needsResource = { session: true, resource: true };
  register('login', login);
  register('logout', async () => {
    loggingOut = true;
    revision++;
    loadController?.abort();
    closeSessionPanels(client);
    closeTunnelPanels(client);
    files.close();
    try {
      await client.logout();
    } finally {
      try { await clearSession(); }
      finally { loggingOut = false; }
    }
  }, { session: true });
  register('refresh', refresh, { session: true });
  register('details', details, needsResource);
  register('billing', billing, needsResource);
  register('diagnostics', diagnostics, needsResource);
  register('start', start, needsResource);
  register('stop', stop, needsResource);
  register('files', files.open, needsResource);
  register('web', web, needsResource);
  register('jupyter', jupyterCommand('connect'), needsResource);
  register('disconnectJupyter', jupyterCommand('disconnect'), needsResource);
  register('setupTunnel', setupTunnel, needsResource);
  register('tunnel', tunnel, needsResource);
  register('portal', async () => vscode.env.openExternal(vscode.Uri.parse((await client.service()).origin + '/')));
  register('aiSettings', () => configureAI(context, client), { session: true });
  register('chat', () => openChatPanel(context, client), { session: true });
  void publishSession(false);
}

function deactivate() { return localService?.close(); }

module.exports = { activate, deactivate };

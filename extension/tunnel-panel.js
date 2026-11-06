'use strict';

const { randomBytes } = require('node:crypto');
const vscode = require('vscode');

const DEVICE_URL = 'https://github.com/login/device';
const LICENSE_URL = 'https://aka.ms/vscode-server-license';
const PRIVACY_URL = 'https://privacy.microsoft.com/en-US/privacystatement';
const namePattern = /^[a-z0-9][a-z0-9-]{1,47}[a-z0-9]$/;
const codePattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i;
const states = new Set(['idle', 'starting', 'waiting_github', 'starting_tunnel', 'ready', 'failed', 'stopped', 'unavailable']);
const activeStates = new Set(['starting', 'waiting_github', 'starting_tunnel']);
const startableStates = new Set(['idle', 'failed', 'stopped']);
const stoppableStates = new Set(['starting', 'waiting_github', 'starting_tunnel', 'ready']);
const panels = new WeakMap();
const pollInterval = 3000;
const pollDuration = 15 * 60 * 1000;

function plain(value, limit = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
}

function expiry(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,13}$/.test(value))) {
    const amount = Number(value);
    const millis = amount < 1e12 ? amount * 1000 : amount;
    return millis > 0 && millis <= 8.64e15 ? millis : null;
  }
  const millis = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(millis) ? millis : null;
}

function normalize(data) {
  if (!states.has(data?.state)) throw new Error('工作台返回的隧道状态无效。');
  const validCode = data.state === 'waiting_github' && data.deviceUrl === DEVICE_URL
    && typeof data.deviceCode === 'string' && codePattern.test(data.deviceCode);
  return {
    state: data.state,
    instanceId: plain(data.instanceId, 128),
    tunnelName: typeof data.tunnelName === 'string' && namePattern.test(data.tunnelName) ? data.tunnelName : '',
    codeExpiresAt: validCode ? expiry(data.codeExpiresAt) : null,
    deviceCode: validCode ? data.deviceCode.toUpperCase() : '',
    message: plain(data.message).replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, '••••-••••'),
  };
}

function currentCode(snapshot) {
  return snapshot?.deviceCode && (!snapshot.codeExpiresAt || snapshot.codeExpiresAt > Date.now()) ? snapshot.deviceCode : '';
}

function tunnelScript() {
  const host = acquireVsCodeApi();
  const get = id => document.getElementById(id);
  const form = get('start-form');
  const name = get('tunnel-name');
  const approval = get('accept-license');
  const labels = {
    idle: '尚未启动',
    starting: '正在准备远端连接',
    waiting_github: '等待 GitHub 授权',
    starting_tunnel: '正在启动隧道',
    ready: '隧道已就绪',
    failed: '启动失败',
    stopped: '已停止',
    unavailable: '此环境暂不支持自动设置',
  };
  let view;
  let initialized = false;
  let awaiting = false;

  function render() {
    const code = view?.deviceCode && (!view.codeExpiresAt || view.codeExpiresAt > Date.now()) ? view.deviceCode : '';
    get('code-section').hidden = !code;
    get('code-pending').hidden = view?.state !== 'waiting_github' || !!code;
    get('desktop-note').hidden = view?.state !== 'ready';
    get('code').textContent = code;
    get('expires').textContent = code && view.codeExpiresAt
      ? '有效期至 ' + new Date(view.codeExpiresAt).toLocaleTimeString()
      : '请在 GitHub 页面及时完成授权。';
    get('state').textContent = labels[view?.state] || '正在读取隧道状态…';
    get('message').textContent = view?.message || '';
    get('error').textContent = view?.error || '';
    get('error').hidden = !view?.error;
    get('polling-hint').hidden = !view?.pollingPaused;
    get('instance').textContent = view?.instanceId ? '当前实例 ' + view.instanceId : '';
    get('name-label').textContent = view?.tunnelName ? '隧道名称 ' + view.tunnelName : '';
    get('action-state').textContent = view?.busy || awaiting ? '正在处理…' : '';
    form.hidden = !view?.canStart;
    get('start').disabled = awaiting || !!view?.busy || !approval.checked || !name.validity.valid;
    get('refresh').disabled = awaiting || !!view?.busy;
    get('github').disabled = awaiting || !!view?.busy || !code;
    get('copy-code').disabled = awaiting || !!view?.busy || !code;
    get('stop').hidden = !view?.canStop;
    get('stop').disabled = awaiting || !!view?.busy;
    get('connect').hidden = !view?.canConnect;
    get('connect').disabled = awaiting || !!view?.busy;
    get('manual').hidden = !view?.canUseManual;
    get('prepare').hidden = !view?.canPrepare;
    get('prepare').disabled = awaiting || !!view?.busy;
    get('workspace').hidden = !view?.canOpenWorkspace;
  }

  function send(type, values = {}) {
    if (awaiting || view?.busy) return;
    awaiting = true;
    render();
    host.postMessage({ type, ...values });
  }

  name.addEventListener('input', render);
  approval.addEventListener('change', render);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!view?.canStart || !approval.checked || !name.validity.valid) return;
    send('start', { name: name.value.trim(), acceptedLicense: true });
    approval.checked = false;
    render();
  });
  for (const [id, type] of [
    ['refresh', 'refresh'], ['github', 'openGithub'], ['copy-code', 'copyCode'],
    ['license', 'openLicense'], ['privacy', 'openPrivacy'], ['stop', 'stop'],
    ['connect', 'connect'], ['manual', 'manual'], ['prepare', 'prepare'], ['workspace', 'workspace'],
  ]) get(id).addEventListener('click', () => send(type));

  window.addEventListener('message', event => {
    const data = event.data;
    if (data?.type !== 'tunnelState') return;
    view = data;
    awaiting = false;
    get('heading').textContent = data.resourceName ? '设置桌面隧道 · ' + data.resourceName : '设置桌面隧道';
    if (!initialized) {
      initialized = true;
      name.value = data.suggestedName || '';
    }
    render();
  });
  window.setInterval(() => {
    if (view?.deviceCode && view.codeExpiresAt && view.codeExpiresAt <= Date.now() && !get('code-section').hidden) render();
  }, 1000);
  render();
  host.postMessage({ type: 'ready' });
}

const markup = `
<main><h1 id="heading">设置桌面隧道</h1>
<p class="muted">使用微软官方私有隧道。首次使用或算力实例重建后，需要在 GitHub 确认设备授权。</p>
<section class="card" aria-label="隧道状态">
  <h2 id="state" aria-live="polite">正在读取隧道状态…</h2>
  <p id="instance" class="muted"></p><p id="name-label" class="muted"></p>
  <p id="message" aria-live="polite"></p><p id="error" class="error" role="alert" hidden></p>
  <p id="polling-hint" class="muted" hidden>自动刷新已暂停。可手动刷新以继续读取状态。</p>
  <p id="code-pending" class="muted" hidden>当前没有可用的设备码。请等待刷新，或查看上面的状态提示。</p>
  <p id="desktop-note" class="muted" hidden>远端隧道已就绪。请打开桌面 VS Code 验证连接和终端。</p>
  <p id="action-state" role="status"></p>
  <section id="code-section" class="code-panel" aria-label="GitHub 设备授权" hidden>
    <h3>在 GitHub 输入此设备码</h3>
    <p><code id="code"></code></p>
    <p id="expires" class="muted"></p>
    <div class="row"><button id="copy-code" type="button">复制设备码</button>
    <button id="github" type="button" class="secondary">打开 GitHub 设备授权页</button></div>
  </section>
  <form id="start-form" autocomplete="off" hidden>
    <label for="tunnel-name">隧道名称</label>
    <input id="tunnel-name" required minlength="3" maxlength="49" pattern="[a-z0-9][a-z0-9\\-]{1,47}[a-z0-9]" placeholder="例如 lab-gpu" spellcheck="false" autocapitalize="none" aria-describedby="tunnel-name-rules">
    <p id="tunnel-name-rules" class="muted">3 至 49 位小写字母、数字或连字符，两端须为字母或数字。</p>
    <div class="row consent"><button id="license" type="button" class="secondary">查看微软 VS Code 服务器许可</button>
    <button id="privacy" type="button" class="secondary">查看微软隐私声明</button></div>
    <label class="consent"><input type="checkbox" id="accept-license">我已阅读并接受微软 VS Code 服务器许可</label>
    <div class="row"><button id="start" type="submit" disabled>同意并申请设备码</button></div>
  </form>
  <div class="row actions">
    <button id="connect" type="button" hidden>在桌面 VS Code 连接</button>
    <button id="refresh" type="button" class="secondary">刷新状态</button>
    <button id="prepare" type="button" hidden>准备后台助手</button>
    <button id="workspace" type="button" class="secondary" hidden>打开网页工作区</button>
    <button id="stop" type="button" class="secondary" hidden>停止本次隧道</button>
    <button id="manual" type="button" class="secondary" hidden>连接手动启动的隧道</button>
  </div>
</section>
<p class="muted footer">关闭面板会停止刷新。需要结束本次授权或隧道时，请使用「停止本次隧道」。</p>
</main>`;

const styles = `
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { max-width: 780px; margin: 0 auto; padding: 28px 24px; line-height: 1.6; }
  h1 { margin: 0 0 8px; font-size: 1.65em; }
  h2 { margin: 0 0 8px; font-size: 1.28em; }
  h3, p { margin: 0 0 10px; }
  p:empty { display: none; }
  .muted { color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
  .card, .code-panel { border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); border-radius: 7px; padding: 17px; overflow-wrap: anywhere; }
  .code-panel { margin: 16px 0; background: var(--vscode-textBlockQuote-background); }
  code { font-size: 1.5em; font-weight: bold; letter-spacing: .09em; }
  label { display: block; font-weight: 600; }
  input[type=text], input:not([type]) { display: block; width: 100%; max-width: 360px; margin-top: 3px; padding: 6px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); font: inherit; }
  button { cursor: pointer; padding: 6px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .55; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .actions, .consent, .footer { margin-top: 12px; }
  form .row:last-child { margin-top: 10px; }
`;

function openTunnelPanel(context, client, resource, options) {
  let byResource = panels.get(client);
  if (!byResource) {
    byResource = new Map();
    panels.set(client, byResource);
  }
  const previous = byResource.get(resource.id);
  if (previous) {
    previous.reveal();
    return previous;
  }
  const panel = vscode.window.createWebviewPanel('computeWorkbench.tunnel', '算力工作台 · 桌面隧道', vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [],
  });
  byResource.set(resource.id, panel);
  context.subscriptions.push(panel);
  const route = '/api/resources/' + encodeURIComponent(resource.id) + '/tunnel';
  const nonce = randomBytes(18).toString('base64');
  let snapshot;
  let preparedInstance = '';
  let legacyUnavailable = false;
  let unverified = false;
  let error = '';
  let notice = '';
  let currentRequest;
  let pollTimer;
  let pollUntil = 0;
  let webviewReady = false;
  let disposed = false;

  function publish() {
    if (disposed || !webviewReady || !panel.visible) return;
    const state = snapshot?.state;
    void panel.webview.postMessage({
      type: 'tunnelState',
      resourceName: plain(resource.name, 100),
      suggestedName: snapshot?.tunnelName || (namePattern.test(options.initialName || '') ? options.initialName : ''),
      instanceId: snapshot?.instanceId || '',
      state,
      tunnelName: snapshot?.tunnelName || '',
      message: notice || snapshot?.message || '',
      error,
      busy: !!currentRequest && currentRequest.kind !== 'read',
      deviceCode: unverified ? '' : currentCode(snapshot),
      codeExpiresAt: snapshot?.codeExpiresAt || null,
      canStart: !unverified && startableStates.has(state),
      canStop: stoppableStates.has(state) && !!snapshot.instanceId,
      canConnect: !unverified && state === 'ready' && !!snapshot.instanceId && !!snapshot.tunnelName,
      canUseManual: state === 'unavailable' && typeof options.onManual === 'function',
      canPrepare: state === 'unavailable' && !legacyUnavailable && !unverified && !!snapshot.instanceId,
      canOpenWorkspace: state === 'unavailable' && typeof options.onOpenWorkspace === 'function',
      pollingPaused: !!state && activeStates.has(state) && !!pollUntil && Date.now() >= pollUntil,
    });
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (disposed || !panel.visible || !activeStates.has(snapshot?.state) || !client.authenticated || Date.now() >= pollUntil) return;
    pollTimer = setTimeout(() => { void call('read'); }, pollInterval);
  }

  async function call(kind, name = '') {
    if (disposed || !client.authenticated) return;
    if (currentRequest && (currentRequest.kind !== 'read' || kind === 'read')) return;
    currentRequest?.controller.abort();
    const request = { kind, controller: new AbortController() };
    currentRequest = request;
    const previousSnapshot = snapshot;
    let verifiedResponse = false;
    const settings = { signal: request.controller.signal, timeoutMs: kind === 'read' || kind === 'connect' ? 12000 : 30000 };
    if (kind !== 'read') {
      error = notice = '';
      publish();
    }
    try {
      let response;
      if (kind === 'start') {
        response = await client.request(route + '/start', { ...settings, method: 'POST', json: { name, acceptServerLicense: true } });
      } else if (kind === 'prepare') {
        response = await client.request(route + '/prepare', { ...settings, method: 'POST' });
      } else if (kind === 'stop') {
        response = await client.request(route + '/stop', { ...settings, method: 'POST' });
      } else {
        response = await client.request(route, settings);
      }
      if (disposed || currentRequest !== request) return;
      snapshot = normalize(response);
      verifiedResponse = true;
      legacyUnavailable = false;
      unverified = false;
      error = '';
      if (snapshot.state !== previousSnapshot?.state || snapshot.deviceCode !== previousSnapshot?.deviceCode) notice = '';
      if (previousSnapshot?.instanceId && snapshot.instanceId !== previousSnapshot.instanceId) {
        preparedInstance = '';
        pollUntil = 0;
        notice = snapshot.state === 'unavailable'
          ? '算力实例已更换。请为当前实例重新准备后台助手。'
          : '算力实例已更换。请核对当前隧道状态。';
      }
      if (kind === 'start' || (activeStates.has(snapshot.state) && !pollUntil)) pollUntil = Date.now() + pollDuration;
      if (!activeStates.has(snapshot.state)) pollUntil = 0;
      if (kind === 'prepare' && snapshot.state === 'unavailable') {
        if (!snapshot.instanceId || snapshot.instanceId !== previousSnapshot?.instanceId) {
          notice = '算力实例已更换。请为当前实例重新准备后台助手。';
        } else if (typeof response.setupCommand !== 'string' || !response.setupCommand.trim()
            || response.setupCommand.length > 150000 || response.setupCommand.includes('\0')) {
          throw new Error('工作台没有返回可复制的准备命令。');
        } else {
          try { await vscode.env.clipboard.writeText(response.setupCommand); }
          catch { throw new Error('准备命令未能复制。请检查剪贴板后重试。'); }
          if (disposed || currentRequest !== request) return;
          preparedInstance = snapshot.instanceId;
          notice = '准备命令已复制。打开当前网页工作区，在远端终端粘贴并执行一次，然后回到这里刷新。';
        }
      }
      if (kind === 'read' && !notice && snapshot.state === 'unavailable' && preparedInstance && preparedInstance === snapshot.instanceId) {
        notice = '请在当前网页工作区的远端终端执行已复制的准备命令，再刷新状态。';
      }
      if (kind === 'connect') {
        if (snapshot.state !== 'ready' || !snapshot.instanceId || snapshot.instanceId !== previousSnapshot?.instanceId
            || !snapshot.tunnelName || snapshot.tunnelName !== previousSnapshot?.tunnelName) {
          notice = '隧道状态或算力实例已变化。请核对当前状态后再连接。';
        } else {
          await options.onConnect(snapshot.tunnelName);
        }
      }
    } catch (cause) {
      if (disposed || currentRequest !== request || request.controller.signal.aborted) return;
      if (cause?.status === 401 || !client.authenticated) {
        panel.dispose();
        await options.onSessionExpired?.();
        return;
      }
      if (cause?.status === 404 && (!cause.code || cause.code === 'NOT_FOUND')) {
        snapshot = { state: 'unavailable', message: '当前本机工作台没有自动设置隧道的接口。可使用网页工作区，或连接你已手动启动的私有隧道。' };
        legacyUnavailable = true;
      } else {
        unverified = !verifiedResponse;
        error = plain(cause?.message) || '无法确认隧道状态，请刷新后重试。';
      }
    } finally {
      if (currentRequest === request) {
        currentRequest = undefined;
        publish();
        schedule();
      }
    }
  }

  const receiver = panel.webview.onDidReceiveMessage(async message => {
    if (disposed || !message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      webviewReady = true;
      publish();
      await call('read');
      return;
    }
    if (!client.authenticated || (currentRequest && currentRequest.kind !== 'read')) {
      publish();
      return;
    }
    try {
      if (message.type === 'refresh') {
        notice = '';
        pollUntil = 0;
        await call('read');
      } else if (message.type === 'start' && !unverified && startableStates.has(snapshot?.state)) {
        if (message.acceptedLicense !== true || typeof message.name !== 'string' || !namePattern.test(message.name)) {
          error = '请填写符合格式的隧道名称，并确认微软服务器许可。';
        } else {
          await call('start', message.name);
        }
      } else if (message.type === 'prepare' && !unverified && !legacyUnavailable && snapshot?.state === 'unavailable' && snapshot.instanceId) {
        await call('prepare');
      } else if (message.type === 'workspace' && snapshot?.state === 'unavailable') {
        await options.onOpenWorkspace?.();
      } else if (message.type === 'stop' && stoppableStates.has(snapshot?.state) && snapshot.instanceId) {
        const instanceId = snapshot.instanceId;
        const confirmed = await vscode.window.showWarningMessage('停止此会话启动的隧道？现有远程连接将断开。', { modal: true }, '停止');
        if (confirmed === '停止' && !disposed && snapshot?.instanceId === instanceId && stoppableStates.has(snapshot.state)) await call('stop');
      } else if (message.type === 'copyCode' && !unverified && currentCode(snapshot)) {
        await vscode.env.clipboard.writeText(currentCode(snapshot));
        notice = '已复制设备码。请到 GitHub 页面粘贴并确认。';
      } else if (message.type === 'openGithub' && !unverified && currentCode(snapshot)) {
        if (!await vscode.env.openExternal(vscode.Uri.parse(DEVICE_URL))) error = '没有打开 GitHub 页面。请检查默认浏览器。';
      } else if (message.type === 'openLicense') {
        if (!await vscode.env.openExternal(vscode.Uri.parse(LICENSE_URL))) error = '没有打开微软服务器许可页面。';
      } else if (message.type === 'openPrivacy') {
        if (!await vscode.env.openExternal(vscode.Uri.parse(PRIVACY_URL))) error = '没有打开微软隐私声明页面。';
      } else if (message.type === 'connect' && !unverified && snapshot?.state === 'ready') {
        await call('connect');
      } else if (message.type === 'manual' && snapshot?.state === 'unavailable') {
        await options.onManual?.();
      }
    } catch (cause) {
      if (cause?.status === 401 || !client.authenticated) {
        panel.dispose();
        await options.onSessionExpired?.();
      } else {
        error = plain(cause?.message) || '操作失败，请重试。';
      }
    } finally {
      publish();
    }
  });
  const visibility = panel.onDidChangeViewState(() => {
    if (panel.visible) {
      publish();
      void call('read');
    } else {
      clearTimeout(pollTimer);
    }
  });
  panel.onDidDispose(() => {
    disposed = true;
    clearTimeout(pollTimer);
    currentRequest?.controller.abort();
    snapshot = undefined;
    byResource.delete(resource.id);
    receiver.dispose();
    visibility.dispose();
  });
  panel.webview.html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
<style nonce="${nonce}">${styles}</style></head><body>${markup}
<script nonce="${nonce}">(${tunnelScript.toString()})();</script></body></html>`;
  return panel;
}

function closeTunnelPanels(client) {
  const byResource = panels.get(client);
  if (!byResource) return;
  for (const panel of byResource.values()) panel.dispose();
  panels.delete(client);
}

module.exports = { openTunnelPanel, closeTunnelPanels };

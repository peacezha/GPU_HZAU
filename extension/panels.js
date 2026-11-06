'use strict';

const { randomBytes } = require('node:crypto');
const vscode = require('vscode');

const loginPanels = new WeakMap();
const chatPanels = new WeakMap();
const editingSettings = new WeakMap();
const MAX_MESSAGE = 30000;

const styles = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { max-width: 840px; margin: 0 auto; padding: 30px 24px; line-height: 1.6; }
  h1 { font-size: 1.65em; margin: 0 0 8px; }
  p { margin: 0 0 14px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .card { padding: 20px; border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); border-radius: 8px; }
  .login { max-width: 470px; }
  .fields { display: grid; gap: 12px; }
  label { display: block; font-weight: 600; }
  input, textarea { display: block; width: 100%; padding: 7px 9px; border: 1px solid var(--vscode-input-border, transparent); color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
  textarea { resize: vertical; min-height: 100px; }
  input:focus, button:focus-visible, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button { cursor: pointer; padding: 6px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .55; cursor: default; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .captcha { margin: 4px 0 8px; }
  .captcha img { max-width: 220px; max-height: 64px; object-fit: contain; }
  .status { min-height: 1.7em; margin: 12px 0 0; }
  .status.error { color: var(--vscode-errorForeground); }
  .log { margin: 16px 0; display: grid; gap: 10px; max-height: 54vh; overflow: auto; }
  .message { border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); border-radius: 6px; padding: 12px; overflow-wrap: anywhere; }
  .message.user { background: var(--vscode-textBlockQuote-background); }
  .message .row { justify-content: space-between; }
  .message p, pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; }
  pre { padding: 8px; background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family, monospace); }
  .code-copy { margin-bottom: 5px; }
`;

function createPanel(type, title, body, script, extraStyles = '') {
  const nonce = randomBytes(18).toString('base64');
  const panel = vscode.window.createWebviewPanel(type, title, vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [],
  });
  panel.webview.html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
<style nonce="${nonce}">${styles}${extraStyles}</style></head><body>${body}
<script nonce="${nonce}">(${script.toString()})();</script></body></html>`;
  return panel;
}

function safeMessage(error, fallback) {
  if (error?.status === 401) return '登录已失效，请重新登录算力平台。';
  return typeof error?.message === 'string' && error.message.trim()
    ? error.message.slice(0, 500)
    : fallback;
}

function captchaDataUrl(challenge) {
  const raw = challenge?.captchaImage || challenge?.image || challenge?.captchaBase64;
  if (typeof raw !== 'string' || raw.length > 512000) throw new Error('验证码图片无效，请重新获取。');
  const content = raw.trim().replace(/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i, '').replace(/\s/g, '');
  if (!content || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw new Error('验证码图片格式不受支持。');
  const bytes = Buffer.from(content, 'base64');
  const signature = bytes.subarray(0, 12).toString('hex');
  let mime;
  if (signature.startsWith('89504e470d0a1a0a')) mime = 'png';
  else if (signature.startsWith('ffd8ff')) mime = 'jpeg';
  else if (/^474946383[79]61/.test(signature)) mime = 'gif';
  else if (/^52494646[0-9a-f]{8}57454250$/.test(signature)) mime = 'webp';
  if (!mime) throw new Error('验证码图片格式不受支持。');
  return `data:image/${mime};base64,${bytes.toString('base64')}`;
}

function loginScript() {
  const host = acquireVsCodeApi();
  const get = id => document.getElementById(id);
  const form = get('login');
  const image = get('captcha-image');
  const status = get('login-status');
  const code = get('captcha-code');
  let busy = true;
  let available = false;

  function update() {
    get('submit').disabled = busy || !available;
    get('refresh').disabled = busy;
    image.hidden = !available;
  }

  get('refresh').addEventListener('click', () => {
    if (busy) return;
    busy = true;
    update();
    host.postMessage({ type: 'refresh' });
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !available) return;
    busy = true;
    update();
    const password = get('password');
    host.postMessage({ type: 'login', username: get('username').value, password: password.value, captchaCode: code.value });
    password.value = '';
    code.value = '';
  });
  window.addEventListener('message', ({ data }) => {
    if (data?.type !== 'loginState') return;
    busy = !!data.busy;
    available = typeof data.image === 'string' && !!data.image;
    if (available && image.getAttribute('src') !== data.image) {
      image.src = data.image;
      code.value = '';
    }
    if (!available) image.removeAttribute('src');
    status.textContent = typeof data.message === 'string' ? data.message : '';
    status.classList.toggle('error', !!data.error);
    update();
  });
  host.postMessage({ type: 'ready' });
}

const loginBody = `
<main class="login"><h1>登录算力工作台</h1>
<p class="muted">使用算力平台的账号，手动输入图中的四位验证码。登录状态仅在本次 VS Code 会话内保留。</p>
<form id="login" class="card fields" autocomplete="off">
  <div><label for="username">平台用户名</label><input id="username" required maxlength="128" autocapitalize="none" spellcheck="false"></div>
  <div><label for="password">平台密码</label><input id="password" type="password" required maxlength="512" autocomplete="off"></div>
  <div><label for="captcha-code">图形验证码</label><div class="row captcha"><img id="captcha-image" alt="四位图形验证码" hidden><button id="refresh" class="secondary" type="button" disabled>获取新码</button></div>
  <input id="captcha-code" required minlength="4" maxlength="4" autocapitalize="none" spellcheck="false" autocomplete="off"></div>
  <div class="row"><button id="submit" type="submit" disabled>登录</button></div>
</form><p id="login-status" class="status" role="status" aria-live="polite">正在获取验证码…</p></main>`;

function openLoginPanel(context, client, onLogin) {
  const previous = loginPanels.get(client);
  if (previous) { previous.reveal(); return previous; }

  const panel = createPanel('computeWorkbench.login', '算力工作台 · 登录', loginBody, loginScript);
  loginPanels.set(client, panel);
  context.subscriptions.push(panel);
  let disposed = false;
  let busy = false;
  let challenge;
  let image;

  function show(message = '', error = false) {
    if (!disposed) void panel.webview.postMessage({ type: 'loginState', busy, image, message, error });
  }

  async function refresh(previousError = '') {
    if (disposed) return;
    busy = true;
    challenge = image = undefined;
    show('正在获取验证码…');
    try {
      const next = await client.challenge();
      if (disposed) return;
      if (!/^[a-f0-9]{64}$/.test(next?.challengeId || '') || !Number.isFinite(next?.expiresAt)) {
        throw new Error('工作台未提供有效的登录验证码。');
      }
      image = captchaDataUrl(next);
      challenge = next;
      busy = false;
      show(previousError || (next.mfaEnabled ? '平台已启用多因素验证。如收到二次验证提示，请按平台要求完成。' : ''), !!previousError);
    } catch (error) {
      busy = false;
      show(safeMessage(error, '获取验证码失败，请重试。'), true);
    }
  }

  const receiver = panel.webview.onDidReceiveMessage(async message => {
    if (!message || typeof message !== 'object' || disposed) return;
    if (message.type === 'ready') {
      if (busy || challenge?.expiresAt > Date.now()) show(busy ? '正在处理…' : '');
      else await refresh();
      return;
    }
    if (busy) return;
    if (message.type === 'refresh') { await refresh(); return; }
    if (message.type !== 'login') return;
    const { username, password, captchaCode } = message;
    if (typeof username !== 'string' || !username.trim() || username.length > 128 ||
        typeof password !== 'string' || !password.trim() || password.length > 512 ||
        typeof captchaCode !== 'string' || captchaCode.trim().length !== 4) {
      show('请输入用户名、密码和四位验证码。', true);
      return;
    }
    if (!challenge || challenge.expiresAt <= Date.now()) {
      await refresh('验证码已更新，请输入新图中的验证码。');
      return;
    }

    const { challengeId } = challenge;
    busy = true;
    challenge = image = undefined;
    show('正在登录算力平台…');
    let session;
    try {
      session = await client.login({ username: username.trim(), password, challengeId, captchaCode: captchaCode.trim() });
    } catch (error) {
      // A failed attempt consumes the challenge on the server.
      await refresh(error?.code === 'LOGIN_FAILED' || error?.status === 401
        ? '登录失败，请核对账号、密码和验证码。' : safeMessage(error, '登录失败，请重试。'));
      return;
    }
    chatPanels.get(client)?.panel.dispose();
    panel.dispose();
    try { await onLogin?.(session); } catch { void vscode.window.showWarningMessage('已登录，请手动刷新资源列表。'); }
  });
  panel.onDidDispose(() => {
    disposed = true;
    challenge = image = undefined;
    receiver.dispose();
    loginPanels.delete(client);
  });
  return panel;
}

function modelEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value.trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) return undefined;
    return url.toString().replace(/\/$/, '');
  } catch { return undefined; }
}

async function configureAI(_context, client) {
  if (!client.authenticated) {
    void vscode.window.showWarningMessage('请先登录算力工作台，再配置模型。');
    return false;
  }
  if (editingSettings.has(client) || chatPanels.get(client)?.pending) {
    void vscode.window.showWarningMessage('请先完成当前的模型设置或聊天请求。');
    return false;
  }
  const operation = new AbortController();
  editingSettings.set(client, operation);
  try {
    const current = await client.request('/api/ai/config', { signal: operation.signal, timeoutMs: 15000 });
    const address = await vscode.window.showInputBox({
      title: 'AI 模型服务地址（1/3）',
      prompt: '填写支持 Chat Completions 的 API 地址。远程服务使用 HTTPS。',
      placeHolder: 'https://api.example.com/v1',
      value: current.baseUrl || '',
      ignoreFocusOut: true,
      validateInput: value => modelEndpoint(value) ? undefined : '请输入不含账户、查询参数或片段的 HTTPS 地址，本机服务可用 HTTP。',
    });
    if (address === undefined || operation.signal.aborted) return false;
    const baseUrl = modelEndpoint(address);
    if (!baseUrl) return false;
    const model = await vscode.window.showInputBox({
      title: 'AI 模型名称（2/3）', prompt: '输入该服务提供的模型名称。', value: current.model || '', ignoreFocusOut: true,
      validateInput: value => value.trim() && value.length <= 200 ? undefined : '模型名称需为 1 到 200 字符。',
    });
    if (model === undefined || operation.signal.aborted) return false;
    const preserve = current.hasKey && current.baseUrl === baseUrl;
    const apiKey = await vscode.window.showInputBox({
      title: 'AI 模型 API Key（3/3）',
      prompt: preserve ? '留空保留此服务现有密钥。' : '无密钥的服务可留空。密钥仅保存在工作台当前会话中。',
      password: true, ignoreFocusOut: true,
      validateInput: value => value.length <= 8192 ? undefined : 'API Key 长度超出限制。',
    });
    if (apiKey === undefined || operation.signal.aborted || !client.authenticated) return false;
    await client.request('/api/ai/config', {
      method: 'PUT', json: { baseUrl, model: model.trim(), apiKey: apiKey.trim() },
      signal: operation.signal, timeoutMs: 15000,
    });
    if (operation.signal.aborted) return false;
    chatPanels.get(client)?.setConfig({ baseUrl, model: model.trim() });
    void vscode.window.showInformationMessage('模型连接已保存。发送一条消息即可验证服务。');
    return true;
  } catch (error) {
    if (!operation.signal.aborted) void vscode.window.showErrorMessage(safeMessage(error, '无法保存模型配置。'));
    return false;
  } finally {
    editingSettings.delete(client);
  }
}

function chatScript() {
  const host = acquireVsCodeApi();
  const get = id => document.getElementById(id);
  const log = get('log');
  const textarea = get('prompt');
  const status = get('chat-status');
  const send = get('send');
  let busy = false;
  let configured = false;
  let submitted = '';

  function copyButton(label, text, className = 'secondary') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', () => host.postMessage({ type: 'copy', content: text }));
    return button;
  }

  function paragraph(target, content) {
    if (!content) return;
    const p = document.createElement('p');
    p.textContent = content;
    target.append(p);
  }

  function render(messages) {
    log.replaceChildren();
    for (const message of messages) {
      const article = document.createElement('article');
      const user = message.role === 'user';
      article.className = user ? 'message user' : 'message';
      const heading = document.createElement('div');
      heading.className = 'row';
      const label = document.createElement('strong');
      label.textContent = user ? '你' : 'AI 助手';
      heading.append(label);
      if (!user) heading.append(copyButton('复制回复', message.content));
      article.append(heading);
      if (user) {
        paragraph(article, message.content);
      } else {
        let cursor = 0;
        const blocks = /```[^\r\n`]*\r?\n([\s\S]*?)```/g;
        for (const match of message.content.matchAll(blocks)) {
          paragraph(article, message.content.slice(cursor, match.index));
          const code = document.createElement('pre');
          code.textContent = match[1];
          article.append(code, copyButton('复制代码', match[1], 'secondary code-copy'));
          cursor = match.index + match[0].length;
        }
        paragraph(article, message.content.slice(cursor));
      }
      log.append(article);
    }
    log.scrollTop = log.scrollHeight;
  }

  get('composer').addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !configured || !textarea.value.trim()) return;
    submitted = textarea.value.trim();
    busy = true;
    send.disabled = true;
    status.textContent = '正在请求模型…';
    status.classList.remove('error');
    host.postMessage({ type: 'send', content: submitted });
  });
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      get('composer').requestSubmit();
    }
  });
  get('settings').addEventListener('click', () => host.postMessage({ type: 'configure' }));
  get('clear').addEventListener('click', () => host.postMessage({ type: 'clear' }));
  window.addEventListener('message', ({ data }) => {
    if (data?.type !== 'chatState') return;
    if (data.accepted && textarea.value.trim() === submitted) textarea.value = '';
    busy = !!data.busy;
    configured = !!data.model && !!data.destination;
    get('model').textContent = configured ? `${data.model} · ${data.destination}` : '还未配置模型';
    get('settings').disabled = busy;
    send.disabled = busy || !configured;
    status.textContent = typeof data.message === 'string' ? data.message : '';
    status.classList.toggle('error', !!data.error);
    render(Array.isArray(data.messages) ? data.messages : []);
  });
  host.postMessage({ type: 'ready' });
}

const chatBody = `
<main><h1>算力工作台 · AI 助手</h1>
<p id="model" class="muted">正在读取模型设置…</p>
<p class="muted">点击发送后，输入的文字和本次对话的近期上下文会发送给上方模型服务。请先检查内容中是否包含密钥或敏感信息。</p>
<div class="row"><button id="settings" type="button" class="secondary">设置模型</button><button id="clear" type="button" class="secondary">清空对话</button></div>
<div id="log" class="log" aria-label="对话记录"></div>
<form id="composer" class="card fields"><div><label for="prompt">输入问题或贴入代码片段</label>
<textarea id="prompt" required maxlength="30000" placeholder="例如：帮我解释这段 Python 报错，并给出修改建议。"></textarea></div>
<div class="row"><button id="send" type="submit" disabled>发送</button><span class="muted">Ctrl / ⌘ + Enter 发送</span></div></form>
<p id="chat-status" class="status" role="status" aria-live="polite"></p></main>`;

function requestHistory(history, prompt) {
  const messages = [{ role: 'user', content: prompt }];
  for (let index = history.length - 2; index >= 0; index -= 2) {
    const candidate = [...history.slice(index, index + 2), ...messages];
    if (Buffer.byteLength(JSON.stringify({ messages: candidate }), 'utf8') > 220 * 1024) break;
    messages.unshift(...history.slice(index, index + 2));
  }
  return messages;
}

function openChatPanel(context, client) {
  if (!client.authenticated) {
    void vscode.window.showWarningMessage('请先登录算力工作台，再打开 AI 助手。');
    return undefined;
  }
  const existing = chatPanels.get(client);
  if (existing) { existing.panel.reveal(); return existing.panel; }

  const panel = createPanel('computeWorkbench.chat', '算力工作台 · AI 助手', chatBody, chatScript);
  context.subscriptions.push(panel);
  let disposed = false;
  let history = [];
  let config;
  let pending;
  let statusMessage = '';
  let statusError = false;

  function show(accepted = false) {
    if (disposed) return;
    const messages = pending?.content ? [...history, { role: 'user', content: pending.content }] : history;
    void panel.webview.postMessage({
      type: 'chatState', messages, busy: !!pending, accepted,
      model: config?.model, destination: config?.baseUrl,
      message: statusMessage, error: statusError,
    });
  }

  function setConfig(next) {
    const baseUrl = modelEndpoint(next?.baseUrl);
    const model = typeof next?.model === 'string' ? next.model.slice(0, 200).trim() : '';
    const previous = config;
    config = baseUrl && model ? { baseUrl, model } : undefined;
    const changed = previous?.baseUrl !== config?.baseUrl || previous?.model !== config?.model;
    const hadHistory = history.length > 0;
    if (changed) history = [];
    statusError = false;
    statusMessage = changed && hadHistory ? '模型设置已变化，对话已清空。' : '';
    show();
    return changed;
  }

  const state = { panel, get pending() { return !!pending; }, setConfig };
  chatPanels.set(client, state);
  const receiver = panel.webview.onDidReceiveMessage(async message => {
    if (!message || typeof message !== 'object' || disposed) return;
    switch (message.type) {
      case 'ready':
        if (config || pending) { show(); return; }
        try { setConfig(await client.request('/api/ai/config', { timeoutMs: 15000 })); }
        catch (error) { statusError = true; statusMessage = safeMessage(error, '读取模型设置失败。'); show(); }
        return;
      case 'configure':
        if (!pending) await configureAI(context, client);
        return;
      case 'clear':
        pending?.controller.abort();
        pending = undefined;
        history = [];
        statusMessage = '对话已清空。';
        statusError = false;
        show();
        return;
      case 'copy': {
        if (typeof message.content !== 'string' || !message.content || message.content.length > MAX_MESSAGE) return;
        if (!history.some(item => item.role === 'assistant' && item.content.includes(message.content))) return;
        try { await vscode.env.clipboard.writeText(message.content); statusMessage = '已复制到剪贴板。'; statusError = false; }
        catch { statusMessage = '无法复制内容。请选中文本后手动复制。'; statusError = true; }
        show();
        return;
      }
      case 'send':
        break;
      default:
        return;
    }

    if (pending) return;
    if (typeof message.content !== 'string' || !message.content.trim() || message.content.length > MAX_MESSAGE) {
      statusMessage = '请输入 1 到 30000 字符的内容。';
      statusError = true;
      show();
      return;
    }
    if (!config || !client.authenticated || editingSettings.has(client)) {
      statusMessage = !client.authenticated ? '登录已失效，请重新登录。' : '请先完成模型设置。';
      statusError = true;
      show();
      return;
    }

    const active = { controller: new AbortController(), content: message.content.trim() };
    pending = active;
    statusMessage = '正在请求模型…';
    statusError = false;
    show();
    let accepted = false;
    try {
      const settings = await client.request('/api/ai/config', { signal: active.controller.signal, timeoutMs: 15000 });
      if (pending !== active || disposed) return;
      if (modelEndpoint(settings?.baseUrl) !== config.baseUrl || settings?.model !== config.model) {
        setConfig(settings);
        statusMessage = '模型设置已更新，请核对服务地址后再次发送。';
        return;
      }
      const response = await client.request('/api/ai/chat', {
        method: 'POST', json: { messages: requestHistory(history, active.content) },
        signal: active.controller.signal, timeoutMs: 125000,
      });
      if (pending !== active || disposed) return;
      if (typeof response?.content !== 'string' || !response.content.trim()) throw new Error('模型未返回可读取的文本。');
      const marker = '\n\n［回复超出长度限制，已截断］';
      const answer = response.content.length > MAX_MESSAGE ? response.content.slice(0, MAX_MESSAGE - marker.length) + marker : response.content;
      history = [...history, { role: 'user', content: active.content }, { role: 'assistant', content: answer }].slice(-40);
      statusMessage = '';
      accepted = true;
    } catch (error) {
      if (pending !== active || disposed) return;
      if (error?.status === 401) { history = []; config = undefined; }
      statusMessage = safeMessage(error, '模型请求失败，请检查设置后重试。');
      statusError = true;
    } finally {
      if (pending === active) { pending = undefined; show(accepted); }
    }
  });
  panel.onDidDispose(() => {
    disposed = true;
    pending?.controller.abort();
    pending = undefined;
    history = [];
    receiver.dispose();
    chatPanels.delete(client);
  });
  return panel;
}

function closeSessionPanels(client) {
  editingSettings.get(client)?.abort();
  chatPanels.get(client)?.panel.dispose();
  loginPanels.get(client)?.dispose();
}

module.exports = { createPanel, openLoginPanel, configureAI, openChatPanel, closeSessionPanels };

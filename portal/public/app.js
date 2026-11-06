'use strict';

// Interface state is intentionally ephemeral. Credentials and AI keys never enter browser storage.
const state = { session: null, resources: [], selectedId: '', resourcesLoaded: false, resourcesLoading: false, resourcesError: '', detail: null, detailLoading: false, detailError: '', detailRequest: 0, view: 'overview', filePath: '/mnt/data', fileData: null, fileLoading: false, fileError: '', fileRequest: 0, fileResourceId: '', workspaceRequest: 0, workspaceResourceId: '', aiConfig: null, messages: [], chatBusy: false, upload: null, compact: false, challenge: null, challengeLoading: false, challengeRequest: 0, resourceRequest: 0, chatRequest: 0, startingResources: Object.create(null), startErrors: Object.create(null), diagnostics: Object.create(null), diagnosticsRequest: 0, forceDiagnosticsId: '' };
const $ = (id) => document.getElementById(id);
const icons = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  layers:'<path d="m12 3 10 5-10 5L2 8Z"/><path d="m2 12 10 5 10-5M2 16l10 5 10-5"/>',
  terminal:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/>',
  'folder-plus':'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M12 11v6m-3-3h6"/>',
  sparkles:'<path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3ZM20 2v4m-2-2h4M4 18v4m-2-2h4"/>',
  user:'<circle cx="12" cy="8" r="3.3"/><path d="M5.5 21v-2.5a6.5 6.5 0 0 1 13 0V21"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  eye:'<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  shield:'<path d="M12 3 4 6v5c0 5 4 8.5 8 10 4-1.5 8-5 8-10V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  'arrow-right':'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  'arrow-up':'<path d="M12 20V4m-6 6 6-6 6 6"/>',
  'arrow-up-right':'<path d="M6 18 18 6M6 6h12v12"/>',
  'chevron-right':'<path d="m9 5 7 7-7 7"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 18 17"/>',
  rotate:'<path d="M3 4v6h6"/><path d="M3.5 9a9 9 0 1 1 .5 8"/>',
  upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
  download:'<path d="M12 3v13m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m6 14 5-5-5-5m-8 5h13"/>',
  settings:'<path d="m9.5 3-.6 2.2-2 .9-2-.6-2.4 4 1.6 1.6v2l-1.6 1.6 2.4 4 2-.6 2 .9.6 2.2h5l.6-2.2 2-.9 2 .6 2.4-4-1.6-1.6v-2l1.6-1.6-2.4-4-2 .6-2-.9-.6-2.2Z"/><circle cx="12" cy="12" r="3"/>',
  sliders:'<path d="M4 7h4m4 0h8M4 17h8m4 0h4M8 4v6m8 4v6"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  layout:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>',
  more:'<circle cx="5" cy="12" r=".7"/><circle cx="12" cy="12" r=".7"/><circle cx="19" cy="12" r=".7"/>',
  cpu:'<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3"/>',
  gpu:'<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="11" cy="12" r="3.5"/><path d="M17 10v4M6 18v3m3-3v3m3-3v3m3-3v3m3-3v3"/>',
  server:'<rect x="4" y="3" width="16" height="8" rx="2"/><rect x="4" y="13" width="16" height="8" rx="2"/><path d="M8 7h.01M8 17h.01M12 7h4m-4 10h4"/>',
  storage:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
  alert:'<path d="m10.3 3.9-8.2 14A2 2 0 0 0 3.8 21h16.4a2 2 0 0 0 1.7-3.1l-8.2-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4v.01"/>',
  code:'<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  lightbulb:'<path d="M8.5 17c0-3-3-3.5-3-7a6.5 6.5 0 1 1 13 0c0 3.5-3 4-3 7Zm.5 3h6m-5 3h4"/>',
  play:'<path d="m8 4 12 8-12 8Z"/>',
  external:'<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>'
};
function icon(name) { const span = document.createElement('span'); span.dataset.icon = name; hydrateIcon(span); return span; }
function hydrateIcon(el) { const name = el.dataset.icon; if (icons[name]) el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`; }
function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(hydrateIcon); }
function el(tag, cls, content) { const node = document.createElement(tag); if (cls) node.className = cls; if (content !== undefined && content !== null) node.textContent = String(content); return node; }
function clear(node) { node.replaceChildren(); }
function showError(id, message) { $(id).textContent = message || ''; $(id).classList.toggle('hidden', !message); }
function readableError(error) { return error?.message || '暂时无法完成请求，请稍后重试。'; }
function loading(container, label = '正在读取资源…') { clear(container); const wrap = el('div', 'loading-state'); wrap.append(el('span', 'spinner'), el('span', '', label)); container.append(wrap); }
function empty(container, {symbol = 'layers', title, message, action, onAction}) { clear(container); const wrap = el('div', 'empty-state'); const img = el('div', 'empty-state-icon'); img.append(icon(symbol)); wrap.append(img, el('h3', '', title), el('p', '', message)); if (action && onAction) { const button = el('button', 'button secondary', action); button.type = 'button'; button.addEventListener('click', onAction); wrap.append(button); } container.append(wrap); }
function toast(message, isError = false) { const item = el('div', `toast${isError ? ' error' : ''}`); item.append(icon(isError ? 'alert' : 'check'), el('span', '', message)); $('toast-container').append(item); setTimeout(() => item.remove(), 5200); }
function buttonBusy(id, busy, label) { const node = $(id); node.disabled = busy; if (!node.dataset.original) node.dataset.original = node.innerHTML; if (busy) { node.replaceChildren(el('span', 'spinner'), el('span', '', label || '请稍候…')); } else { node.innerHTML = node.dataset.original; } }
async function api(path, options = {}) { const headers = new Headers(options.headers || {}); const method = (options.method || 'GET').toUpperCase(); if (options.body !== undefined && !(options.body instanceof FormData)) { headers.set('Content-Type', 'application/json'); options.body = JSON.stringify(options.body); } if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && state.session?.csrfToken) headers.set('X-CSRF-Token', state.session.csrfToken); let response; try { response = await fetch(path, {...options, headers, credentials: 'same-origin', cache: 'no-store'}); } catch { throw new Error('无法连接本地服务，请确认服务正在运行。'); } let data; try { data = await response.json(); } catch { throw new Error('服务返回了无法读取的内容，请检查本地服务。'); } if (!response.ok) { if (response.status === 401 && state.session?.authenticated && !path.startsWith('/api/login') && path !== '/api/session') showLogin('登录已失效，请重新连接平台。'); const error = new Error(data.message || (typeof data.error === 'string' ? data.error : '') || `请求未完成（${response.status}）`); error.code = data.code; error.status = response.status; throw error; } return data; }
function currentResource() { return state.resources.find(item => String(item.id) === state.selectedId) || null; }
function setSelected(id, {load = true} = {}) { if(state.upload && String(id) !== state.selectedId){toast('文件正在上传，请完成后切换资源。',true);return;} const next = String(id || ''); const changed = next !== state.selectedId; state.selectedId = next; if (changed) { state.forceDiagnosticsId = ''; state.detail = null; state.detailError = ''; state.detailRequest++; } syncResourceSelectors(); renderResourceList(); renderDetail(); if (next && load && (changed || !state.detail)) loadDetail(next); }
function syncResourceSelectors() { ['workspace-resource', 'files-resource'].forEach(id => { const select = $(id); select.replaceChildren(); if (!state.resources.length) { const none = el('option', '', '暂无可用资源'); none.value = ''; select.append(none); } state.resources.forEach(item => { const option = el('option', '', item.name || item.id || '未命名资源'); option.value = String(item.id); select.append(option); }); select.disabled = !state.resources.length; select.value = state.selectedId; }); }
function showLogin(message = '') {
  state.session = null;
  state.messages = [];
  state.resources = [];
  state.selectedId = '';
  state.resourcesLoaded = false;
  state.resourcesLoading = false;
  state.resourcesError = '';
  state.quota = null;
  state.quotaUsed = null;
  state.aiConfig = null;
  state.detail = null;
  state.detailLoading = false;
  state.fileData = null;
  state.fileLoading = false;
  state.chatBusy = false;
  state.resourceRequest++;
  state.detailRequest++;
  state.fileRequest++;
  state.workspaceRequest++;
  state.chatRequest++;
  Object.values(state.startingResources).forEach(task => clearTimeout(task.timer));
  state.startingResources = Object.create(null);
  state.startErrors = Object.create(null);
  state.diagnostics = Object.create(null);
  state.diagnosticsRequest++;
  state.forceDiagnosticsId = '';
  if (state.upload) { state.upload.abort(); state.upload = null; }
  $('chat-submit').disabled = false;
  $('clear-chat').disabled = false;
  $('boot').classList.add('hidden');
  $('app-shell').classList.add('hidden');
  $('login-screen').classList.remove('hidden');
  $('password').value = '';
  $('ai-api-key').value = '';
  $('chat-input').value = '';
  $('resource-search').value = '';
  $('resources-updated').textContent = '尚未同步';
  showError('login-error', message);
  showError('chat-error', '');
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  void loadChallenge();
}
function renderWarnings(extra = []) {
  const warnings = [...new Set([...(Array.isArray(state.session?.warnings) ? state.session.warnings : []), ...(Array.isArray(extra) ? extra : [])]
    .map(warning => typeof warning === 'string' ? warning : warning?.message || '').filter(Boolean))];
  const container = $('session-warnings');
  clear(container);
  container.classList.toggle('hidden', !warnings.length);
  if (!warnings.length) return;
  const heading = el('div', 'warnings-heading');
  heading.append(icon('info'), el('strong', '', '平台信息提示'), el('span', 'warnings-count', `${warnings.length} 条`));
  container.append(heading);
  const preview = el('div', 'warnings-preview');
  warnings.slice(0, 2).forEach(warning => preview.append(el('p', '', warning)));
  container.append(preview);
  if (warnings.length > 2) {
    const details = el('details', 'warnings-details');
    const summary = el('summary');
    summary.append(el('span', '', `展开其余 ${warnings.length - 2} 条提示`), icon('chevron-right'));
    const list = el('div', 'warnings-detail-list');
    warnings.slice(2).forEach(warning => list.append(el('p', '', warning)));
    details.append(summary, list);
    details.addEventListener('toggle', () => { summary.firstChild.textContent = details.open ? '收起详细提示' : `展开其余 ${warnings.length - 2} 条提示`; });
    container.append(details);
  }
}

async function loadChallenge() {
  const request = ++state.challengeRequest;
  state.challenge = null;
  state.challengeLoading = true;
  $('captcha-code').value = '';
  $('captcha-image').classList.add('hidden');
  $('captcha-loading').classList.remove('hidden');
  $('captcha-loading').textContent = '正在加载…';
  $('refresh-captcha').disabled = true;
  $('login-submit').disabled = true;
  showError('captcha-error', '');
  try {
    const challenge = await api('/api/login/challenge');
    if (request !== state.challengeRequest) return;
    if (!challenge.challengeId || !challenge.captchaImage) throw new Error('平台没有返回有效的图形验证码。');
    const raw = String(challenge.captchaImage);
    const src = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i.test(raw) ? raw : /^[A-Za-z0-9+/=\s]+$/.test(raw) ? `data:image/png;base64,${raw.replace(/\s/g, '')}` : '';
    if (!src) throw new Error('平台验证码图片格式暂不支持，请刷新重试。');
    state.challenge = challenge;
    $('captcha-image').src = src;
    $('captcha-image').classList.remove('hidden');
    $('captcha-loading').classList.add('hidden');
    if (challenge.enableMfa || challenge.mfaEnabled) showError('captcha-error', '平台启用了二次验证；若账号需要短信或邮箱验证，登录后将显示平台提示。');
  } catch (error) {
    if (request !== state.challengeRequest) return;
    $('captcha-loading').textContent = '点击重试';
    showError('captcha-error', readableError(error));
  } finally {
    if (request === state.challengeRequest) {
      state.challengeLoading = false;
      $('refresh-captcha').disabled = false;
      $('login-submit').disabled = !state.challenge;
    }
  }
}
async function showApp(session) { state.session = session; $('boot').classList.add('hidden'); $('login-screen').classList.add('hidden'); $('app-shell').classList.remove('hidden'); $('sidebar-username').textContent = session.username || '工作台用户'; $('user-avatar').textContent = (session.username || 'U').slice(0, 1).toUpperCase(); renderWarnings(); setView(location.hash.slice(1), {load: false}); renderQuota(); renderChat(); await Promise.allSettled([loadResources(), loadAIConfig()]); if (state.session) loadCurrentView(); }
function setView(view, {load = true} = {}) { const names = {overview:'资源总览', workspace:'在线工作区', files:'数据与文件', assistant:'AI 编程助手'}; if (!names[view]) view = 'overview'; state.view = view; document.querySelectorAll('.view').forEach(node => node.classList.toggle('hidden', node.id !== `view-${view}`)); document.querySelectorAll('.nav-link').forEach(node => node.classList.toggle('active', node.dataset.view === view)); $('breadcrumb-current').textContent = names[view]; document.title = `${names[view]} · 算力工作台`; closeMenu(); if (load && state.session) loadCurrentView(); }
function openView(view) { if (location.hash === `#${view}`) setView(view); else location.hash = view; }
function loadCurrentView() { if (state.view === 'workspace') loadWorkspace(); if (state.view === 'files') loadFiles(); }
function closeMenu() { $('sidebar').classList.remove('open'); $('sidebar-scrim').classList.add('hidden'); $('menu-toggle').setAttribute('aria-expanded', 'false'); }

async function loadResources() {
  if (state.resourcesLoading) return;
  const request = ++state.resourceRequest;
  state.resourcesLoading = true;
  state.resourcesError = '';
  $('refresh-resources').disabled = true;
  if (!state.resourcesLoaded) loading($('resource-list'));
  try {
    const data = await api('/api/resources');
    if (!state.session?.authenticated || request !== state.resourceRequest) return;
    state.resources = Array.isArray(data.items) ? data.items.filter(item => item && item.id != null) : [];
    state.quota = data.quota || {};
    state.quotaUsed = data.quotaUsed || {};
    state.resourcesLoaded = true;
    renderWarnings(data.warnings);
    if (!state.resources.some(item => String(item.id) === state.selectedId)) state.selectedId = state.resources[0] ? String(state.resources[0].id) : '';
    state.detail = null;
    state.detailError = '';
    syncResourceSelectors();
    renderQuota();
    renderResourceList();
    renderDetail();
    $('resources-updated').textContent = `同步于 ${new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'})}`;
    if (state.selectedId) await loadDetail(state.selectedId);
  } catch (error) {
    if (request !== state.resourceRequest) return;
    state.resourcesError = readableError(error);
    renderResourceList();
    renderDetail();
  } finally {
    if (request === state.resourceRequest) {
      state.resourcesLoading = false;
      $('refresh-resources').disabled = false;
    }
  }
}
function quotaValue(value) { if (value === null || value === undefined) return '—'; if (typeof value === 'number' || typeof value === 'string') return String(value); if (typeof value === 'object') { const total = value.total ?? value.limit ?? value.quota; const used = value.used ?? value.allocated; if (used != null && total != null) return `${used} / ${total}`; if (total != null) return String(total); if (used != null) return String(used); } return '—'; }
function renderQuota() { const cards = [{key:'gpu',name:'GPU 算力配额',unit:'张',icon:'gpu',caption:'GPU ACCELERATION'}, {key:'cpu',name:'CPU 核心配额',unit:'核',icon:'cpu',caption:'COMPUTE CAPACITY'}, {key:'npu',name:'NPU 算力配额',unit:'张',icon:'layers',caption:'NEURAL PROCESSING'}, {key:'storageGb',name:'存储空间配额',unit:'GB',icon:'storage',caption:'DATA & STORAGE'}]; $('quota-cards').replaceChildren(...cards.map(card => { const node = el('div', 'quota-card'); const label = el('div', 'quota-card-label'); label.append(icon(card.icon), el('span', '', card.name)); const value = el('div', 'quota-value', quotaValue(state.quota?.[card.key])); value.append(el('small', '', card.unit)); const bottom = el('div', 'quota-bottom'); bottom.append(el('span', '', state.quota?.[card.key] == null ? '平台未提供配额' : state.quotaUsed?.[card.key] != null ? `已使用 ${quotaValue(state.quotaUsed[card.key])} ${card.unit}` : '项目已分配配额'), el('span', 'quota-accent')); const watermark = el('span', 'quota-watermark'); watermark.append(icon(card.icon)); node.append(label, value, bottom, watermark); return node; })); }
function statusInfo(value) {
  const raw = String(value || '未知');
  const lower = raw.toLowerCase();
  if (/error|fail|exception|异常|失败/.test(lower)) return {label:'异常',kind:'error'};
  if (/^(stopped|stop|shutdown|closed|inactive|terminated|deleted)$|已停止|已关闭|已结束/.test(lower)) return {label:'已停止',kind:'stopped'};
  if (/stopping|terminating|deleting/.test(lower)) return {label:'停止中',kind:'pending'};
  if (/imagebuild/.test(lower)) return {label:'镜像构建中',kind:'pending'};
  if (/starting|启动中/.test(lower)) return {label:'启动中',kind:'pending'};
  if (/pending|creating|preparing|initial|scheduling|waiting|等待|创建|准备|排队/.test(lower)) return {label:'准备中',kind:'pending'};
  if (/^(running|active|started|ready|available)$|运行中|已启用/.test(lower)) return {label:'运行中',kind:'running'};
  return {label:raw,kind:'unknown'};
}
function statusBadge(value) { const status = statusInfo(value); return el('span', `status-pill ${status.kind}`, status.label); }
function numberSpec(value, unit) { return value === null || value === undefined || value === '' ? '未提供' : `${value} ${unit}`; }
function isStoppedResource(item) {
  return /^(stopped|已停止)$/i.test(String(item?.status || '').trim());
}
function resourceBadge(item) {
  const task = state.startingResources[String(item.id)];
  if (task) return el('span', 'status-pill pending', task.busy ? '提交启动中' : '等待启动');
  return statusBadge(item.status);
}
function resourceAction(item, className, label = '进入工作区') {
  const id = String(item.id);
  const task = state.startingResources[id];
  const stopped = isStoppedResource(item) && !task;
  const kind = statusInfo(item.status).kind;
  const pending = !!task || kind === 'pending';
  const actionLabel = task?.busy ? '正在提交…' : stopped ? '启动资源' : pending ? '查看启动进度' : kind === 'running' ? label : '查看启动诊断';
  const button = el('button', className, actionLabel);
  button.type = 'button';
  button.disabled = !!task?.busy;
  button.append(icon(stopped ? 'play' : pending ? 'clock' : kind === 'running' ? 'arrow-up-right' : 'info'));
  button.addEventListener('click', () => {
    if (stopped) { void startResource(id); return; }
    setSelected(id);
    if (state.selectedId !== id) return;
    state.forceDiagnosticsId = kind === 'running' && !task ? '' : id;
    openView('workspace');
  });
  return button;
}
function openResourceDiagnostics(id) {
  id = String(id);
  setSelected(id);
  if (state.selectedId !== id) return;
  state.forceDiagnosticsId = id;
  openView('workspace');
}

function appendResourceControls(body, item) {
  if (item.canStop) {
    const button = el('button', 'button detail-file-button', '关闭资源');
    button.type = 'button';
    button.addEventListener('click', async () => {
      if (!window.confirm(`关闭 ${item.name || item.id}？实例上的运行任务会中断。`)) return;
      const session = state.session;
      button.disabled = true;
      try {
        const result = await api(`/api/resources/${encodeURIComponent(item.id)}/stop`, { method: 'POST', body: {} });
        if (state.session !== session) return;
        toast(result.message || '关闭请求已提交。');
        await refreshResourceStatus(item.id, session);
      } catch (error) {
        if (state.session === session) toast(readableError(error), true);
      } finally { button.disabled = false; }
    });
    body.append(button);
  }

  const billing = el('div', 'detail-section');
  const read = el('button', 'button detail-file-button', '查看本月用量和费用');
  const result = el('div', 'detail-image');
  read.type = 'button';
  read.addEventListener('click', async () => {
    read.disabled = true;
    result.textContent = '正在读取平台账单…';
    try {
      const data = await api(`/api/resources/${encodeURIComponent(item.id)}/billing`);
      const money = value => Number.isFinite(value) ? `${value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })} 元` : '未提供';
      result.replaceChildren(el('div', '', [data.month, data.message].filter(Boolean).join(' · ')));
      for (const row of data.rows || []) {
        const usage = Number.isFinite(row.usage) ? `${row.usage} ${row.usageUnit || ''}`.trim() : '未提供';
        result.append(el('div', '', `${row.chargingItemName || row.chargingItem || '计费项'} · 用量 ${usage} · 实付 ${money(row.payAmount)} · 金额 ${money(row.amount)}`));
      }
    } catch (error) { result.textContent = readableError(error); }
    finally { read.disabled = false; }
  });
  billing.append(read, result);
  body.append(billing);
}

function updateResourceFromServer(item) {
  if (!item || item.id == null) return;
  const id = String(item.id);
  const index = state.resources.findIndex(resource => String(resource.id) === id);
  if (index >= 0) state.resources[index] = {...state.resources[index], ...item};
  if (id === state.selectedId) { state.detail = {...state.detail, ...item}; state.detailError = ''; }
}
async function refreshResourceStatus(id, session = state.session) {
  const data = await api(`/api/resources/${encodeURIComponent(id)}`);
  if (state.session !== session) return null;
  const item = data.item || data.resource || data;
  updateResourceFromServer(item);
  renderResourceList();
  if (id === state.selectedId) renderDetail();
  return item;
}
async function pollResourceStart(id, session, attempt = 0) {
  const task = state.startingResources[id];
  if (!task || state.session !== session) return;
  try {
    const item = await refreshResourceStatus(id, session);
    if (!item || state.session !== session || state.startingResources[id] !== task) return;
    const kind = statusInfo(item.status).kind;
    if (kind === 'running' || kind === 'error') {
      delete state.startingResources[id];
      renderResourceList();
      if (id === state.selectedId) {
        renderDetail();
        if (state.view === 'workspace') void loadWorkspace();
      }
      toast(kind === 'running' ? '资源已就绪，可以进入工作区' : '平台返回了异常状态，请查看资源详情。', kind === 'error');
      return;
    }
  } catch (error) {
    if (state.session !== session || state.startingResources[id] !== task) return;
    task.pollError = readableError(error);
  }
  if (attempt >= 35) {
    delete state.startingResources[id];
    renderResourceList();
    if (id === state.selectedId) {
      renderDetail();
      if (state.view === 'workspace') void loadWorkspace();
    }
    toast('启动请求已提交，平台尚未确认就绪，请稍后刷新状态。');
    return;
  }
  task.timer = setTimeout(() => { void pollResourceStart(id, session, attempt + 1); }, 5000);
}
async function startResource(id) {
  id = String(id);
  const item = state.resources.find(resource => String(resource.id) === id) || (String(state.detail?.id) === id ? state.detail : null);
  if (!isStoppedResource(item) || state.startingResources[id]) return;
  const session = state.session;
  const task = {busy:true, timer:null};
  state.startingResources[id] = task;
  delete state.startErrors[id];
  if (id === state.selectedId) { state.detailRequest++; state.detailLoading = false; }
  renderResourceList();
  if (id === state.selectedId) {
    renderDetail();
    if (state.view === 'workspace') renderStoppedWorkspace();
  }
  try {
    const result = await api(`/api/resources/${encodeURIComponent(id)}/start`, {method:'POST',body:{}});
    if (state.session !== session || state.startingResources[id] !== task) return;
    if (result.accepted === false || result.ok === false) throw new Error(result.message || '平台未接受启动请求，请稍后重试。');
    task.busy = false;
    task.message = result.message || '启动请求已提交，正在等待平台更新运行状态。';
    if (result.item || result.resource) updateResourceFromServer(result.item || result.resource);
    renderResourceList();
    if (id === state.selectedId) {
      renderDetail();
      if (state.view === 'workspace') renderStoppedWorkspace();
    }
    toast(task.message);
    void pollResourceStart(id, session);
  } catch (error) {
    if (state.session !== session || state.startingResources[id] !== task) return;
    delete state.startingResources[id];
    state.startErrors[id] = readableError(error);
    renderResourceList();
    if (id === state.selectedId) {
      renderDetail();
      if (state.view === 'workspace') renderStoppedWorkspace();
    }
    toast(readableError(error), true);
  }
}
function renderResourceList() { $('resource-count').textContent = state.resourcesLoaded ? state.resources.length : '—'; const container = $('resource-list'); container.classList.toggle('compact', state.compact); if (state.resourcesError) { empty(container, {symbol:'alert', title:'资源暂时未能同步', message:state.resourcesError, action:'重新读取', onAction:loadResources}); return; } if (!state.resourcesLoaded && state.resourcesLoading) { loading(container); return; } if (!state.resources.length) { empty(container, {symbol:'server', title:'还没有可显示的算力资源', message:'工作台会显示原平台分配给当前账户的资源。资源就绪后，点击刷新即可同步。', action:'刷新资源', onAction:loadResources}); return; } const term = $('resource-search').value.trim().toLocaleLowerCase(); const filtered = state.resources.filter(item => [item.name,item.id,item.gpuModel,item.acceleratorModel,item.image].some(value => String(value || '').toLocaleLowerCase().includes(term))); if (!filtered.length) { empty(container, {symbol:'search', title:'没有找到匹配的资源', message:'试试资源名称、编号或 GPU 型号。'}); return; } container.replaceChildren(...filtered.map(item => { const row = el('div', `resource-row${String(item.id) === state.selectedId ? ' selected' : ''}`); const img = el('span', 'resource-avatar'); img.append(icon('server')); const main = el('div', 'resource-row-main'); const line = el('div', 'resource-name-line'); const name = el('button', 'resource-name', item.name || item.id || '未命名资源'); name.type='button'; name.title = `${item.name || item.id} · 查看详情`; name.addEventListener('click', () => setSelected(item.id)); line.append(name, resourceBadge(item)); const specs = el('div', 'resource-specs'); if (item.acceleratorModel || item.gpuModel || item.gpuCount != null) { const model = item.acceleratorModel || item.gpuModel; const count = item.acceleratorCount ?? item.gpuCount; specs.append(el('span', '', model ? `${model}${count != null ? ` × ${count}` : ''}` : numberSpec(item.gpuCount, 'GPU'))); } specs.append(el('span', '', numberSpec(item.cpu, 'vCPU')), el('span', '', numberSpec(item.memoryGb, 'GB 内存'))); main.append(line,specs); const actions = el('div','resource-row-action'); const enter = resourceAction(item,'resource-enter'); const detail = el('button','icon-button'); detail.type='button'; detail.setAttribute('aria-label', `查看 ${item.name || item.id} 的详情`); detail.append(icon('chevron-right')); detail.addEventListener('click',()=>setSelected(item.id)); actions.append(enter,detail); row.append(img,main,actions); return row; })); }
async function loadDetail(id) { const request = ++state.detailRequest; state.detailLoading = true; renderDetail(); try { const data = await api(`/api/resources/${encodeURIComponent(id)}`); if (request !== state.detailRequest || !state.session) return; state.detail = data.item || data; state.detailError = ''; } catch (error) { if (request !== state.detailRequest) return; state.detailError = readableError(error); } finally { if (request === state.detailRequest) { state.detailLoading = false; renderDetail(); } } }
function detailRow(label, value, strong = false) { const row=el('div','detail-row'); const dd=el('dd'); dd.append(el(strong?'strong':'span','',value == null || value === '' ? '未提供' : value)); row.append(el('dt','',label),dd); return row; }
function renderDetail() { const container=$('resource-detail-content'); document.querySelector('.resource-details').classList.toggle('has-selection',!!state.selectedId); if(!state.selectedId){empty(container,{symbol:'sliders',title:'了解你的计算环境',message:state.resourcesError ? '连接恢复后，资源配置将显示在这里。' : '选择一个资源，查看硬件配置、运行环境与挂载目录。'});return;} if(state.detailLoading){loading(container,'正在读取配置…');return;} const item=state.detail || currentResource(); if(!item)return; clear(container); const body=el('div','detail-body'); if(state.detailError)body.append(el('div','error-inline',state.detailError)); const header=el('div','detail-header');const img=el('span','resource-avatar');img.append(icon('server'));const copy=el('div');copy.append(el('h3','',item.name||item.id),resourceBadge(item));header.append(img,copy);body.append(header);const dl=el('dl');dl.append(detailRow(item.acceleratorType==='NPU'?'NPU 型号':'GPU 型号',item.acceleratorModel||item.gpuModel,true),detailRow(item.acceleratorType==='NPU'?'NPU 数量':'GPU 数量',numberSpec(item.acceleratorCount??item.gpuCount,'张')),detailRow('CPU 核心',numberSpec(item.cpu,'vCPU')),detailRow('运行内存',numberSpec(item.memoryGb,'GB')),detailRow('资源编号',item.id));if(item.createdAt)dl.append(detailRow('创建时间',formatDate(item.createdAt)));body.append(dl);const image=el('div','detail-section');image.append(el('span','detail-section-label','运行环境 / IMAGE'),el('div','detail-image',item.image||'平台未提供镜像信息'));body.append(image); const mounts=el('div','detail-section');mounts.append(el('span','detail-section-label','挂载目录 / STORAGE')); if(Array.isArray(item.mounts)&&item.mounts.length){item.mounts.forEach(mount=>{const card=el('div','detail-mount');const mcopy=el('div');mcopy.append(el('strong','',mount.path||'未提供路径'));if(mount.type||mount.source)mcopy.append(el('small','',[mount.type,mount.source].filter(Boolean).join(' · ')));card.append(icon('folder'),mcopy);mounts.append(card);});}else mounts.append(el('div','detail-image',state.detailError?'详情连接恢复后可查看挂载目录':'平台未提供挂载目录'));body.append(mounts);if(state.startErrors[String(item.id)])body.append(el('div','form-error',state.startErrors[String(item.id)]));const startTask=state.startingResources[String(item.id)];if(startTask)body.append(el('div','start-pending-note',startTask.busy?'正在向平台提交启动请求…':startTask.message||'启动请求已提交，正在等待平台更新运行状态。'));const workspace=resourceAction(item,'button primary detail-workspace-button','进入在线工作区');const files=el('button','button detail-file-button');files.type='button';files.append(icon('folder'),el('span','','查看资源文件'));files.addEventListener('click',()=>openView('files'));body.append(workspace,files);appendResourceControls(body,item);if(statusInfo(item.status).kind!=='running'){const diagnostics=el('button','button detail-diagnostics-button');diagnostics.type='button';diagnostics.append(icon('info'),el('span','','查看启动诊断'));diagnostics.addEventListener('click',()=>openResourceDiagnostics(item.id));body.append(diagnostics);}if(item.autoStopAt){const stop=el('div','auto-stop');const text=el('span');text.dataset.stopTime=String(item.autoStopAt);stop.append(icon('clock'),text);body.append(stop);}container.append(body);updateCountdowns(); }
function parseDate(value) { if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) { const n = Number(value); return new Date(n < 1e12 ? n * 1000 : n); } return new Date(value); }
function formatDate(value) { const date=parseDate(value);return Number.isNaN(date.getTime())?String(value):date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}); }
function updateCountdowns(){document.querySelectorAll('[data-stop-time]').forEach(node=>{const date=parseDate(node.dataset.stopTime);const remaining=date.getTime()-Date.now();if(Number.isNaN(remaining)){node.textContent=`自动停止时间：${node.dataset.stopTime}`;return;}if(remaining<=0){node.textContent=`已到计划停止时间 ${formatDate(node.dataset.stopTime)}`;return;}const mins=Math.ceil(remaining/60000);const days=Math.floor(mins/1440);const hours=Math.floor(mins%1440/60);const minutes=mins%60;node.textContent=`${days?`${days} 天 `:''}${hours?`${hours} 小时 `:''}${minutes} 分钟后自动停止 · ${formatDate(node.dataset.stopTime)}`;});}

function safeWorkspaceUrl(raw){if(!raw)return null;try{const url=new URL(raw,location.origin);return ['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;}}
function openVSCodeGuide(id) {
  const item = state.resources.find(resource=>String(resource.id)===String(id)) || currentResource();
  $('vscode-guide-resource').textContent = `${item?.name || '当前资源'}：本机扩展、远端隧道授权与实际连接尚待确认。`;
  $('vscode-guide-dialog').showModal();
}
async function loadEmbeddedWorkspace(id, container, details, workspaceRequest) {
  const session = state.session;
  const previewRequest = String((Number(container.dataset.requestId)||0)+1);
  container.dataset.requestId = previewRequest;
  loading(container,'正在建立预览连接…');
  try {
    const data = await api(`/api/resources/${encodeURIComponent(id)}/workspace`);
    if(state.session !== session || state.workspaceRequest !== workspaceRequest || container.dataset.requestId !== previewRequest || !details.open) return;
    const url = safeWorkspaceUrl(data.proxyUrl || data.url);
    if(!data.supported || !url){empty(container,{symbol:'terminal',title:'预览入口尚未就绪',message:data.reason||'请稍后重试，或查看启动诊断。',action:'查看启动诊断',onAction:()=>openResourceDiagnostics(id)});return;}
    clear(container);
    const frame = document.createElement('iframe');
    frame.className = 'workspace-iframe workspace-optional-iframe';
    frame.title = `${currentResource()?.name || id} 可选工作区预览`;
    frame.referrerPolicy = 'no-referrer';
    frame.allow = 'clipboard-read; clipboard-write; fullscreen';
    frame.src = url;
    const note = el('div','workspace-embed-note');
    note.append(icon('info'),el('span','',data.requiresBrowserSession?'此入口需要原平台浏览器登录状态。若预览无法使用，请在独立标签页打开并完成平台登录。':'预览受浏览器嵌入策略和显示空间限制。完整开发请使用上方的全屏入口。'));
    container.append(frame,note);
  } catch(error) {
    if(state.session !== session || state.workspaceRequest !== workspaceRequest || container.dataset.requestId !== previewRequest || !details.open)return;
    empty(container,{symbol:'alert',title:'预览暂时无法连接',message:readableError(error),action:'重试预览',onAction:()=>loadEmbeddedWorkspace(id,container,details,workspaceRequest)});
  }
}
function renderWorkspaceLauncher(id) {
  const container = $('workspace-content');
  const item = state.detail || currentResource() || {id};
  const request = state.workspaceRequest;
  clear(container);
  const root = el('div','workspace-launcher');
  const heading = el('div','launcher-heading');
  const title = el('div');
  title.append(el('span','eyebrow','CHOOSE YOUR WORKSPACE'),el('h2','','让编辑器，适应你的工作方式。'),el('p','','优先使用熟悉的本机编辑器，也可以直接打开独立的网页开发环境。'));
  const resource = el('div','launcher-resource');
  resource.append(icon('server'),el('span','',item.name||id),statusBadge(item.status));
  heading.append(title,resource);
  root.append(heading);
  const cards = el('div','connection-cards');
  const local = el('section','connection-card local-connection-card');
  const localTop = el('div','connection-card-top');
  const localIcon = el('span','connection-card-icon');localIcon.append(icon('terminal'));
  localTop.append(localIcon,el('span','connection-recommended','优先使用'));
  const localTitle = el('div','connection-card-title');localTitle.append(el('h3','','本机 VS Code'),el('span','connection-setup-badge','连接待确认'));
  local.append(localTop,localTitle,el('p','connection-description','在本机编辑与调试，让代码、终端和计算运行在远端资源上。'));
  const localFeatures = el('div','connection-features');['完整编辑空间','远端终端','本机扩展体验'].forEach(text=>{const feature=el('span');feature.append(icon('check'),el('span','',text));localFeatures.append(feature);});
  local.append(localFeatures);
  const localSetup = el('div','local-setup-summary');localSetup.append(icon('info'),el('span','','首次连接需安装 Remote - Tunnels，并完成远端隧道授权。'));
  local.append(localSetup);
  const guide = el('button','button primary connection-main-action','查看本机连接步骤');guide.type='button';guide.append(icon('arrow-right'));guide.addEventListener('click',()=>openVSCodeGuide(id));
  local.append(guide,el('p','connection-footnote','计划隧道 wuhan-a800 · 当前页面尚未验证本机连接'));
  const web = el('section','connection-card web-connection-card');
  const webTop = el('div','connection-card-top');const webIcon=el('span','connection-card-icon violet');webIcon.append(icon('sparkles'));webTop.append(webIcon,el('span','connection-mode-label','独立网页工作区'));
  const webTitle=el('div','connection-card-title');webTitle.append(el('h3','','全屏 AI IDE'),el('span','connection-setup-badge web-setup','IDE 内配置'));
  web.append(webTop,webTitle,el('p','connection-description','用一个独立标签页展开完整开发空间，编辑文件、运行终端，并在 IDE 中使用 AI 助手。'));
  const webFeatures=el('div','connection-features');['独立标签页','远端文件与终端','IDE 内的 AI 配置'].forEach(text=>{const feature=el('span');feature.append(icon('check'),el('span','',text));webFeatures.append(feature);});web.append(webFeatures);
  const aiNote=el('div','web-ai-setup-summary');aiNote.append(icon('sparkles'),el('span','','AI 功能通过 IDE 内的 Continue 扩展配置。首次使用需在扩展中设置模型和密钥。'));web.append(aiNote);
  const open=el('button','button secondary connection-main-action','打开全屏 AI IDE');open.type='button';open.append(icon('external'));open.addEventListener('click',()=>openWorkspaceInNewTab(id));
  web.append(open,el('p','connection-footnote','每次打开都会重新获取工作区入口'));
  cards.append(local,web);root.append(cards);
  const preview=el('details','workspace-preview');
  const summary=el('summary');const previewCopy=el('div');previewCopy.append(el('strong','','页面内预览'),el('span','','可选 · 展开后再建立连接'));summary.append(icon('layout'),previewCopy,icon('chevron-right'));
  const previewBody=el('div','workspace-preview-body');
  preview.append(summary,previewBody);
  preview.addEventListener('toggle',()=>{if(preview.open)void loadEmbeddedWorkspace(id,previewBody,preview,request);else{previewBody.dataset.requestId=String((Number(previewBody.dataset.requestId)||0)+1);clear(previewBody);}});
  root.append(preview);
  const footer=el('div','launcher-footer');
  const diagnostic=el('button','text-button','查看资源诊断');diagnostic.type='button';diagnostic.append(icon('arrow-right'));diagnostic.addEventListener('click',()=>openResourceDiagnostics(id));
  footer.append(el('span','','算力状态与编辑器连接状态分别显示。完成连接后，请以编辑器中的实际结果为准。'),diagnostic);root.append(footer);
  container.append(root);
}
async function openWorkspaceInNewTab(id) {
  const popup = window.open('about:blank', '_blank');
  if (!popup) { toast('浏览器阻止了新窗口，请允许此站点打开弹出式窗口。', true); return; }
  popup.opener = null;
  try {
    popup.document.title = '正在连接在线工作区…';
    popup.document.body.textContent = '正在为你建立工作区连接…';
    const data = await api(`/api/resources/${encodeURIComponent(id)}/workspace`);
    const target = safeWorkspaceUrl(data.proxyUrl || data.url);
    if (!data.supported || !target) throw new Error(data.reason || '此资源暂未提供可用的工作区入口。');
    popup.location.replace(target);
  } catch (error) {
    popup.close();
    toast(readableError(error), true);
  }
}
function diagnosticEventLevel(value) {
  const level = String(value || '').toLowerCase();
  return /error|fail|fatal|异常|失败/.test(level) ? 'error' : /warn|警告/.test(level) ? 'warning' : /success|normal|成功/.test(level) ? 'normal' : 'info';
}
function diagnosticText(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function isUnboundStorageMessage(value) {
  return /unbound\s+(?:immediate\s+)?persistent\s*volume\s*claims?|persistent\s*volume\s*claims?\s+(?:is\s+|are\s+)?(?:not\s+bound|unbound)/i.test(diagnosticText(value));
}
function isStorageBindingTimeoutMessage(value) {
  const text = diagnosticText(value);
  return /VolumeBinding|binding\s*volumes/i.test(text) && /context\s+deadline\s+exceeded/i.test(text);
}
function storageMessageFamily(value) {
  return isStorageBindingTimeoutMessage(value) ? 'timeout' : isUnboundStorageMessage(value) ? 'unbound' : '';
}
function storageDiagnosis(data, status) {
  if (statusInfo(status).kind === 'running' || isStoppedResource({status})) return null;
  const currentReason = diagnosticText(data.reason || data.errorMessage).trim();
  const currentFamily = storageMessageFamily(currentReason);
  if (currentReason && !currentFamily) return null;
  const candidates = [data.reason, data.errorMessage, ...(Array.isArray(data.reasons) ? data.reasons : []), ...(Array.isArray(data.events) ? data.events.map(event => event?.message || event?.reason) : [])].map(diagnosticText);
  const family = currentFamily || candidates.map(storageMessageFamily).find(Boolean);
  if (!family) return null;
  const originals = [...new Set(candidates.filter(message => storageMessageFamily(message) === family))];
  return {
    family,
    title:family === 'timeout' ? '存储绑定超时' : '等待存储就绪',
    reason:family === 'timeout' ? '平台绑定存储卷时超时，开发环境尚未启动。' : '平台尚未完成存储卷绑定，开发环境暂时无法启动。',
    guidance:'可刷新进度查看变化；如果持续等待，请联系平台管理员检查存储卷绑定状态。',
    originals,
  };
}
function originalDiagnosticDetails(messages, label = '查看平台原始信息') {
  const details = el('details','diagnostics-original');
  const summary = el('summary');
  summary.append(el('span','',label),icon('chevron-right'));
  const content = el('div','diagnostics-original-content');
  messages.forEach(message=>content.append(el('p','',message)));
  details.append(summary,content);
  return details;
}
async function loadResourceDiagnostics(id, {reason = ''} = {}) {
  const session = state.session;
  const request = ++state.diagnosticsRequest;
  const cached = state.diagnostics[id]?.data || null;
  state.diagnostics[id] = {data:cached,loading:true,error:'',reason};
  renderResourceDiagnostics(id);
  try {
    const data = await api(`/api/resources/${encodeURIComponent(id)}/diagnostics`);
    if (state.session !== session || request !== state.diagnosticsRequest || state.selectedId !== id) return;
    state.diagnostics[id] = {data,loading:false,error:'',reason,updatedAt:Date.now()};
    if (data.status) {
      if(statusInfo(data.status).kind === 'running'){const task=state.startingResources[id];if(task)clearTimeout(task.timer);delete state.startingResources[id];delete state.startErrors[id];}
      updateResourceFromServer({id,status:data.status});
      renderResourceList();
      renderDetail();
    }
  } catch (error) {
    if (state.session !== session || request !== state.diagnosticsRequest || state.selectedId !== id) return;
    state.diagnostics[id] = {data:cached,loading:false,error:readableError(error),reason};
  }
  if (state.session === session && request === state.diagnosticsRequest && state.selectedId === id) renderResourceDiagnostics(id);
}
function renderResourceDiagnostics(id) {
  const container = $('workspace-content');
  const item = state.detail || currentResource() || {id};
  const entry = state.diagnostics[id] || {};
  const data = entry.data || {};
  const status = data.status || item.status;
  const kind = statusInfo(status).kind;
  const storage = storageDiagnosis(data,status);
  clear(container);
  const root = el('div','resource-diagnostics');
  const header = el('div','diagnostics-header');
  const symbol = el('div',`diagnostics-symbol ${kind === 'error' ? 'error' : ''}`);
  symbol.append(icon(kind === 'running' ? 'check' : kind === 'error' ? 'alert' : 'clock'));
  const copy = el('div','diagnostics-header-copy');
  copy.append(el('span','eyebrow','RESOURCE STARTUP DIAGNOSTICS'));
  const title = entry.error && !entry.data ? '启动诊断暂时无法读取' : storage ? storage.title : kind === 'running' ? '资源已运行' : isStoppedResource({status}) ? '资源已停止' : kind === 'error' ? '资源启动遇到异常' : '工作区尚未就绪';
  copy.append(el('h2','',title));
  const statusLine = el('div','diagnostics-status');
  statusLine.append(statusBadge(status), el('span','',`${item.name || id} · 平台状态：${status || '未提供'}`));
  copy.append(statusLine);
  const reason = kind === 'running' ? '平台已显示运行状态，可以打开在线工作区。' : storage?.reason || diagnosticText(data.reason) || entry.reason || '资源尚未进入可用的运行状态。请查看平台最近事件，了解启动进度或阻塞原因。';
  copy.append(el('p','diagnostics-reason',reason));
  if(storage){copy.append(el('p','diagnostics-guidance',storage.guidance),originalDiagnosticDetails(storage.originals.slice(0,3)));}
  header.append(symbol,copy);
  root.append(header);
  if (entry.error) root.append(el('div','form-error diagnostics-error',entry.error));
  const actions = el('div','diagnostics-actions');
  if (kind === 'running' || (isStoppedResource({status}) && !state.startingResources[id])) actions.append(resourceAction({...item,status},'button primary'));
  const refresh = el('button',`button ${kind === 'running' || isStoppedResource({status}) ? 'secondary' : 'primary'}`,entry.loading ? '正在读取…' : '刷新启动进度');
  refresh.type = 'button';
  refresh.disabled = !!entry.loading;
  refresh.append(icon('refresh'));
  refresh.addEventListener('click',()=>{void loadResourceDiagnostics(id,{reason:entry.reason||''});});
  actions.append(refresh);
  if (entry.updatedAt) actions.append(el('span','diagnostics-updated',`更新于 ${new Date(entry.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}`));
  root.append(actions);
  const events = (Array.isArray(data.events) ? data.events : []).filter(event => event && (event.message || event.action || event.reason)).map(event=>({...event,message:diagnosticText(event.message || event.reason || event.action)}));
  events.sort((a,b)=>(parseDate(b.timestamp).getTime()||0)-(parseDate(a.timestamp).getTime()||0));
  const section = el('section','diagnostics-events');
  const sectionHeading = el('div','diagnostics-section-heading');
  sectionHeading.append(el('h3','',kind === 'running' ? '平台事件历史' : '平台最近事件'),el('span','',events.length > 20 ? `显示最近 20 / ${events.length} 条` : `${events.length} 条记录`));
  section.append(sectionHeading);
  if (entry.loading && !entry.data) loading(section,'正在读取平台启动事件…');
  else if (!events.length) {
    const blank = el('div','diagnostics-empty');
    blank.append(icon('info'),el('p','',entry.error?'诊断读取失败，请点击「刷新启动进度」重试。':'平台暂未返回事件记录，当前无法从事件中判断具体原因。可稍后刷新启动进度。'));
    section.append(blank);
  } else {
    const list = el('ol','diagnostics-event-list');
    events.slice(0,20).forEach(event=>{
      const row = el('li',`diagnostics-event ${diagnosticEventLevel(event.level)}`);
      const indicator = el('span','event-indicator');
      indicator.append(icon(diagnosticEventLevel(event.level)==='error'?'alert':diagnosticEventLevel(event.level)==='warning'?'alert':'info'));
      const content = el('div','event-content');
      const meta = el('div','event-meta');
      if (event.action) meta.append(el('strong','',diagnosticText(event.action)));
      if (event.level) meta.append(el('span','event-level',diagnosticText(event.level)));
      if (event.timestamp) meta.append(el('time','event-time',formatDate(event.timestamp)));
      const storageEventFamily = storage ? storageMessageFamily(event.message) : '';
      const eventExplanation = storageEventFamily === 'timeout' ? '平台绑定存储卷时超时，开发环境尚未启动。' : storageEventFamily === 'unbound' ? '存储卷尚未绑定，平台暂时无法安排开发环境运行。' : event.message;
      content.append(meta,el('p','event-message',eventExplanation));
      if(storageEventFamily)content.append(originalDiagnosticDetails([event.message],'查看原始事件'));
      if (event.source) content.append(el('span','event-source',`来源：${diagnosticText(event.source)}`));
      row.append(indicator,content);
      list.append(row);
    });
    section.append(list);
  }
  root.append(section);
  const warnings = Array.isArray(data.warnings) ? data.warnings.map(diagnosticText).filter(Boolean) : [];
  if (warnings.length) {
    const notices = el('div','diagnostics-notices');
    warnings.slice(0,4).forEach(warning=>notices.append(el('p','',warning)));
    root.append(notices);
  }
  container.append(root);
}
function renderStoppedWorkspace() {
  const item = state.detail || currentResource();
  const container = $('workspace-content');
  if (!item) return;
  const id = String(item.id);
  const task = state.startingResources[id];
  const error = state.startErrors[id];
  const message = task ? task.busy ? '正在向平台提交请求，请稍候。' : task.message || '启动请求已提交，正在等待平台更新运行状态。'
    : error || '该资源当前已停止。启动后，平台会分配算力并准备在线开发环境。';
  empty(container, {symbol:task?'clock':'server',title:task?(task.busy?'正在提交启动请求':'等待资源启动'):'资源已停止',message});
  const wrap = container.querySelector('.empty-state');
  const actions = el('div','workspace-stopped-actions');
  actions.append(resourceAction(item,'button primary'));
  const refresh = el('button','button secondary','刷新状态');
  refresh.type = 'button';
  refresh.append(icon('refresh'));
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    try { await refreshResourceStatus(id); if (id === state.selectedId) await loadWorkspace(); }
    catch (error) { toast(readableError(error),true); }
    finally { refresh.disabled = false; }
  });
  actions.append(refresh);
  wrap.append(actions);
  const diagnostics = el('button','text-button stopped-diagnostics-button','查看启动诊断');
  diagnostics.type = 'button';
  diagnostics.append(icon('arrow-right'));
  diagnostics.addEventListener('click', () => openResourceDiagnostics(id));
  wrap.append(diagnostics);
}
async function loadWorkspace() {
  const container = $('workspace-content');
  const id = state.selectedId;
  const request = ++state.workspaceRequest;
  state.workspaceResourceId = id;
  if (!id) { empty(container, {symbol:'terminal',title:'先选择一个算力资源',message:'原平台的资源同步后，即可在这里连接在线开发环境。',action:'前往资源总览',onAction:()=>openView('overview')}); return; }
  const selected = state.detail || currentResource();
  if (state.forceDiagnosticsId === id || state.startingResources[id] || ['pending','error'].includes(statusInfo(selected?.status).kind)) { await loadResourceDiagnostics(id); return; }
  if (isStoppedResource(selected)) { renderStoppedWorkspace(); return; }
  if(statusInfo(selected?.status).kind === 'running'){renderWorkspaceLauncher(id);return;}
  loading(container, '正在获取工作区入口…');
  try {
    const data = await api(`/api/resources/${encodeURIComponent(id)}/workspace`);
    if (request !== state.workspaceRequest || !state.session) return;
    const url = safeWorkspaceUrl(data.proxyUrl || data.url);
    if (!data.supported || !url) { await loadResourceDiagnostics(id, {reason:data.reason||'原平台未返回可用的开发环境入口。'}); return; }
    renderWorkspaceLauncher(id);
  } catch (error) {
    if (request !== state.workspaceRequest) return;
    empty(container, {symbol:'alert',title:'工作区暂时无法连接',message:readableError(error),action:'重新连接',onAction:loadWorkspace});
  }
}

function normalizePath(path){const parts=String(path||'/').replace(/\\/g,'/').split('/');const stack=[];parts.forEach(part=>{if(!part||part==='.')return;if(part==='..')stack.pop();else stack.push(part);});return '/'+stack.join('/');}
function joinPath(path,name){return normalizePath(`${path}/${name}`);}
function renderBreadcrumbs(){const container=$('file-breadcrumbs');clear(container);const root=el('button','','根目录');root.type='button';root.addEventListener('click',()=>navigateFiles('/'));container.append(root);const segments=state.filePath.split('/').filter(Boolean);let path='';segments.forEach(segment=>{path+='/'+segment;const target=path;const crumb=el('button','',segment);crumb.type='button';crumb.addEventListener('click',()=>navigateFiles(target));container.append(el('span','','/'),crumb);});$('file-path-input').value=state.filePath;$('drop-path').textContent=state.filePath;}
function navigateFiles(path){if(state.upload){toast('文件正在上传，请完成后切换目录。',true);return;}state.filePath=normalizePath(path);loadFiles();}
function canUseFiles(){return !!state.selectedId&&!state.fileLoading&&state.fileData?.available===true&&state.fileData?.readOnly!==true&&state.filePath!=='/'&&!state.upload;}
function updateFileActions(){const enabled=canUseFiles();$('upload-button').disabled=!enabled;$('new-folder').disabled=!enabled;$('refresh-files').disabled=!state.selectedId||state.fileLoading||!!state.upload;$('file-path-input').disabled=!state.selectedId||!!state.upload;}
async function loadFiles(){const id=state.selectedId;const request=++state.fileRequest;if(state.upload)return;if(state.fileResourceId!==id){state.filePath='/mnt/data';state.fileResourceId=id;}state.fileData=null;state.fileError='';renderBreadcrumbs();if(!id){empty($('files-content'),{symbol:'folder',title:'为数据选择一个落脚点',message:'连接一个资源后，即可浏览目录、上传数据并下载结果。',action:'前往资源总览',onAction:()=>openView('overview')});$('file-summary').textContent='尚未选择资源';updateFileActions();return;}state.fileLoading=true;updateFileActions();loading($('files-content'),'正在读取目录…');try{const params=new URLSearchParams({resourceId:id,path:state.filePath});const data=await api(`/api/files?${params}`);if(request!==state.fileRequest||!state.session)return;state.fileData=data;state.filePath=normalizePath(data.path||state.filePath);renderBreadcrumbs();renderFiles();}catch(error){if(request!==state.fileRequest)return;state.fileError=readableError(error);renderFiles();}finally{if(request===state.fileRequest){state.fileLoading=false;updateFileActions();}}}
function formatBytes(size){if(size===null||size===undefined||size==='')return '—';const n=Number(size);if(!Number.isFinite(n))return '—';if(n===0)return '0 B';const units=['B','KB','MB','GB','TB'];const index=Math.min(Math.floor(Math.log(Math.abs(n))/Math.log(1024)),4);return `${(n/1024**index).toLocaleString('en-US',{maximumFractionDigits:index?1:0})} ${units[index]}`;}
function renderFiles(){const container=$('files-content');if(state.fileError){empty(container,{symbol:'alert',title:'目录暂时无法读取',message:state.fileError,action:'重新读取',onAction:loadFiles});$('file-summary').textContent='读取失败';return;}if(!state.fileData?.available){empty(container,{symbol:'folder',title:'此资源暂未接通文件管理',message:state.fileData?.reason||'原平台未提供可用的文件接口。请通过在线工作区管理此资源的数据。',action:'打开在线工作区',onAction:()=>openView('workspace')});$('file-summary').textContent='文件接口不可用';return;}const items=Array.isArray(state.fileData.items)?[...state.fileData.items]:[];items.sort((a,b)=>(a.type==='directory'?0:1)-(b.type==='directory'?0:1)||String(a.name).localeCompare(String(b.name),'zh-CN',{numeric:true}));const dirs=items.filter(item=>item.type==='directory').length;$('file-summary').textContent=`${dirs} 个文件夹 · ${items.length-dirs} 个文件`;if(!items.length){empty(container,{symbol:'upload',title:'这个目录，留给新的发现',message:'拖放文件到这里，或点击「上传文件」准备你的实验数据。',action:'选择文件',onAction:()=>$('upload-input').click()});return;}clear(container);const table=el('table','file-table');const thead=el('thead');const hr=el('tr');['名称','大小','类型','修改时间','操作'].forEach(title=>hr.append(el('th','',title)));thead.append(hr);const tbody=el('tbody');items.forEach(item=>{const row=el('tr');const nameCell=el('td');const name=el('div','file-name');const itemIcon=el('span',`file-type-icon${item.type==='directory'?' directory':''}`);itemIcon.append(icon(item.type==='directory'?'folder':'file'));const filePath=item.path||joinPath(state.filePath,item.name);if(item.type==='directory'){const folder=el('button','',item.name);folder.type='button';folder.addEventListener('click',()=>navigateFiles(filePath));name.append(itemIcon,folder);}else name.append(itemIcon,el('span','',item.name));nameCell.append(name);row.append(nameCell,el('td','',item.type==='directory'?'—':formatBytes(item.size)),el('td','',item.type==='directory'?'文件夹':'文件'),el('td','',item.modified?formatDate(item.modified):'—'));const actionCell=el('td');if(item.type==='directory'){const open=el('button','icon-button');open.type='button';open.setAttribute('aria-label',`打开文件夹 ${item.name}`);open.title='打开文件夹';open.append(icon('chevron-right'));open.addEventListener('click',()=>navigateFiles(filePath));actionCell.append(open);}else{const link=el('a','icon-button');link.href=`/api/files/download?${new URLSearchParams({resourceId:state.selectedId,path:filePath})}`;link.download=item.name;link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label',`下载 ${item.name}`);link.title='下载文件';link.append(icon('download'));actionCell.append(link);}row.append(actionCell);tbody.append(row);});table.append(thead,tbody);container.append(table);}
function uploadFiles(fileList){const files=Array.from(fileList||[]);if(!files.length)return;if(!canUseFiles()){toast('请先连接可管理文件的资源，再上传数据。',true);return;}const data=new FormData();files.forEach(file=>data.append('files',file));const xhr=new XMLHttpRequest();state.upload=xhr;const container=$('upload-progress');clear(container);container.classList.remove('hidden');const top=el('div','upload-progress-top');const label=el('span','',`正在上传 ${files.length} 个文件`);const percent=el('strong','','0%');const cancel=el('button','icon-button');cancel.type='button';cancel.title='取消上传';cancel.setAttribute('aria-label','取消上传');cancel.append(icon('close'));cancel.addEventListener('click',()=>xhr.abort());top.append(icon('upload'),label,percent,cancel);const track=el('div','progress-track');const bar=el('div','progress-bar');track.append(bar);container.append(top,track);updateFileActions();xhr.open('POST',`/api/files/upload?${new URLSearchParams({resourceId:state.selectedId,path:state.filePath})}`);xhr.withCredentials=true;if(state.session?.csrfToken)xhr.setRequestHeader('X-CSRF-Token',state.session.csrfToken);xhr.upload.onprogress=(event)=>{if(event.lengthComputable){const progress=Math.round(event.loaded/event.total*100);percent.textContent=`${progress}%`;bar.style.width=`${progress}%`;if(progress===100)label.textContent='文件已发送，正在等待服务器保存…';}};const finish=()=>{state.upload=null;$('upload-input').value='';updateFileActions();};xhr.onload=()=>{let response;try{response=JSON.parse(xhr.responseText);}catch{response={message:'服务返回了无法读取的内容。'};}finish();if(xhr.status>=200&&xhr.status<300){container.classList.add('hidden');toast(`${files.length} 个文件已上传`);loadFiles();}else{container.classList.add('hidden');if(xhr.status===401)showLogin('登录已失效，请重新连接平台。');toast(response.message||(typeof response.error==='string'?response.error:'上传失败，请稍后重试。'),true);}};xhr.onerror=()=>{finish();container.classList.add('hidden');toast('上传连接中断，请检查本地服务后重试。',true);};xhr.onabort=()=>{finish();container.classList.add('hidden');toast('已取消上传');};xhr.send(data);}

async function loadAIConfig(){const session=state.session;try{const data=await api('/api/ai/config');if(state.session!==session)return;state.aiConfig=data;renderAIConnection();}catch(error){if(state.session!==session)return;state.aiConfig=null;renderAIConnection();$('ai-connection-description').textContent=readableError(error);}}
function renderAIConnection(){const config=state.aiConfig;$('chat-model-label').textContent=config?.model||'尚未连接模型';$('ai-connection-description').textContent=config?.model?`当前模型 · ${config.model}`:'配置兼容 OpenAI 的模型服务';}
async function openAISettings(){if(!state.session)return;const dialog=$('ai-settings-dialog');showError('ai-settings-error','');$('ai-api-key').value='';$('ai-base-url').value=state.aiConfig?.baseUrl||'';$('ai-model').value=state.aiConfig?.model||'';$('api-key-state').textContent=state.aiConfig?.hasKey?'已设置 · 留空保留密钥':'可按服务要求填写';$('ai-api-key').placeholder=state.aiConfig?.hasKey?'已设置，留空则保留':'输入 API Key';dialog.showModal();if(!state.aiConfig){await loadAIConfig();if(dialog.open&&state.aiConfig){$('ai-base-url').value=state.aiConfig.baseUrl||'';$('ai-model').value=state.aiConfig.model||'';$('api-key-state').textContent=state.aiConfig.hasKey?'已设置 · 留空保留密钥':'可按服务要求填写';}}}
function renderChat(){const container=$('chat-messages');clear(container);if(!state.messages.length){const welcome=el('div','chat-welcome');const orb=el('span','ai-orb');orb.append(icon('sparkles'));welcome.append(orb,el('h2','','把想法，写成下一步。'),el('p','','环境配置、脚本编写、报错排查。我们从哪里开始？'));const starters=el('div','chat-starters');[{icon:'terminal',title:'检查运行环境',subtitle:'整理环境与依赖',prompt:'请给我一组用于检查当前 Linux Python 和 GPU 运行环境的只读命令，并解释如何阅读输出。'},{icon:'code',title:'编写处理脚本',subtitle:'把重复工作交给代码',prompt:'我想编写一个数据处理脚本。请先帮我梳理需要提供的输入、输出格式和处理规则。'},{icon:'lightbulb',title:'一起排查问题',subtitle:'从报错中找到线索',prompt:'我遇到了程序报错。请告诉我需要提供哪些报错信息和环境信息，帮我一步步定位原因。'}].forEach(item=>{const button=el('button','chat-starter');button.type='button';button.append(icon(item.icon),el('strong','',item.title),el('span','',item.subtitle));button.addEventListener('click',()=>{$('chat-input').value=item.prompt;$('chat-input').focus();});starters.append(button);});welcome.append(starters);container.append(welcome);}else state.messages.forEach(message=>container.append(messageElement(message)));if(state.chatBusy){const pending=el('div','chat-message assistant');pending.id='chat-pending';const avatar=el('span','message-avatar');avatar.append(icon('sparkles'));const copy=el('div','message-content');copy.append(el('div','message-role','研究伙伴正在思考'));const dots=el('div','chat-thinking');dots.append(el('i'),el('i'),el('i'));copy.append(dots);pending.append(avatar,copy);container.append(pending);}container.scrollTop=container.scrollHeight;}
function messageElement(message){const row=el('div',`chat-message ${message.role}`);const avatar=el('span','message-avatar');if(message.role==='user')avatar.textContent=(state.session?.username||'U').slice(0,1).toUpperCase();else avatar.append(icon('sparkles'));const copy=el('div','message-content');copy.append(el('div','message-role',message.role==='user'?'你':'研究伙伴'));const text=el('div','message-text');if(message.role==='assistant')renderResponseText(text,message.content);else text.textContent=message.content;copy.append(text);if(message.role==='assistant'){const button=el('button','message-copy');button.type='button';button.append(icon('copy'),el('span','','复制回答'));button.addEventListener('click',()=>copyText(message.content));copy.append(button);}row.append(avatar,copy);return row;}
function renderResponseText(container,content){const pattern=/```([^\n`]*)\n([\s\S]*?)```/g;let cursor=0;let match;while((match=pattern.exec(content))){if(match.index>cursor)container.append(document.createTextNode(content.slice(cursor,match.index)));const block=el('div','code-block');const head=el('div','code-block-header');head.append(el('span','',match[1].trim()||'code'));const copy=el('button');copy.type='button';copy.append(icon('copy'),el('span','','复制'));const code=match[2].replace(/\n$/,'');copy.addEventListener('click',()=>copyText(code));head.append(copy);const pre=el('pre');pre.append(el('code','',code));block.append(head,pre);container.append(block);cursor=pattern.lastIndex;}if(cursor<content.length)container.append(document.createTextNode(content.slice(cursor)));}
async function copyText(text){try{await navigator.clipboard.writeText(text);toast('已复制到剪贴板');}catch{toast('浏览器未允许复制，请选中文本后手动复制。',true);}}

function bindEvents(){window.addEventListener('hashchange',()=>setView(location.hash.slice(1)));$('login-form').addEventListener('submit',async event=>{event.preventDefault();const username=$('username').value.trim();const password=$('password').value;const captchaCode=$('captcha-code').value.trim();if(!username||!password){showError('login-error','请填写平台用户名和密码。');(!username?$('username'):$('password')).focus();return;}if(!state.challenge||!captchaCode){showError('login-error','请填写图形验证码；点击图片可刷新。');$('captcha-code').focus();return;}if(state.challenge.expiresAt&&Date.now()>=Number(state.challenge.expiresAt)){showError('login-error','验证码已过期，请输入新图片中的验证码。');void loadChallenge();return;}showError('login-error','');buttonBusy('login-submit',true,'正在连接平台…');try{const response=await api('/api/login',{method:'POST',body:{username,password,challengeId:state.challenge.challengeId,captchaCode}});const session=response.session||response;if(!session.authenticated){throw new Error(response.message||'平台尚未建立登录会话，请检查登录配置。');}$('password').value='';await showApp(session);}catch(error){showError('login-error',readableError(error));void loadChallenge();}finally{buttonBusy('login-submit',false);$('login-submit').disabled=state.challengeLoading||!state.challenge;}});
  $('copy-vscode-extension-command').addEventListener('click',()=>copyText('code --install-extension ms-vscode.remote-server'));
  $('copy-tunnel-name').addEventListener('click',()=>copyText('wuhan-a800'));
  $('refresh-captcha').addEventListener('click',loadChallenge);
  $('toggle-password').addEventListener('click',()=>{const input=$('password');const visible=input.type==='password';input.type=visible?'text':'password';$('toggle-password').setAttribute('aria-label',visible?'隐藏密码':'显示密码');});
  $('logout').addEventListener('click',async()=>{const button=$('logout');button.disabled=true;try{await api('/api/logout',{method:'POST'});showLogin();state.resourcesLoaded=false;state.quota=null;state.aiConfig=null;}catch(error){toast(readableError(error),true);}finally{button.disabled=false;}});
  $('refresh-resources').addEventListener('click',loadResources);$('resource-search').addEventListener('input',renderResourceList);$('resource-view-toggle').addEventListener('click',()=>{state.compact=!state.compact;$('resource-view-toggle').setAttribute('aria-pressed',String(state.compact));renderResourceList();});document.querySelectorAll('[data-open-view]').forEach(button=>button.addEventListener('click',()=>openView(button.dataset.openView)));
  $('menu-toggle').addEventListener('click',()=>{const open=$('sidebar').classList.toggle('open');$('sidebar-scrim').classList.toggle('hidden',!open);$('menu-toggle').setAttribute('aria-expanded',String(open));});$('sidebar-scrim').addEventListener('click',closeMenu);
  ['workspace-resource','files-resource'].forEach(id=>$(id).addEventListener('change',event=>{if(state.upload){event.target.value=state.selectedId;toast('文件正在上传，请完成后切换资源。',true);return;}setSelected(event.target.value);if(id==='workspace-resource')loadWorkspace();else loadFiles();}));
  $('file-path-form').addEventListener('submit',event=>{event.preventDefault();navigateFiles($('file-path-input').value);});$('refresh-files').addEventListener('click',loadFiles);$('upload-button').addEventListener('click',()=>$('upload-input').click());$('upload-input').addEventListener('change',event=>uploadFiles(event.target.files));$('new-folder').addEventListener('click',()=>{if(!canUseFiles())return;$('folder-parent-label').textContent=`创建到 ${state.filePath}`;$('folder-name').value='';showError('folder-error','');$('folder-dialog').showModal();$('folder-name').focus();});
  $('folder-form').addEventListener('submit',async event=>{event.preventDefault();const name=$('folder-name').value.trim();if(!name||/[/\\\u0000]/.test(name)||name==='.'||name==='..'){showError('folder-error','请输入有效的名称，不含斜杠。');return;}showError('folder-error','');buttonBusy('folder-submit',true,'正在创建…');try{await api('/api/files/mkdir',{method:'POST',body:{resourceId:state.selectedId,path:state.filePath,name}});$('folder-dialog').close();toast('文件夹已创建');loadFiles();}catch(error){showError('folder-error',readableError(error));}finally{buttonBusy('folder-submit',false);}});
  let dragDepth=0;const manager=$('file-manager');manager.addEventListener('dragenter',event=>{event.preventDefault();if(!event.dataTransfer.types.includes('Files'))return;dragDepth++;if(canUseFiles())$('drop-overlay').classList.remove('hidden');});manager.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=canUseFiles()?'copy':'none';}});manager.addEventListener('dragleave',event=>{event.preventDefault();dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-overlay').classList.add('hidden');});manager.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;$('drop-overlay').classList.add('hidden');uploadFiles(event.dataTransfer.files);});window.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();});window.addEventListener('drop',event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();});
  ['open-ai-settings','aside-ai-settings','ai-settings-shortcut'].forEach(id=>$(id).addEventListener('click',openAISettings));document.querySelectorAll('[data-close-dialog]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.closeDialog).close()));document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const bounds=dialog.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();}}));
  $('ai-settings-form').addEventListener('submit',async event=>{event.preventDefault();const baseUrl=$('ai-base-url').value.trim();const model=$('ai-model').value.trim();if(!baseUrl||!model){showError('ai-settings-error','请填写服务地址和模型名称。');return;}try{const url=new URL(baseUrl);if(!['http:','https:'].includes(url.protocol))throw new Error();}catch{showError('ai-settings-error','请输入有效的 HTTP 或 HTTPS 服务地址。');return;}showError('ai-settings-error','');buttonBusy('ai-settings-submit',true,'正在保存…');const body={baseUrl,model,apiKey:$('ai-api-key').value};try{const result=await api('/api/ai/config',{method:'PUT',body});state.aiConfig=result.config||result;if(!state.aiConfig.model)state.aiConfig={baseUrl,model,hasKey:!!body.apiKey||!!state.aiConfig.hasKey};$('ai-api-key').value='';renderAIConnection();$('ai-settings-dialog').close();toast('AI 模型连接已保存');}catch(error){showError('ai-settings-error',readableError(error));}finally{buttonBusy('ai-settings-submit',false);}});
  $('chat-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('chat-form').requestSubmit();}});$('chat-input').addEventListener('input',()=>{const node=$('chat-input');node.style.height='auto';node.style.height=`${Math.min(node.scrollHeight,220)}px`;});$('clear-chat').addEventListener('click',()=>{if(state.chatBusy)return;state.messages=[];showError('chat-error','');renderChat();});$('chat-form').addEventListener('submit',async event=>{event.preventDefault();const content=$('chat-input').value.trim();if(!content||state.chatBusy)return;showError('chat-error','');if(!state.aiConfig?.model||!state.aiConfig?.baseUrl){await openAISettings();return;}const request=++state.chatRequest;state.messages.push({role:'user',content});state.chatBusy=true;$('chat-submit').disabled=true;$('clear-chat').disabled=true;$('chat-input').value='';$('chat-input').style.height='auto';renderChat();const payload={messages:state.messages.map(message=>({role:message.role,content:message.content}))};try{const data=await api('/api/ai/chat',{method:'POST',body:payload});if(!state.session||request!==state.chatRequest)return;if(typeof data.content!=='string'||!data.content.trim())throw new Error('模型未返回文本内容，请检查服务配置后重试。');state.messages.push({role:'assistant',content:data.content});}catch(error){if(state.session&&request===state.chatRequest){showError('chat-error',readableError(error));state.messages.pop();$('chat-input').value=content;}}finally{if(request===state.chatRequest){state.chatBusy=false;$('chat-submit').disabled=false;$('clear-chat').disabled=false;renderChat();}}});
}

async function init(){hydrateIcons();bindEvents();$('topbar-date').textContent=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});renderQuota();updateFileActions();setInterval(updateCountdowns,30000);try{const data=await api('/api/session');const session=data.session||data;state.session=session;if(session.authenticated)await showApp(session);else{showLogin();state.session=session;}}catch(error){showLogin(readableError(error));}}
init();

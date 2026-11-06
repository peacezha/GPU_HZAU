import { constants, publicEncrypt, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

// Contracts verified against the platform's public production JavaScript on 2026-11-04.
// See work/api-discovery: loading-gOuBBb6L.js, VerifyPhone-DPlMlrYx.js,
// encrypt-DRg24LiE.js, dev-machine-0e6GP28o.js, asset-manage-BiGA1SYB.js,
// FileManage-BVt2qL1x.js, and index-BU9FIhRE.js.
const ORIGIN = 'https://xr.wuhan.net.cn:30443';
const AUTH = '/xrops/auth-srv/tenant/v1';
const TOOL = '/tai/toolchain/toolchain-srv/tenant/v1';
const FILE = '/tai/toolchain/toolchain-srv/g/tenant/v1';
const RESOURCE = '/tai/resource/vrspool-srv/tenant/v1';
const STOPPABLE = new Set(['Running', 'StopFailed', 'Starting', 'Pending']);
const BILL_TYPES = [1, 2, 3, 4, 5, 13, 99];
const BILL_PAGE_SIZE = 100;
const BILL_PAGE_LIMIT = 5;
const CHALLENGE_TTL = 5 * 60 * 1000;
const MAX_FILE_SIZE = 5 * 1024 ** 3;
const challenges = new Map();
const LOGIN_KEY = `-----BEGIN RSA PUBLIC KEY-----
MIIBCgKCAQEAvvgKPlmFW0r+xIMWElW7LQGHVJ7fy2DPWrxyy48RmJV1WAWmTf2+
EwjYUT0s7lGX1srK/72oRxf7aB5Q6/cSdlWR5lDeR/P4bVDoPF0N1MPAe9nNOOLT
+OIRrCtyVy1XQbXjEUZc+nwcatMptrw7GyeDhnaWdjmLa7SdNBxggIPNZ30y3Ckp
JWLMn/kG37xgBXnW3STPy3W9/VcnV+LvTkyBOFdxqBHpF1ihiOpOxxsoh93wUTSF
WDTSZZq9pmc85wga/2qXdvM5j8Cd9zaVbGyRZkPnbiRdz9BxMWwK8ptNK3clTDx9
GDo8jFjjoZjpXsi3n0myLWhN6s2xJM4wKwIDAQAB
-----END RSA PUBLIC KEY-----`;

const fail = (status, message, code = 'UPSTREAM_ERROR') => Object.assign(new Error(message), { status, code });
const numeric = value => value === '' || value == null || !Number.isFinite(Number(value)) ? null : Number(value);
const successful = data => ['ok', 0, '0'].includes(data?.status?.code) || [200, '0'].includes(data?.code);
const upstreamError = data => {
  // Return the platform's short error message, never request bodies or headers.
  const message = String(data?.status?.message || data?.message || '算力平台未完成请求。').slice(0, 500);
  return fail(502, message, 'PLATFORM_REQUEST_FAILED');
};

// This jar belongs to one local login attempt/session. It never reads browser cookies.
class CookieJar {
  entries = new Map();
  absorb(response, url) {
    const lines = response.headers.getSetCookie?.() || [];
    for (const line of lines) {
      const [pair, ...attributes] = line.split(';');
      const equals = pair.indexOf('=');
      if (equals < 1) continue;
      const cookie = { name: pair.slice(0, equals).trim(), value: pair.slice(equals + 1), domain: url.hostname, hostOnly: true, path: url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/', secure: false, httpOnly: false, expires: Infinity };
      for (const attribute of attributes) {
        const [key, ...rest] = attribute.trim().split('=');
        const value = rest.join('=');
        switch (key.toLowerCase()) {
          case 'domain': {
            const domain = value.toLowerCase().replace(/^\./, '');
            if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) continue;
            cookie.domain = domain; cookie.hostOnly = false; break;
          }
          case 'path': if (value.startsWith('/')) cookie.path = value; break;
          case 'secure': cookie.secure = true; break;
          case 'httponly': cookie.httpOnly = true; break;
          case 'max-age': if (Number.isFinite(Number(value))) cookie.expires = Date.now() + Number(value) * 1000; break;
          case 'expires': if (cookie.expires === Infinity && Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value); break;
        }
      }
      const id = `${cookie.domain}|${cookie.path}|${cookie.name}`;
      if (cookie.expires <= Date.now()) this.entries.delete(id); else this.entries.set(id, cookie);
    }
  }
  header(url) {
    const matching = [];
    for (const [id, cookie] of this.entries) {
      if (cookie.expires <= Date.now()) { this.entries.delete(id); continue; }
      const domainMatches = cookie.hostOnly ? url.hostname === cookie.domain : url.hostname === cookie.domain || url.hostname.endsWith(`.${cookie.domain}`);
      const pathMatches = url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`);
      if (domainMatches && pathMatches && (!cookie.secure || url.protocol === 'https:')) matching.push(cookie);
    }
    return matching.sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }
  readable(name, url) {
    // Axios reads document.cookie, so HttpOnly cookies must not become XSRF headers.
    const eligible = this.header(url).split('; ').map(pair => pair.slice(0, pair.indexOf('=')));
    const cookie = [...this.entries.values()].filter(entry => entry.name === name && !entry.httpOnly && eligible.includes(entry.name))
      .filter(entry => (entry.hostOnly ? url.hostname === entry.domain : url.hostname === entry.domain || url.hostname.endsWith(`.${entry.domain}`)) && (url.pathname === entry.path || url.pathname.startsWith(entry.path.endsWith('/') ? entry.path : `${entry.path}/`)) && (!entry.secure || url.protocol === 'https:') && entry.expires > Date.now())
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!cookie) return '';
    try { return decodeURIComponent(cookie.value); } catch { return ''; }
  }
  clear() { this.entries.clear(); }
}

class PlatformClient {
  jar = new CookieJar();
  closed = false;
  browserBootstrapped = false;
  bootstrapPromise = null;
  async ensureBrowserContext() {
    if (this.browserBootstrapped) return;
    if (!this.bootstrapPromise) this.bootstrapPromise = (async () => {
      try {
        // The normal browser loads its authenticated overview before mutations.
        // Preserve any server-issued XSRF cookie from that authenticated page load.
        const response = await this.raw('/tai/overview/index', { headers: { Accept: 'text/html' }, timeout: 15000 });
        await response.body?.cancel();
        this.browserBootstrapped = true;
      } catch (error) {
        if (error.status === 401) throw error;
        throw fail(502, '无法初始化平台会话校验，请重新登录后重试。', 'SESSION_BOOTSTRAP_FAILED');
      } finally { this.bootstrapPromise = null; }
    })();
    await this.bootstrapPromise;
  }
  async raw(route, { method = 'GET', query, context, body, headers = {}, timeout = 60000, stream = false } = {}) {
    if (this.closed) throw fail(401, '当前会话已结束，请重新登录。', 'SESSION_CLOSED');
    const url = new URL(route, ORIGIN);
    if (url.origin !== ORIGIN) throw fail(400, '上游地址不在授权范围。', 'UPSTREAM_NOT_ALLOWED');
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
    if (mutation && url.pathname !== '/xrops/v1/auth/login') await this.ensureBrowserContext();
    for (const [key, value] of Object.entries(query || {})) {
      if (value == null || value === '') continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }
    const cookie = this.jar.header(url);
    const requestHeaders = { Accept: 'application/json', Referer: `${ORIGIN}/tai/overview/index`, ...headers };
    if (mutation) requestHeaders.Origin = ORIGIN;
    // index-BU9FIhRE.js Axios defaults: same-origin XSRF-TOKEN cookie is decoded
    // and copied to X-XSRF-TOKEN. No custom notebook/OSS CSRF endpoint is declared.
    const xsrfToken = this.jar.readable('XSRF-TOKEN', url);
    if (xsrfToken) requestHeaders['X-XSRF-TOKEN'] = xsrfToken;
    if (context?.workspaceUuid) requestHeaders['Grpc-Metadata-X-Workspace-Uuid'] = context.workspaceUuid;
    if (context?.enterpriseSpaceUuid) requestHeaders['Grpc-Metadata-X-EnterpriseSpace-Uuid'] = context.enterpriseSpaceUuid;
    if (cookie) requestHeaders.Cookie = cookie;
    let response;
    try {
      response = await fetch(url, { method, headers: requestHeaders, body, ...(stream ? { duplex: 'half' } : {}), redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    } catch {
      throw fail(502, '无法连接算力平台，请稍后重试。', 'PLATFORM_UNREACHABLE');
    }
    this.jar.absorb(response, url);
    if (response.status === 401) { await response.body?.cancel(); throw fail(401, '算力平台会话已过期，请重新登录。', 'PLATFORM_LOGIN_REQUIRED'); }
    if (response.status === 403) { await response.body?.cancel(); throw fail(403, '算力平台拒绝了该请求，请检查会话校验和对应操作权限。', 'PLATFORM_FORBIDDEN'); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw fail(401, '算力平台要求重新登录，请刷新验证码。', 'PLATFORM_LOGIN_REQUIRED'); }
    if (!response.ok) { await response.body?.cancel(); throw fail(502, `算力平台返回 ${response.status}，请稍后重试。`, 'PLATFORM_HTTP_ERROR'); }
    return response;
  }
  async json(route, options = {}) {
    const response = await this.raw(route, options);
    let data;
    try { data = await response.json(); } catch { throw fail(502, '算力平台返回了无法识别的数据。', 'PLATFORM_FORMAT_ERROR'); }
    if (!successful(data)) throw upstreamError(data);
    return data;
  }
  post(route, value, options = {}) {
    return this.json(route, { ...options, method: 'POST', headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify(value) });
  }
  close() { this.closed = true; this.jar.clear(); this.browserBootstrapped = false; this.bootstrapPromise = null; }
}

function pruneChallenges() {
  for (const [id, challenge] of challenges) if (challenge.expiresAt <= Date.now()) { challenge.client.close(); challenges.delete(id); }
  while (challenges.size >= 100) { const [id, challenge] = challenges.entries().next().value; challenge.client.close(); challenges.delete(id); }
}

export async function createChallenge() {
  pruneChallenges();
  const client = new PlatformClient();
  try {
    const [captcha, settings] = await Promise.all([
      client.json(`${AUTH}/captcha/generate`),
      client.json(`${AUTH}/systemSetting/get`),
    ]);
    if (!captcha.data?.uuid || !captcha.data?.captchaBase64) throw fail(502, '平台没有返回图形验证码。', 'CAPTCHA_UNAVAILABLE');
    const challengeId = randomBytes(32).toString('hex');
    const remoteExpiry = Number(captcha.data.expireTime) * 1000;
    const expiresAt = Math.min(Date.now() + CHALLENGE_TTL, remoteExpiry > Date.now() ? remoteExpiry : Infinity);
    challenges.set(challengeId, { client, captchaUuid: captcha.data.uuid, expiresAt, mfa: settings.data?.enableLoginMfa === true });
    return { challengeId, captchaImage: captcha.data.captchaBase64, image: captcha.data.captchaBase64, captchaBase64: captcha.data.captchaBase64, expiresAt, mfaEnabled: settings.data?.enableLoginMfa === true };
  } catch (error) { client.close(); throw error; }
}

export async function login(username, password, { challengeId, captchaCode } = {}) {
  const challenge = challenges.get(challengeId);
  challenges.delete(challengeId); // A challenge is single use, including failed login attempts.
  pruneChallenges();
  if (!challenge || challenge.expiresAt <= Date.now()) { challenge?.client.close(); throw fail(400, '验证码已失效，请刷新后重新输入。', 'CAPTCHA_EXPIRED'); }
  const { client } = challenge;
  try {
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password.trim()) throw fail(400, '请输入用户名和密码。', 'INVALID_CREDENTIALS');
    if (typeof captchaCode !== 'string' || captchaCode.trim().length !== 4) throw fail(400, '请输入图中的四位验证码。', 'INVALID_CAPTCHA');
    const plaintext = Buffer.from(JSON.stringify({ account: username.trim(), password: password.trim(), captchaUuid: challenge.captchaUuid, captchaCode: captchaCode.trim() }), 'utf8');
    let encrypted;
    try { encrypted = publicEncrypt({ key: LOGIN_KEY, padding: constants.RSA_PKCS1_PADDING }, plaintext).toString('base64'); }
    catch { throw fail(400, '账号信息过长，无法使用平台的登录加密方式。', 'LOGIN_PAYLOAD_TOO_LONG'); }
    finally { plaintext.fill(0); }
    // The site's login helper uses RSA PKCS#1 v1.5 and JSON, not form encoding.
    const response = await client.raw('/xrops/v1/auth/login?from=local&rd=%2Ftai%2F', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: challenge.mfa ? 3 : 1, from: 'local', account_info: encrypted }),
    });
    let data;
    try { data = await response.json(); } catch { throw fail(502, '平台登录返回格式异常。', 'LOGIN_FORMAT_ERROR'); }
    if (data?.status?.code !== 0) {
      throw fail(401, String(data?.status?.message || '登录失败，请检查账号、密码和验证码。').slice(0, 500), 'LOGIN_FAILED');
    }
    if (challenge.mfa && !data.isWhitelistLoginSuccess && data.twoFactorUuid) {
      throw fail(409, '此账号需要邮箱或短信二次验证，请先使用平台原登录页。', 'MFA_REQUIRED');
    }
    const provider = new Provider(username.trim(), client);
    await provider.initialize();
    return provider;
  } catch (error) { client.close(); throw error; }
}

function cleanPath(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\x00-\x1f]/.test(value) || value.split('/').some(part => part === '..' || part === '.')) throw fail(400, '目录路径无效。', 'INVALID_PATH');
  return `/${value.split('/').filter(Boolean).join('/')}`;
}
const within = (file, root) => file === root || file.startsWith(root === '/' ? '/' : `${root}/`);
const keyPrefix = value => String(value || '').replace(/^\/+|\/+$/g, '');
const fileTime = value => {
  if (!value) return null;
  const number = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : null;
  const date = new Date(number == null ? Date.parse(value) : number < 1e12 ? number * 1000 : number);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const billMonth = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', timeZone: 'Asia/Shanghai' });

function currentBillMonth() {
  const parts = billMonth.formatToParts(new Date());
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
}

function mountsOf(item) {
  const all = [...(item.mountInfo || []), ...(item.homeWork ? [item.homeWork] : [])];
  const mounts = all.filter(mount => mount?.mountPath).map(mount => {
    const storage = mount.storageInfo || {};
    const object = storage.ossInfo;
    const type = storage.type === 'Object' ? 'object' : storage.type === 'File' ? 'nas' : storage.type === 'Hpfs' ? 'hpfs' : 'workspace';
    return {
      path: cleanPath(mount.mountPath), type, source: object?.bucketName || storage.fileStorageInfo?.name || storage.hpfsInfo?.name || '工作区目录',
      readOnly: mount.mountMode === 'ReadOnly', supported: type === 'object' && !!object?.bucketUuid,
      bucketUuid: object?.bucketUuid || '', subPath: keyPrefix(object?.subPath),
      reason: type === 'object' && object?.bucketUuid ? '' : '平台未公开此挂载目录的文件管理接口，请在工作区内管理。',
    };
  });
  if (!mounts.some(mount => mount.path === '/home/work')) mounts.push({ path: '/home/work', type: 'workspace', source: '工作区目录', readOnly: false, supported: false, reason: '平台未公开工作区本地文件接口，请在工作区内管理。' });
  return mounts.filter((mount, index) => mounts.findIndex(other => other.path === mount.path) === index);
}

function normalize(item, context) {
  const accelerator = item.accelerator || {};
  const ratio = numeric(accelerator.allocationRatio);
  const virtual = !!accelerator.isVirtualizationEnabled;
  const count = ratio > 0 ? ratio / 100 : numeric(virtual ? accelerator.virtualCardNum : accelerator.acceleratorNum);
  const cpu = ratio > 0 ? Math.max(1, Math.floor(Number(accelerator.cpu || 0) * ratio / 100)) : numeric(accelerator.cpu);
  const memoryGb = ratio > 0 ? Math.max(1, Math.floor(Number(accelerator.mem || 0) * ratio / 100)) : numeric(accelerator.mem);
  return {
    id: item.uuid, uuid: item.uuid, name: item.name || item.uuid, description: item.description || '', status: item.status || 'Unknown',
    cpu, memoryGb, gpuCount: accelerator.acceleratorType === 'GPU' ? count : 0,
    gpuModel: accelerator.acceleratorType === 'GPU' ? accelerator.acceleratorModel || '' : '',
    acceleratorType: accelerator.acceleratorType || 'CPU', acceleratorModel: accelerator.acceleratorModel || '', acceleratorCount: count,
    image: item.imageConfig?.url || '', autoStopAt: item.stopTimeAvailable !== false && Number(item.deleteAfter) > 0 ? fileTime(item.deleteAfter) : null, createdAt: fileTime(item.createTime), creator: item.creator || '',
    canStop: STOPPABLE.has(item.status), runtimeInstanceCreatedAt: fileTime(item.instance?.createTime),
    workspaceName: context.workspaceName || '', enterpriseSpaceName: context.enterpriseSpaceName || '',
    mounts: mountsOf(item), memory: memoryGb, gpu: accelerator.acceleratorType === 'GPU' ? count : 0,
  };
}

function diagnosticText(value, client) {
  let text = String(value || '').slice(0, 12000);
  // Event messages can contain service responses. Scrub session material and
  // common credential formats before exposing even a selected message field.
  for (const cookie of client.jar.entries.values()) {
    const values = [cookie.value];
    try { values.push(decodeURIComponent(cookie.value)); } catch { /* not encoded */ }
    for (const secret of values) if (secret.length >= 8) text = text.split(secret).join('[已隐藏]');
  }
  return text
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:["']?)(?:authorization|password|passwd|secret|token|api[_-]?key|access[_-]?key|credential|cookie)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]]+)/gi, '$1[已隐藏]')
    .replace(/([?&](?:[^\s=&#]*(?:token|password|secret|signature|credential|api[_-]?key)[^\s=&#]*)=)[^\s&#]*/gi, '$1[已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[已隐藏]');
}

class Provider {
  constructor(username, client) { this.username = username; this.client = client; this.contexts = []; this.records = new Map(); this.deniedContexts = new Set(); }
  async initialize() {
    const authorized = await this.client.json(`${AUTH}/enterpriseSpace/getAuthorizedData`);
    // Production UI gates enterprise-level selection with space.isAuthorized,
    // but permits workspace selection beneath that space independently. Do not
    // drop assigned workspaces merely because their parent space flag is false.
    this.contexts = (authorized.data || []).flatMap(space => (space.workspaces || []).map(workspace => ({
      enterpriseSpaceUuid: space.enterpriseSpaceUuid, enterpriseSpaceName: space.enterpriseSpaceName,
      workspaceUuid: workspace.workspaceUuid, workspaceName: workspace.workspaceName,
    }))).filter((context, index, all) => context.enterpriseSpaceUuid && context.workspaceUuid && all.findIndex(other => other.enterpriseSpaceUuid === context.enterpriseSpaceUuid && other.workspaceUuid === context.workspaceUuid) === index);
  }
  close() { this.client.close(); this.contexts = []; this.records.clear(); this.deniedContexts.clear(); }
  async listResources() {
    if (this.client.closed) throw fail(401, '当前会话已结束，请重新登录。', 'SESSION_CLOSED');
    const collected = [];
    const warnings = [];
    const contextKey = context => `${context.enterpriseSpaceUuid}|${context.workspaceUuid}`;
    for (const context of this.contexts) {
      if (this.deniedContexts.has(contextKey(context))) continue;
      let page = 1;
      for (;;) {
        let data;
        try { data = await this.client.json(`${TOOL}/notebook/list`, { context, query: { 'paging.page': page, 'paging.perPage': 100, createdByMe: false } }); }
        catch (error) {
          if (error.status === 403) { this.deniedContexts.add(contextKey(context)); break; }
          throw error;
        }
        const items = data.items || [];
        for (const item of items) {
          if (!item.uuid) continue;
          this.records.set(item.uuid, { item, context });
          collected.push(normalize(item, context));
        }
        const total = numeric(data.paging?.totalRecord);
        if (!items.length || (total != null && page * 100 >= total) || (total == null && items.length < 100)) break;
        if (++page > 1000) throw fail(502, '平台资源列表分页超出预期，请使用平台原页面。', 'PAGINATION_LIMIT');
      }
    }
    // The overview calls this endpoint once for the selected project. These are
    // allocated project quotas (capacity), not physical pool size or remaining quota.
    const accessibleContexts = this.contexts.filter(context => !this.deniedContexts.has(contextKey(context)));
    if (this.deniedContexts.size) warnings.push(`已略过 ${this.deniedContexts.size} 个当前账号无权查看开发环境的项目。`);
    const quotaResults = await Promise.allSettled(accessibleContexts.map(context => this.client.json(`${RESOURCE}/quotaPolicyGlobal/getWorkspaceQuotaOverview`, { context, timeout: 15000 })));
    const quota = { cpu: null, gpu: null, npu: null, storageGb: null };
    const quotaUsed = { cpu: null, gpu: null, npu: null, storageGb: null };
    const quotaRows = [];
    const fieldForType = { cpu: 'cpu', gpu: 'gpu', npu: 'npu', storage: 'storageGb' };
    for (let index = 0; index < quotaResults.length; index++) {
      const result = quotaResults[index];
      if (result.status !== 'fulfilled' || !Array.isArray(result.value?.data)) continue;
      const context = accessibleContexts[index];
      for (const row of result.value.data) {
        const capacity = numeric(row.capacity), used = numeric(row.used);
        const field = fieldForType[row.resourceType];
        quotaRows.push({ workspaceName: context.workspaceName, enterpriseSpaceName: context.enterpriseSpaceName, assignmentType: row.assignmentType, resourceType: row.resourceType, resourceModel: row.resourceModel || '', capacity, used });
        if (field && capacity != null && capacity >= 0) quota[field] = (quota[field] ?? 0) + capacity;
        if (field && used != null && used >= 0) quotaUsed[field] = (quotaUsed[field] ?? 0) + used;
      }
    }
    if (quotaResults.some(result => result.status !== 'fulfilled' || !Array.isArray(result.value?.data))) {
      for (const field of Object.keys(quota)) { quota[field] = null; quotaUsed[field] = null; }
      warnings.push('部分项目的配额信息暂不可用，配额合计未显示。');
    }
    return { items: collected.filter((item, index) => collected.findIndex(other => other.id === item.id) === index), quota, quotaUsed, quotaRows, quotaScope: 'allocated-by-workspace', source: 'live', warnings };
  }
  async record(id, refresh = false) {
    if (typeof id !== 'string' || !id || id.length > 256) throw fail(400, '资源编号无效。', 'INVALID_RESOURCE');
    if (!this.records.has(id)) await this.listResources();
    let record = this.records.get(id);
    if (!record) throw fail(404, '没有找到可访问的开发环境。', 'RESOURCE_NOT_FOUND');
    if (refresh || !record.detail) {
      const data = await this.client.json(`${TOOL}/notebook/get`, { context: record.context, query: { uuid: id } });
      if (!data.detail?.uuid) throw fail(404, '开发环境详情不可用。', 'RESOURCE_NOT_FOUND');
      record = { ...record, item: { ...record.item, ...data.detail }, detail: true };
      this.records.set(id, record);
    }
    return record;
  }
  async getResource(id) { const { item, context } = await this.record(id, true); return normalize(item, context); }
  async getResourceDiagnostics(id) {
    const { item, context } = await this.record(id, true);
    const instance = item.instance?.uuid ? {
      id: item.instance.uuid, status: item.instance.status || 'Unknown', createdAt: fileTime(item.instance.createTime),
    } : null;
    // These are the exact three event views used by the production notebook
    // detail page; resource UUID and runtime instance UUID are distinct.
    const sources = [
      { source: 'business', route: `${TOOL}/event/listServiceEvent`, query: { type: 'Notebook', uuid: item.uuid }, field: 'events' },
      { source: 'dispatch', route: `${TOOL}/event/list`, query: { scene: 'Notebook', uuid: item.uuid }, field: 'events' },
      ...(instance ? [{ source: 'instance', route: `${TOOL}/event/listEdgeEvent`, query: { type: 'Notebook', instanceUuid: instance.id }, field: 'items' }] : []),
    ];
    const results = await Promise.allSettled(sources.map(async source => {
      const query = { ...source.query, 'paging.page': 1, 'paging.perPage': 100 };
      const first = await this.client.json(source.route, { context, query, timeout: 20000 });
      const total = numeric(first.paging?.totalRecord);
      const entries = Array.isArray(first[source.field]) ? [...first[source.field]] : [];
      if (total > 100) {
        const lastPage = Math.ceil(total / 100);
        const pages = [lastPage, ...(total % 100 && lastPage > 2 ? [lastPage - 1] : [])];
        const tails = await Promise.all(pages.map(page => this.client.json(source.route, { context, query: { ...query, 'paging.page': page }, timeout: 20000 })));
        for (const tail of tails) if (Array.isArray(tail[source.field])) entries.push(...tail[source.field]);
      }
      const events = entries.map(event => ({
        source: source.source, level: diagnosticText(event.level, this.client), action: diagnosticText(event.action, this.client),
        message: diagnosticText(event.userMessage, this.client), timestamp: fileTime(event.timestamp),
      })).filter((event, index, all) => all.findIndex(other => other.timestamp === event.timestamp && other.level === event.level && other.action === event.action && other.message === event.message) === index)
        .sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0)).slice(0, 100);
      return { source: source.source, events, totalRecord: total, truncated: total != null && total > events.length };
    }));
    const events = [];
    const eventSources = [];
    const warnings = [];
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'fulfilled') {
        const { events: sourceEvents, ...sourceStatus } = result.value;
        events.push(...sourceEvents);
        eventSources.push({ ...sourceStatus, available: true });
      } else {
        eventSources.push({ source: sources[index].source, available: false, code: result.reason?.code || 'DIAGNOSTICS_UNAVAILABLE' });
        warnings.push(`${{ business: '业务', dispatch: '调度', instance: '实例' }[sources[index].source]}事件暂时无法读取。`);
      }
    }
    events.sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0));
    const errorMessage = diagnosticText(item.errMsg, this.client);
    const reasons = [...new Set([
      ...(errorMessage ? [errorMessage] : []),
      ...events.filter(event => /warn|error|fatal|panic/i.test(event.level) || /fail|error|backoff|unhealthy|失败|错误/i.test(event.action)).map(event => event.message).filter(Boolean),
    ])].slice(0, 30);
    return {
      id: item.uuid, status: item.status || 'Unknown', resource: normalize(item, context), instance, instances: instance ? [instance] : [],
      errorMessage, reason: errorMessage || reasons[0] || '', reasons, events, eventSources, warnings, checkedAt: new Date().toISOString(),
      placement: {
        strategy: diagnosticText(item.schedDetail?.schedStrategyName || item.schedDetail?.schedStrategy, this.client),
        dataCenter: diagnosticText(item.schedDetail?.dcName, this.client), pool: diagnosticText(item.schedDetail?.vrsPoolName, this.client),
      },
    };
  }
  async startResource(id) {
    const { item, context } = await this.record(id, true);
    // List-DSJHxAUj.js enables Start only for Stopped / StartFailed and posts {uuid}.
    if (!['Stopped', 'StartFailed'].includes(item.status)) throw fail(409, '开发环境当前状态不支持启动，请刷新资源状态。', 'RESOURCE_NOT_STARTABLE');
    await this.client.post(`${TOOL}/notebook/start`, { uuid: item.uuid }, { context });
    return { ok: true, id: item.uuid, submitted: true, message: '启动请求已提交，请稍后刷新资源状态。' };
  }
  async stopResource(id) {
    const { item, context } = await this.record(id, true);
    // The production notebook list uses stop for these states. Terminate is a separate action.
    if (!STOPPABLE.has(item.status)) throw fail(409, '开发环境当前状态不支持关闭，请刷新资源状态。', 'RESOURCE_NOT_STOPPABLE');
    await this.client.post(`${TOOL}/notebook/stop`, { uuid: item.uuid }, { context });
    return { ok: true, id: item.uuid, submitted: true, message: '关闭请求已提交，请稍后刷新资源状态。' };
  }
  async getResourceBilling(id, month = currentBillMonth()) {
    if (typeof month !== 'string' || !/^[2-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) || month > currentBillMonth()) {
      throw fail(400, '请选择有效的账期。', 'INVALID_BILL_MONTH');
    }
    const { item, context } = await this.record(id, true);
    const ids = [...new Set([item.uuid, item.instance?.uuid].filter(Boolean))];
    const rows = [];
    let truncated = false;
    const base = { month, currency: 'CNY' };
    try {
      // Billing search can return fuzzy matches. Classify by the exact
      // resource/task identifiers used by the platform, with notebook first.
      for (const keyword of ids) {
        for (let page = 1; page <= BILL_PAGE_LIMIT; page++) {
          const data = await this.client.json(`${RESOURCE}/billing/listWsBill`, {
            context, timeout: 15000, query: { billingCycle: month, keyword, billingTransactionTypes: BILL_TYPES, 'paging.page': page, 'paging.perPage': BILL_PAGE_SIZE },
          });
          const entries = data.data ?? [];
          if (!Array.isArray(entries)) throw fail(502, '算力平台返回了无法识别的账单。', 'PLATFORM_FORMAT_ERROR');
          for (const entry of entries) {
            if (!entry || ids.find(candidate => [entry.itResourceId, entry.realResourceId, entry.taskId].includes(candidate)) !== keyword) continue;
            const hidePrice = entry.hidePrice === true || entry.hidePrice === 'true';
            rows.push({
              resourceId: keyword,
              transactionType: numeric(entry.billingTransactionType),
              chargingItem: diagnosticText(entry.chargingItem, this.client).slice(0, 120),
              chargingItemName: diagnosticText(entry.chargingItemName, this.client).slice(0, 120),
              usage: numeric(entry.usage), usageUnit: diagnosticText(entry.usageUnit, this.client).slice(0, 40),
              consumeStartAt: fileTime(entry.consumeStartTime), consumeEndAt: fileTime(entry.consumeEndTime),
              amount: hidePrice ? null : numeric(entry.amount), payAmount: hidePrice ? null : numeric(entry.payAmount),
              discountAmount: hidePrice ? null : numeric(entry.discountAmount), hidePrice,
            });
          }
          const total = numeric(data.paging?.totalRecord);
          if (!entries.length || (total != null ? page * BILL_PAGE_SIZE >= total : entries.length < BILL_PAGE_SIZE)) break;
          if (page === BILL_PAGE_LIMIT) truncated = true;
        }
      }
    } catch (error) {
      if (error.status === 401) throw error;
      return { ...base, available: false, truncated: false, rows: [], message: error.status === 403 ? '当前账号或项目没有账单查询权限。' : '平台账单暂不可用，请稍后刷新。' };
    }
    const message = truncated ? '平台返回的账单较多，这里只显示已读取的明细。' : rows.length ? '' : '本账期暂未查询到该资源的已出账用量和费用。';
    return { ...base, available: true, truncated, rows, message };
  }
  async getWorkspace(id) {
    const { item } = await this.record(id, true);
    if (!item.endpoint) return { url: '', supported: false, available: false, reason: '平台尚未返回此开发环境的工作区地址。' };
    let endpoint;
    try { endpoint = new URL(item.endpoint, ORIGIN); } catch { return { url: '', supported: false, available: false, reason: '平台返回的工作区地址无效。' }; }
    const allowed = endpoint.protocol === 'https:' && endpoint.origin === 'https://xrapi.wuhan.net.cn:9443' && endpoint.pathname.startsWith('/notebook/') && !endpoint.username && !endpoint.password;
    const secretQuery = [...endpoint.searchParams.keys()].some(key => /token|auth|secret|password|credential|session|key/i.test(key));
    if (!allowed || secretQuery) return { url: '', supported: false, available: false, reason: '工作区地址需要平台原页面打开。', portalUrl: `${ORIGIN}/tai/model-development/notebook/list` };
    const running = ['Running', 'ImageBuilding'].includes(item.status);
    return { url: endpoint.toString(), supported: running, available: running, iframeVerified: false, requiresBrowserSession: true,
      publicWorkspaceAuthSupported: !!this.client.jar.header(endpoint),
      reason: running ? '直接使用平台返回的工作区地址。内嵌兼容性尚未验证；若提示登录，请先在平台原页面登录。' : '开发环境当前未处于可打开状态。' };
  }
  // SERVER INTERNAL ONLY. Never serialize this result into a public API response.
  // The local server may use it for an authenticated, path-scoped workspace proxy.
  async getWorkspaceConnection(id) {
    const workspace = await this.getWorkspace(id);
    if (!workspace.supported || !workspace.url) return { supported: false, reason: workspace.reason || '工作区当前不可用。' };
    const endpoint = new URL(workspace.url);
    const prefix = /^\/notebook\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})(?:\/|$)/.exec(endpoint.pathname);
    if (!prefix) return { supported: false, reason: '工作区地址不在已验证的路径范围。' };
    const cookie = this.client.jar.header(endpoint);
    if (!cookie) return { supported: false, reason: '平台登录没有提供此工作区域名可用的会话，无法通过本机代理打开。' };
    const xsrfToken = this.client.jar.readable('XSRF-TOKEN', endpoint);
    return { supported: true, url: endpoint.toString(), headers: { Cookie: cookie, ...(xsrfToken ? { 'X-XSRF-TOKEN': xsrfToken } : {}) }, allowedOrigin: endpoint.origin, allowedPrefix: `/notebook/${prefix[1]}/` };
  }
  async location(id, requestedPath, write = false) {
    const record = await this.record(id, true);
    const normalizedPath = cleanPath(requestedPath || '/');
    const mounts = mountsOf(record.item);
    const mount = mounts.filter(candidate => within(normalizedPath, candidate.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!mount?.supported) throw fail(501, mount?.reason || '此路径未挂载可管理的对象存储，请选择资源详情中的对象存储挂载目录。', 'FILES_UNSUPPORTED');
    if (write && mount.readOnly) throw fail(403, '此存储为只读挂载，不能上传或创建目录。', 'READ_ONLY_MOUNT');
    const relative = normalizedPath.slice(mount.path === '/' ? 1 : mount.path.length).replace(/^\/+/, '');
    return { ...record, mount, path: normalizedPath, key: [mount.subPath, relative].filter(Boolean).join('/') };
  }
  async listFiles(id, requestedPath = '/') {
    const folder = cleanPath(requestedPath);
    const { item } = await this.record(id, true);
    const mounts = mountsOf(item);
    if (folder === '/') return { path: '/', available: true, items: mounts.map(mount => ({ name: mount.path, path: mount.path, type: 'directory', size: null, modified: null, supported: mount.supported, reason: mount.reason || '', source: mount.source, readOnly: mount.readOnly })), mounts };
    let location;
    try { location = await this.location(id, folder); }
    catch (error) { if (error.code === 'FILES_UNSUPPORTED') return { path: folder, items: [], mounts, available: false, reason: error.message }; throw error; }
    const prefix = location.key ? `${location.key}/` : '';
    const entries = [];
    let marker = '';
    for (let page = 0; page < 1000; page++) {
      const response = await this.client.json(`${TOOL}/oss/listObjects`, { context: location.context, query: { bucketUuid: location.mount.bucketUuid, prefix, marker, maxKeys: 1000, delimiter: '/' } });
      const data = response.data || {};
      for (const directory of data.commonPrefixes || []) {
        const key = String(directory.prefix || '');
        if (!key.startsWith(prefix) || key === prefix) continue;
        const name = key.slice(prefix.length).replace(/\/$/, '');
        entries.push({ name, path: `${folder === '/' ? '' : folder}/${name}`, type: 'directory', size: null, modified: null });
      }
      for (const object of data.contents || []) {
        const key = String(object.key || '');
        if (!key.startsWith(prefix) || key === prefix) continue;
        const name = key.slice(prefix.length);
        entries.push({ name, path: `${folder === '/' ? '' : folder}/${name}`, type: 'file', size: numeric(object.size), modified: fileTime(object.lastModified) });
      }
      if (!data.isTruncated) return { path: folder, items: entries, available: true, readOnly: location.mount.readOnly, source: location.mount.source, mounts };
      const next = String(data.nextMarker || '');
      if (!next || next === marker) throw fail(502, '平台文件列表没有提供下一页标记。', 'FILE_PAGINATION_ERROR');
      marker = next;
    }
    throw fail(502, '文件列表过长，请使用平台原页面。', 'PAGINATION_LIMIT');
  }
  async mkdir(id, requestedPath, name) {
    if (typeof name !== 'string' || !/^[\u4e00-\u9fa5a-zA-Z0-9_.-]{1,64}$/.test(name) || ['.', '..'].includes(name)) throw fail(400, '目录名需为 1 至 64 位中文、字母、数字、点、下划线或短横线。', 'INVALID_NAME');
    const location = await this.location(id, requestedPath, true);
    const key = [location.key, name].filter(Boolean).join('/');
    await this.client.post(`${TOOL}/oss/createFolder`, { bucketUuid: location.mount.bucketUuid, folderKey: `${key}/` }, { context: location.context });
    return { ok: true, path: `${location.path === '/' ? '' : location.path}/${name}` };
  }
  async uploadFiles(id, requestedPath, files) {
    if (!Array.isArray(files) || !files.length || files.length > 100) throw fail(400, '请选择 1 至 100 个文件。', 'INVALID_FILES');
    const location = await this.location(id, requestedPath, true);
    const prepared = [];
    const names = new Set();
    for (const file of files) {
      const name = file?.name;
      if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 1023 || /[\/:\\\x00-\x1f]/.test(name) || ['.', '..'].includes(name)) throw fail(400, '文件名不符合平台要求。', 'INVALID_NAME');
      if (names.has(name)) throw fail(409, `本次上传包含重复文件名“${name}”，请更换文件名后重试。`, 'DUPLICATE_FILE_NAME');
      names.add(name);
      const size = file.buffer ? file.buffer.length : (await stat(file.path)).size;
      if (size > MAX_FILE_SIZE) throw fail(413, '平台单个文件上传上限为 5GB。', 'FILE_TOO_LARGE');
      prepared.push({ ...file, size });
    }
    // Best-effort preflight only: no conditional-write contract is documented by
    // the platform, so another client can still create a name after this check.
    const existing = await this.listFiles(id, location.path);
    if (!existing.available) throw fail(502, '无法检查目标目录中的同名文件，请稍后重试。', 'UPLOAD_PREFLIGHT_FAILED');
    const existingNames = new Set(existing.items.map(file => file.name));
    for (const name of names) if (existingNames.has(name)) throw fail(409, `目标目录已存在“${name}”，请更换文件名后重试。`, 'FILE_EXISTS');
    const uploaded = [];
    for (const file of prepared) {
      const boundary = `----resourceportal${randomBytes(16).toString('hex')}`;
      const objectKey = [location.key, file.name].filter(Boolean).join('/');
      const objectType = /^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType || '') ? file.mimeType : 'application/octet-stream';
      const fields = { bucketUuid: location.mount.bucketUuid, objectKey, objectType, objectSize: file.size };
      const fieldParts = Object.entries(fields).map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('');
      const header = Buffer.from(`${fieldParts}--${boundary}\r\nContent-Disposition: form-data; name="body"; filename="${file.name.replace(/"/g, '%22')}"\r\nContent-Type: ${objectType}\r\n\r\n`);
      const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
      async function* multipart() {
        yield header;
        if (file.buffer) yield file.buffer; else for await (const chunk of createReadStream(file.path)) yield chunk;
        yield ending;
      }
      await this.client.json(`${FILE}/oss/uploadObject`, { method: 'POST', context: location.context, body: multipart(), stream: true, timeout: 30 * 60 * 1000,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(header.length + file.size + ending.length) } });
      uploaded.push({ name: file.name, size: file.size, path: `${location.path === '/' ? '' : location.path}/${file.name}`, status: 'success' });
    }
    return { ok: true, uploaded, count: uploaded.length };
  }
  async downloadFile(id, requestedPath) {
    const location = await this.location(id, requestedPath);
    if (!location.key || cleanPath(requestedPath) === location.mount.path) throw fail(400, '请选择一个文件下载。', 'INVALID_FILE');
    return this.client.raw(`${FILE}/oss/downloadObject`, { context: location.context, query: { bucketUuid: location.mount.bucketUuid, objectKey: location.key }, headers: { Accept: 'application/octet-stream' }, timeout: 30 * 60 * 1000 });
  }
}

// Exposed solely for deterministic contract tests with mocked fetch; no secrets are exported.
export const internals = { CookieJar, PlatformClient, Provider, normalize, mountsOf, cleanPath };

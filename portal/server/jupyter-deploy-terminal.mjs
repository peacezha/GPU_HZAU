import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { NOTEBOOK_ID } from './jupyter-proxy.mjs';

const READY = 'WORKBENCH_JUPYTER_READY';
const FOCUSED_TERMINAL = 'textarea.xterm-helper-textarea:focus-within';
const SHELL_SOURCE = /^python3 - <<'COMPUTE_JUPYTER_SETUP'\n([\s\S]+)\nCOMPUTE_JUPYTER_SETUP\n?$/;
const WORKSPACE_TIMEOUT = 45_000;
const DEPLOY_TIMEOUT = 1_900_000;

function deploymentError(status, message) {
  return Object.assign(new Error(message), { status, code: 'JUPYTER_DEPLOY_TERMINAL' });
}

async function browserFor(chromium, signal) {
  for (const channel of ['msedge', 'chrome']) {
    signal.throwIfAborted();
    try {
      return await chromium.launch({ channel, headless: false, chromiumSandbox: true, timeout: 15_000 });
    } catch { /* Try the other supported browser without changing user settings. */ }
  }
  throw deploymentError(503, '无法启动用于部署的浏览器。请确认本机已安装 Microsoft Edge 或 Google Chrome。');
}

function workspaceOrigin(proxy) {
  const address = proxy?.server?.address();
  if (!address || address.address !== '127.0.0.1') throw deploymentError(503, '网页工作区代理未运行。请重新启动算力工作台。');
  return `http://127.0.0.1:${address.port}`;
}

function isWorkspace(value, origin, prefix, websocket = false) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && url.pathname.startsWith(prefix)
      && url.origin === (websocket ? origin.replace(/^http:/, 'ws:') : origin);
  } catch { return false; }
}

function observeTerminal(page, origin, prefix, shellMarker, resultMarker) {
  let shellReady = false;
  let ready = false;
  let exitCode;
  page.on('websocket', socket => {
    if (!isWorkspace(socket.url(), origin, prefix, true)) return;
    let tail = '';
    socket.on('framereceived', ({ payload }) => {
      // VS Code's terminal events travel as serialized strings inside binary
      // WebSocket frames. Retain a short suffix only for fragmented markers.
      const chunk = typeof payload === 'string' ? payload : payload.toString('latin1');
      const data = tail + chunk;
      shellReady ||= data.includes(shellMarker);
      ready ||= data.includes(READY);
      const status = new RegExp(`${resultMarker}:([0-9]{1,3})(?=[\\\\\r\n])`).exec(data);
      if (status) exitCode = Number(status[1]);
      tail = data.slice(-128);
    });
  });
  return { shellReady: () => shellReady, result: () => ({ ready, exitCode }) };
}

async function waitFor(read, timeout, signal) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    signal.throwIfAborted();
    const value = read();
    if (value !== undefined && value !== false) return value;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

async function enterTerminalLine(page, text) {
  const terminal = page.locator(FOCUSED_TERMINAL);
  await terminal.evaluate((textarea, line) => {
    // Send through xterm's normal paste handler. No host clipboard or
    // persisted browser profile receives the command or pairing token.
    const data = new DataTransfer();
    data.setData('text/plain', line);
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text, { timeout: 5_000 });
  await page.keyboard.press('Enter');
}

async function openTerminal(page) {
  try { await page.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: WORKSPACE_TIMEOUT }); }
  catch { throw deploymentError(502, '工作区网页已打开，但编辑器未加载完成。'); }
  const palette = page.locator('.quick-input-widget input').filter({ visible: true }).first();
  try {
    // The web app can reserve browser shortcuts or restore focus late.
    // Prefer the same application-menu route used by code-server's own tests.
    const applicationMenu = page.locator('[aria-label="Application Menu"], [aria-label="应用程序菜单"]').filter({ visible: true }).first();
    if (await applicationMenu.isVisible()) {
      try {
        await applicationMenu.click({ timeout: 4000 });
        const view = applicationMenu.getByText(/^(View|查看|视图)$/).first();
        await view.hover({ timeout: 4000 });
        await view.click({ timeout: 4000 });
        await applicationMenu.getByText(/^(Command Palette[.。…]*|命令面板[.。…]*)$/).first().click({ timeout: 4000 });
      } catch {
        await page.keyboard.press('Escape');
      }
    }
    if (!await palette.isVisible()) await page.keyboard.press('F1');
    await palette.fill('>Terminal: Create New Terminal', { timeout: 8000 });
  } catch {
    if (await page.getByRole('button', { name: /^(?:Yes, I trust the authors|是的，我信任作者)/i }).first().isVisible()) {
      throw deploymentError(409, '工作区在等待目录信任选择，终端尚未打开。');
    }
    throw deploymentError(502, '编辑器已加载，但网页命令面板未打开。');
  }
  try {
    const command = page.getByText(/^(?:Terminal: Create New Terminal|终端[：:]\s*(?:创建|新建)终端)$/);
    await command.first().click({ timeout: 12_000 });
  } catch { throw deploymentError(502, '网页命令面板中未出现新建终端命令。'); }
  try { await page.locator(FOCUSED_TERMINAL).waitFor({ state: 'attached', timeout: WORKSPACE_TIMEOUT }); }
  catch { throw deploymentError(502, '新建终端已请求，但终端输入区没有就绪。'); }
}

async function navigateWorkspace(page, url, origin, prefix, signal) {
  for (const backoff of [0, 1500, 3000, 6000]) {
    if (backoff) await delay(backoff, undefined, { signal });
    signal.throwIfAborted();
    let failedNavigation;
    const observe = response => {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && response.status() >= 400) failedNavigation = response;
    };
    page.on('response', observe);
    let response;
    try { response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: WORKSPACE_TIMEOUT }); }
    catch (error) {
      // Chromium can reject navigation after receiving an empty HTTP error.
      if (!failedNavigation) throw error;
      response = failedNavigation;
    } finally { page.off('response', observe); }
    if (!response || !isWorkspace(response.url(), origin, prefix)) {
      throw deploymentError(409, '打开的网页与当前实例不一致，请刷新资源后重新部署。');
    }
    if (response.ok()) {
      if (!isWorkspace(page.url(), origin, prefix)) throw deploymentError(409, '打开的网页与当前实例不一致，请刷新资源后重新部署。');
      return;
    }
    const status = response.status();
    const proxyError = response.headers()['x-workbench-proxy-error'];
    if (proxyError === 'upstream-response-rejected') {
      throw deploymentError(502, '平台返回了超出当前实例范围的跳转。请先用工作台打开网页开发环境检查平台登录状态。');
    }
    if (status === 401 || status === 403) {
      const message = proxyError ? '本机工作区会话未通过验证。请重新登录工作台后部署。'
        : `平台拒绝打开当前网页工作区（HTTP ${status}）。请先在工作台打开网页开发环境确认账号权限。`;
      throw deploymentError(status, message);
    }
    if (backoff === 6000 || ![404, 429, 502, 503, 504].includes(status)) {
      throw deploymentError(502, `网页工作区返回 HTTP ${status}。请确认工作区可以打开后重试。`);
    }
  }
}

export function createJupyterTerminalRunner({ getWorkspaceProxy, loadChromium = async () => (await import('playwright-core')).chromium } = {}) {
  return async function runTerminal({ session, resourceId, target, command, signal: externalSignal }) {
    const signal = externalSignal || new AbortController().signal;
    const source = typeof command === 'string' && command.length <= 80_000 && SHELL_SOURCE.exec(command)?.[1];
    const instanceId = target?.instanceId;
    if (!source || !NOTEBOOK_ID.test(instanceId || '') || target.prefix !== `/notebook/${instanceId}/`) {
      throw deploymentError(409, '当前实例或 Jupyter 准备命令已失效。请刷新资源后重试。');
    }
    const proxy = getWorkspaceProxy?.();
    const origin = workspaceOrigin(proxy);
    const random = randomBytes(12).toString('hex');
    const shellMarker = `WB_DEPLOY_SHELL_${random}`;
    const resultMarker = `WB_DEPLOY_RESULT_${random}`;
    let browser, access;
    const cancel = () => { void browser?.close().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    let stage = 'browser';
    try {
      signal.throwIfAborted();
      browser = await browserFor(await loadChromium(), signal);
      signal.throwIfAborted();
      stage = 'workspace';
      try { access = await proxy.openAutomation(session, resourceId, target.prefix); }
      catch (error) {
        if (error.status === 401 || error.status === 409 || error.status === 429) throw deploymentError(error.status, error.message);
        throw error;
      }
      if (!isWorkspace(access.url, origin, target.prefix) || !/^[a-f0-9]{64}$/.test(access.cookie)) {
        throw deploymentError(502, '工作区没有返回可用的部署连接。请刷新后重试。');
      }
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', locale: 'en-US' });
      await context.addCookies([{ name: access.cookieName || 'workspace_session', value: access.cookie, domain: '127.0.0.1', path: target.prefix, httpOnly: true, sameSite: 'Strict' }]);
      await context.route('**/*', route => {
        return isWorkspace(route.request().url(), origin, target.prefix) ? route.continue() : route.abort();
      });
      await context.routeWebSocket('**/*', route => {
        if (isWorkspace(route.url(), origin, target.prefix, true)) route.connectToServer();
        else void route.close();
      });
      const page = await context.newPage();
      const terminal = observeTerminal(page, origin, target.prefix, shellMarker, resultMarker);
      // Open the authenticated instance in an empty code-server window. The
      // bootstrap uses absolute paths and does not need to open a folder.
      const deployUrl = new URL(target.prefix, access.url);
      deployUrl.searchParams.set('ew', 'true');
      await navigateWorkspace(page, deployUrl.href, origin, target.prefix, signal);
      stage = 'shell';
      await openTerminal(page);
      // A fresh Bash terminal must prove it can accept input before it ever
      // sees a token. Disable history in that terminal and hide command echo.
      await enterTerminalLine(page, `if [ -n "$BASH_VERSION" ]; then unset HISTFILE; set +o history; stty -echo && printf '\\n%s%s\\n' 'WB_DEPLOY_' 'SHELL_${random}'; fi`);
      if (!await waitFor(terminal.shellReady, 15_000, signal)) {
        throw deploymentError(502, '网页终端没有确认 Bash 输入。请检查当前算力环境的网页终端是否可以运行命令。');
      }
      signal.throwIfAborted();
      if (!isWorkspace(page.url(), origin, target.prefix)) throw deploymentError(409, '算力实例已变化。请重新部署。');
      stage = 'deploy';
      const encoded = gzipSync(source).toString('base64');
      await enterTerminalLine(page, "WB_DEPLOY_SOURCE=''");
      for (const chunk of encoded.match(/.{1,900}/g)) {
        signal.throwIfAborted();
        await enterTerminalLine(page, `WB_DEPLOY_SOURCE+='${chunk}'`);
      }
      await enterTerminalLine(page, `printf '%s' "$WB_DEPLOY_SOURCE" | python3 -c 'import base64,gzip,sys;exec(compile(gzip.decompress(base64.b64decode(sys.stdin.buffer.read())),"<jupyter-deploy>","exec"))'; status=$?; unset WB_DEPLOY_SOURCE; printf '\\n%s%s:%s\\n' 'WB_DEPLOY_' 'RESULT_${random}' "$status"; exit "$status"`);
      const result = await waitFor(() => {
        const current = terminal.result();
        return current.exitCode === undefined ? undefined : current;
      }, DEPLOY_TIMEOUT, signal);
      if (!result) throw deploymentError(504, '等待远程安装完成超时。请查看当前实例的 Jupyter 安装记录。');
      if (result.exitCode !== 0 || !result.ready) {
        throw deploymentError(502, 'A800 中的 Jupyter 准备失败。详细安装记录在 /home/work/.compute-connect/jupyter/setup.log。');
      }
    } catch (error) {
      if (signal.aborted) throw deploymentError(409, '本次 Jupyter 部署已结束。请刷新资源后重试。');
      if (error?.code === 'JUPYTER_DEPLOY_TERMINAL') throw error;
      const message = stage === 'browser' ? '无法启动用于部署的浏览器。请确认本机已安装 Microsoft Edge 或 Google Chrome。'
        : stage === 'workspace' ? '无法连接当前实例的网页工作区。请确认资源正在运行。'
          : stage === 'shell' ? '无法打开当前实例的网页终端。请检查网页开发环境是否已就绪。'
            : '远程终端连接中断。请刷新当前资源后重新部署。';
      // Playwright errors can contain command arguments or the one-use URL.
      throw deploymentError(502, message);
    } finally {
      signal.removeEventListener('abort', cancel);
      access?.close();
      await browser?.close().catch(() => {});
    }
  };
}

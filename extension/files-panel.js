'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { homedir } = require('node:os');
const { lstat } = require('node:fs/promises');
const { createPanel } = require('./panels');

const styles = `
  body { max-width: 1180px; }
  .panes { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr); gap: 14px; }
  @media (max-width: 640px) { .panes { grid-template-columns: 1fr; } }
  .card { min-width: 0; padding: 14px; }
  h2 { margin: 0 0 8px; font-size: 1.2em; }
  .path { display: block; margin: 8px 0; overflow-wrap: anywhere; }
  ul { margin: 8px 0 0; padding: 0; list-style: none; }
  .listing { overflow: auto; max-height: 54vh; }
  li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 7px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .name { flex: 1 1 9em; min-width: 0; overflow-wrap: anywhere; }
  .notice { margin-top: 14px; }
  .notice p:last-child { margin: 0; }
  .error { color: var(--vscode-errorForeground); }
`;

const body = `
<h1>文件传输</h1>
<p class="muted">选择本机文件后，上传到右侧目录。远程内核可读取上传后的路径，结果也可以从这里下载到本机。</p>
<div class="panes">
  <section class="card" aria-labelledby="local-heading">
    <h2 id="local-heading">本机文件</h2>
    <p class="muted">待上传文件 · 每次最多 20 个，总计 5 GB</p>
    <div class="row"><button id="choose" disabled>选择本机文件…</button><button id="upload" disabled>上传到远端 →</button></div>
    <ul id="local" class="listing" aria-label="待上传文件"></ul>
  </section>
  <section class="card" aria-labelledby="remote-heading">
    <h2 id="remote-heading">远端目录 <span id="resource" class="muted"></span></h2>
    <code id="folder" class="path"></code>
    <div class="row">
      <button id="parent" class="secondary" disabled>上一级</button><button id="refresh" class="secondary" disabled>刷新</button>
      <button id="mkdir" class="secondary" disabled>新建文件夹</button><button id="copyFolder" class="secondary" disabled>复制目录路径</button>
    </div>
    <p id="read-status" class="status" role="status">正在读取远端目录…</p>
    <ul id="remote" class="listing" aria-label="远端文件和文件夹"></ul>
  </section>
</div>
<div id="notice" class="notice" role="status" aria-live="polite"></div>
<section id="completed" class="card notice" hidden><h2>远程内核可读取的文件</h2><ul id="paths"></ul></section>`;

function script() {
  const host = acquireVsCodeApi();
  const get = id => document.getElementById(id);
  const send = (type, index) => host.postMessage({ type, index });
  for (const id of ['choose', 'upload', 'parent', 'refresh', 'mkdir', 'copyFolder']) get(id).onclick = () => send(id);
  function addText(parent, tag, value, style) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (style) node.className = style;
    parent.append(node);
    return node;
  }
  function button(row, label, action, index, busy) {
    const node = addText(row, 'button', label, 'secondary');
    node.disabled = busy;
    node.onclick = () => send(action, index);
  }
  window.addEventListener('message', ({ data }) => {
    if (data?.type !== 'files') return;
    const { busy, folder, local, remote, paths, writable } = data;
    get('resource').textContent = data.resource;
    get('folder').textContent = folder === '/' ? '存储挂载' : folder;
    get('choose').disabled = get('refresh').disabled = busy;
    get('choose').textContent = local.length ? '添加本机文件…' : '选择本机文件…';
    get('upload').disabled = busy || !writable || !local.length;
    get('mkdir').disabled = busy || !writable;
    get('parent').disabled = get('copyFolder').disabled = busy || folder === '/';
    get('read-status').textContent = data.readStatus;
    get('notice').textContent = data.notice;
    get('notice').classList.toggle('error', data.failed);
    for (const id of ['local', 'remote', 'paths']) get(id).replaceChildren();
    if (!local.length) addText(get('local'), 'li', '还没有选择文件。', 'muted');
    local.forEach((item, index) => {
      const row = addText(get('local'), 'li', '');
      addText(row, 'span', item.name, 'name');
      addText(row, 'span', item.size, 'muted');
      button(row, '移除', 'remove', index, busy);
    });
    remote.forEach((item, index) => {
      const row = addText(get('remote'), 'li', '');
      addText(row, 'span', item.name, 'name');
      if (item.directory) button(row, item.supported ? '打开' : '查看说明', 'open', index, busy);
      else {
        addText(row, 'span', item.size, 'muted');
        button(row, '复制路径', 'copyFile', index, busy);
        button(row, '下载', 'download', index, busy);
      }
    });
    get('completed').hidden = !paths.length;
    paths.forEach((value, index) => {
      const row = addText(get('paths'), 'li', '');
      addText(row, 'code', value, 'name');
      button(row, '复制路径', 'copyUploaded', index, busy);
    });
  });
  send('ready');
}

function validPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && value.length <= 2048
    && !/[\\\u0000-\u001f\u007f]/.test(value) && path.posix.normalize(value) === value;
}

function saveName(value) {
  const name = value.slice(0, 180).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  return !name || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(name) ? '下载文件' : name;
}

function createFileTransfer(client, { withTransferProgress, bytes, sessionActive, sessionExpired }) {
  const panels = new Map();

  function open(resource) {
    const previous = panels.get(resource.id);
    if (previous) { previous.reveal(); return; }
    const title = String(resource.name || '算力资源').slice(0, 60);
    const panel = createPanel('computeWorkbench.files', `${title} · 文件传输`, body, script, styles);
    panels.set(resource.id, panel);
    const controller = new AbortController();
    const active = () => sessionActive() && !controller.signal.aborted;
    let folder = '/', mounts = [], remote = [], local = [], paths = [], notice = '';
    let readStatus = '', writable = false, loaded = false, busy = false, failed = false;

    function show() {
      if (!active()) return;
      void panel.webview.postMessage({ type: 'files', resource: title, folder, busy, writable, readStatus, notice, failed, paths,
        local: local.map(file => ({ name: path.basename(file.filename), size: bytes(file.size) })),
        remote: remote.map(item => ({ name: item.name, directory: item.type === 'directory', supported: item.supported !== false, size: bytes(item.size) })) });
    }

    async function read(next = folder, selectDefault = false) {
      folder = next;
      writable = false;
      remote = [];
      readStatus = '正在读取远端目录…';
      show();
      try {
        const query = new URLSearchParams({ resourceId: resource.id, path: folder });
        const data = await client.request(`/api/files?${query}`, { signal: controller.signal });
        if (!active()) return;
        const items = Array.isArray(data.items) ? data.items : [];
        if (Array.isArray(data.mounts)) mounts = data.mounts.map(mount => mount.path);
        if (selectDefault && items.some(item => item.path === '/mnt/data' && item.supported)) return read('/mnt/data');
        writable = folder !== '/' && data.available === true && !data.readOnly;
        remote = items.filter(item => typeof item.name === 'string' && validPath(item.path) && ['directory', 'file'].includes(item.type));
        readStatus = data.available === false ? (data.reason || '此目录暂不可用。')
          : data.readOnly ? '当前目录只读。' : remote.length ? '' : '当前目录没有文件。';
      } catch (error) {
        if (error.status === 401) throw error;
        readStatus = '目录读取失败。' + (error.message || '请刷新重试。');
      }
    }

    async function choose() {
      const selected = await vscode.window.showOpenDialog({ title: '选择要上传的本机文件', defaultUri: vscode.Uri.file(homedir()),
        canSelectFiles: true, canSelectFolders: false, canSelectMany: true });
      if (!selected?.length || !active()) return;
      if (selected.some(file => file.scheme !== 'file')) throw new Error('请选择本机文件。');
      const filenames = [...new Set([...local.map(file => file.filename), ...selected.map(file => file.fsPath)])];
      if (filenames.length > 20) throw new Error('一次最多上传 20 个文件。');
      if (new Set(filenames.map(filename => path.basename(filename))).size !== filenames.length) {
        throw new Error('这批文件包含同名文件，请分别上传到不同目录。');
      }
      const files = await Promise.all(filenames.map(async filename => {
        const info = await lstat(filename);
        if (!info.isFile()) throw new Error('请选择普通文件。');
        return { filename, size: info.size };
      }));
      local = files;
    }

    const transfer = (title, operation) => withTransferProgress(title, ({ signal, onProgress }) =>
      operation({ signal: AbortSignal.any([signal, controller.signal]), onProgress }));

    async function upload() {
      const filenames = local.map(file => file.filename);
      let result;
      paths = [];
      try {
        result = await transfer('上传到 ' + folder, options => client.upload(resource.id, folder, filenames, options));
      } catch (error) {
        if (error.status === 401 || !active()) throw error;
        await read();
        if (error.name !== 'AbortError' && error.code !== 'CANCELLED') throw error;
        notice = '已取消上传。请在右侧查看平台已保存的文件。';
        return;
      }
      if (!active()) return;
      const count = result?.count;
      if (result?.ok !== true || !Number.isSafeInteger(count) || count < 0 || count > filenames.length) {
        await read();
        throw new Error('服务器没有确认上传结果，请核对右侧目录。');
      }
      const expected = filenames.map(filename => path.posix.join(folder, path.basename(filename)));
      const uploaded = Array.isArray(result.uploaded) ? result.uploaded : [];
      paths = count === filenames.length ? expected : expected.filter(value => uploaded.some(file => file?.path === value));
      local = local.filter((_, index) => !paths.includes(expected[index]));
      notice = `服务器确认上传 ${count}/${filenames.length} 个文件到 ${folder}。`;
      failed = count !== filenames.length;
      await read();
    }

    async function download(item) {
      const downloads = path.join(homedir(), 'Downloads');
      const preferred = await lstat(downloads).then(info => info.isDirectory() ? downloads : homedir(), () => homedir());
      const destination = await vscode.window.showSaveDialog({ title: '下载 ' + item.name + ' 到本机',
        defaultUri: vscode.Uri.file(path.join(preferred, saveName(item.name))) });
      if (!destination || !active()) return;
      if (destination.scheme !== 'file') throw new Error('请选择本机保存位置。');
      await transfer('下载 ' + item.name, options => client.download(resource.id, item.path, destination.fsPath, options));
      notice = '已下载到 ' + destination.fsPath + '。';
    }

    async function mkdir() {
      const valid = value => /^[\u4e00-\u9fa5a-zA-Z0-9_.-]{1,64}$/.test(value) && value !== '.' && value !== '..';
      const name = await vscode.window.showInputBox({ title: '新建远端文件夹', prompt: '创建位置 ' + folder,
        validateInput: value => valid(value) ? undefined : '请输入 1 至 64 位中文、字母、数字、点、下划线或短横线。' });
      if (!name || !valid(name) || !active()) return;
      await client.request('/api/files/mkdir', { method: 'POST', json: { resourceId: resource.id, path: folder, name }, signal: controller.signal });
      await read();
    }

    const copy = async value => {
      if (!value) return;
      await vscode.env.clipboard.writeText(value);
      notice = '已复制远端路径 ' + value + '。';
    };

    const receiver = panel.webview.onDidReceiveMessage(async message => {
      if (!active() || !message) return;
      const { type, index } = message;
      if (busy) { if (type === 'ready') show(); return; }
      const selected = Number.isSafeInteger(index) && index >= 0 ? index : -1;
      const item = remote[selected];
      busy = true;
      if (type !== 'ready') { notice = ''; failed = false; }
      show();
      try {
        if (type === 'ready' && !loaded) { loaded = true; await read('/', true); }
        if (type === 'refresh') await read();
        if (type === 'choose') await choose();
        if (type === 'remove' && local[selected]) local.splice(selected, 1);
        if (type === 'upload' && writable && local.length) await upload();
        if (type === 'parent' && folder !== '/') await read(mounts.includes(folder) ? '/' : path.posix.dirname(folder));
        if (type === 'open' && item?.type === 'directory') {
          if (item.supported === false) notice = item.reason || '请在网页开发环境中访问此目录。';
          else await read(item.path);
        }
        if (type === 'copyFolder' && folder !== '/') await copy(folder);
        if (type === 'copyFile' && item?.type === 'file') await copy(item.path);
        if (type === 'copyUploaded') await copy(paths[selected]);
        if (type === 'download' && item?.type === 'file') await download(item);
        if (type === 'mkdir' && writable) await mkdir();
      } catch (error) {
        if (error.status === 401) await sessionExpired();
        else if (error.name !== 'AbortError' && error.code !== 'CANCELLED') {
          failed = true;
          notice = String(error.message || '操作失败，请重试。').slice(0, 300);
        }
      } finally { busy = false; show(); }
    });

    panel.onDidDispose(() => {
      controller.abort();
      receiver.dispose();
      panels.delete(resource.id);
    });
  }

  return { open, close: () => { for (const panel of panels.values()) panel.dispose(); } };
}

module.exports = { createFileTransfer };

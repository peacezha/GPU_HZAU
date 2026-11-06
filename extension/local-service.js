'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

function createLocalService(extensionPath) {
  const entry = pathToFileURL(path.join(extensionPath, 'backend', 'server', 'index.mjs'));
  let running;
  let closed = false;
  return {
    async get() {
      if (closed) throw new Error('算力工作台已关闭。');
      running ??= import(entry.href).then(module => module.startWorkbench()).catch(() => {
        running = undefined;
        throw new Error('插件内置服务启动失败。请重载 VS Code 窗口后重试。');
      });
      return running;
    },
    async close() {
      closed = true;
      const service = await running?.catch(() => undefined);
      await service?.close();
    },
  };
}

module.exports = { createLocalService };

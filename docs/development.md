# 本地构建与测试

安装包的使用说明在[仓库首页](../README.md)。以下命令供维护源码和重建 VSIX 使用。

需要 Node.js 22 或更新版本、npm 和 Python 3.9 或更新版本。以下命令在仓库根目录运行。

```powershell
npm ci --prefix portal
npm install --prefix .build --no-save @vscode/vsce@4.1.0
python scripts/package-vsix.py .build/node_modules/@vscode/vsce/vsce
node --test portal/test/*.test.mjs
```

构建产物在 `downloads/`。打包器按 `portal/package-lock.json` 检查已安装依赖，并核对 Jupyter 离线包的 SHA-256。离线包适配 Linux x86_64、Python 3.12。

| 目录 | 内容 |
| --- | --- |
| `extension/` | VS Code 侧栏、文件传输和 Jupyter 连接界面 |
| `portal/` | 本机服务、工作区和 Jupyter 代理、平台适配与测试 |
| `portal/connectors/` | 远端引导脚本和离线依赖包 |
| `downloads/` | 可安装的 VSIX 和校验值 |

本机服务在扩展首次使用时启动，仅监听 `127.0.0.1`。平台登录会话和 AI 配置保存在内存中。请避免把账号、验证码、连接令牌、模型密钥或含个人数据的截图提交到仓库。

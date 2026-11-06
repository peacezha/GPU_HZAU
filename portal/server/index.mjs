import express from 'express';
import multer from 'multer';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createTunnelManager } from './tunnel-manager.mjs';
import { createJupyterManager } from './jupyter-manager.mjs';
import { createJupyterProxy } from './jupyter-proxy.mjs';
import { createWorkspaceProxy } from './workspace-proxy.mjs';
import { createJupyterTerminalRunner } from './jupyter-deploy-terminal.mjs';
import { login as platformLogin, createChallenge as platformChallenge } from './provider.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const token = () => randomBytes(32).toString('hex');
const fail = (status, message, code = 'REQUEST_FAILED') => Object.assign(new Error(message), { status, code });
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApp({ login, createChallenge, sessionTtlMs = 8 * 3600 * 1000, fetchImpl = fetch, tunnelManager = createTunnelManager(), createTerminalRunner, sessionCookie = 'portal_session' } = {}) {
  const app = express();
  const runTerminal = createTerminalRunner?.({ getWorkspaceProxy: () => app.locals.workspaceProxy });
  const jupyterManager = createJupyterManager({ getProxy: () => app.locals.jupyterProxy, fetchImpl, runTerminal });
  const sessions = new Map();
  const attempts = new Map();
  const sessionPattern = new RegExp(`(?:^|;\\s*)${sessionCookie}=([a-f0-9]{64})(?:;|$)`);
  const activeUploads=new Set();
  const stagingRoot=path.join(tmpdir(),'compute-workspace-uploads');
  const stagingReady=(async()=>{
    await mkdir(stagingRoot,{recursive:true});
    for(const name of await readdir(stagingRoot)){
      if(!/^[a-f0-9]{64}$/.test(name))continue;
      const target=path.resolve(stagingRoot,name);
      if(path.dirname(target)!==path.resolve(stagingRoot))continue;
      try{if(Date.now()-(await stat(target)).mtimeMs>24*3600*1000)await rm(target,{recursive:true,force:true});}catch{}
    }
  })();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const hostname = req.hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname) && hostname !== process.env.PORTAL_HOSTNAME) return next(fail(403, '访问域名未配置。', 'HOST_NOT_ALLOWED'));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const workspacePort = app.locals.workspaceProxy?.server?.address()?.port;
    const workspaceFrame = workspacePort ? ` http://127.0.0.1:${workspacePort}` : '';
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src https://xrapi.wuhan.net.cn:9443${workspaceFrame}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`);
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({limit:'256kb'}));
  app.use('/api', (req, res, next) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== `${req.protocol}://${req.headers.host}`) return next(fail(403,'请求来源不匹配。','ORIGIN_REJECTED'));
      if (req.headers['sec-fetch-site'] === 'cross-site') return next(fail(403,'不接受跨站请求。','ORIGIN_REJECTED'));
    }
    const sid = sessionPattern.exec(req.headers.cookie || '')?.[1];
    let session = sessions.get(sid);
    if (session && session.expiresAt < Date.now()) { jupyterManager.logout(session); session.provider?.close?.(); sessions.delete(sid); session = null; }
    req.session = session;
    req.sid = sid;
    next();
  });
  const describe = session => ({ authenticated: !!session, username: session?.username || '', csrfToken: session?.csrfToken || '', capabilities:{resources:true,files:true,workspace:true}, warnings:[] });
  app.get('/api/health', (req,res) => res.json({ok:true,version:'1.0.0'}));
  app.get('/api/session', (req,res) => res.json(describe(req.session)));
  app.get('/api/login/challenge',async(req,res)=>{
    const key=`challenge:${req.ip}`,now=Date.now(),entry=attempts.get(key);
    if(entry&&entry.until>now&&entry.count>=30)throw fail(429,'验证码请求过于频繁，请稍后再试。','RATE_LIMITED');
    attempts.set(key,{count:entry?.until>now?entry.count+1:1,until:now+60000});
    res.json(await createChallenge());
  });
  app.post('/api/login', async (req,res) => {
    const key=req.ip, now=Date.now();
    const entry=attempts.get(key);
    if (entry && entry.until>now && entry.count>=8) throw fail(429,'登录尝试过于频繁，请稍后再试。','RATE_LIMITED');
    attempts.set(key,{count: entry?.until>now ? entry.count+1:1,until:now+10*60*1000});
    const {username,password,challengeId,captchaCode}=req.body || {};
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password || username.length>128 || password.length>512) throw fail(400,'请输入用户名和密码。','INVALID_CREDENTIALS');
    const provider = await login(username.trim(),password,{challengeId,captchaCode});
    // Never retain the submitted password in the session.
    if(req.sid){if(req.session)jupyterManager.logout(req.session);req.session?.provider?.close?.();sessions.delete(req.sid);}
    const sid=token(), session={username:username.trim(),provider,csrfToken:token(),expiresAt:now+sessionTtlMs,ai:{baseUrl:'',model:'',apiKey:''}};
    session._sid=sid;
    sessions.set(sid,session);
    attempts.delete(key);
    res.cookie(sessionCookie,sid,{httpOnly:true,sameSite:'strict',secure:req.secure,path:'/',maxAge:sessionTtlMs});
    res.json(describe(session));
  });
  app.use('/api', (req,res,next) => {
    if(!req.session) return next(fail(401,'请先登录算力平台。','LOGIN_REQUIRED'));
    if(!['GET','HEAD','OPTIONS'].includes(req.method) && !safeEqual(req.headers['x-csrf-token'],req.session.csrfToken)) return next(fail(403,'会话验证失败，请刷新页面。','CSRF_REJECTED'));
    next();
  });
  app.post('/api/logout',(req,res)=>{jupyterManager.logout(req.session);req.session.provider?.close?.();sessions.delete(req.sid);res.clearCookie(sessionCookie,{path:'/'});res.json({ok:true});});
  app.get('/api/resources',async(req,res)=>res.json(await req.session.provider.listResources()));
  app.get('/api/resources/:id',async(req,res)=>res.json(await req.session.provider.getResource(req.params.id)));
  app.get('/api/resources/:id/diagnostics',async(req,res)=>res.json(await req.session.provider.getResourceDiagnostics(req.params.id)));
  app.get('/api/resources/:id/billing', async (req, res) => res.json(await req.session.provider.getResourceBilling(req.params.id, req.query.month)));
  app.post('/api/resources/:id/start',async(req,res)=>res.json(await req.session.provider.startResource(req.params.id)));
  app.post('/api/resources/:id/stop', async (req, res) => {
    const result = await req.session.provider.stopResource(req.params.id);
    jupyterManager.resourceStopped(req.session, req.params.id);
    res.json(result);
  });
  app.get('/api/resources/:id/tunnel', async (req, res) => res.json(await tunnelManager.status(req.session, req.params.id)));
  app.post('/api/resources/:id/tunnel/prepare', async (req, res) => res.json(await tunnelManager.prepare(req.session, req.params.id)));
  app.post('/api/resources/:id/tunnel/start', async (req, res) => res.json(await tunnelManager.start(req.session, req.params.id, req.body || {})));
  app.post('/api/resources/:id/tunnel/stop', async (req, res) => res.json(await tunnelManager.stop(req.session, req.params.id)));
  app.get('/api/resources/:id/jupyter', async (req, res) => res.json(await jupyterManager.status(req.session, req.params.id)));
  app.post('/api/resources/:id/jupyter/prepare', async (req, res) => res.json(await jupyterManager.prepare(req.session, req.params.id, req.body || {})));
  app.post('/api/resources/:id/jupyter/deploy', async (req, res) => res.json(await jupyterManager.deploy(req.session, req.params.id)));
  app.post('/api/resources/:id/jupyter/connect', async (req, res) => res.json(await jupyterManager.connect(req.session, req.params.id)));
  app.post('/api/resources/:id/jupyter/disconnect', (req, res) => res.json(jupyterManager.disconnect(req.session, req.params.id)));
  app.get('/api/resources/:id/workspace',async(req,res)=>{
    const workspace=await req.session.provider.getWorkspace(req.params.id);
    if(workspace.supported && app.locals.workspaceProxy){
      try{
        const connection=await app.locals.workspaceProxy.issue(req.session,req.params.id);
        if(connection?.proxyUrl)Object.assign(workspace,connection,{requiresBrowserSession:false,reason:'工作区通过本机会话连接。若浏览器限制内嵌，请在新窗口打开。'});
        else if(connection?.reason)workspace.reason=connection.reason;
      }catch(error){workspace.reason=error.status?error.message:'工作区连接暂时不可用，请稍后重试。';}
    }
    res.json(workspace);
  });
  const cleanPath = value => {
    if(typeof value !== 'string' || value.length>2048 || value.includes('\0') || value.includes('\\') || value.split('/').includes('..')) throw fail(400,'目录路径无效。','INVALID_PATH');
    return value || '/';
  };
  app.get('/api/files',async(req,res)=>res.json(await req.session.provider.listFiles(String(req.query.resourceId||''),cleanPath(req.query.path || '/mnt/data/'))));
  app.post('/api/files/mkdir',async(req,res)=>{
    const {resourceId,path:folder,name}=req.body||{};
    if(typeof name!=='string'||!name.trim()||/[\\/\x00-\x1f]/.test(name)||['.','..'].includes(name)) throw fail(400,'文件夹名称无效。','INVALID_NAME');
    res.json(await req.session.provider.mkdir(String(resourceId||''),cleanPath(folder),name));
  });
  app.post('/api/files/upload',async(req,res,next)=>{
    const budget=Number(process.env.MAX_UPLOAD_BYTES || 5*1024**3);
    const contentLength=Number(req.headers['content-length']);
    if(!Number.isSafeInteger(contentLength)||contentLength<1)throw fail(411,'上传需要提供文件总大小。','UPLOAD_LENGTH_REQUIRED');
    if(contentLength>budget+1024*1024)throw fail(413,'单次上传总量超出限制（默认 5GB）。','UPLOAD_TOO_LARGE');
    await stagingReady;
    const dir=path.join(stagingRoot,token());
    await mkdir(dir,{recursive:true});
    activeUploads.add(dir);
    const upload=multer({dest:dir,defParamCharset:'utf8',limits:{files:20,fields:0,parts:21,fileSize:budget}}).array('files',20);
    upload(req,res,async error=>{
      try {
        if(error) throw error;
        if(!req.files?.length) throw fail(400,'请选择上传文件。','NO_FILES');
        const files=req.files.map(f=>({name:f.originalname,path:f.path,size:f.size,mimeType:f.mimetype}));
        res.json(await req.session.provider.uploadFiles(String(req.query.resourceId||''),cleanPath(req.query.path||'/mnt/data/'),files));
      }catch(e){next(e);}finally{
        activeUploads.delete(dir);
        try{await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}catch{console.warn('临时上传数据未能立即清理，后续启动时会重试清理。');}
      }
    });
  });
  app.get('/api/files/download',async(req,res)=>{
    const remote=await req.session.provider.downloadFile(String(req.query.resourceId||''),cleanPath(req.query.path));
    if(!remote?.body) throw fail(502,'数据服务未返回文件。','DOWNLOAD_FAILED');
    const filename=path.posix.basename(String(req.query.path));
    res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type','application/octet-stream');
    await pipeline(Readable.fromWeb(remote.body),res);
  });
  app.get('/api/ai/config',(req,res)=>res.json({baseUrl:req.session.ai.baseUrl,model:req.session.ai.model,hasKey:!!req.session.ai.apiKey}));
  app.put('/api/ai/config',(req,res)=>{
    const {baseUrl,model,apiKey}=req.body||{};
    let url;try{url=new URL(baseUrl);}catch{throw fail(400,'请输入完整的模型 API 地址。','INVALID_AI_URL');}
    if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw fail(400,'模型 API 需使用 HTTPS，本机服务可使用 HTTP。','INVALID_AI_URL');
    if(typeof model!=='string'||!model.trim()||model.length>200)throw fail(400,'请填写模型名称。','INVALID_MODEL');
    if(typeof apiKey!=='string'||apiKey.length>8192)throw fail(400,'API Key 格式无效。','INVALID_API_KEY');
    const endpoint=url.toString().replace(/\/$/,'');
    const sameEndpoint=endpoint===req.session.ai.baseUrl;
    if(!apiKey && !sameEndpoint) req.session.ai.apiKey='';
    req.session.ai={baseUrl:endpoint,model:model.trim(),apiKey:apiKey||(sameEndpoint?req.session.ai.apiKey:'')};
    res.json({ok:true,hasKey:!!req.session.ai.apiKey});
  });
  app.post('/api/ai/chat',async(req,res)=>{
    const cfg=req.session.ai;
    if(!cfg.baseUrl||!cfg.model)throw fail(409,'请先配置模型 API 地址、模型名称和密钥。','AI_NOT_CONFIGURED');
    const messages=req.body?.messages;
    if(!Array.isArray(messages)||!messages.length||messages.length>80||messages.some(m=>!['user','assistant'].includes(m.role)||typeof m.content!=='string'||m.content.length>30000))throw fail(400,'聊天内容格式无效或过长。','INVALID_MESSAGES');
    const url=cfg.baseUrl.endsWith('/chat/completions')?cfg.baseUrl:`${cfg.baseUrl}/chat/completions`;
    const upstream=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json',...(cfg.apiKey?{Authorization:`Bearer ${cfg.apiKey}`}:{})},body:JSON.stringify({model:cfg.model,messages:[{role:'system',content:'你是科研算力工作台助手。帮助用户编写代码、分析报错、规划数据处理。你没有执行命令、读取服务器文件或管理资源的工具，请勿声称已经执行操作。'},...messages],stream:false}),signal:AbortSignal.timeout(120000),redirect:'error'});
    if(!upstream.ok)throw fail(502,`模型服务返回 ${upstream.status}，请检查地址、模型和密钥。`,'AI_UPSTREAM_ERROR');
    const result=await upstream.json();
    const content=result.choices?.[0]?.message?.content;
    if(typeof content!=='string')throw fail(502,'模型服务没有返回兼容的聊天内容。','AI_FORMAT_ERROR');
    res.json({content});
  });
  app.use('/api',(req,res)=>res.status(404).json({error:'NOT_FOUND',message:'接口不存在。',code:'NOT_FOUND'}));
  app.use(express.static(path.join(root,'public'),{index:'index.html',etag:true}));
  app.use((error,req,res,next)=>{
    if(res.headersSent)return next(error);
    const status=error.status|| (error.code?.startsWith('LIMIT_')?413:500);
    if(status===401&&req.path!=='/api/login'&&req.sid){jupyterManager.logout(req.session);req.session?.provider?.close?.();sessions.delete(req.sid);res.clearCookie(sessionCookie,{path:'/'});}
    const message=status===500?'操作失败，请稍后重试；上游连接可能暂时不可用。':error.message;
    res.status(status).json({error:error.code||'REQUEST_FAILED',code:error.code||'REQUEST_FAILED',message});
  });
  const cleanup=setInterval(()=>{for(const [id,s]of sessions)if(s.expiresAt<Date.now()){jupyterManager.logout(s);s.provider?.close?.();sessions.delete(id);}},60000);cleanup.unref();
  app.locals.close=async()=>{clearInterval(cleanup);for(const s of sessions.values()){jupyterManager.logout(s);s.provider?.close?.();}sessions.clear();await Promise.allSettled([...activeUploads].map(dir=>rm(dir,{recursive:true,force:true})));activeUploads.clear();await Promise.all([app.locals.workspaceProxy?.close(),app.locals.jupyterProxy?.close()]);};
  app.locals.getSession=sid=>{const session=sessions.get(sid);return session&&session.expiresAt>Date.now()?session:null;};
  return app;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

export async function startWorkbench({ port = 0, workspacePort = 0, jupyterPort = 0, host = '127.0.0.1', legacy = false,
  login = platformLogin, createChallenge = platformChallenge } = {}) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('本机服务仅监听回环地址。');
  const suffix = legacy ? '' : '_' + token().slice(0, 16);
  const sessionCookie = 'portal_session' + suffix;
  const app = createApp({ login, createChallenge, sessionCookie, createTerminalRunner: createJupyterTerminalRunner });
  const server = createServer(app);
  server.requestTimeout = 30 * 60 * 1000;
  let closing;
  function close() {
    closing ??= Promise.all([
      app.locals.close(),
      new Promise(resolve => {
        if (!server.listening) return resolve();
        server.close(resolve);
        server.closeAllConnections();
      }),
    ]).then(() => undefined);
    return closing;
  }
  try {
    const apiPort = await listen(server, port, host);
    const origin = `http://${host === '::1' ? '[::1]' : host}:${apiPort}`;
    const getSession = sid => app.locals.getSession(sid);
    const workspaceProxy = createWorkspaceProxy({ getSession, portalPort: apiPort, cookieName: 'workspace_session' + suffix });
    const jupyterProxy = createJupyterProxy({ getSession });
    let workspaceOrigin, jupyterOrigin;
    try {
      workspaceOrigin = `http://127.0.0.1:${await listen(workspaceProxy.server, workspacePort, '127.0.0.1')}`;
      app.locals.workspaceProxy = workspaceProxy;
    } catch (error) {
      await workspaceProxy.close();
      if (!legacy) { await jupyterProxy.close(); throw error; }
      console.warn('工作区连接端口暂不可用，资源与文件功能仍可使用。');
    }
    try {
      jupyterOrigin = await jupyterProxy.listen(jupyterPort);
      app.locals.jupyterProxy = jupyterProxy;
    } catch (error) {
      await jupyterProxy.close();
      if (!legacy) throw error;
      console.warn('本机 Jupyter 连接端口暂不可用。');
    }
    return { origin, workspaceOrigin, jupyterOrigin, sessionCookie, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await startWorkbench({ port: Number(process.env.PORT || 4318), workspacePort: 4320, jupyterPort: 4321,
    host: process.env.HOST || '127.0.0.1', legacy: true });
  console.log(`算力工作台已启动：${service.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
}

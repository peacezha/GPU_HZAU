import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import assert from 'node:assert/strict';
import {createWorkspaceProxy} from '../../server/workspace-proxy.mjs';
const all=new Set();let phase='gap';
const upstream=http.createServer((_req,res)=>res.end('alive'));
upstream.on('connection',socket=>{all.add(socket);socket.on('error',()=>socket.destroy());socket.on('close',()=>all.delete(socket));});
upstream.on('upgrade',(_req,socket)=>{
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
https.request=(options,cb)=>{
  const request=http.request({...options,protocol:'http:',hostname:'127.0.0.1',port:upstream.address().port,agent:undefined},cb);
  request.on('upgrade',(_response,socket)=>{
    if(phase==='outgoing')setTimeout(()=>socket.emit('error',Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'})),5);
  });
  return request;
};
const session={_sid:'a'.repeat(64),expiresAt:Date.now()+60000,provider:{getWorkspaceConnection:async()=>({url:'https://xrapi.wuhan.net.cn:9443/notebook/reset-test/',headers:{Cookie:'remote=test-only'}})}};
const proxy=createWorkspaceProxy({getSession:async()=>{await new Promise(r=>setTimeout(r,15));return session;}});
proxy.server.on('upgrade',(_req,socket)=>{
  if(phase==='gap')setImmediate(()=>socket.emit('error',Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'})));
  if(phase==='incoming')setTimeout(()=>socket.emit('error',Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'})),35);
});
await new Promise(r=>proxy.server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${proxy.server.address().port}`;
const ticket=await proxy.issue(session,'resource-test');
const boot=await fetch(ticket.proxyUrl,{redirect:'manual'});
const cookie=boot.headers.get('set-cookie').split(';')[0];
async function disconnect(){
  const socket=net.connect(proxy.server.address().port,'127.0.0.1');
  socket.on('error',()=>socket.destroy());
  await new Promise(r=>socket.once('connect',r));
  socket.write(`GET /notebook/reset-test/ HTTP/1.1\r\nHost: ${new URL(base).host}\r\nOrigin: ${base}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGVzdC10ZXN0LXRlc3QxMg==\r\n\r\n`);
  socket.resume();
  await new Promise(r=>setTimeout(r,65));
  socket.destroy();
}
try{
  for(const mode of ['gap','incoming','outgoing']){phase=mode;for(let i=0;i<5;i++)await disconnect();}
  const response=await fetch(`${base}/notebook/reset-test/`,{headers:{Cookie:cookie}});
  assert.equal(await response.text(),'alive');
  console.log('survived 15 reset/upgrade cycles');
}finally{
  await proxy.close();for(const socket of all)socket.destroy();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));
}

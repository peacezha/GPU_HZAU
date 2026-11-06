import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createApp } from '../server/index.mjs';

async function setup(t, overrides={}) {
  let uploadedPath;
  const provider={listResources:async()=>({items:[{id:'one',name:'real-test-resource'}],source:'live'}),getResource:async id=>({id,name:'test'}),getWorkspace:async()=>({url:'https://xrapi.wuhan.net.cn:9443/notebook/test/',supported:true}),listFiles:async()=>({items:[],available:true}),uploadFiles:async(id,dir,files)=>{uploadedPath=files[0].path;assert.equal((await readFile(uploadedPath)).toString(),'small-test-data');return {ok:true};},close:()=>{}};
  const app=createApp({login:async(user,pass,challenge)=>{assert.equal(user,'test-user');assert.equal(pass,'test-password');assert.equal(challenge.captchaCode,'ABCD');return provider;},createChallenge:async()=>({challengeId:'test-challenge',captchaImage:'data:image/png;base64,AA=='}),...overrides});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await app.locals.close();server.closeAllConnections();server.close();});
  const response=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'test-user',password:'test-password',challengeId:'test-challenge',captchaCode:'ABCD'})});
  assert.equal(response.status,200);
  const session=await response.json();
  const cookie=response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'),/HttpOnly/);assert.match(response.headers.get('set-cookie'),/SameSite=Strict/);
  return {base,session,cookie,headers:{cookie,'X-CSRF-Token':session.csrfToken},getUploadedPath:()=>uploadedPath};
}
test('authenticated resources, session isolation and cookie flags',async t=>{
  const {base,cookie}=await setup(t);
  assert.equal((await fetch(`${base}/api/resources`)).status,401);
  const res=await fetch(`${base}/api/resources`,{headers:{cookie}});
  assert.equal(res.status,200);assert.equal((await res.json()).items[0].id,'one');
  const session=await(await fetch(`${base}/api/session`,{headers:{cookie}})).json();
  assert.equal(session.username,'test-user');assert.equal(session.password,undefined);assert.equal(session.provider,undefined);
});
test('mutations enforce CSRF and origin, logout invalidates session',async t=>{
  const {base,cookie,headers}=await setup(t);
  assert.equal((await fetch(`${base}/api/logout`,{method:'POST',headers:{cookie}})).status,403);
  assert.equal((await fetch(`${base}/api/logout`,{method:'POST',headers:{cookie,'X-CSRF-Token':'é'.repeat(64)}})).status,403);
  assert.equal((await fetch(`${base}/api/logout`,{method:'POST',headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
  assert.equal((await fetch(`${base}/api/logout`,{method:'POST',headers})).status,200);
  assert.equal((await fetch(`${base}/api/resources`,{headers:{cookie}})).status,401);
});
test('Chinese filenames survive browser and RFC5987 multipart forms',async t=>{
  const names=[];
  const {base,headers}=await setup(t,{login:async()=>({uploadFiles:async(id,dir,files)=>{names.push(files[0].name);return {ok:true};}})});
  const form=new FormData();form.append('files',new Blob(['data']),'测试.txt');
  assert.equal((await fetch(`${base}/api/files/upload?resourceId=one&path=/mnt/data/`,{method:'POST',headers,body:form})).status,200);
  const boundary='TestBoundary';
  const body=`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename*=UTF-8''%E6%B5%8B%E8%AF%95.txt\r\nContent-Type: text/plain\r\n\r\ndata\r\n--${boundary}--\r\n`;
  assert.equal((await fetch(`${base}/api/files/upload?resourceId=one&path=/mnt/data/`,{method:'POST',headers:{...headers,'Content-Type':`multipart/form-data; boundary=${boundary}`},body})).status,200);
  assert.deepEqual(names,['测试.txt','测试.txt']);
});
test('multipart non-file fields rejected',async t=>{
  const {base,headers}=await setup(t);
  const form=new FormData();form.append('extra','not allowed');form.append('files',new Blob(['data']),'test.txt');
  assert.equal((await fetch(`${base}/api/files/upload?resourceId=one&path=/mnt/data/`,{method:'POST',headers,body:form})).status,413);
});
test('path traversal rejected before provider',async t=>{
  const {base,cookie}=await setup(t);
  for(const folder of ['/mnt/data/../secret','/mnt/data/\\secret']){
    const res=await fetch(`${base}/api/files?path=${encodeURIComponent(folder)}`,{headers:{cookie}});assert.equal(res.status,400);
  }
});
test('start existing resource requires session and CSRF',async t=>{
  let resource;
  const {base,headers,cookie}=await setup(t,{login:async()=>({startResource:async id=>{resource=id;return {ok:true,id,submitted:true};}})});
  assert.equal((await fetch(`${base}/api/resources/one/start`,{method:'POST'})).status,401);
  assert.equal((await fetch(`${base}/api/resources/one/start`,{method:'POST',headers:{cookie}})).status,403);
  const response=await fetch(`${base}/api/resources/one/start`,{method:'POST',headers});
  assert.equal(response.status,200);assert.equal((await response.json()).submitted,true);assert.equal(resource,'one');
});
test('resource diagnostics requires login and returns provider events',async t=>{
  const {base,cookie}=await setup(t,{login:async()=>({getResourceDiagnostics:async id=>({id,status:'Starting',reason:'Waiting for image',events:[{message:'Pulling image',source:'instance'}]})})});
  assert.equal((await fetch(`${base}/api/resources/one/diagnostics`)).status,401);
  const response=await fetch(`${base}/api/resources/one/diagnostics`,{headers:{cookie}});
  assert.equal(response.status,200);const data=await response.json();assert.equal(data.id,'one');assert.equal(data.events[0].message,'Pulling image');
});
test('uploads reach provider and temporary data is removed',async t=>{
  const {base,headers,getUploadedPath}=await setup(t);
  const form=new FormData();form.append('files',new Blob(['small-test-data']),'small.txt');
  const res=await fetch(`${base}/api/files/upload?resourceId=one&path=/mnt/data/`,{method:'POST',headers,body:form});
  assert.equal(res.status,200);
  for(let attempt=0;attempt<30;attempt++){try{await access(getUploadedPath());await new Promise(resolve=>setTimeout(resolve,10));}catch{return;}}
  assert.fail('Temporary upload was not removed');
});
test('AI config never returns key, only sends user text to chosen API',async t=>{
  let sent;
  const {base,headers,cookie}=await setup(t,{fetchImpl:async(url,options)=>{sent={url,options};return new Response(JSON.stringify({choices:[{message:{content:'test response'}}]}),{headers:{'Content-Type':'application/json'}});}});
  let res=await fetch(`${base}/api/ai/config`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({baseUrl:'https://model.example/v1',model:'configured-model',apiKey:'test-key'})});
  assert.equal(res.status,200);
  const config=await(await fetch(`${base}/api/ai/config`,{headers:{cookie}})).json();assert.equal(config.apiKey,undefined);assert.equal(config.hasKey,true);
  res=await fetch(`${base}/api/ai/chat`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'hello'}],resourceId:'one'})});
  assert.equal((await res.json()).content,'test response');assert.equal(sent.url,'https://model.example/v1/chat/completions');assert.equal(sent.options.headers.Authorization,'Bearer test-key');assert.equal(JSON.parse(sent.options.body).messages.at(-1).content,'hello');
  res=await fetch(`${base}/api/ai/config`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({baseUrl:'https://other-model.example/v1',model:'m',apiKey:''})});assert.equal(res.status,200);
  assert.equal((await(await fetch(`${base}/api/ai/config`,{headers:{cookie}})).json()).hasKey,false);
});
test('unconfigured AI and invalid endpoint fail clearly',async t=>{
  const {base,headers}=await setup(t);
  assert.equal((await fetch(`${base}/api/ai/chat`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"messages":[{"role":"user","content":"hello"}]}' })).status,409);
  assert.equal((await fetch(`${base}/api/ai/config`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({baseUrl:'http://model.example/v1',model:'m',apiKey:'x'})})).status,400);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('workspace service survives resets before authorization and after WebSocket upgrade',()=>{
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/ws-reset-child.mjs',import.meta.url))],{encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,child.stderr||String(child.error||''));
  assert.match(child.stdout,/survived 15 reset\/upgrade cycles/);
});

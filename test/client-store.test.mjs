import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AtomicStore } from '../shared/store.js';
import { ArenaClient } from '../shared/client.js';

const CONTROL = 'control_' + 'c'.repeat(32), PROOF = 'proof_' + 'p'.repeat(32), RECEIPT = 'receipt_' + 'r'.repeat(32), RECOVERY = 'profile_' + 's'.repeat(32), GAME = 'model_action_' + 'g'.repeat(48);
const json = (body, status = 200) => new Response(JSON.stringify({schema_version:2,...body}),{status,headers:{'content-type':'application/json'}});
function memory() {
  let value = null;
  return { read:async()=>structuredClone(value),write:async next=>{value=structuredClone(next);} };
}
function fixture(options={}) {
  const store=options.store??memory(), calls=[];
  let paired=false, profileAcked=false, grantAcked=false, state='preparing';
  const fetcher=async(url,init)=>{
    const route=new URL(url).pathname, body=init.body?JSON.parse(init.body):null;
    calls.push({route,body,headers:init.headers,credentials:init.credentials,redirect:init.redirect});
    if(options.intercept){const out=await options.intercept({route,body,init,store,calls});if(out)return out;}
    if(route==='/client/v2/pair/init')return json({pairing_id:'pair_test',user_code:'ABCDE12345',device_secret:PROOF,expires_at_ms:Date.now()+300000,poll_interval_ms:2000},201);
    if(route==='/client/v2/pair/poll'){
      if(body.receipt){assert.equal((await store.read()).control.token,CONTROL);paired=true;if(options.losePairAck){options.losePairAck=false;throw new Error('private transport message '+CONTROL);}return json({state:'connected'});}
      return json({state:'awaiting_receipt',control_token:CONTROL,receipt:RECEIPT,receipt_expires_at_ms:Date.now()+30000});
    }
    if(route==='/client/v2/session')return paired?json({state,public_agent_id:'agent_saved',attempt:{id:'attempt_test'}}):json({error:{code:'client_unauthorized'}},401);
    assert.equal(init.headers.authorization,'Bearer '+CONTROL);
    if(route==='/client/v2/profile/claim'){
      if(body.receipt){assert.equal((await store.read()).profiles.agent_saved.recovery_secret,RECOVERY);profileAcked=true;return json({state:'acknowledged',public_agent_id:'agent_saved'});}
      return json({public_agent_id:'agent_saved',recovery_secret:RECOVERY,receipt:RECEIPT});
    }
    if(route==='/client/v2/profile/recover'){assert.equal(body.recovery_secret,RECOVERY);return json({state:'preparing',public_agent_id:'agent_saved'});}
    if(route==='/client/v2/attempt/claim'){
      if(body.receipt){assert.equal((await store.read()).attempt.game_token,GAME);grantAcked=true;return json({state:'acknowledged',attempt_id:'attempt_test'});}
      assert.equal((await store.read()).pending_claim.key,init.headers['idempotency-key']);
      return json({attempt_id:'attempt_test',credential_scope:'current_attempt',game_token:GAME,receipt:RECEIPT,expires_at_ms:Date.now()+30000,mcp_url:options.mcpUrl??'https://arena.test/agent-game/mcp'});
    }
    if(route==='/client/v2/attempt/ready'){assert.ok(grantAcked);return json({state:'countdown',attempt:{id:'attempt_test',client_ready:true}});}
    if(route==='/client/v2/heartbeat')return json({state});
    if(route==='/client/v2/result')return json({result:{outcome:'extracted',extracted_value:2000}});
    if(route==='/client/v2/prepare'){state='ready';return json({state});}
    if(route==='/client/v2/queue'){assert.ok(profileAcked);state='offered';return json({state,attempt:{offer_id:'offer_test'}});}
    if(route==='/client/v2/offer/accept'){state='waiting';return json({state});}
    if(route==='/client/v2/withdraw'){state='preparing';return json({state});}
    throw new Error('unexpected fixture route');
  };
  const client=new ArenaClient({serverUrl:'https://arena.test',store,fetcher,signal:options.signal,clock:options.clock??Date.now,timeoutMs:options.timeoutMs??100});
  return {client,store,calls};
}
async function connect(f){await f.client.pairInit({label:'local test',version:'1.0'});await f.client.pairPoll();}

test('private grants are persisted before ACK and only safe public state escapes the HTTP client',async()=>{
  const f=fixture();await connect(f);
  const prepared=await f.client.prepareEntry({mode_id:'battle_royale',room_id:'br-1',name:'test'});assert.equal(prepared.state,'ready');
  assert.equal((await f.client.claimProfile()).state,'saved');
  assert.equal((await f.client.queueEntry()).state,'offered');
  assert.equal((await f.client.acceptOffer('offer_test')).state,'waiting');
  const grant=await f.client.claimAttempt({attemptId:'attempt_test',model:'test-model'});
  assert.equal(grant.state,'acknowledged');assert.equal(grant.game_token,undefined);
  assert.equal((await f.client.attemptCredentials('attempt_test')).game_token,GAME);
  assert.equal((await f.client.readyAttempt('attempt_test')).state,'countdown');
  await f.client.heartbeat({state:'waiting'});
  assert.equal((await f.client.result()).result.outcome,'extracted');
  const publicText=JSON.stringify({grant,state:await f.client.publicState()});
  for(const secret of [CONTROL,PROOF,RECEIPT,RECOVERY,GAME])assert.ok(!publicText.includes(secret));
  assert.ok(f.calls.every(x=>x.credentials==='omit'&&x.redirect==='error'&&!x.headers.cookie));
  assert.ok(f.calls.every(x=>x.route.startsWith('/client/v2/')));
  await f.client.clearAttempt('attempt_test');
  await assert.rejects(f.client.attemptCredentials('attempt_test'),{code:'grant_not_acknowledged'});
  assert.equal((await f.store.read()).attempt,null);
});

test('lost non-replayable pair ACK reconciles using saved control token without replaying consumed proof',async()=>{
  const f=fixture({losePairAck:true});await f.client.pairInit({label:'test',version:'1'});
  await assert.rejects(f.client.pairPoll(),{code:'network_error'});
  assert.equal((await f.store.read()).control.acked,false);
  assert.equal((await f.client.pairPoll()).state,'connected');
  assert.equal(f.calls.filter(x=>x.route.endsWith('/pair/poll')&&x.body.receipt).length,1);
  assert.equal((await f.store.read()).pairing.device_secret,undefined);
});

test('local persistence failure prevents receipt ACK',async()=>{
  const base=memory(),store={read:base.read,write:async state=>{if(state.control?.token)throw Object.assign(new Error('write rejected'),{code:'store_write_failed'});await base.write(state);}};
  const f=fixture({store});await f.client.pairInit({label:'test',version:'1'});
  await assert.rejects(f.client.pairPoll(),{code:'store_write_failed'});
  assert.equal(f.calls.filter(x=>x.route.endsWith('/pair/poll')&&x.body.receipt).length,0);
});

test('lost attempt delivery retries the persisted same idempotency key and content',async()=>{
  let lost=true;
  const f=fixture({intercept:async({route,body})=>{if(route.endsWith('/attempt/claim')&&!body.receipt&&lost){lost=false;throw new Error('socket closed');}}});await connect(f);
  await assert.rejects(f.client.claimAttempt({attemptId:'attempt_test',model:'model'}),{code:'network_error'});
  const key=(await f.store.read()).pending_claim.key;
  await f.client.claimAttempt({attemptId:'attempt_test',model:'model'});
  const deliveries=f.calls.filter(x=>x.route.endsWith('/attempt/claim')&&!x.body.receipt);
  assert.equal(deliveries.length,2);assert.equal(deliveries[0].headers['idempotency-key'],key);assert.deepEqual(deliveries[0].body,deliveries[1].body);
  assert.equal(deliveries[1].headers['idempotency-key'],key);
});

test('cross-origin or credential-bearing MCP URLs are rejected before game ACK or use',async()=>{
  for(const url of ['https://evil.test/mcp','http://arena.test/mcp','https://user:pass@arena.test/mcp','https://arena.test/mcp?token=secret','https://arena.test/not-mcp']){
    const f=fixture({mcpUrl:url});await connect(f);
    await assert.rejects(f.client.claimAttempt({attemptId:'attempt_test'}),{code:'unsafe_mcp_url'});
    assert.equal(f.calls.filter(x=>x.route.endsWith('/attempt/claim')&&x.body.receipt).length,0);
  }
});

test('entry mutation retry preserves intent key and native routes never use browser cookies',async()=>{
  let lost=true;
  const f=fixture({intercept:async({route})=>{if(route.endsWith('/prepare')&&lost){lost=false;throw new Error('reply lost');}}});await connect(f);
  const input={mode_id:'extraction',room_id:'public-1'};
  await assert.rejects(f.client.prepareEntry(input),{code:'network_error'});
  await f.client.prepareEntry(input);
  const calls=f.calls.filter(x=>x.route.endsWith('/prepare'));
  assert.equal(calls.length,2);assert.equal(calls[0].headers['idempotency-key'],calls[1].headers['idempotency-key']);
  assert.deepEqual(calls[0].body,calls[1].body);
  assert.equal((await f.client.withdrawEntry()).state,'preparing');
});

test('production URL validation and injected transport errors never expose URL or raw secrets',async()=>{
  for(const serverUrl of ['http://example.com','https://user:secret@arena.test','https://arena.test/?secret=x','file:///tmp/test'])assert.throws(()=>new ArenaClient({serverUrl,store:memory()}),{code:'invalid_server_url'});
  for(const serverUrl of ['http://localhost:1234','http://127.0.0.1:1234','http://[::1]:1234'])assert.ok(new ArenaClient({serverUrl,store:memory()}));
  const f=fixture({intercept:async()=>{throw Object.assign(new Error('secret-url '+GAME),{code:'arbitrary_private_message'});}});
  await assert.rejects(f.client.pairInit({label:'test',version:'1'}),e=>e.code==='network_error'&&!e.message.includes(GAME));
});

test('AbortSignal and cancelPending bound in-flight requests without starting heartbeat timers',async()=>{
  const controller=new AbortController();
  const f=fixture({signal:controller.signal,intercept:async({init})=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))});
  const pending=f.client.pairInit({label:'test',version:'1'});await new Promise(resolve=>setImmediate(resolve));f.client.cancelPending();
  await assert.rejects(pending,{code:'request_cancelled'});
  controller.abort();await assert.rejects(f.client.pairInit({label:'test',version:'1'}),{code:'request_cancelled'});
});

test('atomic store owns one session path, persists with 0600, and refuses symlinks',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-arena-store-')),file=path.join(dir,'private','session.json');
  let store;
  try{
    store=new AtomicStore(file);assert.throws(()=>new AtomicStore(file),{code:'store_locked'});
    await store.write({schema_version:1,private_token:'test-secret'});
    assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);
    await store.close();store=new AtomicStore(file);
    assert.equal((await store.read()).private_token,'test-secret');await store.close();store=null;
    fs.unlinkSync(file);const outside=path.join(dir,'outside.json');fs.writeFileSync(outside,'{}');fs.symlinkSync(outside,file);
    assert.throws(()=>new AtomicStore(file),{code:'store_permissions'});
    assert.equal(fs.readFileSync(outside,'utf8'),'{}');
  }finally{await store?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('connection reset requires a control-session 401 and preserves saved profile recovery',async()=>{
  let revoked=false;
  const f=fixture({intercept:async({route})=>route==='/client/v2/session'&&revoked?json({error:{code:'client_unauthorized'}},401):null});
  await connect(f);await f.client.claimProfile();await f.client.claimAttempt({attemptId:'attempt_test'});
  await assert.rejects(f.client.resetConnection(),{code:'connection_active'});
  assert.equal((await f.store.read()).attempt.game_token,GAME);
  revoked=true;
  assert.deepEqual(await f.client.resetConnection(),{state:'unpaired',profiles_preserved:1});
  const saved=await f.store.read();assert.equal(saved.control,null);assert.equal(saved.pairing,null);assert.equal(saved.attempt,null);
  assert.equal(saved.pending_claim,null);assert.deepEqual(saved.pending_operations,{});
  assert.equal(saved.profiles.agent_saved.recovery_secret,RECOVERY);
});

test('expired unacknowledged pair can initialize anew only after saved control is confirmed unauthorized',async()=>{
  let now=Date.now(),failAck=true;
  const f=fixture({clock:()=>now,intercept:async({route,body})=>route.endsWith('/pair/poll')&&body.receipt&&failAck?json({error:{code:'unavailable'}},503):null});
  await f.client.pairInit({label:'test',version:'1'});
  await assert.rejects(f.client.pairPoll(),{code:'unavailable'});
  assert.equal((await f.store.read()).control.acked,false);
  now+=40000;failAck=false;
  assert.equal((await f.client.pairInit({label:'test',version:'1'})).state,'pending');
  assert.equal((await f.store.read()).control,null);
  assert.equal(f.calls.filter(x=>x.route.endsWith('/pair/init')).length,2);
  assert.equal((await f.client.pairPoll()).state,'connected');
});

test('concurrent processes never reclaim an existing apparently stale session lock',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-arena-lock-')),file=path.join(dir,'session.json'),lock=file+'.lock';
  const original=JSON.stringify({pid:999999999,nonce:'apparently-stale-owner'});
  fs.writeFileSync(lock,original,{mode:0o600});
  const moduleUrl=new URL('../shared/store.js',import.meta.url).href;
  const script=`import {AtomicStore} from ${JSON.stringify(moduleUrl)};try{const store=new AtomicStore(process.argv[1]);await store.close();process.stdout.write('unexpected_owner');}catch(error){process.stdout.write(error.code);}`;
  try{
    const run=promisify(execFile);
    const results=await Promise.all([run(process.execPath,['--input-type=module','-e',script,file]),run(process.execPath,['--input-type=module','-e',script,file])]);
    assert.ok(results.every(result=>result.stdout==='store_locked'));
    assert.equal(fs.readFileSync(lock,'utf8'),original);
    assert.equal(fs.existsSync(file),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('store size boundary includes the committed newline and every accepted write remains readable',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-arena-size-')),file=path.join(dir,'session.json');
  const store=new AtomicStore(file),limit=1024*1024,overhead=Buffer.byteLength(JSON.stringify({padding:''}));
  try{
    const accepted={padding:'x'.repeat(limit-overhead-1)};
    await store.write(accepted);assert.equal(fs.statSync(file).size,limit);
    assert.deepEqual(await store.read(),accepted);
    await assert.rejects(store.write({padding:'x'.repeat(limit-overhead)}),{code:'invalid_store_value'});
    assert.equal(fs.statSync(file).size,limit);assert.deepEqual(await store.read(),accepted);
  }finally{await store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

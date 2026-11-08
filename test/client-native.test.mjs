import test from 'node:test';
import assert from 'node:assert/strict';
import {ArenaClient} from '../shared/client.js';
import {containsPrivateCredentials} from '../shared/credential-guard.js';
const TICKET='model_beta_invite_'+'i'.repeat(43),ACCESS='model_beta_'+'a'.repeat(43),CONTROL='native_control_'+'c'.repeat(32),RECOVERY='aea_profile_'+'r'.repeat(43);
const json=(body,status=200)=>new Response(JSON.stringify({schema_version:2,...body}),{status});
function fixture({loseConnect=false,losePrepare=false,failSave=false,loseRecover=false,loseWithdraw=false}={}){
 let data=null,valid=false,state='preparing',seq=0;const calls=[];
 const store={read:async()=>structuredClone(data),write:async v=>{if(failSave&&v.control){failSave=false;throw Object.assign(new Error('store_write_failed'),{code:'store_write_failed'});}data=structuredClone(v);}};
 const session=()=>({state,connection:{state:'connected'},public_agent_id:null});
 const fetcher=async(url,init)=>{
  const route=new URL(url).pathname,b=init.body?JSON.parse(init.body):null;calls.push({route,body:b,key:init.headers['idempotency-key'],credentials:init.credentials,headers:init.headers});
  if(route==='/lobby/v2/catalog')return json({catalog_revision:'test-1',appearance:{character:[{id:'qwen',name:'Qwen 娘',enabled:true}]},loadouts:[{id:'rifle',name:'步枪标准配置',enabled:true}],mode_ids:['extraction','battle_royale']});
  if(route==='/client/v2/access/connect'){
   const pending=(await store.read()).pending_native_connect;assert.equal(pending.key,init.headers['idempotency-key']);assert.deepEqual(pending.body,b);valid=true;
   if(loseConnect){loseConnect=false;throw new Error('transport diagnostic '+TICKET+ACCESS);}
   return json({access_token:ACCESS,grant:{id:'beta_native',state:'active',expires_at_ms:Date.now()+86400000,max_concurrent_agents:1},control_token:CONTROL,session:session()});
  }
  if(route==='/client/v2/session')return valid?json(session()):json({error:{code:'client_unauthorized'}},401);
  assert.equal(init.headers.authorization,'Bearer '+CONTROL);
  if(route==='/client/v2/profile/recover'){if(loseRecover){loseRecover=false;throw new Error('recovery request lost before commit');}assert.equal((await store.read()).control.acked,true);assert.equal(b.recovery_secret,RECOVERY);return json({...session(),public_agent_id:b.public_agent_id});}
  if(route==='/client/v2/withdraw'){state='preparing';if(loseWithdraw){loseWithdraw=false;throw new Error('withdraw reply lost');}return json(session());}
  if(route==='/client/v2/prepare'){state='ready';if(losePrepare){losePrepare=false;throw new Error('prepare reply lost');}return json(session());}
  throw new Error('unexpected route '+route+' '+(++seq));
 };
 return {client:new ArenaClient({serverUrl:'https://arena.test',store,fetcher}),store,calls,invalid:()=>valid=false,setState:v=>state=v};
}
const entry={mode_id:'extraction',room_id:'public-1',name:'小鱼',character_id:'qwen',loadout_id:'rifle'};

test('native invitation exchange is private, durable and has no browser pairing or queue side effect',async()=>{
 const f=fixture(),catalog=await f.client.catalog();assert.equal(catalog.appearance.character[0].id,'qwen');
 const result=await f.client.connectNative({ticket:'https://arena.test/agent-arena/lobby/#invite='+TICKET});assert.equal(result.state,'connected');
 const disk=await f.store.read();assert.equal(disk.control.token,CONTROL);assert.equal(disk.native_access.token,ACCESS);assert.equal(disk.pending_native_connect,null);
 const exposed=JSON.stringify([result,await f.client.publicState()]);for(const secret of [TICKET,ACCESS,CONTROL])assert.ok(!exposed.includes(secret));
 assert.ok(f.calls.every(c=>c.credentials==='omit'));assert.ok(!f.calls.some(c=>/pair|lobby\/v2\/session|queue|prepare|approve/.test(c.route)));
 assert.equal((await f.client.publicState()).access_credential_saved,true);
});
test('lost native delivery retries one durable request; expired control reconnects using saved qualification instead of invite',async()=>{
 const f=fixture({loseConnect:true});await assert.rejects(f.client.connectNative({ticket:TICKET}),e=>e.code==='network_error'&&!e.message.includes(TICKET));
 const key=(await f.store.read()).pending_native_connect.key;await f.client.connectNative();const attempts=f.calls.filter(c=>c.route.endsWith('/access/connect'));assert.equal(attempts.length,2);assert.equal(attempts[1].key,key);
 f.invalid();await f.client.connectNative();const last=f.calls.filter(c=>c.route.endsWith('/access/connect')).at(-1);assert.equal(last.body.access_token,ACCESS);assert.equal(last.body.ticket,undefined);assert.notEqual(last.key,key);
});
test('failed private save leaves the same pending native exchange recoverable without another invitation',async()=>{
 const f=fixture({failSave:true});await assert.rejects(f.client.connectNative({ticket:TICKET}),{code:'store_write_failed'});const saved=await f.store.read();assert.equal(saved.control,null);assert.ok(saved.pending_native_connect);
 await f.client.connectNative();assert.equal(f.calls.filter(c=>c.route.endsWith('/access/connect')).at(-1).key,saved.pending_native_connect.key);
});
test('invitation URLs cannot redirect credentials to another origin and missing qualification fails without network',async()=>{
 const f=fixture();await assert.rejects(f.client.connectNative(),{code:'invite_required'});assert.equal(f.calls.length,0);
 for(const ticket of ['https://evil.test/agent-arena/lobby/#invite='+TICKET,'https://arena.test/agent-arena/lobby/?ticket=x#invite='+TICKET,'https://arena.test/agent-arena/lobby/#invite='+TICKET+'&invite='+TICKET])await assert.rejects(f.client.connectNative({ticket}),{code:'invalid_invite_input'});
 assert.equal(f.calls.length,0);
});
test('native reconnect restores a saved profile before preparing a new one without exposing its recovery proof',async()=>{
 const f=fixture();await f.client.connectNative({ticket:TICKET});let disk=await f.store.read();disk.profiles.agent_recent={public_agent_id:'agent_recent',acked:true,recovery_secret:RECOVERY,name:'小鱼',appearance:{character:'qwen'}};disk.last_profile_id='agent_recent';await f.store.write(disk);
 f.invalid();const reply=await f.client.connectNative();assert.equal(reply.session.public_agent_id,'agent_recent');const p=(await f.client.publicState()).profiles[0];assert.equal(p.name,'小鱼');assert.equal(p.appearance.character,'qwen');assert.ok(!JSON.stringify(reply).includes(RECOVERY));
});
test('confirmed preparation replaces an older ready configuration and retries a committed prepare without withdrawing it',async()=>{
 const f=fixture({losePrepare:true});await f.client.connectNative({ticket:TICKET});f.setState('ready');
 await assert.rejects(f.client.prepareEntry(entry),{code:'network_error'});const pending=(await f.store.read()).pending_operations.prepare;
 assert.equal(f.calls.filter(c=>c.route.endsWith('/withdraw')).length,1);await f.client.prepareEntry(entry);assert.equal(f.calls.filter(c=>c.route.endsWith('/withdraw')).length,1);
 const prepares=f.calls.filter(c=>c.route.endsWith('/prepare'));assert.equal(prepares[1].key,pending.key);assert.equal(prepares[1].body.character_id,'qwen');assert.deepEqual((await f.client.publicState()).entry_preferences,entry);
});
test('new qualification and invitation proofs are blocked from tool output while safe booleans remain usable',()=>{
 assert.equal(containsPrivateCredentials({content:[{type:'text',text:ACCESS}]}),true);assert.equal(containsPrivateCredentials({invite:TICKET}),true);assert.equal(containsPrivateCredentials({access_token:ACCESS}),true);
 assert.equal(containsPrivateCredentials({access_credential_saved:true,profiles:[{public_agent_id:'agent_id',saved:true}]}),false);
});

test('native profile recovery retries after its first network failure even when control was already saved',async()=>{
 const f=fixture({loseRecover:true});await f.client.connectNative({ticket:TICKET});const disk=await f.store.read();disk.profiles.agent_recent={public_agent_id:'agent_recent',acked:true,recovery_secret:RECOVERY};disk.last_profile_id='agent_recent';await f.store.write(disk);f.invalid();
 await assert.rejects(f.client.connectNative(),{code:'network_error'});assert.equal((await f.store.read()).control.acked,true);
 const resumed=await f.client.connectNative();assert.equal(resumed.session.public_agent_id,'agent_recent');assert.equal(f.calls.filter(c=>c.route.endsWith('/profile/recover')).length,2);
});

test('lost withdrawal reply is reconciled and cannot silently retain an old configuration in a later preparation',async()=>{
 const f=fixture({loseWithdraw:true});await f.client.connectNative({ticket:TICKET});f.setState('ready');
 await assert.rejects(f.client.prepareEntry(entry),{code:'network_error'});const oldKey=(await f.store.read()).pending_operations.withdraw.key;
 await f.client.prepareEntry(entry);assert.deepEqual((await f.store.read()).pending_operations,{});
 const next={...entry,name:'新名称',character_id:'deepseek',loadout_id:'smg'};await f.client.prepareEntry(next);
 const withdrawals=f.calls.filter(c=>c.route.endsWith('/withdraw')),prepares=f.calls.filter(c=>c.route.endsWith('/prepare'));
 assert.equal(withdrawals[0].key,oldKey);assert.equal(withdrawals[1].key,oldKey);assert.notEqual(withdrawals[2].key,oldKey);assert.equal(prepares.length,2);assert.deepEqual(prepares[1].body,next);assert.deepEqual((await f.client.publicState()).entry_preferences,next);
});

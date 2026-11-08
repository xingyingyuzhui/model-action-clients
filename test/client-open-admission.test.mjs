import test from 'node:test';
import assert from 'node:assert/strict';
import {ArenaClient} from '../shared/client.js';
import {McpDialogue} from '../shared/mcp-dialogue.js';
const TOKEN='model_beta_'+'o'.repeat(43),OLD='model_beta_'+'a'.repeat(43),TICKET='model_beta_invite_'+'t'.repeat(43),CONTROL='control_'+'c'.repeat(32),RECOVERY='aea_profile_'+'r'.repeat(43);
const response=(value,status=200)=>new Response(JSON.stringify({schema_version:2,...value}),{status});
function fixture({policy={enabled:true,admission_mode:'open',invite_required:false},saved=false,controlError,proofError,lose=false,state='preparing',profileError}={}){
 let value=saved?{schema_version:1,origin:'https://arena.test',profiles:{agent_saved:{public_agent_id:'agent_saved',acked:true,recovery_secret:RECOVERY,name:'小鱼',appearance:{character:'qwen'}}},last_profile_id:'agent_saved',control:{token:CONTROL,acked:true},native_access:{token:OLD,grant:{id:'beta_old',state:'active',expires_at_ms:Date.now()+60000}},pending_operations:{}}:null;
 let valid=saved,selectedPolicy=policy,drop=lose,sessionError=controlError;const calls=[];
 const store={read:async()=>structuredClone(value),write:async data=>{value=structuredClone(data);}};
 const client=new ArenaClient({serverUrl:'https://arena.test',store,fetcher:async(url,init)=>{
  const route=new URL(url).pathname,body=init.body?JSON.parse(init.body):undefined;calls.push({route,body,key:init.headers['idempotency-key']});
  if(route==='/lobby/v2/catalog')return response({catalog_revision:'open-test',appearance:{character:[{id:'qwen',name:'Qwen 娘',enabled:true}]},loadouts:[{id:'rifle',name:'步枪配置',enabled:true}],mode_ids:['extraction','battle_royale']});
  if(route==='/lobby/v2/access'){if(selectedPolicy instanceof Error)throw selectedPolicy;return response(selectedPolicy);}
  if(route==='/client/v2/session'){
   if(sessionError)return response({error:{code:sessionError}},sessionError==='client_unauthorized'?401:403);
   return valid?response({state,public_agent_id:null}):response({error:{code:'client_unauthorized'}},401);
  }
  if(route==='/client/v2/access/connect'){
   const pending=(await store.read()).pending_native_connect;assert.equal(pending.key,init.headers['idempotency-key']);assert.deepEqual(pending.body,body);
   if(body.access_token&&proofError)return response({error:{code:proofError}},403);
   const anonymous=body.ticket===undefined&&body.access_token===undefined;
   if(anonymous&&!(selectedPolicy.admission_mode==='open'&&selectedPolicy.invite_required===false))return response({error:{code:'beta_invite_required'}},403);
   if(anonymous)assert.match(pending.key,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
   if(drop){drop=false;throw Error('response lost');}
   valid=true;sessionError=null;
   return response({access_token:TOKEN,grant:{id:'beta_new',kind:anonymous?'open':'invite',state:'active',expires_at_ms:Date.now()+60000,max_concurrent_agents:1},control_token:CONTROL,session:{state:'preparing',public_agent_id:null}});
  }
  if(route==='/client/v2/profile/recover'){
   if(profileError)return response({error:{code:profileError}},profileError==='profile_in_use'?409:403);
   assert.equal(body.recovery_secret,RECOVERY);return response({state:'preparing',public_agent_id:body.public_agent_id});
  }
  throw Error('unexpected '+route);
 }});
 return {client,store,calls,setPolicy:p=>selectedPolicy=p,setControlError:e=>sessionError=e};
}
test('fresh public bootstrap requires explicit policy, uses a durable UUID and never prepares or queues',async()=>{
 const f=fixture(),result=await f.client.connectNative();assert.equal(result.grant.kind,'open');assert.equal(result.state,'connected');
 assert.deepEqual(f.calls.map(c=>c.route),['/lobby/v2/access','/client/v2/access/connect']);
 assert.equal(f.calls[1].body.label,'Model行动 client');assert.equal(f.calls[1].body.protocol_version,1);assert.equal(typeof f.calls[1].body.version,'string');assert.equal(f.calls[1].body.ticket,undefined);
 assert.equal((await f.store.read()).native_access.grant.kind,'open');
 for(const privateValue of [TOKEN,CONTROL])assert.ok(!JSON.stringify([result,await f.client.publicState()]).includes(privateValue));
});
test('closed, legacy and incoherent metadata never authorize a proofless mutation',async()=>{
 for(const policy of [{enabled:true,admission_mode:'invite',invite_required:true},{enabled:false},{enabled:false,admission_mode:'open',invite_required:false},{admission_mode:'open',invite_required:false},{admission_mode:'open',invite_required:true},{admission_mode:'open',invite_required:'false'},{invite_required:false}]){
  const f=fixture({policy});await assert.rejects(f.client.connectNative(),{code:'invite_required'});assert.equal(f.calls.length,1);assert.equal(f.calls[0].route,'/lobby/v2/access');
 }
 const network=fixture({policy:Error('offline')});await assert.rejects(network.client.connectNative(),{code:'network_error'});assert.equal(network.calls.length,1);
 const schema=fixture({policy:{schema_version:1,admission_mode:'open',invite_required:false}});await assert.rejects(schema.client.connectNative(),{code:'unsupported_schema'});assert.equal(schema.calls.length,1);
});
test('lost public reply retries the exact saved bootstrap, and closure still rejects authoritative retry',async()=>{
 const f=fixture({lose:true});await assert.rejects(f.client.connectNative(),{code:'network_error'});const pending=(await f.store.read()).pending_native_connect;
 await f.client.connectNative();const exchanges=f.calls.filter(c=>c.route.endsWith('/connect'));assert.equal(exchanges.length,2);assert.equal(exchanges[1].key,pending.key);assert.deepEqual(exchanges[1].body,pending.body);
 const closed=fixture({lose:true});await assert.rejects(closed.client.connectNative(),{code:'network_error'});closed.setPolicy({admission_mode:'invite',invite_required:true});await assert.rejects(closed.client.connectNative(),{code:'beta_invite_required'});assert.equal((await closed.store.read()).pending_native_connect,null);
});
test('expired or revoked saved proof can become a guest only with explicit open policy, preserving identity',async()=>{
 for(const cause of ['beta_access_expired','beta_access_revoked']){
  const f=fixture({saved:true,controlError:cause}),before=(await f.store.read()).profiles;
  const connected=await f.client.connectNative();assert.equal(connected.session.public_agent_id,'agent_saved');assert.deepEqual((await f.store.read()).profiles,before);
  assert.ok(f.calls.some(c=>c.route==='/lobby/v2/access'));assert.equal(f.calls.filter(c=>c.route.endsWith('/connect')).length,1);assert.equal(f.calls.find(c=>c.route.endsWith('/connect')).body.access_token,undefined);
 }
 const f=fixture({saved:true,controlError:'client_unauthorized',proofError:'beta_access_expired'});await f.client.connectNative();assert.equal(f.calls.filter(c=>c.route.endsWith('/connect')).length,2);assert.equal(f.calls.filter(c=>c.route.endsWith('/connect'))[1].body.access_token,undefined);
 const closed=fixture({saved:true,controlError:'beta_access_expired',policy:{admission_mode:'invite',invite_required:true}});await assert.rejects(closed.client.connectNative(),{code:'beta_access_expired'});assert.ok(!closed.calls.some(c=>c.route.endsWith('/connect')));
});
test('profile or administration errors cannot silently mint another guest or erase profile recovery',async()=>{
 for(const code of ['agent_deleted','agent_kicked','profile_in_use','unknown_failure']){
  const f=fixture({saved:true,controlError:code}),before=await f.store.read();await assert.rejects(f.client.connectNative(),{code});assert.equal(f.calls.length,1);assert.deepEqual(await f.store.read(),before);
 }
 const f=fixture({saved:true,profileError:'profile_in_use'});await assert.rejects(f.client.connectNative(),{code:'profile_in_use'});assert.ok(!f.calls.some(c=>c.route==='/lobby/v2/access'||c.route.endsWith('/connect')));
});
test('a fresh invite replaces a closed guest lease, including ended-result leases that still validate',async()=>{
 for(const state of ['preparing','ended']){
  const f=fixture({saved:true,state,policy:{admission_mode:'invite',invite_required:true},...(state==='preparing'?{controlError:'beta_invite_required'}:{})});
  const value=await f.store.read();value.native_access.grant.kind='open';await f.store.write(value);
  const connected=await f.client.connectNative({ticket:TICKET});assert.equal(connected.session.public_agent_id,'agent_saved');assert.equal(f.calls.find(c=>c.route.endsWith('/connect')).body.ticket,TICKET);
 }
 const live=fixture({saved:true,state:'in_world',policy:{admission_mode:'invite',invite_required:true}});const value=await live.store.read();value.native_access.grant.kind='open';await live.store.write(value);await live.client.connectNative({ticket:TICKET});assert.ok(!live.calls.some(c=>c.route.endsWith('/connect')));
});
test('an unresolved public-only bootstrap may be superseded by an explicit invite after closure',async()=>{
 const f=fixture({lose:true});await assert.rejects(f.client.connectNative(),{code:'network_error'});const pending=(await f.store.read()).pending_native_connect;
 f.setPolicy({admission_mode:'invite',invite_required:true});await f.client.connectNative({ticket:TICKET});const last=f.calls.filter(c=>c.route.endsWith('/connect')).at(-1);assert.equal(last.body.ticket,TICKET);assert.notEqual(last.key,pending.key);
});

test('guest fallback never silently replaces a deleted or invalid retained profile, even on retry',async()=>{
 for(const profileError of ['agent_deleted','invalid_profile_proof','profile_not_found']){
  const f=fixture({saved:true,controlError:'beta_access_expired',profileError}),before=(await f.store.read()).profiles;
  await assert.rejects(f.client.connectNative(),{code:profileError});assert.deepEqual((await f.store.read()).profiles,before);
  const bootstraps=f.calls.filter(c=>c.route.endsWith('/connect')).length;
  await assert.rejects(f.client.connectNative(),{code:profileError});assert.deepEqual((await f.store.read()).profiles,before);assert.equal(f.calls.filter(c=>c.route.endsWith('/connect')).length,bootstraps);
 }
});

test('standard MCP discovers open access while first configuration remains a local proposal',async()=>{
 const f=fixture();let starts=0;
 const runtime={client:f.client,state:()=>({active:false,phase:'idle',entry_state:null}),start:async()=>{starts++;}};
 const dialogue=new McpDialogue(runtime,{serverUrl:'https://arena.test',version:'test'});
 const opened=await dialogue.start({});assert.equal(opened.phase,'configuring');assert.equal(opened.connected,true);
 const proposal=await dialogue.prepare({name:'小鱼',character_id:'qwen',loadout_id:'rifle',mode_id:'extraction',room_id:'public-1'});
 assert.equal(proposal.phase,'awaiting_confirmation');assert.equal(starts,0);
 assert.ok(!f.calls.some(c=>/pair|queue|\/prepare$/.test(c.route)));
});

test('closed guest result leases remain readable but cannot claim eligibility for another preparation',async()=>{
 const f=fixture({saved:true,state:'ended',policy:{enabled:true,admission_mode:'invite',invite_required:true}});
 const value=await f.store.read();value.native_access.grant.kind='open';await f.store.write(value);
 await assert.rejects(f.client.connectNative(),{code:'invite_required'});
 assert.deepEqual((await f.store.read()).control,value.control,'do not clear the result-channel lease');
 assert.equal((await f.client.session()).state,'ended');
 assert.ok(!f.calls.some(c=>c.route.endsWith('/connect')));
});

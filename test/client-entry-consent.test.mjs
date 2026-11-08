import test from 'node:test';
import assert from 'node:assert/strict';
import {ArenaClient} from '../shared/client.js';
const ENTRY={name:'小鱼',character_id:'deepseek',loadout_id:'rifle',mode_id:'extraction',room_id:'public-1'};
const ID='agent_entry_consent',NOW=100000;
function fixture({legacy=true,profile=true}={}) {
 let data={schema_version:1,origin:'https://arena.test',control:{token:'private_control_1234567890',acked:true},profiles:profile?{[ID]:{public_agent_id:ID,acked:true,name:ENTRY.name,appearance:{character:ENTRY.character_id},recovery_secret:'private_recovery_123456789'}}:{},last_profile_id:profile?ID:null,entry_preferences:legacy?structuredClone(ENTRY):null,native_access:{token:'model_beta_'+'a'.repeat(43),grant:{id:'beta_consent',state:'active',expires_at_ms:NOW+10000}},pending_operations:{}};
 let state='preparing',lost=false;
 const store={read:async()=>structuredClone(data),write:async v=>{data=structuredClone(v);}};
 const client=new ArenaClient({serverUrl:data.origin,store,clock:()=>NOW,fetcher:async(url,init)=>{
  const route=new URL(url).pathname;
  if(route==='/client/v2/profile/claim'){const body=JSON.parse(init.body);return new Response(JSON.stringify(body.receipt?{schema_version:2,state:'acknowledged',public_agent_id:ID}:{schema_version:2,public_agent_id:ID,recovery_secret:'private_profile_recovery_123456',receipt:'private_profile_receipt_123456'}),{status:200});}
  if(route==='/client/v2/prepare'){assert.equal(data.entry_consent_schema,1,'new SDK marks intent provenance before network write');if(lost){lost=false;throw Error('lost prepare response');}state='ready';}
  else if(route==='/client/v2/withdraw')state='preparing';
  else assert.equal(route,'/client/v2/session');
  return new Response(JSON.stringify({schema_version:2,state,public_agent_id:ID}),{status:200});
 }});
 return {client,store,loseNext:()=>lost=true};
}
test('0.2.0 successful native preparation recovers reusable configuration without exposing private proofs',async()=>{
 const f=fixture();const before=await f.store.read(),view=await f.client.publicState();
 assert.deepEqual(view.confirmed_entry,ENTRY);assert.deepEqual(await f.store.read(),before,'reading state does not rewrite a running store');
 for(const secret of [before.native_access.token,before.control.token,before.profiles[ID].recovery_secret])assert.ok(!JSON.stringify(view).includes(secret));
 for(const patch of [{native_access:null},{last_profile_id:'other'},{entry_preferences:{...ENTRY,character_id:'unknown'}}]){
  await f.store.write({...before,...patch});assert.equal((await f.client.publicState()).confirmed_entry,null);
 }
 for(const field of [{unavailable:true},{acked:false},{name:'other'},{appearance:{character:'kimi'}}]){
  await f.store.write({...before,profiles:{[ID]:{...before.profiles[ID],...field}}});assert.equal((await f.client.publicState()).confirmed_entry,null);
 }
});
test('new unconfirmed SDK preparation never becomes legacy consent, including after a lost reply',async()=>{
 const f=fixture({legacy:false});f.loseNext();
 await assert.rejects(f.client.prepareEntry(ENTRY),{code:'network_error'});
 assert.equal((await f.client.publicState()).confirmed_entry,null);
 await f.client.prepareEntry(ENTRY);
 assert.deepEqual((await f.client.publicState()).entry_preferences,ENTRY);
 assert.equal((await f.client.publicState()).confirmed_entry,null);
});
test('confirmed entry remains private until matching preparation and binds the first acknowledged profile',async()=>{
 const f=fixture({legacy:false,profile:false});assert.deepEqual(await f.client.rememberConfirmedEntry(ENTRY),{saved:true});
 assert.equal((await f.client.publicState()).confirmed_entry,null);
 const value=await f.store.read();value.profiles[ID]={public_agent_id:ID,acked:true,name:ENTRY.name,appearance:{character:ENTRY.character_id}};value.last_profile_id=ID;await f.store.write(value);
 assert.equal((await f.client.publicState()).confirmed_entry,null);
 await f.client.prepareEntry(ENTRY);assert.deepEqual((await f.client.publicState()).confirmed_entry,ENTRY);
 assert.equal((await f.store.read()).entry_consent.public_agent_id,ID);
});
test('unconfirmed changed configuration, another identity or another qualification cannot reuse consent',async()=>{
 const f=fixture();await f.client.rememberConfirmedEntry(ENTRY);await f.client.prepareEntry(ENTRY);
 const confirmed=await f.store.read();
 await f.client.prepareEntry({...ENTRY,character_id:'kimi'});assert.equal((await f.client.publicState()).confirmed_entry,null);
 await f.store.write({...confirmed,native_access:{...confirmed.native_access,grant:{...confirmed.native_access.grant,id:'beta_other'}}});assert.equal((await f.client.publicState()).confirmed_entry,null);
 await f.store.write({...confirmed,native_access:{...confirmed.native_access,grant:{...confirmed.native_access.grant,state:'revoked'}}});assert.equal((await f.client.publicState()).confirmed_entry,null);
 await f.store.write({...confirmed,native_access:{...confirmed.native_access,grant:{...confirmed.native_access.grant,expires_at_ms:NOW}}});assert.deepEqual((await f.client.publicState()).confirmed_entry,ENTRY,'local expiry metadata must not undo a server-side extension');
});
test('legacy consent is materialized before an SDK upgrade can prepare a different entry',async()=>{
 const f=fixture();await f.client.prepareEntry({...ENTRY,loadout_id:'smg'});
 const value=await f.store.read();assert.deepEqual(value.entry_consent.entry,ENTRY);assert.equal(value.entry_consent_schema,1);assert.equal((await f.client.publicState()).confirmed_entry,null);
});
test('confirmation rejects incomplete or private fields before mutating state',async()=>{
 const f=fixture();const before=await f.store.read();
 for(const value of [{...ENTRY,access_token:'secret'},{name:'x'},{...ENTRY,name:'x\n'},{...ENTRY,room_id:'br-1'},null])await assert.rejects(f.client.rememberConfirmedEntry(value),{code:'invalid_client_input'});
 assert.deepEqual(await f.store.read(),before);
});

test('real runtime order prepares first and acknowledges a new profile afterwards; consent survives reload',async()=>{
 const f=fixture({legacy:false,profile:false});
 await f.client.rememberConfirmedEntry(ENTRY);await f.client.prepareEntry(ENTRY);
 assert.equal((await f.client.publicState()).confirmed_entry,null,'pending proof is not usable before profile acknowledgement');
 const result=await f.client.claimProfile();assert.equal(result.state,'saved');
 assert.deepEqual((await f.client.publicState()).confirmed_entry,ENTRY);
 const reloaded=new ArenaClient({serverUrl:'https://arena.test',store:f.store,clock:()=>NOW});
 assert.deepEqual((await reloaded.publicState()).confirmed_entry,ENTRY);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {McpDialogue} from '../shared/mcp-dialogue.js';
const selected={name:'小鱼',character_id:'qwen',loadout_id:'rifle',mode_id:'extraction',room_id:'public-1'};
function fixture(){
 let now=1000,phase='preparing',starts=0,remembers=0;
 const catalog={catalog_revision:'v1',appearance:{character:[{id:'qwen',name:'Qwen 娘',enabled:true}]},loadouts:[{id:'rifle',name:'步枪配置',enabled:true}],mode_ids:['extraction','battle_royale']};
 const client={connectNative:async()=>({session:{state:phase}}),catalog:async()=>structuredClone(catalog),publicState:async()=>({entry_preferences:selected,confirmed_entry:selected}),session:async()=>({state:phase}),rememberConfirmedEntry:async()=>{remembers++;},cancelPending(){}};
 const runtime={client,active:false,state(){return {active:this.active,phase:this.active?'in_world':'idle',entry_state:phase};},async start(){starts++;this.active=true;phase='in_world';return this.state();},async stop(){this.active=false;return {stopped:true};},async refresh(){}};
 const dialogue=new McpDialogue(runtime,{serverUrl:'https://arena.test',version:'0.2.2',clock:()=>now});
 return {dialogue,runtime,client,catalog,setClock:value=>now=value,starts:()=>starts,remembers:()=>remembers};
}
test('proposal expiration and changed catalog reject before remembering or starting',async()=>{
 const f=fixture();await f.dialogue.start({});let view=await f.dialogue.prepare(selected);f.setClock(301000);await assert.rejects(f.dialogue.accept({confirmation_id:view.dialogue.confirmation_id}),{code:'confirmation_stale'});assert.equal(f.starts(),0);assert.equal(f.remembers(),0);
 f.setClock(500000);view=await f.dialogue.prepare(selected);f.catalog.catalog_revision='v2';await assert.rejects(f.dialogue.accept({confirmation_id:view.dialogue.confirmation_id}),{code:'confirmation_stale'});assert.equal(f.starts(),0);
});
test('concurrent duplicate confirmation launches once and replaying the consumed id never launches again',async()=>{
 const f=fixture();await f.dialogue.start({});const view=await f.dialogue.prepare(selected),args={confirmation_id:view.dialogue.confirmation_id};
 await Promise.all([f.dialogue.accept(args),f.dialogue.accept(args)]);assert.equal(f.starts(),1);assert.equal(f.remembers(),1);
 await f.dialogue.accept(args);assert.equal(f.starts(),1);
});
test('fresh startup waits for a previous stop to finish before it can own the runtime',async()=>{
 const f=fixture();await f.dialogue.start({});let release,arrived;
 const seen=new Promise(r=>arrived=r);f.runtime.stop=async()=>{arrived();await new Promise(r=>release=r);f.runtime.active=false;return {stopped:true};};
 const stopping=f.dialogue.stop({abandon:false});await seen;
 const next=f.dialogue.start({reuse_previous:true});await new Promise(r=>setImmediate(r));assert.equal(f.starts(),0);release();await stopping;await next;assert.equal(f.starts(),1);assert.equal(f.runtime.active,true);
});
test('new unconfirmed proposals invalidate previous confirmation identifiers without network entry',async()=>{
 const f=fixture();await f.dialogue.start({});const old=await f.dialogue.prepare(selected),next=await f.dialogue.prepare({...selected,name:'新昵称'});
 assert.notEqual(old.dialogue.confirmation_id,next.dialogue.confirmation_id);await assert.rejects(f.dialogue.accept({confirmation_id:old.dialogue.confirmation_id}),{code:'confirmation_stale'});assert.equal(f.starts(),0);
});

#!/usr/bin/env node
// Official MCP stdio transport + isolated real room workers. No LLM, browser,
// production invitation, production profile or user configuration is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ElicitRequestSchema,ToolListChangedNotificationSchema} from '@modelcontextprotocol/sdk/types.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--game-dir')throw Error('usage: --game-dir /absolute/agent-extraction-arena');
const game=path.resolve(args[1]);
const [{RoomManager},{ArenaLobby},{ProfileStore},{RankingStore},{BetaAccessStore},{createArenaServer},{listen}]=await Promise.all(['rooms/manager.js','arena/lobby.js','profiles/store.js','rankings/store.js','beta/store.js','arena/http.js','server.js'].map(name=>import(pathToFileURL(path.join(game,'src',name)))));
const out=path.join(root,'evidence','mcp-native-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(out,{recursive:true,mode:0o700});
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'model-mcp-native-')),stateDir=path.join(temporary,'client');
const checks=[],routes=[],outputs=[],forms=[],errors=[];
let manager,lobby,server,connection,stage=0,notifications=0;
const check=(name,pass)=>{checks.push({name,pass:!!pass});console.log(JSON.stringify(checks.at(-1)));};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const decode=value=>JSON.parse(value.content.find(c=>c.type==='text').text);
async function open(origin,elicitation){
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'packages/model-action-mcp/bin/model-action-mcp.mjs'),'--server-url',origin,'--session','real-worker-fixture','--state-dir',stateDir],stderr:'pipe'});
 transport.stderr?.on('data',()=>{});
 const client=new Client({name:'explicit-mcp-e2e-fixture',version:'1.0.0'},{capabilities:elicitation?{elicitation:{form:{}}}:{}});
 client.setNotificationHandler(ToolListChangedNotificationSchema,()=>notifications++);
 if(elicitation)client.setRequestHandler(ElicitRequestSchema,async request=>{
  assert.equal(request.params.mode,'form');
  const props=request.params.requestedSchema.properties;
  assert.ok(Object.keys(props).length>0);assert.ok(Object.values(props).every(v=>v.type==='boolean'),'only non-sensitive confirmation');
  assert.ok(!/invitation|ticket|secret|token|password/i.test(Object.keys(props).join(' ')));
  forms.push({stage,fields:Object.keys(props)});
  return {action:'accept',content:Object.fromEntries(Object.keys(props).map(k=>[k,true]))};
 });
 await client.connect(transport);return {client,close:()=>client.close()};
}
async function call(name,args={}){
 const value=await connection.client.callTool({name,arguments:args});outputs.push(value);
 if(value.isError)throw Error(name+':'+(decode(value).error?.code??'tool_error'));
 return name.startsWith('game_')?value:decode(value);
}
async function statusUntil(expected){
 for(let n=0;n<100;n++){const view=await call('arena_status');if(view.entry_state===expected)return view;await wait(100);}
 throw Error('state_timeout_'+expected);
}
try{
 const access=new BetaAccessStore({dir:path.join(temporary,'beta')});const ticket=access.createInvites({count:1})[0].ticket;
 manager=new RoomManager({dataDir:path.join(temporary,'rooms'),invite:'unused-local-fixture',seed:'mcp-native-e2e',world:{npcTarget:0,airdrops:false}});await manager.start();
 lobby=new ArenaLobby(manager,{access,invite:'unused-local-fixture',profiles:new ProfileStore(path.join(temporary,'profiles')),rankings:new RankingStore(path.join(temporary,'rankings'))});
 server=createArenaServer(lobby);server.prependListener('request',req=>routes.push({stage,path:new URL(req.url,'http://local').pathname}));
 const port=await listen(server,0,'127.0.0.1'),origin='http://127.0.0.1:'+port;lobby.mcpUrl=origin+'/agent-game/mcp';
 stage=1;connection=await open(origin,true);
 const names=(await connection.client.listTools()).tools.map(t=>t.name);
 check('conversation controls replace browser repair and include invitation, character preparation and confirmation',names.includes('arena_submit_invite')&&names.includes('arena_prepare')&&names.includes('arena_confirm')&&!names.includes('arena_repair_pairing'));
 const start=await call('arena_start');check('first start only requests an invitation inside the conversation',start.phase==='awaiting_ticket'&&start.browser_required===false&&!routes.some(r=>/queue|\/prepare$/.test(r.path)));
 await call('arena_submit_invite',{invitation:origin+'/agent-arena/lobby/#invite='+ticket});
 const entry={name:'MCP实测',character_id:'deepseek',loadout_id:'rifle',mode_id:'extraction',room_id:'public-1'};
 const proposal=await call('arena_prepare',entry);
 check('all five choices remain local until confirmation',!!proposal.dialogue?.confirmation_id&&!routes.some(r=>r.path==='/client/v2/prepare'));
 stage=2;await call('arena_confirm',{confirmation_id:proposal.dialogue.confirmation_id});await statusUntil('in_world');
 check('non-sensitive native confirmation is elicited once, with no invitation form',forms.length===1&&forms[0].stage===2);
 const gameNames=(await connection.client.listTools()).tools.map(t=>t.name);
 check('real entry publishes dynamic authoritative game tools',gameNames.includes('game_step')&&gameNames.includes('game_observe_compact')&&notifications>0);
 const observation=decode(await call('game_observe_compact'));
 const snapshot=await (await fetch(origin+'/agent-arena/rooms/public-1/spectator/v2/snapshot')).json();
 check('configured character actually enters the authoritative world',observation.self?.hp>0&&manager.room('public-1').players_active===1&&snapshot.participants.some(p=>p.name===entry.name&&p.appearance.character==='deepseek'));
 await call('game_step',{input:{right:true,hold_ms:100},client_cmd_id:'mcp-native-first-step'});
 await call('game_abandon');const terminal=await statusUntil('ended');
 check('first match ends only on authoritative result',terminal.result?.outcome==='abandoned');
 await connection.close();connection=null;
 stage=3;connection=await open(origin,false);
 const before=routes.filter(r=>r.path==='/client/v2/access/connect').length;
 await call('arena_start',{reuse_previous:true});await statusUntil('in_world');
 check('process restart reuses qualification, identity and confirmed config without another invitation',routes.filter(r=>r.path==='/client/v2/access/connect').length===before&&routes.some(r=>r.stage===3&&r.path==='/client/v2/queue'));
 check('explicit replay needs no additional preparation summary or form',forms.length===1);
 const second=decode(await call('game_observe_compact'));
 const cancel=new AbortController();
 const pending=connection.client.callTool({name:'game_wait_for_event',arguments:{since_seq:second.next_seq??0,min_priority:'urgent',timeout_s:30}},undefined,{signal:cancel.signal});
 const cancelled=assert.rejects(pending);await wait(100);cancel.abort();await cancelled;
 check('MCP cancellation aborts a game wait without stopping the active match',(await call('arena_status')).entry_state==='in_world');
 await call('arena_stop',{abandon:true});const ended=await statusUntil('ended');
 for(let n=0;n<30&&manager.room('public-1').players_active;n++)await wait(100);
 check('explicit stop confirms the second terminal and frees the player seat',ended.result?.outcome==='abandoned'&&manager.room('public-1').players_active===0);
 const privateState=JSON.parse(fs.readFileSync(fs.readdirSync(stateDir,{recursive:true}).map(n=>path.join(stateDir,n)).find(p=>p.endsWith('.json'))));
 const privateValues=[ticket];
 function secrets(v){if(v&&typeof v==='object')for(const [key,item]of Object.entries(v)){if(/token|secret|receipt/i.test(key)&&typeof item==='string')privateValues.push(item);else secrets(item);}}
 secrets(privateState);
 check('tool outputs never echo invitation or long-term proofs',privateValues.every(value=>!JSON.stringify(outputs).includes(value)));
 check('no browser pairing, approval or session-cookie endpoint is invoked',!routes.some(r=>/\/pair\/|^\/lobby\/v2\/(session|pairing)/.test(r.path)));
 check('all four isolated real rooms remain available',manager.rooms().length===4&&manager.rooms().every(r=>r.state!=='unavailable'));
}catch(cause){errors.push(String(cause.code??cause.message));process.exitCode=1;}
finally{
 await connection?.close().catch(()=>{});lobby?.stop();server?.closeAllConnections();server?.close();await manager?.stop();
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({label:'Official MCP stdio Client/Server and four real isolated workers, explicit host calls, no LLM',checks,errors,routes,forms,invitation_passes_through_tool_arguments:true,paid_model_calls:0,new_production_matches:0},null,2)+'\n',{mode:0o600});
 fs.rmSync(temporary,{recursive:true,force:true});
}
const passed=checks.length>0&&checks.every(c=>c.pass)&&errors.length===0;
console.log(JSON.stringify({evidence:out,passed,errors}));if(!passed)process.exitCode=1;

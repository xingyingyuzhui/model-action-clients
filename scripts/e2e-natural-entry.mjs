#!/usr/bin/env node
// Official installed DSH CLI/core, one persistent Agent, six genuine user
// messages, native plugin and four real workers. Only the LLM and humans are
// explicit isolated fixtures. The supervisor never invokes entry/game tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';







const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--game-dir')throw new Error('usage: --game-dir /absolute/agent-extraction-arena');
const GAME=path.resolve(args[1]);
const [{RoomManager},{ArenaLobby},{ProfileStore},{RankingStore},{BetaAccessStore},{createArenaServer},{listen}]=await Promise.all(['rooms/manager.js','arena/lobby.js','profiles/store.js','rankings/store.js','beta/store.js','arena/http.js','server.js'].map(name=>import(pathToFileURL(path.join(GAME,'src',name)))));
const CLIENT=ROOT,HOST=process.env.MODEL_ACTION_DSH_MODULES??'/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules';
const CLI=path.join(HOST,'@deepseek-ai/dsh/lib/bin.js');
const version=JSON.parse(fs.readFileSync(path.join(HOST,'@deepseek-ai/dsh/package.json'))).version;
if(version!=='0.2.2-rc.1')throw new Error('official_dsh_version_mismatch');
const OUT=path.join(ROOT,'evidence','natural-entry-dsh-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(OUT,{recursive:true,mode:0o700});fs.chmodSync(OUT,0o700);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'model-conversational-')),home=path.join(temp,'home'),workspace=path.join(temp,'workspace'),profile=path.join(home,'profiles','conversation-fixture');
const progress=path.join(temp,'human-progress.json'),inputFile=path.join(temp,'human-inputs.private.json');
const save=(name,data)=>fs.writeFileSync(path.join(OUT,name),typeof data==='string'?data:JSON.stringify(data,null,2)+'\n',{mode:0o600});
const checks=[],calls=[],httpRoutes=[];let child,manager,lobby,server,llm,output='',diagnostics='',paidModelCalls=0,confirmationId,step=false,abandon=false,earlyFinal=false,modelCalls=0,ticket,exit;
const steps=new Set(),abandons=new Set(),finals=new Set();
const check=(name,pass)=>{checks.push({name,pass:!!pass});console.log(JSON.stringify({check:name,pass:!!pass}));};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const driver=`import fs from 'node:fs';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
export const name='explicit-human-fixture';
export const inject=['agents','agentLoop','agentDefaultModel','sessions','appExit'];
export function apply(ctx){
 (async()=>{
  const {agent}=await ctx.agents.create({sessionId:'session-conversational-fixture',meta:{cwd:process.cwd()},agentOptions:{...ctx.agentDefaultModel.currentSelection()}});
  const humans=JSON.parse(fs.readFileSync(process.env.MODEL_E2E_INPUTS,'utf8'));
  for(let index=0;index<humans.length;index++){
   await agent.whenIdle();fs.writeFileSync(process.env.MODEL_E2E_PROGRESS,JSON.stringify({stage:index+1}),{mode:0o600});
   agent.followup(createUserMessage({content:[{type:'text',text:humans[index]}],source:{kind:'user'}}));
   await agent.whenIdle();
   if(index===3||index===5){for(let n=0;n<20;n++){await new Promise(r=>setTimeout(r,150));await agent.whenIdle();}}
   await ctx.sessions.flush(agent.session);
   process.stdout.write(JSON.stringify({fixture:'human_round_complete',round:index+1})+'\\n');
  }
  fs.writeFileSync(process.env.MODEL_E2E_SESSION,JSON.stringify(agent.session.log,null,2),{mode:0o600});
  ctx.appExit(0);
 })().catch(e=>{process.stderr.write('human_fixture:'+String(e.code??e.message)+'\\n');ctx.appExit(1);});
}
`;
try{
 fs.mkdirSync(workspace,{recursive:true,mode:0o700});fs.mkdirSync(profile,{recursive:true,mode:0o700});
 const access=new BetaAccessStore({dir:path.join(temp,'beta')});ticket=access.createInvites({count:1})[0].ticket;
 fs.writeFileSync(inputFile,JSON.stringify(['我想试试这个游戏',ticket,'昵称：对话验收；形象：DeepSeek娘（deepseek）；装备：rifle；模式：extraction；房间：public-1','行，就按这套开始吧，多拿点钱再去撤离','刚才赚了多少？先别开始','要多拿点钱再去撤离，再来一轮，确认开始']),{mode:0o600});
 manager=new RoomManager({dataDir:path.join(temp,'rooms'),invite:'isolated-unused-legacy-invite',seed:'conversation-acceptance',world:{npcTarget:0,airdrops:false}});await manager.start();
 lobby=new ArenaLobby(manager,{access,invite:'isolated-unused-legacy-invite',profiles:new ProfileStore(path.join(temp,'profiles')),rankings:new RankingStore(path.join(temp,'rankings'))});
 server=createArenaServer(lobby);server.prependListener('request',req=>httpRoutes.push({method:req.method,path:new URL(req.url,'http://local').pathname,stage:fs.existsSync(progress)?JSON.parse(fs.readFileSync(progress)).stage:0}));
 const port=await listen(server,0,'127.0.0.1'),base='http://127.0.0.1:'+port;lobby.mcpUrl=base+'/agent-game/mcp';
 const phaseCalls=new Map();
 llm=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  try{
   const request=JSON.parse(raw),stage=JSON.parse(fs.readFileSync(progress)).stage,count=(phaseCalls.get(stage)??0);phaseCalls.set(stage,count+1);modelCalls++;
   const names=(request.tools??[]).map(t=>t.function?.name??t.name),history=(request.messages??[]).filter(m=>m.role==='tool').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content));
   const found=history.join('\n').match(/confirmation_id["\\\s:]+([0-9a-f]{64})/);if(found)confirmationId=found[1];
   let action,parameters={},message;
   if(stage===1&&count===0)action='arena_start';
   else if(stage===1)message='请在本轮对话发送邀请码或完整邀请链接。';
   else if(stage===2&&count===0)action='arena_submit_invite';
   else if(stage===2)message='请提供昵称、模型少女形象、装备、模式、房间五项。';
   else if(stage===3&&count===0){action='arena_prepare';parameters={name:'对话验收',character_id:'deepseek',loadout_id:'rifle',mode_id:'extraction',room_id:'public-1'};}
   else if(stage===3)message='备赛摘要：昵称对话验收；DeepSeek娘；rifle装备；持久搜打撤；public-1。请确认。';
   else if(stage===5&&count===0)action='arena_start';
   else if(stage===5)message='上一局已结束，尚未重新入场。';
   else if(stage===6&&count===0)action='arena_start';
   else if(stage===4&&count===0){if(!confirmationId)throw new Error('missing_confirmation_id');action='arena_confirm';parameters={confirmation_id:confirmationId};}
   else if([4,6].includes(stage)&&!finals.has(stage)){finals.add(stage);earlyFinal=true;message='沿用核对过的配置，继续游戏至终局。';}
   else if([4,6].includes(stage)&&!steps.has(stage)&&names.includes('mcp__model_action__step')){steps.add(stage);step=true;action='mcp__model_action__step';parameters={input:{right:true,hold_ms:100},client_cmd_id:'natural-step-'+stage};}
   else if([4,6].includes(stage)&&!abandons.has(stage)&&names.includes('mcp__model_action__abandon')){abandons.add(stage);abandon=true;action='mcp__model_action__abandon';}
   else message='等待服务端确认本局结果。';
   calls.push({call:modelCalls,stage,tools:names,action:action??'final',...(action==='arena_submit_invite'?{argument_keys:Object.keys(parameters)}:{}),invite_in_model_request:raw.includes(ticket),invite_in_tool_history:history.some(text=>text.includes(ticket)),private_credentials_in_tool_history:history.some(text=>/model_beta_(?:invite_)?[A-Za-z0-9_-]{43}|aea_profile_[A-Za-z0-9_-]{32,}|[\"'](?:access_token|control_token|game_token|recovery_secret|device_secret)[\"']\s*:\s*[\"'][A-Za-z0-9_-]{16,}/.test(text.replace(/\\\"/g,'\"')))});
   const delta=action?{role:'assistant',content:null,tool_calls:[{index:0,id:'fixture-'+modelCalls,type:'function',function:{name:action,arguments:JSON.stringify(parameters)}}]}:{role:'assistant',content:message};
   const chunk=(d,f)=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:0,model:request.model,choices:[{index:0,delta:d,finish_reason:f}]})+'\n\n';
   res.writeHead(200,{'content-type':'text/event-stream'});res.end(chunk(delta,null)+chunk({},action?'tool_calls':'stop')+'data: [DONE]\n\n');
  }catch(e){diagnostics+='fake_model:'+String(e.code??e.message)+'\n';res.writeHead(500);res.end('{}');}
 });});await new Promise(r=>llm.listen(0,'127.0.0.1',r));
 const modules=path.join(profile,'node_modules');fs.mkdirSync(path.join(modules,'@deepseek-ai'),{recursive:true});
 const target=path.join(modules,'dsh-model-action');fs.mkdirSync(target);
 for(const file of ['package.json','host.js','cordis.patch.yml','lib'])fs.cpSync(path.join(CLIENT,file),path.join(target,file),{recursive:true});
 // The plugin is copied, never linked to mutable source or the user's profile.
 for(const dep of ['dsh-tools','dsh-mcp-client','dsh-llm'])fs.symlinkSync(path.join(HOST,'@deepseek-ai',dep),path.join(modules,'@deepseek-ai',dep));
 const humanDir=path.join(modules,'model-action-human-fixture');fs.mkdirSync(humanDir);fs.writeFileSync(path.join(humanDir,'package.json'),JSON.stringify({name:'model-action-human-fixture',type:'module',main:'index.js'}));fs.writeFileSync(path.join(humanDir,'index.js'),driver);
 fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({name:'model-action-conversation-fixture',private:true,dependencies:{'dsh-model-action':JSON.parse(fs.readFileSync(path.join(CLIENT,'package.json'))).version,'model-action-human-fixture':'0.0.0'},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless','dsh-model-action']}}}));
 fs.writeFileSync(path.join(profile,'cordis.patch.yml'),`- id: headless-runner\n  disabled: true\n- id: permission\n  config:\n    presets:\n      arena-test:\n        sandbox: workspace-write\n        approval: never\n    defaultPreset: arena-test\n- id: model-action-native\n  config:\n    serverUrl: ${base}\n    maxSeconds: 60\n    maxToolCalls: 20\n    maxContinuations: 10\n    connectSeconds: 30\n- id: llm-pi-ai\n  config:\n    providers:\n      fake:\n        displayName: Explicit loopback fixture\n        api: openai-completions\n        baseURL: http://127.0.0.1:${llm.address().port}/v1\n        apiKeyEnv: MODEL_E2E_FAKE_KEY\n        models:\n          - id: conversation-fixture\n            name: Explicit loopback fixture\n            contextWindow: 200000\n            maxTokens: 1000\n            input: [text]\n- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: fake\n    model: conversation-fixture\n- insert:\n    - id: explicit-human-fixture\n      name: model-action-human-fixture\n`);
 const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_MODE:'DISABLED',MODEL_E2E_FAKE_KEY:'explicit-local-fixture',MODEL_E2E_INPUTS:inputFile,MODEL_E2E_PROGRESS:progress,MODEL_E2E_SESSION:path.join(OUT,'session.private.json')};
 for(const key of Object.keys(env))if(/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|MODEL_ACTION|AEA_)/.test(key))delete env[key];
 child=spawn(process.execPath,[CLI,'--profile','conversation-fixture','--approval-policy','never','explicit-human-fixture-driver'],{cwd:workspace,env});
 child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>diagnostics+=v);
 const timeout=setTimeout(()=>child.kill('SIGTERM'),60000);exit=await new Promise(r=>child.on('close',r));clearTimeout(timeout);
 const session=[...lobby.byId.values()][0];if(session)await lobby.exclusive(session,()=>lobby.refresh(session));
 for(let n=0;n<20&&manager.room('public-1').players_active;n++)await wait(100);
 check('official DSH 0.2.2-rc.1 completes six persistent human rounds',exit===0&&output.includes('"round":6'));
 check('invitation requested before this turn ends',calls.some(c=>c.stage===1&&c.action==='arena_start')&&calls.some(c=>c.stage===1&&c.action==='final'));
 check('human invitation submitted with no tool arguments',calls.some(c=>c.stage===2&&c.action==='arena_submit_invite'&&c.argument_keys.length===0));
 check('first configuration summarized before natural human confirmation',calls.some(c=>c.stage===3&&c.action==='arena_prepare')&&calls.some(c=>c.stage===3&&c.action==='final')&&calls.some(c=>c.stage===4&&c.action==='arena_confirm'));
 check('natural first confirmation and a single repeat request both run to real terminal',earlyFinal&&steps.size===2&&abandons.size===2);
 check('a second real queue request is issued only by the new human request',httpRoutes.some(r=>r.stage===4&&r.path==='/client/v2/queue')&&httpRoutes.some(r=>r.stage===6&&r.path==='/client/v2/queue'));
 check('repeat skips preparation summary and a second confirmation',calls.some(c=>c.stage===6&&c.action==='arena_start')&&!calls.some(c=>c.stage===6&&['arena_prepare','arena_confirm'].includes(c.action)));
 check('intervening question or refusal never queues a game',!httpRoutes.some(r=>r.stage===5&&['/client/v2/prepare','/client/v2/queue','/client/v2/offer/accept'].includes(r.path)));
 check('authoritative real-worker terminal frees the player seat',session?.state==='ended'&&session?.result?.outcome==='abandoned'&&manager.room('public-1').players_active===0);
 check('four real rooms remain healthy',manager.rooms().length===4&&manager.rooms().every(r=>r.state!=='unavailable'));
 check('browser session creation and approval endpoints are never called',!httpRoutes.some(r=>/^\/lobby\/v2\/(?:session|pairing)/.test(r.path))&&httpRoutes.some(r=>r.path==='/client/v2/access/connect'));
 check('private credentials are absent from tool history and invitation submission has no arguments',calls.every(c=>!c.invite_in_tool_history&&!c.private_credentials_in_tool_history)&&calls.filter(c=>c.action==='arena_submit_invite').every(c=>c.argument_keys.length===0));
 save('result.json',{label:'Official DSH CLI/core + real native plugin + real four-worker HTTP; explicit loopback LLM/human fixtures',version,checks,exit,model_calls:modelCalls,paid_model_calls:paidModelCalls,terminal:session?.result??null});
}catch(e){save('failure.private.json',{error:e.code??e.message,exit});process.exitCode=1;}
finally{save('dsh.private.log',output);save('diagnostics.private.log',diagnostics);save('model-actions.private.json',calls);save('http-routes.private.json',httpRoutes);child?.kill();lobby?.stop();server?.closeAllConnections();server?.close();llm?.closeAllConnections();llm?.close();await manager?.stop();fs.rmSync(temp,{recursive:true,force:true});}
console.log(JSON.stringify({evidence:OUT,passed:checks.length>0&&checks.every(c=>c.pass)}));if(!checks.length||checks.some(c=>!c.pass))process.exitCode=1;

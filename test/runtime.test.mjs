import test from 'node:test';
import assert from 'node:assert/strict';
import { ArenaRuntime } from '../shared/runtime.js';
const clone=value=>structuredClone(value);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const err=(code,status=null)=>Object.assign(new Error('private diagnostic must not escape'),{code,status});

function fixture(t,{state='in_world',connected=true,transport,clientChanges={}}={}) {
  const calls=[],wakes=[],terminals=[],states=[];let now=1000;
  const s={state,public_agent_id:state==='preparing'?null:'agent_public',connection:{state:'connected'},
    attempt:['preparing','ready'].includes(state)?null:{id:'attempt_public',room_id:'public-1',mode_id:'extraction',state,client_ready:false,offer_id:'offer_public'},result:null};
  const local={connected,pairing:null};
  const credentials={attempt_id:'attempt_public',game_token:'private_game_token_123456',mcp_url:'https://arena.test/agent-game/mcp'};
  const client={serverUrl:'https://arena.test',
    async publicState(){calls.push('publicState');return clone(local);},
    async pairInit(){calls.push('pairInit');local.pairing={user_code:'AB12345678',expires_at_ms:now+300000,poll_interval_ms:2000};return {state:'pending',...local.pairing};},
    async pairPoll(){calls.push('pairPoll');return {state:local.connected?'connected':'pending'};},
    async session(){calls.push('session');if(client.sessionError)throw client.sessionError;return clone(s);},
    async heartbeat(loop){calls.push('heartbeat');client.lastLoop=clone(loop);if(client.sessionError)throw client.sessionError;return clone(s);},
    async claimProfile(){calls.push('claimProfile');return {state:'saved',public_agent_id:s.public_agent_id};},
    async prepareEntry(options){calls.push('prepareEntry');client.entry=options;s.state='ready';s.attempt=null;s.public_agent_id='agent_public';return clone(s);},
    async queueEntry(){calls.push('queueEntry');s.state='offered';s.attempt={id:'attempt_public',room_id:'public-1',mode_id:'extraction',state:'offered',offer_id:'offer_public',client_ready:false};return clone(s);},
    async acceptOffer(id){assert.equal(id,'offer_public');calls.push('acceptOffer');s.state=s.attempt.state='in_world';return clone(s);},
    async claimAttempt(){calls.push('claimAttempt');return {state:'acknowledged',attempt_id:s.attempt.id,mcp_url:credentials.mcp_url};},
    async readyAttempt(){calls.push('readyAttempt');s.attempt.client_ready=true;return clone(s);},
    async attemptCredentials(){calls.push('attemptCredentials');return clone(credentials);},
    async result(){calls.push('result');if(!s.result)throw err('result_unavailable',404);return {result:clone(s.result)};},
    async clearAttempt(id){calls.push('clearAttempt:'+id);},
    async withdrawEntry(){calls.push('withdrawEntry');s.state='ready';s.attempt=null;return clone(s);},
    cancelPending(){calls.push('cancelPending');},...clientChanges};
  const defaultTransport=async ({method,params,signal})=>{
    calls.push(method);
    if(method==='tools/list')return {tools:[{name:'observe',description:'Visible only',inputSchema:{type:'object',properties:{}}},{name:'wait_for_event',inputSchema:{type:'object',properties:{}}},{name:'abandon',inputSchema:{type:'object',properties:{}}}]};
    if(params.name==='wait_for_event')return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(err('request_cancelled')),{once:true});});
    if(params.name==='abandon'){s.state=s.attempt.state='ended';s.result={attempt_id:s.attempt.id,outcome:'abandoned',kills:0,extracted_value:0};return {content:[{type:'text',text:JSON.stringify({ok:true,outcome:'abandoned'})}]};}
    return {content:[{type:'text',text:JSON.stringify({ok:true,echoed_token:credentials.game_token})}]};
  };
  const runtime=new ArenaRuntime({client,transport:transport??defaultTransport,clock:()=>now,
    onWake:value=>{wakes.push(value);},onTerminal:value=>{terminals.push(value);},onState:value=>{states.push(value);}});
  t.after(()=>runtime.stop());
  return {runtime,client,s,local,credentials,calls,wakes,terminals,states,now:value=>{now=value;},defaultTransport};
}

test('automatic entry requires explicit start option; profile ACK and claim ACK precede a single entered wake',async t=>{
  const f=fixture(t,{state:'preparing'});await f.runtime.start();
  assert.equal(f.runtime.state().phase,'preparing');assert.ok(!f.calls.includes('queueEntry'));
  await f.runtime.stop();await f.runtime.start({autoEnter:true,entry:{mode_id:'extraction',room_id:'public-1',name:'Agent'}});await settle();
  assert.equal(f.runtime.state().phase,'in_world');assert.equal(f.wakes.length,1);
  assert.ok(f.calls.indexOf('claimProfile')<f.calls.indexOf('queueEntry'));
  assert.ok(f.calls.indexOf('claimAttempt')>f.calls.indexOf('acceptOffer'));
  assert.equal(f.client.entry.name,'Agent');
  for(let i=0;i<4;i++)await f.runtime.refresh();await settle();
  assert.equal(f.wakes.length,1);assert.equal(f.calls.filter(x=>x==='claimAttempt').length,1);
  assert.equal(f.calls.filter(x=>x==='claimProfile').length,1);
  assert.equal(f.runtime.wake(),true);assert.equal(f.runtime.wake(),false);await settle();assert.equal(f.wakes.length,2);
});

test('pairing presents only public code and never approves on behalf of the human',async t=>{
  const f=fixture(t,{state:'preparing',connected:false});await f.runtime.start({autoEnter:true});
  assert.equal(f.runtime.state().phase,'pairing');assert.equal(f.runtime.state().pairing.user_code,'AB12345678');
  await f.runtime.refresh();assert.equal(f.calls.filter(x=>x==='pairInit').length,1);assert.ok(f.calls.includes('pairPoll'));assert.equal(f.wakes.length,0);
  f.local.connected=true;await f.runtime.refresh();await settle();assert.equal(f.wakes.length,1);
  assert.ok(f.calls.every(x=>!x.includes('approve')));
  assert.ok(!JSON.stringify(f.states).includes('private_game_token'));
});

test('BR waiting acknowledges attempt then re-readies after countdown cancellation without a second model start',async t=>{
  const f=fixture(t,{state:'waiting'});f.s.attempt.mode_id='battle_royale';f.s.attempt.room_id='br-1';
  await f.runtime.start();assert.equal(f.wakes.length,0);assert.equal(f.calls.filter(x=>x==='readyAttempt').length,1);
  assert.ok(f.calls.indexOf('claimAttempt')<f.calls.indexOf('readyAttempt'));
  f.s.state=f.s.attempt.state='countdown';await f.runtime.refresh();assert.equal(f.wakes.length,0);
  f.s.state=f.s.attempt.state='waiting';f.s.attempt.client_ready=false;await f.runtime.refresh();assert.equal(f.calls.filter(x=>x==='readyAttempt').length,2);
  f.s.state=f.s.attempt.state='in_world';await f.runtime.refresh();await f.runtime.refresh();await settle();
  assert.equal(f.calls.filter(x=>x==='claimAttempt').length,1);assert.equal(f.wakes.length,1);assert.equal(f.wakes[0].room_id,'br-1');
});

test('polls are single-flight, heartbeat uses five-second clock, and one client cannot run twice',async t=>{
  const f=fixture(t);await f.runtime.start();const initial=f.calls.filter(x=>x==='session').length;
  f.now(3000);await Promise.all(Array.from({length:8},()=>f.runtime.refresh()));
  assert.equal(f.calls.filter(x=>x==='session').length,initial+1);assert.equal(f.calls.filter(x=>x==='heartbeat').length,1);
  f.now(6001);await f.runtime.refresh();assert.equal(f.calls.filter(x=>x==='heartbeat').length,2);
  const other=new ArenaRuntime({client:f.client});await assert.rejects(other.start(),{code:'runtime_already_running'});
});

test('bounded backoff recovers and control-lease 401 stops rather than inventing a result',async t=>{
  const f=fixture(t);f.client.sessionError=err('request_timeout');await f.runtime.start();
  assert.equal(f.runtime.state().phase,'backoff');assert.equal(f.runtime.state().last_error.code,'request_timeout');
  delete f.client.sessionError;await f.runtime.refresh();await settle();assert.equal(f.runtime.state().phase,'in_world');assert.equal(f.wakes.length,1);
  f.now(9000);f.client.sessionError=err('client_unauthorized',401);await f.runtime.refresh();
  assert.equal(f.runtime.state().active,false);assert.equal(f.runtime.state().phase,'error');assert.equal(f.terminals.length,0);
  assert.equal(f.runtime.wake(),false);assert.equal(f.runtime.state().character_state,'still_in_world');
});

test('terminal interrupts MCP wait, clears private credentials once and never auto-enqueues another game',async t=>{
  const f=fixture(t);await f.runtime.start();await settle();
  const waiting=f.runtime.callGame('wait_for_event',{});const cancelled=assert.rejects(waiting,{code:'request_cancelled'});await settle();
  f.s.state=f.s.attempt.state='ended';f.s.result={attempt_id:'attempt_public',outcome:'killed',extracted_value:0};
  await Promise.all([f.runtime.refresh(),f.runtime.refresh()]);await cancelled;await settle();
  assert.equal(f.terminals.length,1);assert.equal(f.calls.filter(x=>x==='clearAttempt:attempt_public').length,1);assert.equal(f.runtime.wake(),false);
  f.s.state='preparing';f.s.attempt=null;f.s.result=null;await f.runtime.refresh();
  assert.ok(!f.calls.includes('prepareEntry'));assert.ok(!f.calls.includes('queueEntry'));
});

test('MCP 401 consults control state and suspends gameplay without declaring a win',async t=>{
  let mode='normal';const f=fixture(t,{transport:async args=>{if(args.method==='tools/call'&&mode==='reject')throw err('game_unauthorized',401);return f.defaultTransport(args);}});
  await f.runtime.start();await f.runtime.listGameTools();mode='reject';
  await assert.rejects(f.runtime.callGame('observe',{}),{code:'game_unauthorized'});
  assert.equal(f.terminals.length,0);assert.equal(f.runtime.state().phase,'error');assert.equal(f.runtime.state().character_state,'still_in_world');assert.equal(f.runtime.wake(),false);
  await f.runtime.refresh();assert.equal(f.runtime.state().phase,'error');
});

test('game tool results redact credentials and reject an off-origin grant before any transport',async t=>{
  const f=fixture(t);await f.runtime.start();
  const result=await f.runtime.callGame('observe',{});assert.ok(JSON.stringify(result).includes('[redacted]'));assert.ok(!JSON.stringify(result).includes(f.credentials.game_token));
  assert.ok(!JSON.stringify(f.runtime.state()).includes(f.credentials.game_token));
  const before=f.calls.filter(x=>x==='tools/call').length;f.credentials.mcp_url='https://attacker.test/mcp';
  await assert.rejects(f.runtime.callGame('observe',{}),{code:'unsafe_mcp_url'});assert.equal(f.calls.filter(x=>x==='tools/call').length,before);
});

test('stopping the model alone reports the role still in world; explicit abandon confirms terminal',async t=>{
  const f=fixture(t);await f.runtime.start();await settle();
  const stopped=await f.runtime.stop();assert.equal(stopped.character_state,'still_in_world');assert.equal(stopped.terminal_confirmed,false);assert.equal(f.terminals.length,0);
  await f.runtime.start();const abandoned=await f.runtime.stop('budget_limit',{abandon:true});
  assert.equal(abandoned.character_state,'ended');assert.equal(abandoned.terminal_confirmed,true);assert.equal(f.terminals.length,1);assert.equal(abandoned.result.outcome,'abandoned');
});

test('stop reconciles and releases a prestart reservation using authenticated client operation',async t=>{
  const f=fixture(t,{state:'waiting'});await f.runtime.start();
  const result=await f.runtime.stop('user_stop',{abandon:true});assert.equal(result.character_state,'not_in_world');assert.equal(result.reservation_state,'released');
  assert.ok(f.calls.includes('withdrawEntry'));assert.ok(!f.calls.includes('tools/call'));
});

test('an explicitly requested next start may prepare from a prior terminal; terminal callbacks can stop without a false client error',async t=>{
  const f=fixture(t,{state:'ended'});f.s.result={attempt_id:'attempt_public',outcome:'extracted',extracted_value:123};
  await f.runtime.start({autoEnter:true});await settle();
  assert.equal(f.calls.filter(x=>x==='prepareEntry').length,1);assert.equal(f.runtime.state().phase,'in_world');assert.equal(f.terminals.length,0);
  f.s.state=f.s.attempt.state='ended';f.s.result={attempt_id:'next_attempt',outcome:'abandoned'};
  f.s.attempt.id='next_attempt';
  f.runtime.onTerminal=async info=>{f.terminals.push(info);await f.runtime.stop('server_terminal');};
  await f.runtime.refresh();assert.equal(f.terminals.length,1);assert.equal(f.runtime.state().phase,'stopped');assert.equal(f.runtime.state().loop.reason,null);
});

